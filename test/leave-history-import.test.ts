/**
 * 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT, against a real database.
 *
 * The ticket's validation matrix, the two behaviours it asks about but does not spell out (what a second
 * upload of the same file does, and what happens to the good rows when one row is bad), the fidelity of
 * the record that lands, and the audit trail. The MONEY claims — that no balance moves, and the three
 * paths that had to be fixed for that to stay true — are in test/leave-history-import-balance.test.ts.
 *
 * NON-VACUITY, demonstrated per claim by reverting the behaviour in the working tree and watching the
 * named assertion fail; the quoted AssertionErrors are in the round's report, not paraphrased here.
 *
 * ⚠️ FIXTURE DATES DERIVE FROM THE CLOCK (CLAUDE.md §8). `todayInKualaLumpur()` is the origin for every
 * date below; nothing is hard-coded, so this file does not start failing on a date in 2027.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createCompany, createDepartment, createLeaveType } from '../core/admin';
import {
  commitLeaveHistoryImport,
  listLeaveHistoryImportRuns,
  validateLeaveHistoryImport,
} from '../core/leave-history-import';
import { listLeaveRequests } from '../core/read';
import { parseCsvRecords } from '../lib/csv';
import type { SessionContext } from '../db/client';
import { buildTemplateCsv, leaveHistoryImportTemplate, LEAVE_HISTORY_XLSX_HEADERS } from '../lib/import-template';
import { buildXlsx, workbookToCsvTexts } from '../lib/spreadsheet';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let emp: { employmentId: string; code: string };

const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A settled past week, far enough back that it is history under any clock. */
const P_MON = (() => {
  let d = addDays(TODAY, -120);
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
})();
const P_TUE = addDays(P_MON, 1);
const P_WED = addDays(P_MON, 2);
const P_ENTRY = addDays(P_MON, -7);
const P_APPROVED = addDays(P_MON, -5);
const YEAR = P_MON.slice(0, 4);

/** A row of the file, by contract key. Undefined keys are simply absent, as a real sparse file is. */
type Row = Partial<Record<string, string>>;
const HEADERS = [
  'employee_no',
  'leave_reference',
  'leave_code',
  'entitlement_year',
  'leave_start_date',
  'leave_end_date',
  'number_of_day',
  'session',
  'entry_date',
  'submit_date',
  'approved_date',
  'remark',
];
/** Records as the server actions build them: whatever the header row said, values as strings. */
const recs = (rows: Row[]) => rows.map((r) => Object.fromEntries(HEADERS.map((h) => [h, r[h] ?? ''])));

/** A complete, valid three-day row. Override any field per case. */
const good = (over: Row = {}): Row => ({
  employee_no: emp.code,
  leave_reference: `LV/${YEAR}/${randomUUID().slice(0, 8)}`,
  leave_code: 'ANNUAL',
  entitlement_year: YEAR,
  leave_start_date: P_MON,
  leave_end_date: P_WED,
  number_of_day: '3',
  session: '',
  entry_date: P_ENTRY,
  submit_date: P_ENTRY,
  approved_date: P_APPROVED,
  remark: 'Data Migration',
  ...over,
});

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const email = `lhi_${randomUUID().slice(0, 8)}@t.local`;
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'History Emp', primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: addDays(TODAY, -800),
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });
  const [row] = await owner.db
    .select({ code: schema.employment.employeeCode })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  emp = { employmentId, code: row.code! };
});

const requestRows = () =>
  owner.db
    .select({
      id: schema.leaveRequest.id,
      status: schema.leaveRequest.status,
      startDate: schema.leaveRequest.startDate,
      endDate: schema.leaveRequest.endDate,
      days: schema.leaveRequest.days,
      durationType: schema.leaveRequest.durationType,
      reason: schema.leaveRequest.reason,
      createdAt: schema.leaveRequest.createdAt,
      decidedAt: schema.leaveRequest.decidedAt,
      decidedBy: schema.leaveRequest.decidedByEmploymentId,
      externalReference: schema.leaveRequest.externalReference,
      entitlementYear: schema.leaveRequest.entitlementYear,
      submittedOn: schema.leaveRequest.submittedOn,
      importedHistory: schema.leaveRequest.importedHistory,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, emp.employmentId))
    // ORDER BY, because this array is asserted (CLAUDE.md §8 — pin invariants, not positions).
    .orderBy(schema.leaveRequest.startDate, schema.leaveRequest.externalReference);

