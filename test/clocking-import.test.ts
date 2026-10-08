/**
 * r424 (50ed39e1) — Import Clocking Data against a real database: the mapping library, the line-by-line
 * decisions, the ADD-never-overwrite write, the payroll interlock and the permanent import log.
 *
 * Each `describe` is one promise from the approved plan (items 9-22), asserted on rows rather than on the
 * preview alone. Dates are in July 2026, before today (2026-10-08) — a future clocking is refused.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { checkIn, checkOut } from '../core/attendance';
import {
  ClockingMappingError,
  commitClockingImport,
  createClockingMapping,
  deleteClockingMapping,
  getClockingImportRun,
  listClockingImportRuns,
  setClockingMappingActive,
  validateClockingImport,
  type ClockingMappingInput,
} from '../core/attendance-clocking-import';
import { BUILTIN_MAPPING_ID } from '../lib/clocking-file';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

async function makeEmp(opts: {
  code: string;
  card?: string;
  ic?: string;
  companyId?: string;
  hiredOn?: string;
  terminatedOn?: string;
  name?: string;
}) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: opts.name ?? `W ${opts.code}`, primaryEmail: `w_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({
      tenantId: b.tenantId,
      personId: p.id,
      companyId: opts.companyId ?? b.companyId,
      hiredOn: opts.hiredOn ?? '2020-01-01',
      employeeCode: opts.code,
      cardId: opts.card ?? null,
      terminatedOn: opts.terminatedOn ?? null,
    })
    .returning({ id: schema.employment.id });
  if (opts.ic) await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: p.id, icNumber: opts.ic });
  return e.id;
}

/** Card, day, month, year, hours, minute, code — comma separated, IN / OUT. */
const CODED: ClockingMappingInput = {
  name: 'Suprema CSV',
  description: '',
  deviceName: 'Suprema',
  fileType: 'csv',
  layout: 'delimited',
  delimiter: ',',
  hasHeader: false,
  encoding: 'utf-8',
  active: true,
  fields: {
    cardId: { column: 1 },
    day: { column: 2 },
    month: { column: 3 },
    year: { column: 4 },
    hours: { column: 5 },
    minute: { column: 6 },
    inOutCode: { column: 7 },
  },
  inOutCodes: [
    { code: 'IN', direction: 'in' },
    { code: 'OUT', direction: 'out' },
  ],
  sampleLines: ['001234,01,07,2026,08,15,IN'],
  sampleFileName: 'suprema-sample.csv',
};
const UNCODED: ClockingMappingInput = {
  ...CODED,
  name: 'Factory (no codes)',
  fields: { ...CODED.fields, inOutCode: undefined } as ClockingMappingInput['fields'],
  inOutCodes: [],
};
const line = (card: string, date: string, time: string, code?: string) => {
  const [y, m, d] = date.split('-');
  const [h, mi] = time.split(':');
  return [card, d, m, y, h, mi, ...(code ? [code] : [])].join(',');
};

const importText = (ctx: SessionContext, mappingId: string, text: string, fileName = 'clock.csv') =>
  commitClockingImport(ctx, { mappingId, text, fileName, fileBytes: Buffer.byteLength(text) });

async function dayRow(employmentId: string, date: string) {
  const [row] = await owner.db
    .select()
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  return row;
}
async function punchesOf(employmentId: string, date: string) {
  return owner.db
    .select({ at: schema.attendancePunch.punchAt, dir: schema.attendancePunch.direction, method: schema.attendancePunch.method })
    .from(schema.attendancePunch)
    .where(and(eq(schema.attendancePunch.employmentId, employmentId), eq(schema.attendancePunch.attendanceDate, date)))
    .orderBy(schema.attendancePunch.punchAt, schema.attendancePunch.direction);
}
async function linesOf(runId: string) {
  return owner.db
    .select()
    .from(schema.clockingImportLine)
    .where(eq(schema.clockingImportLine.runId, runId))
    .orderBy(schema.clockingImportLine.lineNo);
}

