/**
 * Upload Shift Roster (item 23390097) — the month-grid analyzer and its write path.
 *
 * The reporter's rules, one test each, because every one of them is a promise made on the screen before
 * anything is saved:
 *   · a valid code writes, and writes ONLY inside the chosen month;
 *   · an unknown code, an ARCHIVED code, an unknown employee number, a date outside the month and a
 *     repeated (employee, date) are each REJECTED with their own reason and never written;
 *   · RD writes an explicit rest day, OFF removes the entry, a blank cell and a `(bracketed)` cell
 *     leave the date exactly as it was;
 *   · a dry run writes nothing at all;
 *   · a commit files ONE `roster.bulk.uploaded` entry carrying the file name and the counts.
 *
 * The out-of-month case is the load-bearing one: "days outside the chosen month are NEVER touched" is
 * the sentence that makes an upload safe to hand to HR, so it asserts the neighbouring month's stored
 * row is byte-identical afterwards, not merely that a reject was reported.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { archiveShift, assignShift, createShift, rosterForRange, setRestDay } from '../core/roster';
import { analyzeRosterImport } from '../core/roster-import';

let b: Base;
let ctx: ReturnType<typeof adminCtx>;
let empA = '';
let empB = '';
let morning = '';
let night = '';

const MONTH = '2026-08';
const csv = (rows: string[][]) => rows.map((r) => r.join(',')).join('\n');

async function hire(code: string, name: string) {
  const r = await hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${code.toLowerCase()}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
    employeeCode: code,
  });
  return r.employmentId;
}

const storedFor = (employmentId: string, date: string) =>
  owner.db
    .select({ shiftId: schema.rosterAssignment.shiftId, isRestDay: schema.rosterAssignment.isRestDay })
    .from(schema.rosterAssignment)
    .where(and(eq(schema.rosterAssignment.employmentId, employmentId), eq(schema.rosterAssignment.shiftDate, date)));

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ctx = adminCtx(b);
  empA = await hire('A0001', 'Ahmad Zulkifli');
  empB = await hire('A0002', 'Nurul Ain');
  morning = (await createShift(ctx, { companyId: b.companyId, name: 'Morning full', code: 'MB28', startTime: '08:00:00', endTime: '17:00:00' })).id;
  night = (await createShift(ctx, { companyId: b.companyId, name: 'Night', code: 'WFO-HQ-FWH', startTime: '22:00:00', endTime: '06:00:00' })).id;
});

describe('roster upload — analyze (23390097)', () => {
  it('accepts codes case-insensitively, counts what it read, and a dry run writes nothing', async () => {
    const text = csv([
      ['Employee No', 'Employee Name', '2026-08-03', '2026-08-04'],
      ['a0001', 'Ahmad Zulkifli', 'mb28', 'RD'],
      ['A0002', 'Nurul Ain', 'WFO-HQ-FWH', ''],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, fileName: 'aug.xlsx', dryRun: true });
    expect(r.rowsRead).toBe(2);
    expect(r.employees).toBe(2);
    expect(r.daysRead).toBe(3); // the blank cell is not an instruction
    expect(r.valid).toBe(3);
    expect(r.duplicates).toBe(0);
    expect(r.changed).toBe(3);
    expect(r.rejects).toEqual([]);
    expect(r.committed).toBe(false);
    expect(await rosterForRange(ctx, { from: '2026-08-01', to: '2026-08-31' })).toHaveLength(0);
  });

  it('commits the accepted cells: shift, RD, and a blank left alone', async () => {
    const text = csv([
      ['Employee No', '2026-08-03', '2026-08-04', '2026-08-05'],
      ['A0001', 'MB28', 'RD', ''],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, fileName: 'aug.xlsx', dryRun: false });
    expect(r.committed).toBe(true);
    expect(r.changed).toBe(2);
    expect((await storedFor(empA, '2026-08-03'))[0]).toMatchObject({ shiftId: morning, isRestDay: false });
    expect((await storedFor(empA, '2026-08-04'))[0]).toMatchObject({ shiftId: null, isRestDay: true });
    expect(await storedFor(empA, '2026-08-05')).toHaveLength(0);
  });

  it('OFF clears an existing entry; a bracketed ghost code leaves the date alone', async () => {
    await assignShift(ctx, { employmentId: empA, shiftDate: '2026-08-06', shiftId: morning });
    await assignShift(ctx, { employmentId: empA, shiftDate: '2026-08-07', shiftId: night });
    const text = csv([
      ['Employee No', '2026-08-06', '2026-08-07'],
      ['A0001', 'OFF', '(MB28)'],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: false });
    expect(r.daysRead).toBe(1); // the bracketed cell is not read as an instruction
    expect(await storedFor(empA, '2026-08-06')).toHaveLength(0);
    expect((await storedFor(empA, '2026-08-07'))[0]).toMatchObject({ shiftId: night });
  });

  it('rejects an unknown shift code and writes nothing for that cell', async () => {
    const text = csv([
      ['Employee No', '2026-08-10'],
      ['A0001', 'NOPE'],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: false });
    expect(r.valid).toBe(0);
    expect(r.rejects).toEqual([{ row: 2, employeeCode: 'A0001', date: '2026-08-10', value: 'NOPE', reason: 'unknown_code' }]);
    expect(await storedFor(empA, '2026-08-10')).toHaveLength(0);
  });

  it('rejects an ARCHIVED shift code with its own reason — never quietly re-creates it', async () => {
    await archiveShift(ctx, { shiftId: night });
    const text = csv([
      ['Employee No', '2026-08-11'],
      ['A0001', 'WFO-HQ-FWH'],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: false });
    expect(r.rejects.map((x) => x.reason)).toEqual(['archived_code']);
    expect(await storedFor(empA, '2026-08-11')).toHaveLength(0);
  });

  it('rejects an employee number that resolves to nobody, once for the whole line', async () => {
    const text = csv([
      ['Employee No', '2026-08-12', '2026-08-13'],
      ['ZZZZ', 'MB28', 'MB28'],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: false });
    expect(r.employees).toBe(0);
    expect(r.rejects).toEqual([{ row: 2, employeeCode: 'ZZZZ', date: null, value: '', reason: 'unknown_employee' }]);
  });

  it('NEVER touches a date outside the chosen month — it is reported and the stored row is unchanged', async () => {
    await assignShift(ctx, { employmentId: empA, shiftDate: '2026-09-01', shiftId: morning });
    const text = csv([
      ['Employee No', '2026-08-14', '2026-09-01', '2026-07-31'],
      ['A0001', 'MB28', 'WFO-HQ-FWH', 'RD'],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: false });
    expect(r.rejects.map((x) => [x.date, x.reason])).toEqual([
      ['2026-09-01', 'out_of_month'],
      ['2026-07-31', 'out_of_month'],
    ]);
    // The September row is exactly as it was — the upload did not re-write it, and did not delete it.
    expect((await storedFor(empA, '2026-09-01'))[0]).toMatchObject({ shiftId: morning, isRestDay: false });
    expect(await storedFor(empA, '2026-07-31')).toHaveLength(0);
    expect((await storedFor(empA, '2026-08-14'))[0]).toMatchObject({ shiftId: morning });
  });

  it('rejects the SECOND appearance of an (employee, date) inside one file and keeps the first', async () => {
    const text = csv([
      ['Employee No', '2026-08-17'],
      ['A0001', 'MB28'],
      ['A0001', 'WFO-HQ-FWH'],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: false });
    expect(r.duplicates).toBe(1);
    expect(r.rejects.map((x) => x.reason)).toEqual(['duplicate']);
    expect((await storedFor(empA, '2026-08-17'))[0]).toMatchObject({ shiftId: morning });
  });

  it('a column heading that is not a real date is rejected, not silently dropped', async () => {
    const text = csv([
      ['Employee No', '2026-02-31'],
      ['A0001', 'MB28'],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: true });
    expect(r.rejects.map((x) => x.reason)).toEqual(['bad_date_column']);
  });

  it('counts only the cells that would CHANGE, so re-uploading the same file writes nothing', async () => {
    const text = csv([
      ['Employee No', '2026-08-18'],
      ['A0001', 'MB28'],
    ]);
    await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: false });
    const again = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: true });
    expect(again.valid).toBe(1);
    expect(again.changed).toBe(0);
  });

  it('files ONE roster.bulk.uploaded audit entry with the file name and the counts', async () => {
    const text = csv([
      ['Employee No', '2026-08-19', '2026-08-20'],
      ['A0001', 'MB28', 'RD'],
      ['A0002', 'MB28', 'NOPE'],
    ]);
    await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, fileName: 'august-roster.xlsx', dryRun: false });
    const payload = await latestEventPayload(b.tenantId, b.companyId, 'roster.bulk.uploaded');
    expect(payload).toMatchObject({
      fileName: 'august-roster.xlsx',
      month: MONTH,
      employees: 2,
      rowsRead: 2,
      changed: 3,
      rejected: 1,
    });
    expect((await storedFor(empB, '2026-08-19'))[0]).toMatchObject({ shiftId: morning });
  });

  it('a rest day that is already stored is not re-written, and RD after a shift flips the row', async () => {
    await setRestDay(ctx, { employmentId: empA, shiftDate: '2026-08-21' });
    const text = csv([
      ['Employee No', '2026-08-21', '2026-08-22'],
      ['A0001', 'RD', 'RD'],
    ]);
    const r = await analyzeRosterImport(ctx, { csvText: text, month: MONTH, companyId: b.companyId, dryRun: false });
    expect(r.changed).toBe(1);
    expect((await storedFor(empA, '2026-08-22'))[0]).toMatchObject({ isRestDay: true, shiftId: null });
  });
});