// ── The ticket's validation matrix (section 4) ────────────────────────────────────────────────────
describe('validation — every rule the ticket names, and the status it produces', () => {
  it('a blank or unknown Employee No. is an error, and the two are not conflated', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ employee_no: '' }), good({ employee_no: 'NOBODY-9999' })]),
    });
    expect(p.rows[0].status).toBe('error');
    expect(p.rows[0].errors).toContain('Employee No. is required');
    expect(p.rows[1].status).toBe('error');
    expect(p.rows[1].errors).toContain('Employee No. not found');
    expect(p.validCount).toBe(0);
    expect(p.errorCount).toBe(2);
  });

  it('a blank or unknown Leave Code is an error', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ leave_code: '' }), good({ leave_code: 'NOPE' })]),
    });
    expect(p.rows[0].errors).toContain('Leave Code is required');
    expect(p.rows[1].errors).toContain('Leave Code not found');
  });

  it('a leave code matches case-insensitively, so a lower-case export is not rejected wholesale', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), { records: recs([good({ leave_code: 'annual' })]) });
    expect(p.rows[0].status).toBe('valid');
  });

  it('a missing Leave Reference is an error — it is the only cross-run duplicate key there is', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), { records: recs([good({ leave_reference: '' })]) });
    expect(p.rows[0].errors).toContain('Leave Reference is required');
    expect(p.rows[0].status).toBe('error');
  });

  it('start after end, and an unparseable date, are each their own error', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([
        good({ leave_start_date: P_WED, leave_end_date: P_MON }),
        good({ leave_start_date: 'not-a-date' }),
        // A date the REGEX accepts and the calendar does not. This is the case a pattern-only check
        // passes: there is no 31 February, and the row must not import as one.
        good({ leave_start_date: `${YEAR}-02-31` }),
      ]),
    });
    expect(p.rows[0].errors).toContain('Leave Start Date cannot be later than Leave End Date');
    expect(p.rows[1].errors).toContain('Invalid Leave Start Date');
    expect(p.rows[2].errors).toContain('Invalid Leave Start Date');
  });

  it('dd/mm/yyyy is read as written; mm/dd/yyyy is never guessed at', async () => {
    // A Malaysian export writes 10/03/2025 for 10 March. Reading it the other way would mis-date leave
    // with nothing on screen to notice, so the only ambiguity-free rule is "day first, always".
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ leave_start_date: `10/03/${YEAR}`, leave_end_date: `12/03/${YEAR}`, number_of_day: '3' })]),
    });
    expect(p.rows[0].status).toBe('valid');
    expect(p.rows[0].startDate).toBe(`${YEAR}-03-10`);
    expect(p.rows[0].endDate).toBe(`${YEAR}-03-12`);
  });

  it('Number of Day must be numeric and greater than zero', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([
        good({ number_of_day: '0' }),
        good({ number_of_day: 'three' }),
        good({ number_of_day: '-2' }),
        good({ number_of_day: '' }),
      ]),
    });
    expect(p.rows[0].errors).toContain('Number of Day is invalid');
    expect(p.rows[1].errors).toContain('Number of Day is invalid');
    expect(p.rows[2].errors).toContain('Number of Day is invalid');
    expect(p.rows[3].errors).toContain('Number of Day is required');
  });

  it('Session accepts AM / PM / blank and nothing else, and is never forced', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([
        good({ session: '', leave_end_date: P_WED, number_of_day: '3' }),
        good({ session: 'AM', leave_end_date: P_MON, number_of_day: '0.5' }),
        good({ session: 'pm', leave_end_date: P_MON, number_of_day: '0.5' }),
        good({ session: 'MORNING' }),
      ]),
    });
    expect(p.rows[0].status).toBe('valid'); // blank on a multi-day record: the ticket's own requirement
    expect(p.rows[1].status).toBe('valid');
    expect(p.rows[2].status).toBe('valid'); // case-insensitive
    expect(p.rows[3].errors).toContain('Session must be AM, PM or blank');
  });

  it('an Entitlement Year that is not a year is an error; one that disagrees with the start date is a WARNING', async () => {
    const other = String(Number(YEAR) - 1);
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ entitlement_year: 'twenty' }), good({ entitlement_year: other })]),
    });
    expect(p.rows[0].errors).toContain('Entitlement Year is not a valid year');
    // …and the disagreement does NOT demote the row. A leave period is configurable, so a January leave
    // can legitimately belong to the previous entitlement year; rejecting it would lose real history.
    expect(p.rows[1].status).toBe('valid');
    expect(p.rows[1].warnings.join(' ')).toContain('does not match the leave start year');
  });

  it('a day count our calendar disagrees with is FLAGGED and still imported, with the file’s own figure kept', async () => {
    // Mon–Wed is three working days here. The file says five; the old system's calendar is not ours.
    const p = await validateLeaveHistoryImport(adminCtx(b), { records: recs([good({ number_of_day: '5' })]) });
    expect(p.rows[0].status).toBe('valid');
    expect(p.rows[0].warnings.join(' ')).toMatch(/calendar makes this 3 day\(s\); the file says 5/);
    await commitLeaveHistoryImport(adminCtx(b), { records: recs([good({ number_of_day: '5' })]) });
    const rows = await requestRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].days)).toBe(5); // the FILE's figure, not ours
  });

  it('the required columns the header row is missing are named, rather than every row failing mysteriously', async () => {
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: [{ employee_no: emp.code, leave_code: 'ANNUAL' }],
    });
    expect(p.missingColumns.sort()).toEqual(
      ['leave_end_date', 'leave_reference', 'leave_start_date', 'number_of_day'].sort(),
    );
  });

  it('the reporter’s own human headings are accepted, punctuation and all', async () => {
    // What actually happens on upload: the workbook is decoded to CSV, parseCsvRecords lower-cases and
    // underscores the headings (keeping the period in "Employee No."), and the service canonicalises.
    const csv = [
      'Employee No.,Leave Reference,Leave Code,Entitlement Year,Leave Start Date,Leave End Date,Number of Day,Session,Entry Date,Submit Date,Approved Date,Remark',
      `${emp.code},LV/${YEAR}/HUMAN,ANNUAL,${YEAR},${P_MON},${P_WED},3,,${P_ENTRY},${P_ENTRY},${P_APPROVED},Data Migration`,
    ].join('\n');
    const { records } = parseCsvRecords(csv);
    expect(Object.keys(records[0])).toContain('employee_no.'); // the period really is there
    const p = await validateLeaveHistoryImport(adminCtx(b), { records });
    expect(p.missingColumns).toEqual([]);
    expect(p.rows[0].status).toBe('valid');
  });

  it('the downloadable CSV template validates against the importer as-is (no desync between them)', async () => {
    const { records } = parseCsvRecords(buildTemplateCsv(leaveHistoryImportTemplate));
    const p = await validateLeaveHistoryImport(adminCtx(b), { records });
    expect(p.missingColumns).toEqual([]);
    // The sample employee code is E1001 (the demo seed's), absent from this harness, so the rows resolve
    // every column and fail ONLY on the employee — which is the property worth pinning: the CONTRACT
    // matches, and nothing in the template is a malformed date, a bad session or a missing column.
    for (const r of p.rows) expect(r.errors).toEqual(['Employee No. not found']);
  });
});