describe('matching (plan item 14)', () => {
  it('card beats employee code beats IC, as before; leading zeros are kept', async () => {
    const ctx = adminCtx(b);
    const byCard = await makeEmp({ code: 'E1', card: '007' });
    const byCode = await makeEmp({ code: '7' });
    const byIc = await makeEmp({ code: 'E3', ic: '900101-01-1234' });
    const csv = ['staff,time', '007,2026-07-01 08:00', '7,2026-07-01 08:05', '900101011234,2026-07-01 08:10'].join('\n');
    const r = await importText(ctx, BUILTIN_MAPPING_ID, csv);
    expect(r.imported).toBe(3);
    expect((await punchesOf(byCard, '2026-07-01')).map((p) => p.at)).toEqual(['08:00:00']);
    expect((await punchesOf(byCode, '2026-07-01')).map((p) => p.at)).toEqual(['08:05:00']);
    expect((await punchesOf(byIc, '2026-07-01')).map((p) => p.at)).toEqual(['08:10:00']);
  });

  it('a card belonging to an employee not employed on the date is not matched', async () => {
    const ctx = adminCtx(b);
    const gone = await makeEmp({ code: 'G1', card: 'C-OLD', terminatedOn: '2026-06-30' });
    const late = await makeEmp({ code: 'G2', card: 'C-NEW', hiredOn: '2026-08-01' });
    const r = await importText(ctx, BUILTIN_MAPPING_ID, 'staff,time\nC-OLD,2026-07-01 08:00\nC-NEW,2026-07-01 08:00');
    expect(r.imported).toBe(0);
    const lines = await linesOf(r.runId!);
    expect(lines.map((l) => l.result)).toEqual(['not_employed_on_date', 'not_employed_on_date']);
    expect(await dayRow(gone, '2026-07-01')).toBeUndefined();
    expect(await dayRow(late, '2026-07-01')).toBeUndefined();
    expect(r.counts.unmatchedCard).toBe(2);
  });

  it('a card outside the importer’s companies is "not found", naming no one', async () => {
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: `Other ${randomUUID().slice(0, 6)}`, country: 'MY' })
      .returning({ id: schema.company.id });
    const outsider = await makeEmp({ code: 'O1', card: 'C-OUT', companyId: other.id, name: 'Secret Person' });
    const scoped: SessionContext = {
      ...adminCtx(b),
      grants: [{ role: 'hr_admin', companyId: b.companyId }],
    };
    const p = await validateClockingImport(scoped, { mappingId: BUILTIN_MAPPING_ID, text: 'staff,time\nC-OUT,2026-07-01 08:00' });
    expect(p.counts.unmatchedCard).toBe(1);
    expect(p.errorRows[0]).toMatchObject({ result: 'unmatched_card', employeeName: null, employmentId: null });
    expect(JSON.stringify(p)).not.toContain('Secret Person');
    const r = await importText(scoped, BUILTIN_MAPPING_ID, 'staff,time\nC-OUT,2026-07-01 08:00');
    expect(r.imported).toBe(0);
    expect(await dayRow(outsider, '2026-07-01')).toBeUndefined();
  });

  it('two employments answering the same IC on the date is ambiguous, never a guess', async () => {
    // One person employed by two companies at once (multi-company) — both employments answer the IC.
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: `Twin ${randomUUID().slice(0, 6)}`, country: 'MY' })
      .returning({ id: schema.company.id });
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Two Jobs', primaryEmail: `w_${randomUUID()}@t.local` })
      .returning({ id: schema.person.id });
    await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: p.id, icNumber: '880808088888' });
    const ids = await owner.db
      .insert(schema.employment)
      .values([
        { tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01', employeeCode: 'TJ1' },
        { tenantId: b.tenantId, personId: p.id, companyId: other.id, hiredOn: '2020-01-01', employeeCode: 'TJ2' },
      ])
      .returning({ id: schema.employment.id });
    const r = await importText(adminCtx(b), BUILTIN_MAPPING_ID, 'staff,time\n880808088888,2026-07-01 08:00');
    expect((await linesOf(r.runId!))[0].result).toBe('ambiguous_card');
    for (const { id } of ids) expect(await dayRow(id, '2026-07-01')).toBeUndefined();
  });
});