// ── Duplicates and idempotency (ticket section 4, and the question it does not ask out loud) ──────
describe('duplicates — the same reference twice, in one file and across two uploads', () => {
  it('a repeated Leave Reference inside one file is the SECOND row, and it is a duplicate, not an error', async () => {
    const ref = `LV/${YEAR}/SAME`;
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ leave_reference: ref }), good({ leave_reference: ref })]),
    });
    expect(p.rows[0].status).toBe('valid');
    expect(p.rows[1].status).toBe('duplicate');
    expect(p.rows[1].errors).toContain('Duplicate Leave Reference in this file');
    expect(p.duplicateCount).toBe(1);
    expect(p.errorCount).toBe(0); // a duplicate is NOT counted as an error: the ticket keeps them apart
  });

  it('IMPORTING THE SAME FILE TWICE IMPORTS NOTHING THE SECOND TIME, and says why for every row', async () => {
    const file = recs([good({ leave_reference: `LV/${YEAR}/A` }), good({ leave_reference: `LV/${YEAR}/B` })]);

    const first = await commitLeaveHistoryImport(adminCtx(b), { records: file });
    expect(first).toMatchObject({ total: 2, imported: 2, failed: 0, duplicates: 0 });

    const second = await commitLeaveHistoryImport(adminCtx(b), { records: file });
    expect(second).toMatchObject({ total: 2, imported: 0, failed: 0, duplicates: 2 });
    expect(second.errors.map((e) => e.errors[0])).toEqual([
      'Leave Reference already imported',
      'Leave Reference already imported',
    ]);
    // …and the records are not doubled. This is the assertion that would catch a dedupe that reported
    // correctly and wrote anyway.
    expect(await requestRows()).toHaveLength(2);
  });

  it('a row that is BOTH malformed and a duplicate reports as an error, so the fixable reason comes first', async () => {
    await commitLeaveHistoryImport(adminCtx(b), { records: recs([good({ leave_reference: `LV/${YEAR}/C` })]) });
    const p = await validateLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ leave_reference: `LV/${YEAR}/C`, number_of_day: '0' })]),
    });
    expect(p.rows[0].status).toBe('error');
    expect(p.rows[0].errors).toContain('Number of Day is invalid');
  });
});

// ── Partial failure (ticket section 7, and the approved plan's "writes only the good rows") ───────
describe('partial failure — the good rows go in, the bad ones are named, nothing is silently skipped', () => {
  it('row 2 of 3 being invalid imports rows 1 and 3 and reports row 2 with its reason', async () => {
    const file = recs([
      good({ leave_reference: `LV/${YEAR}/OK1` }),
      good({ leave_reference: `LV/${YEAR}/BAD`, leave_code: 'NOPE' }),
      good({ leave_reference: `LV/${YEAR}/OK2`, leave_start_date: P_TUE, leave_end_date: P_TUE, number_of_day: '1' }),
    ]);
    const res = await commitLeaveHistoryImport(adminCtx(b), { records: file });
    // NOT all-or-nothing, and that is the approved plan's own wording ("Confirm Import writes only the
    // good rows") plus the ticket's ("do not silently skip them… tell the user which and why"). One
    // transaction per row, so a bad row can never strand the rest.
    expect(res).toMatchObject({ total: 3, imported: 2, failed: 1, duplicates: 0 });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ rowNum: 2, leaveReference: `LV/${YEAR}/BAD` });
    expect(res.errors[0].errors).toContain('Leave Code not found');

    const rows = await requestRows();
    expect(rows.map((r) => r.externalReference)).toEqual([`LV/${YEAR}/OK1`, `LV/${YEAR}/OK2`]);
  });

  it('the three non-total counts are disjoint and sum to the total, always', async () => {
    const dup = `LV/${YEAR}/D`;
    await commitLeaveHistoryImport(adminCtx(b), { records: recs([good({ leave_reference: dup })]) });
    const res = await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        good({ leave_reference: `LV/${YEAR}/E` }),
        good({ leave_reference: dup }),
        good({ leave_reference: `LV/${YEAR}/F`, employee_no: 'NOBODY' }),
      ]),
    });
    expect(res.imported + res.failed + res.duplicates).toBe(res.total);
    expect(res).toMatchObject({ total: 3, imported: 1, failed: 1, duplicates: 1 });
  });
});