describe('duplicates (plan item 15): importing a file twice adds nothing twice', () => {
  it('the second import of the same file is all duplicates and reads No Records Imported', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp({ code: 'E100' });
    const csv = 'staff,time\nE100,2026-07-01 08:00\nE100,2026-07-01 17:00';
    const first = await importText(ctx, BUILTIN_MAPPING_ID, csv);
    expect(first).toMatchObject({ imported: 2, status: 'successful' });
    const preview = await validateClockingImport(ctx, { mappingId: BUILTIN_MAPPING_ID, text: csv });
    expect(preview.previousImport?.runId).toBe(first.runId);
    const second = await importText(ctx, BUILTIN_MAPPING_ID, csv);
    expect(second).toMatchObject({ imported: 0, status: 'no_records' });
    expect(second.counts.duplicate).toBe(2);
    expect(await punchesOf(emp, '2026-07-01')).toHaveLength(2);
    const runs = await listClockingImportRuns(ctx);
    expect(runs.find((r) => r.id === second.runId)).toMatchObject({ status: 'no_records', failedLines: 2, duplicateLines: 2 });
  });

  it('a clocking repeated inside one file is a duplicate of the earlier line', async () => {
    const emp = await makeEmp({ code: 'E101' });
    const r = await importText(adminCtx(b), BUILTIN_MAPPING_ID, 'staff,time\nE101,2026-07-01 08:00:10\nE101,2026-07-01 08:00:50\nE101,2026-07-01 17:00');
    expect(r.imported).toBe(2);
    expect((await linesOf(r.runId!)).map((l) => l.result)).toEqual(['imported', 'duplicate', 'imported']);
    expect((await dayRow(emp, '2026-07-01')).checkOutAt).toBe('17:00:00');
  });

  it('a day written before multi-punch (no punch rows) is matched through its own check-in/out', async () => {
    const emp = await makeEmp({ code: 'E102' });
    // The retired importer's footprint: an aggregate with times and NO attendance_punch children.
    await owner.db.insert(schema.attendance).values({
      tenantId: b.tenantId,
      employmentId: emp,
      attendanceDate: '2026-07-02',
      checkInAt: '08:00:00',
      checkOutAt: '17:00:00',
      status: 'present',
      dayType: 'workday',
      workedMinutes: 480,
      checkInMethod: 'import',
      checkOutMethod: 'import',
    });
    const r = await importText(adminCtx(b), BUILTIN_MAPPING_ID, 'staff,time\nE102,2026-07-02 08:00\nE102,2026-07-02 17:00');
    expect(r).toMatchObject({ imported: 0, status: 'no_records' });
    expect(await punchesOf(emp, '2026-07-02')).toHaveLength(0); // nothing synthesised when nothing is added
  });
});