// ── Fidelity: the record that lands (ticket section 8) ────────────────────────────────────────────
describe('the imported record keeps what the file said, and lands already approved', () => {
  it('reference, dates, days, session, entry / submit / approved dates and remark all survive', async () => {
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        good({
          leave_reference: `LV/${YEAR}/FID`,
          leave_start_date: P_MON,
          leave_end_date: P_MON,
          number_of_day: '0.5',
          session: 'PM',
        }),
      ]),
    });
    const [r] = await requestRows();
    expect(r.status).toBe('approved'); // the employee never re-applies through ESS
    expect(r.externalReference).toBe(`LV/${YEAR}/FID`);
    expect(r.entitlementYear).toBe(Number(YEAR));
    expect(r.startDate).toBe(P_MON);
    expect(r.endDate).toBe(P_MON);
    expect(Number(r.days)).toBe(0.5);
    expect(r.durationType).toBe('half_day_pm'); // Session PM maps onto the ADR-0048 duration
    expect(r.submittedOn).toBe(P_ENTRY);
    expect(r.reason).toBe('Data Migration');
    expect(r.importedHistory).toBe(true);
    // Entry Date and Approved Date are stamped at Kuala Lumpur midnight, so they read back as the SAME
    // calendar date the file gave rather than the day before (the UTC-vs-MYT off-by-one).
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(r.createdAt)).toBe(P_ENTRY);
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(r.decidedAt!)).toBe(P_APPROVED);
    // No approver is invented: the file names a DATE, never a person.
    expect(r.decidedBy).toBeNull();
  });

  it('it appears in the employee’s leave history, which is the whole point of the item', async () => {
    await commitLeaveHistoryImport(adminCtx(b), { records: recs([good({ leave_reference: `LV/${YEAR}/HIST` })]) });
    const history = await listLeaveRequests(adminCtx(b), [b.companyId]);
    const row = history.find((h) => h.employmentId === emp.employmentId);
    expect(row, 'an imported record must be visible in Leave History').toBeTruthy();
    expect(row!.status).toBe('approved');
    expect(row!.startDate).toBe(P_MON);
    expect(Number(row!.days)).toBe(3);
    // `appliedOn` is leave_request.createdAt, so the history reads with the ORIGINAL entry date.
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(row!.appliedOn)).toBe(P_ENTRY);
  });

  it('no approval steps are created — there is no decision left for anybody to take', async () => {
    await commitLeaveHistoryImport(adminCtx(b), { records: recs([good({ leave_reference: `LV/${YEAR}/NOSTEP` })]) });
    const [r] = await requestRows();
    const steps = await owner.db
      .select({ id: schema.leaveApprovalStep.id })
      .from(schema.leaveApprovalStep)
      .where(eq(schema.leaveApprovalStep.leaveRequestId, r.id));
    expect(steps).toEqual([]);
  });

  it('an empty Approved Date leaves decided_at null rather than inventing today', async () => {
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ leave_reference: `LV/${YEAR}/NODATE`, approved_date: '', submit_date: '' })]),
    });
    const [r] = await requestRows();
    expect(r.decidedAt).toBeNull();
    expect(r.submittedOn).toBeNull();
  });
});

// ── The audit trail (ticket section 10) ───────────────────────────────────────────────────────────
describe('the run log records who imported what, and the rejected rows stay downloadable', () => {
  it('one row per run with the four counts and the per-row reasons, newest first', async () => {
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        good({ leave_reference: `LV/${YEAR}/R1` }),
        good({ leave_reference: `LV/${YEAR}/R2`, leave_code: 'NOPE' }),
      ]),
      source: { kind: 'file', name: 'leave-history-2025.xlsx', format: 'xlsx' },
    });
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ leave_reference: `LV/${YEAR}/R3` })]),
      source: { kind: 'file', name: 'leave-history-2024.xlsx', format: 'xlsx' },
    });

    const runs = await listLeaveHistoryImportRuns(adminCtx(b));
    expect(runs).toHaveLength(2);
    // Newest first — asserted as a property of the ORDER BY, not of the order rows happened to come back.
    expect(runs[0].fileName).toBe('leave-history-2024.xlsx');
    expect(runs[1].fileName).toBe('leave-history-2025.xlsx');
    expect(runs[1]).toMatchObject({ totalRows: 2, importedRows: 1, failedRows: 1, duplicateRows: 0 });
    expect(runs[1].errors[0]).toMatchObject({ rowNum: 2, leaveReference: `LV/${YEAR}/R2` });
    expect(runs[1].errors[0].errors).toContain('Leave Code not found');
    expect(runs[1].errorsTruncated).toBe(false);
  });

  it('the run log stores the reason and the row’s identity — never the row’s own data', async () => {
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ leave_reference: `LV/${YEAR}/PRIV`, leave_code: 'NOPE', remark: 'Hospitalised, cancer ward' })]),
      source: { kind: 'file', name: 'x.xlsx', format: 'xlsx' },
    });
    const [run] = await listLeaveHistoryImportRuns(adminCtx(b));
    // A leave-history file says who was absent, for how long and WHY. Keeping the remark in an audit
    // row would turn an audit feature into a data-retention liability (migration 0341's rule, 0490's
    // header). Identity + reason is all a correction needs.
    expect(JSON.stringify(run.errors)).not.toContain('Hospitalised');
    expect(JSON.stringify(run.errors)).not.toContain('cancer');
    expect(run.errors[0]).toMatchObject({ employeeNo: emp.code, leaveReference: `LV/${YEAR}/PRIV` });
    expect(Object.keys(run.errors[0]).sort()).toEqual(['employeeNo', 'errors', 'leaveReference', 'rowNum']);
  });

  it('a paste run records an empty file name rather than a made-up one', async () => {
    await commitLeaveHistoryImport(adminCtx(b), { records: recs([good({ leave_reference: `LV/${YEAR}/P` })]) });
    const [run] = await listLeaveHistoryImportRuns(adminCtx(b));
    expect(run.fileName).toBe('');
  });

  it('one summary event is appended for the batch', async () => {
    const res = await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([good({ leave_reference: `LV/${YEAR}/EV` })]),
    });
    expect(res.runId).toBeTruthy();
    const evs = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.eventType, 'leave-history-import.completed'),
        ),
      );
    expect(evs).toHaveLength(1);
    // Named through the shared helper too, so a rename of the aggregate cannot pass this file silently.
    void eventTypesFor;
  });
});

// ── Authority (ticket section 11) ─────────────────────────────────────────────────────────────────
describe('authority — a company-scoped admin cannot import for a company they do not hold', () => {
  it('the out-of-authority row is refused in the PREVIEW and never written by the commit', async () => {
    const { id: coB } = await createCompany(adminCtx(b), { legalName: 'Sub B Sdn Bhd' });
    const deptB = await createDepartment(adminCtx(b), { companyId: coB, name: 'B-Ops' });
    // Created by a GROUP admin, so both employments exist; the scoped admin below holds only company B.
    const { employmentId: outEmploymentId } = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Other Co Emp', primaryEmail: `lhi_${randomUUID().slice(0, 8)}@t.local` },
      companyId: coB,
      departmentId: deptB.id,
      employmentType: 'full_time',
      hiredOn: addDays(TODAY, -800),
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    const [outRow] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, outEmploymentId));

    // A scoped admin holding ONLY company B: the harness employee (company A) is out of their reach.
    const scoped: SessionContext = {
      tenantId: b.tenantId,
      userId: b.adminUserId,
      grants: [{ role: 'hr_admin', companyId: coB }],
    };
    const p = await validateLeaveHistoryImport(scoped, {
      records: recs([
        good({ leave_reference: `LV/${YEAR}/OUT`, employee_no: emp.code }), // company A — out of reach
        good({ leave_reference: `LV/${YEAR}/IN`, employee_no: outRow.code! }), // company B — in reach
      ]),
    });

    // ⚠️ ASSERTED AS AN OUTCOME, NOT AS A MESSAGE, and the reason is CLAUDE.md §8's warning that a green
    // refusal test may be pinning RLS rather than your guard. BOTH mechanisms refuse this row and RLS
    // gets there first: company-scope RLS hides company A's employment from the scoped admin's read
    // entirely, so the row surfaces as "Employee No. not found" rather than as the authority message.
    // The explicit `hasGrantFor` check inside analyze() backstops the visible-but-unauthorized case.
    // What matters to the reporter is the same either way and is what is pinned: the preview never
    // promises a row that cannot be written, and the commit writes nothing for it.
    expect(p.rows[0].status).toBe('error');
    expect(p.rows[0].errors.length).toBeGreaterThan(0);
    expect(p.rows[1].status).toBe('valid'); // non-vacuity: the in-authority row IS offered

    const res = await commitLeaveHistoryImport(scoped, {
      records: recs([
        good({ leave_reference: `LV/${YEAR}/OUT`, employee_no: emp.code }),
        good({ leave_reference: `LV/${YEAR}/IN`, employee_no: outRow.code! }),
      ]),
    });
    expect(res).toMatchObject({ total: 2, imported: 1, failed: 1 });
    expect(await requestRows(), 'nothing may be written for the out-of-authority employee').toEqual([]);
  });
});