describe('imported clockings are ADDED to the day, never written over it (plan items 16-17)', () => {
  it('a coded file on a Clock-screen day adds its clockings and the day is first in / last out', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp({ code: 'E200', card: 'C200' });
    await checkIn(ctx, { employmentId: emp, date: '2026-07-03', time: '08:30:00' });
    await checkOut(ctx, { employmentId: emp, date: '2026-07-03', time: '12:00:00' });
    const mappingId = await createClockingMapping(ctx, CODED);
    const r = await importText(ctx, mappingId, [line('C200', '2026-07-03', '13:00', 'IN'), line('C200', '2026-07-03', '18:00', 'OUT')].join('\n'));
    expect(r.imported).toBe(2);
    const ps = await punchesOf(emp, '2026-07-03');
    expect(ps.map((p) => `${p.at}|${p.dir}|${p.method}`)).toEqual([
      '08:30:00|in|web',
      '12:00:00|out|web',
      '13:00:00|in|import',
      '18:00:00|out|import',
    ]);
    const day = await dayRow(emp, '2026-07-03');
    expect(day.checkInAt).toBe('08:30:00'); // the web clock-in is NOT overwritten
    expect(day.checkOutAt).toBe('18:00:00');
    expect(day.checkInMethod).toBe('web');
    expect(day.checkOutMethod).toBe('import');
  });

  it('an uncoded file reads a day in time order; an odd count leaves the day open for review', async () => {
    const emp = await makeEmp({ code: 'E201' });
    const r = await importText(adminCtx(b), BUILTIN_MAPPING_ID, 'staff,time\nE201,2026-07-04 08:00\nE201,2026-07-04 12:00\nE201,2026-07-04 13:00');
    expect(r.imported).toBe(3);
    expect((await punchesOf(emp, '2026-07-04')).map((p) => p.dir)).toEqual(['in', 'out', 'in']);
    const day = await dayRow(emp, '2026-07-04');
    expect(day.checkInAt).toBe('08:00:00');
    expect(day.checkOutAt).toBeNull();
    expect(day.workedMinutes).toBeNull();
  });

  it('a later uncoded file completes that open day, continuing the in/out order', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp({ code: 'E202' });
    await importText(ctx, BUILTIN_MAPPING_ID, 'staff,time\nE202,2026-07-05 08:00\nE202,2026-07-05 12:00\nE202,2026-07-05 13:00');
    await importText(ctx, BUILTIN_MAPPING_ID, 'staff,time\nE202,2026-07-05 17:30', 'second.csv');
    expect((await punchesOf(emp, '2026-07-05')).map((p) => p.dir)).toEqual(['in', 'out', 'in', 'out']);
    expect((await dayRow(emp, '2026-07-05')).checkOutAt).toBe('17:30:00');
  });

  it('uncoded lines may not add to a day with Clock-screen clockings; they are listed instead', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp({ code: 'E203' });
    await checkIn(ctx, { employmentId: emp, date: '2026-07-06', time: '08:30:00' });
    const r = await importText(ctx, BUILTIN_MAPPING_ID, 'staff,time\nE203,2026-07-06 17:00');
    expect(r.imported).toBe(0);
    expect((await linesOf(r.runId!))[0].result).toBe('uncoded_on_clocked_day');
    expect(await punchesOf(emp, '2026-07-06')).toHaveLength(1);
  });
});

describe('days the import refuses to change (plan item 18)', () => {
  it('a day corrected through an approved attendance request is untouched', async () => {
    const emp = await makeEmp({ code: 'E300' });
    await owner.db.insert(schema.attendance).values({
      tenantId: b.tenantId,
      employmentId: emp,
      attendanceDate: '2026-07-07',
      checkInAt: '09:00:00',
      checkOutAt: '18:00:00',
      status: 'present',
      dayType: 'workday',
    });
    await owner.db.insert(schema.attendanceCorrection).values({
      tenantId: b.tenantId,
      employmentId: emp,
      attendanceDate: '2026-07-07',
      proposedCheckIn: '09:00:00',
      proposedCheckOut: '18:00:00',
      reason: 'forgot',
      status: 'approved',
      decidedAt: new Date(),
    });
    const r = await importText(adminCtx(b), BUILTIN_MAPPING_ID, 'staff,time\nE300,2026-07-07 07:55\nE300,2026-07-07 20:00');
    expect(r.imported).toBe(0);
    expect((await linesOf(r.runId!)).map((l) => l.result)).toEqual(['day_corrected', 'day_corrected']);
    const day = await dayRow(emp, '2026-07-07');
    expect([day.checkInAt, day.checkOutAt]).toEqual(['09:00:00', '18:00:00']);
  });

  async function onRun(code: string) {
    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: `Run ${code}`, primaryEmail: `run_${randomUUID()}@acme.test` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    await owner.db.update(schema.employment).set({ employeeCode: code }).where(eq(schema.employment.id, e.employmentId));
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    return { emp: e.employmentId, batchId };
  }

  it('a day inside a CLOSED pay run is refused and its lines listed', async () => {
    const { emp, batchId } = await onRun('E301');
    await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));
    const r = await importText(adminCtx(b), BUILTIN_MAPPING_ID, 'staff,time\nE301,2026-07-15 08:00\nE301,2026-07-15 17:00');
    expect(r.imported).toBe(0);
    expect((await linesOf(r.runId!)).map((l) => l.result)).toEqual(['period_closed', 'period_closed']);
    expect(await dayRow(emp, '2026-07-15')).toBeUndefined();
  });

  it('a day inside a PROCESSED pay run is updated and that run is marked as needing recalculation', async () => {
    const { emp, batchId } = await onRun('E302');
    const r = await importText(adminCtx(b), BUILTIN_MAPPING_ID, 'staff,time\nE302,2026-07-16 08:00\nE302,2026-07-16 17:00');
    expect(r.imported).toBe(2);
    expect((await dayRow(emp, '2026-07-16')).checkOutAt).toBe('17:00:00');
    const [run] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(run.needsRecalcAt).not.toBeNull();
    expect(run.recalcEmploymentIds as string[]).toContain(emp);
  });
});

describe('one bad line never stops the others; validate writes nothing (plan items 10-13)', () => {
  it('a mixed file imports the good lines and logs every bad one with its reason', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp({ code: 'E400', card: 'C400' });
    const mappingId = await createClockingMapping(ctx, CODED);
    const text = [
      line('C400', '2026-07-08', '08:15', 'IN'),
      'C400,31,09,2026,08,02,IN', // 31 September
      'C400,08,07,2026,25,10,IN', // 25:10
      line('C400', '2026-07-08', '12:00', 'BRK'),
      line('NOBODY', '2026-07-08', '08:20', 'IN'),
      '',
      line('C400', '2026-07-08', '17:32', 'OUT'),
    ].join('\n');
    const preview = await validateClockingImport(ctx, { mappingId, text });
    expect(preview.counts).toMatchObject({ total: 6, valid: 2, invalidDateTime: 2, unmatchedCard: 1, otherError: 1, duplicate: 0, employees: 1 });
    expect(await dayRow(emp, '2026-07-08')).toBeUndefined(); // Validate wrote nothing
    expect(await owner.db.select().from(schema.clockingImportRun)).toHaveLength(0);

    const r = await importText(ctx, mappingId, text, 'mixed.csv');
    expect(r).toMatchObject({ imported: 2, status: 'completed_with_errors' });
    const lines = await linesOf(r.runId!);
    expect(lines.map((l) => [l.lineNo, l.result])).toEqual([
      [1, 'imported'],
      [2, 'invalid_date'],
      [3, 'invalid_time'],
      [4, 'unknown_in_out_code'],
      [5, 'unmatched_card'],
      [7, 'imported'],
    ]);
    // Raw text only for a line that was not imported; the punch link only for one that was.
    expect(lines.filter((l) => l.result === 'imported').every((l) => l.rawLine === null && l.attendancePunchId)).toBe(true);
    expect(lines.filter((l) => l.result !== 'imported').every((l) => l.rawLine && !l.attendancePunchId)).toBe(true);
    const log = await getClockingImportRun(ctx, r.runId!);
    expect(log!.run).toMatchObject({ totalLines: 6, importedLines: 2, failedLines: 4, daysUpdated: 1, employeesUpdated: 1, mappingName: 'Suprema CSV', fileName: 'mixed.csv' });
    expect(log!.run.failedLines).toBe(log!.run.duplicateLines + log!.run.unmatchedCardLines + log!.run.invalidDatetimeLines + log!.run.otherErrorLines);
  });

  it('a run that throws saves nothing and leaves a Failed log row with the reason', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp({ code: 'E401' });
    // Make every log-line insert fail, while nothing else in the commit path is touched.
    await owner.db.execute(sql`ALTER TABLE clocking_import_line ADD COLUMN forced_failure text NOT NULL`);
    try {
      const r = await importText(ctx, BUILTIN_MAPPING_ID, 'staff,time\nE401,2026-07-09 08:00');
      expect(r.status).toBe('failed');
      expect(r.failureReason).toBeTruthy();
      expect(await dayRow(emp, '2026-07-09')).toBeUndefined();
      const runs = await listClockingImportRuns(ctx);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: r.runId, status: 'failed', importedLines: 0 });
    } finally {
      await owner.db.execute(sql`ALTER TABLE clocking_import_line DROP COLUMN forced_failure`);
    }
  });

  it('an inactive mapping is not offered for import', async () => {
    const ctx = adminCtx(b);
    const id = await createClockingMapping(ctx, CODED);
    await setClockingMappingActive(ctx, id, false);
    await expect(validateClockingImport(ctx, { mappingId: id, text: line('X', '2026-07-01', '08:00', 'IN') })).rejects.toThrow(/mappingInactive/);
  });

  it('an uncoded custom mapping reads the day in time order like the built-in one', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp({ code: 'E402', card: 'C402' });
    const id = await createClockingMapping(ctx, UNCODED);
    const r = await importText(ctx, id, [line('C402', '2026-07-10', '17:00'), line('C402', '2026-07-10', '08:00')].join('\n'));
    expect(r.imported).toBe(2);
    expect((await punchesOf(emp, '2026-07-10')).map((p) => `${p.at}|${p.dir}`)).toEqual(['08:00:00|in', '17:00:00|out']);
  });
});