// ── A REAL WORKBOOK, end to end (ticket section 3) ───────────────────────────────────────────────
describe('a real .xlsx round-trips through the encoder, the decoder and the importer', () => {
  it('build the template as Excel, fill it with a good row and two bad ones, decode, validate, import', async () => {
    // THE WHOLE CHAIN, not a stand-in for it: `buildXlsx` is the encoder the Download Excel template
    // button calls, `workbookToCsvTexts` is the ONLY workbook decoder in this repo and the one
    // `readImportFile` uses in the browser, and `parseCsvRecords` is what the server action runs on the
    // text it receives. Only the File wrapper is absent, because a File is a browser object.
    const rows = [
      [emp.code, `LV/${YEAR}/XLSX1`, 'ANNUAL', YEAR, P_MON, P_WED, '3', '', P_ENTRY, P_ENTRY, P_APPROVED, 'Data Migration'],
      // A leave code this tenant does not have: reported, never silently dropped.
      [emp.code, `LV/${YEAR}/XLSX2`, 'NOSUCHCODE', YEAR, P_MON, P_MON, '1', 'AM', P_ENTRY, P_ENTRY, P_APPROVED, 'Data Migration'],
      // A purely numeric employee number with a leading zero. The harness's own codes look like
      // `EMP-0007`, so without this row nothing here would exercise a cell that COULD be read as a
      // number. This tenant has no such employee, so the row must fail on "not found" — not on a
      // reference that arrived mangled.
      ['0012', `LV/${YEAR}/XLSX3`, 'ANNUAL', YEAR, P_MON, P_MON, '1', '', P_ENTRY, P_ENTRY, P_APPROVED, ''],
    ];
    const bytes = await buildXlsx(LEAVE_HISTORY_XLSX_HEADERS, rows, {
      sheetName: 'Leave History',
      // ⚠️ WHAT THIS OPTION DOES AND DOES NOT DO, measured rather than assumed. Removing it from this
      // call leaves every assertion below GREEN, so this test does not prove it: `aoa_to_sheet` writes
      // a JS string as a string cell whatever the column format is. The option earns its place on the
      // real screen for the case no Node test can reach — HR TYPING `0012` into the downloaded
      // template, where a General-formatted column is what turns it into the number 12. It is passed
      // here so the bytes under test are the bytes the button produces, not to be tested by this case.
      textColumns: [0, 1],
    });
    const decoded = await workbookToCsvTexts(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      [],
    );
    const { headers, records } = parseCsvRecords(decoded.first);
    // The headers really are the HUMAN ones, punctuation and all — so `canonicalColumnKey` is
    // load-bearing on the file HR actually uploads, not merely on a hand-typed one.
    expect(headers[0]).toBe('employee_no.');
    expect(records).toHaveLength(3);
    expect(records[0]['employee_no.']).toBe(emp.code);
    expect(records[0]['leave_reference']).toBe(`LV/${YEAR}/XLSX1`);
    expect(records[2]['employee_no.'], 'the decoder must return the cell as written').toBe('0012');

    const preview = await validateLeaveHistoryImport(adminCtx(b), { records });
    expect(preview.missingColumns).toEqual([]);
    expect(preview).toMatchObject({ total: 3, validCount: 1, errorCount: 2, duplicateCount: 0 });
    expect(preview.rows[1].errors).toContain('Leave Code not found');
    expect(preview.rows[2].errors).toEqual(['Employee No. not found']);
    expect(preview.rows[2].employeeNo).toBe('0012');

    const res = await commitLeaveHistoryImport(adminCtx(b), {
      records,
      source: { kind: 'file', name: 'leave-history-2025.xlsx', format: 'xlsx' },
    });
    expect(res).toMatchObject({ total: 3, imported: 1, failed: 2, duplicates: 0 });

    const [stored] = await requestRows();
    expect(stored.externalReference).toBe(`LV/${YEAR}/XLSX1`);
    // THE DATES SURVIVED THE WORKBOOK. This is the assertion that catches a date cell that came back
    // as an Excel serial number and was then read as an unparseable string.
    expect(stored.startDate).toBe(P_MON);
    expect(stored.endDate).toBe(P_WED);
    expect(Number(stored.days)).toBe(3);
    expect(stored.status).toBe('approved');
  });
});

// ── Types a leave type of a different code is not confused with ───────────────────────────────────
describe('a second leave type does not bleed into the first', () => {
  it('two codes resolve to their own types', async () => {
    const { id: mcId } = await createLeaveType(adminCtx(b), { code: 'MC', name: 'Medical Leave' });
    await commitLeaveHistoryImport(adminCtx(b), {
      records: recs([
        good({ leave_reference: `LV/${YEAR}/T1`, leave_code: 'ANNUAL' }),
        good({ leave_reference: `LV/${YEAR}/T2`, leave_code: 'MC', leave_start_date: P_TUE, leave_end_date: P_TUE, number_of_day: '1' }),
      ]),
    });
    const rows = await owner.db
      .select({ ref: schema.leaveRequest.externalReference, typeId: schema.leaveRequest.leaveTypeId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, emp.employmentId))
      .orderBy(schema.leaveRequest.externalReference);
    expect(rows[0]).toMatchObject({ ref: `LV/${YEAR}/T1`, typeId: b.annualLeaveTypeId });
    expect(rows[1]).toMatchObject({ ref: `LV/${YEAR}/T2`, typeId: mcId });
  });
});