describe('the mapping library (plan items 1-9, 22)', () => {
  it('refuses to save without the six required fields, naming them', async () => {
    const ctx = adminCtx(b);
    const bad = { ...CODED, fields: { cardId: { column: 1 }, day: { column: 2 } } };
    const err = await createClockingMapping(ctx, bad).catch((e) => e);
    expect(err).toBeInstanceOf(ClockingMappingError);
    expect((err as ClockingMappingError).missing).toEqual(['month', 'year', 'hours', 'minute']);
  });

  it('names are unique, case-insensitively, and the built-in name is taken', async () => {
    const ctx = adminCtx(b);
    await createClockingMapping(ctx, CODED);
    await expect(createClockingMapping(ctx, { ...CODED, name: 'SUPREMA csv' })).rejects.toMatchObject({ code: 'nameTaken' });
    await expect(createClockingMapping(ctx, { ...CODED, name: 'AIHR Standard Template' })).rejects.toMatchObject({ code: 'nameTaken' });
  });

  it('a mapping may be deleted until an import uses it; then only deactivated', async () => {
    const ctx = adminCtx(b);
    const unused = await createClockingMapping(ctx, { ...CODED, name: 'Unused' });
    await deleteClockingMapping(ctx, unused);
    const used = await createClockingMapping(ctx, CODED);
    await makeEmp({ code: 'E500', card: 'C500' });
    await importText(ctx, used, line('C500', '2026-07-11', '08:00', 'IN'));
    await expect(deleteClockingMapping(ctx, used)).rejects.toMatchObject({ code: 'inUse' });
    await setClockingMappingActive(ctx, used, false);
    const [row] = await owner.db.select().from(schema.clockingFileMapping).where(eq(schema.clockingFileMapping.id, used));
    expect(row.active).toBe(false);
  });

  it('the log keeps the mapping as it was on the day, even after it is edited', async () => {
    const ctx = adminCtx(b);
    const id = await createClockingMapping(ctx, CODED);
    await makeEmp({ code: 'E501', card: 'C501' });
    const r = await importText(ctx, id, line('C501', '2026-07-12', '08:00', 'IN'));
    await owner.db.update(schema.clockingFileMapping).set({ name: 'Renamed' }).where(eq(schema.clockingFileMapping.id, id));
    const [run] = await owner.db.select().from(schema.clockingImportRun).where(eq(schema.clockingImportRun.id, r.runId!));
    expect(run.mappingName).toBe('Suprema CSV');
    expect((run.mappingSnapshot as { name: string }).name).toBe('Suprema CSV');
  });
});

describe('RLS: all three tables are tenant-fenced and admin-only', () => {
  it('another tenant sees none of the mappings, runs or lines; a non-admin sees nothing', async () => {
    const ctx = adminCtx(b);
    await createClockingMapping(ctx, CODED);
    await makeEmp({ code: 'E600' });
    await importText(ctx, BUILTIN_MAPPING_ID, 'staff,time\nE600,2026-07-13 08:00\nGHOST,2026-07-13 08:00');
    const counts = (c: SessionContext) =>
      withTenant(c, async (tx) => {
        const one = async (t: string) => Number(((await tx.execute(sql.raw(`select count(*)::int as n from ${t}`))) as unknown as { n: number }[])[0].n);
        return [await one('clocking_file_mapping'), await one('clocking_import_run'), await one('clocking_import_line')];
      });
    expect(await counts(ctx)).toEqual([1, 1, 2]);
    const other = await seedBase();
    expect(await counts(adminCtx(other))).toEqual([0, 0, 0]);
    expect(await counts({ ...adminCtx(b), roles: ['employee'] })).toEqual([0, 0, 0]);
  });
});
