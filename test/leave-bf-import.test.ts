/**
 * db55d08a (r369) — LEAVE B/F DATA IMPORT, against a real database.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ THE FIRST DESCRIBE BLOCK IS THE REASON THIS SCREEN EXISTS. READ IT BEFORE CHANGING ANYTHING.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `yearOpenMarkerCond` (core/leave.ts) is `entry_type = 'accrual' AND effective_on inside the leave year`.
 * A brought-forward figure is dated in the PREVIOUS leave year, so an imported row written as an ACCRUAL
 * would put that (employment, leave type) into `openLeaveYear`'s `openedSet` for THAT year — and Generate
 * Entitlement would then grant the employee NOTHING for it, silently, with no error anywhere. The employee
 * ends up with the imported days where they should have had a full annual allowance.
 *
 * It reaches money: an Annual Leave balance is encashed at resignation (core/leave-encashment.ts), so a
 * cancelled year becomes a wrong final payment.
 *
 * SO THE IMPORTER WRITES `adjustment` AND NEVER `accrual`, and this file pins that in TWO ways, because
 * either alone would pass a broken service:
 *
 *   1. the committed row's own `entry_type`, read back out of the database;
 *   2. `openLeaveYear` for the year the row is dated in does NOT report the pair `already_open` — with a
 *      CONTROL case that inserts a hand-made accrual at the same date and shows the outcome DOES flip to
 *      `already_open`. Without the control, (2) would pass just as happily if `openLeaveYear` never
 *      reached the pair at all.
 *
 * ⚠️ FIXTURE DATES DERIVE FROM THE CLOCK (CLAUDE.md §8). `todayInKualaLumpur()` is the origin for every
 * date below; nothing is hard-coded, so this file does not start failing on a date in 2027.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createLeaveType } from '../core/admin';
import {
  LEAVE_BF_ENTRY_TYPE,
  LEAVE_BF_REASON_DEFAULT,
  LEAVE_BF_REVERSAL_REASON_PREFIX,
  commitLeaveBfImport,
  listLeaveBfImportRuns,
  reverseLeaveBfImportRun,
  validateLeaveBfImport,
} from '../core/leave-bf-import';
import { openLeaveYear } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
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
/**
 * The leave year the figures are carried INTO. Derived from the clock and deliberately the year AFTER
 * this one, so the prior year (where the ledger row lands) is a settled, complete year under any clock.
 */
const TARGET_YEAR = Number(TODAY.slice(0, 4)) + 1;
/** Calendar cycle ⇒ the year opens 1 January ⇒ the figure is dated 31 December of the year before. */
const EXPECTED_EFFECTIVE_ON = `${TARGET_YEAR - 1}-12-31`;
const PRIOR_YEAR = TARGET_YEAR - 1;

/** A row of the file, by contract key. */
type Row = Partial<Record<string, string>>;
const HEADERS = ['employee_id', 'leave_code', 'entitlement_year', 'bf_days', 'remark'];
/** Records as the server action builds them: whatever the header row said, values as strings. */
const recs = (rows: Row[]) => rows.map((r) => Object.fromEntries(HEADERS.map((h) => [h, r[h] ?? ''])));

/** A complete, valid line. Override any field per case. */
const good = (over: Row = {}): Row => ({
  employee_id: emp.code,
  leave_code: 'ANNUAL',
  entitlement_year: String(TARGET_YEAR),
  bf_days: '3.5',
  remark: 'Data Migration',
  ...over,
});

/**
 * Every ledger row for the fixture employee, with an explicit ORDER BY so an asserted array is a fact
 * (CLAUDE.md §8).
 *
 * ⚠️ THE ORDER IS NOT TOTAL, AND THE CASES BELOW DO NOT PRETEND IT IS. `created_at` defaults to `now()`,
 * which in Postgres is the TRANSACTION's start time, so the two rows a Replace line writes inside ONE
 * transaction share it — and the remaining tiebreak is a random uuid. Where two rows are written together,
 * the cases assert the MULTISET and the resulting figure rather than a sequence, because a sequence there
 * would be a position, not an invariant.
 */
async function ledgerRows(leaveTypeId = b.annualLeaveTypeId) {
  return owner.db
    .select({
      entryType: schema.leaveLedger.entryType,
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
      reason: schema.leaveLedger.reason,
      runId: schema.leaveLedger.bfImportRunId,
      sourceRequestId: schema.leaveLedger.sourceRequestId,
    })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, emp.employmentId),
        eq(schema.leaveLedger.leaveTypeId, leaveTypeId),
      ),
    )
    .orderBy(schema.leaveLedger.effectiveOn, schema.leaveLedger.createdAt, schema.leaveLedger.id);
}

/** Turn the carry rule ON for a leave type — the WRITE path's predicate needs it (`carryEnabled`). */
async function setCarry(
  leaveTypeId: string,
  p: { max?: number | null; percent?: number | null; enabled?: boolean | null },
) {
  await owner.db
    .update(schema.leaveType)
    .set({
      carryForwardMax: p.max == null ? null : String(p.max),
      carryForwardPercent: p.percent == null ? null : String(p.percent),
      carryForwardEnabled: p.enabled ?? null,
    })
    .where(eq(schema.leaveType.id, leaveTypeId));
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const email = `bfi_${randomUUID().slice(0, 8)}@t.local`;
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'BF Emp', primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    // Hired long enough ago that every leave year in these cases is one the employee was present for.
    hiredOn: addDays(TODAY, -1200),
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });
  const [row] = await owner.db
    .select({ code: schema.employment.employeeCode })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  emp = { employmentId, code: row.code! };
  // The seeded ANNUAL type carries nothing by default, and `carryEnabled` is the WRITE path's predicate,
  // so without this every line would be refused "Carry forward is not enabled". Generous cap; the cases
  // that test the cap set their own.
  await setCarry(b.annualLeaveTypeId, { max: 30, enabled: true });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — THE LEDGER ROW IS AN ADJUSTMENT AND NEVER AN ACCRUAL', () => {
  it('the committed row carries entry_type = adjustment, no source request, and the file’s remark', async () => {
    const r = await commitLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    expect(r.imported).toBe(1);
    expect(r.failed).toBe(0);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    // ⚠️ THE LOAD-BEARING ASSERTION. 'accrual' here is the defect: see this file's header.
    expect(rows[0].entryType).toBe('adjustment');
    expect(rows[0].entryType).toBe(LEAVE_BF_ENTRY_TYPE);
    expect(Number(rows[0].days)).toBe(3.5);
    // Dated the day BEFORE the leave year opens, so `priorBalance` sees it as brought forward.
    expect(rows[0].effectiveOn).toBe(EXPECTED_EFFECTIVE_ON);
    // A HUMAN reason, so `classifyLedgerAdjustment` keeps it in the 'config' class rather than treating it
    // as a machine correction the forfeit/recalc sweeps hunt for.
    expect(rows[0].reason).toBe('Data Migration');
    expect(rows[0].reason?.startsWith('sys:')).toBe(false);
    // No leave record, so nothing to source it to.
    expect(rows[0].sourceRequestId).toBeNull();
    expect(rows[0].runId).toBe(r.runId);
  });

  it('a blank Remark falls back to the default human reason, never to null and never to a sys: code', async () => {
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ remark: '' })]) });
    const rows = await ledgerRows();
    expect(rows[0].reason).toBe(LEAVE_BF_REASON_DEFAULT);
    expect(LEAVE_BF_REASON_DEFAULT.startsWith('sys:')).toBe(false);
  });

  it('creates NO leave record — nothing appears in anybody’s leave history', async () => {
    await commitLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    // Read as the OWNER rather than through a read helper: the claim is that the TABLE is untouched, and a
    // read helper that filtered the row out for some other reason would make this pass vacuously.
    const requests = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, emp.employmentId));
    expect(requests).toEqual([]);
  });

  /**
   * ⚠️ THE ASSERTION THAT PROVES THE ENTRY TYPE MATTERS, rather than merely restating the constant.
   *
   * The row lands on 31 December of the PRIOR leave year, so it is the PRIOR year `openLeaveYear` would
   * mistake for already-opened. Reverting `LEAVE_BF_ENTRY_TYPE` to 'accrual' makes this case report
   * `already_open` and the whole of that year's entitlement is silently skipped.
   */
  it('openLeaveYear does not treat the imported figure as the prior year’s open marker', async () => {
    await commitLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    const run = await openLeaveYear(adminCtx(b), {
      year: PRIOR_YEAR,
      employmentIds: [emp.employmentId],
      leaveTypeIds: [b.annualLeaveTypeId],
      dryRun: true,
    });
    const row = run.rows.find(
      (x) => x.employmentId === emp.employmentId && x.leaveTypeId === b.annualLeaveTypeId,
    );
    expect(row, 'openLeaveYear must reach this pair at all, or the next assertion proves nothing').toBeDefined();
    expect(row!.outcome).not.toBe('already_open');
  });

  /**
   * THE CONTROL for the case above, and it is not optional: without it, `not.toBe('already_open')` would
   * pass just as happily against an `openLeaveYear` that never saw the pair, which is exactly the
   * "green over a row that was never written" failure the non-vacuity step exists to catch. A hand-made
   * ACCRUAL at the identical date DOES flip the outcome — so the predicate is live, the pair is reachable,
   * and the only thing keeping the year safe is the entry type the importer chooses.
   */
  it('CONTROL — a hand-made accrual at the SAME date does flip the prior year to already_open', async () => {
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '3.50',
      effectiveOn: EXPECTED_EFFECTIVE_ON,
      reason: 'hand-made control row',
    });
    const run = await openLeaveYear(adminCtx(b), {
      year: PRIOR_YEAR,
      employmentIds: [emp.employmentId],
      leaveTypeIds: [b.annualLeaveTypeId],
      dryRun: true,
    });
    const row = run.rows.find(
      (x) => x.employmentId === emp.employmentId && x.leaveTypeId === b.annualLeaveTypeId,
    );
    expect(row!.outcome).toBe('already_open');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — the figure reaches Brought Forward, per employee, on the right date', () => {
  it('Brought Forward reads the imported figure and the grid’s Carried Forward reads it capped', async () => {
    // A cap that BITES, so the two figures are different numbers and a test that conflated them fails.
    await setCarry(b.annualLeaveTypeId, { max: 2, enabled: true });
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    const bd = await leaveEntitlementBreakdown(
      adminCtx(b),
      emp.employmentId,
      b.annualLeaveTypeId,
      `${TARGET_YEAR}-06-30`,
    );
    expect(bd).not.toBeNull();
    // The cycle the figure was dated against, and the RAW prior-cycle sum.
    expect(bd!.cycleStart).toBe(`${TARGET_YEAR}-01-01`);
    expect(bd!.broughtForward).toBe(3.5);
    // …and the capped figure the Employee Balances column reads. 3.5 in, 2.00 kept, 1.50 forfeited.
    expect(bd!.carriedForward).toBe(2);
  });

  it('an ANNIVERSARY leave cycle is dated the day before that employee’s own anniversary, not 31 December', async () => {
    // The whole reason the date is resolved per employee: a company whose leave year runs from the joining
    // anniversary does not open on 1 January, and the reporter must not have to know that.
    await owner.db
      .update(schema.company)
      .set({ leaveCycle: 'anniversary' })
      .where(eq(schema.company.id, b.companyId));
    const [row] = await owner.db
      .select({ hiredOn: schema.employment.hiredOn })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp.employmentId));
    const hireMonth = row.hiredOn.slice(5, 7);
    const expectedCycleStart = `${TARGET_YEAR}-${hireMonth}-01`;
    const expectedDate = addDays(expectedCycleStart, -1);

    const p = await validateLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    expect(p.rows[0].status).toBe('valid');
    expect(p.rows[0].cycleStart).toBe(expectedCycleStart);
    expect(p.rows[0].effectiveOn).toBe(expectedDate);
    // Non-vacuity of THIS case: a calendar-cycle answer would be 31 December, which is what a hardcoded
    // date would have produced. The two must not be the same day, or the case proves nothing.
    expect(expectedDate).not.toBe(EXPECTED_EFFECTIVE_ON);

    await commitLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    const rows = await ledgerRows();
    expect(rows[0].effectiveOn).toBe(expectedDate);
  });

  it('the figure lands on the BALANCE type’s ledger when the filed type borrows its balance', async () => {
    const pooled = await createLeaveType(adminCtx(b), { code: 'EMERG', name: 'Emergency Leave' });
    await owner.db
      .update(schema.leaveType)
      .set({ balanceSourceTypeId: b.annualLeaveTypeId })
      .where(eq(schema.leaveType.id, pooled.id));

    const p = await validateLeaveBfImport(adminCtx(b), { records: recs([good({ leave_code: 'EMERG' })]) });
    expect(p.rows[0].status).toBe('valid');
    // The preview says so rather than hiding the pooling.
    expect(p.rows[0].balanceCode).toBe('ANNUAL');
    expect(p.balanceImpact).toHaveLength(1);
    expect(p.balanceImpact[0].leaveCode).toBe('ANNUAL');
    expect(p.balanceImpact[0].filedCodes).toEqual(['EMERG']);

    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ leave_code: 'EMERG' })]) });
    // The days are on ANNUAL's ledger, where the balance actually lives…
    expect(await ledgerRows(b.annualLeaveTypeId)).toHaveLength(1);
    // …and not on the borrower's own, which has no balance of its own to move.
    expect(await ledgerRows(pooled.id)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — validation: the reporter’s list, as errors and as warnings', () => {
  const firstRow = async (over: Row) =>
    (await validateLeaveBfImport(adminCtx(b), { records: recs([good(over)]) })).rows[0];

  it('rejects an unknown employee, an unknown leave code and a blank or impossible year', async () => {
    expect((await firstRow({ employee_id: 'NOPE999' })).errors).toContain('Employee ID not found');
    expect((await firstRow({ leave_code: 'NOSUCH' })).errors).toContain('Leave Code not found');
    expect((await firstRow({ entitlement_year: '' })).errors).toContain('Entitlement Year is required');
    expect((await firstRow({ entitlement_year: '20x6' })).errors).toContain(
      'Entitlement Year is not a valid year',
    );
  });

  it('rejects days that are not a number, are negative, or are not in half-day steps', async () => {
    expect((await firstRow({ bf_days: 'three' })).errors).toContain('B/F Days is not a number');
    expect((await firstRow({ bf_days: '-1' })).errors).toContain('B/F Days cannot be negative');
    expect((await firstRow({ bf_days: '0.25' })).errors).toContain('B/F Days must be in steps of 0.5');
    // …and the three that must still be accepted, or the rule is over-tight: a whole day, a half day, and
    // ZERO — which under Replace is the instruction "take back what a previous import put there".
    for (const d of ['3', '3.5', '0']) {
      expect((await firstRow({ bf_days: d })).status, d).toBe('valid');
    }
  });

  it('rejects a leave type whose carry-forward is off — on the WRITE path’s predicate, not the cap alone', async () => {
    // ⚠️ THE DIVERGENCE THIS PINS. The READ path (`carryAllowanceFrom`) ignores `carryForwardEnabled`,
    // so a type with the switch OFF and a positive cap would DISPLAY up to 5.00 brought forward while
    // `openLeaveYear` forfeited the lot. Validating on `carryEnabled` — the write path's own predicate —
    // is what stops this screen promising a figure the engine will take away.
    await setCarry(b.annualLeaveTypeId, { max: 5, enabled: false });
    expect((await firstRow({})).errors).toContain('Carry forward is not enabled for this leave type');
    // A percentage-only type DOES carry and must be accepted: `carryEnabled` returns true on a positive
    // percentage whatever the cap says.
    await setCarry(b.annualLeaveTypeId, { max: null, percent: 50, enabled: null });
    expect((await firstRow({})).status).toBe('valid');
    // And carry off with nothing configured at all is refused, which is every non-annual type's default.
    await setCarry(b.annualLeaveTypeId, { max: null, percent: null, enabled: null });
    expect((await firstRow({})).errors).toContain('Carry forward is not enabled for this leave type');
  });

  it('names the LENDER in the carry error when the filed type borrows its balance', async () => {
    const pooled = await createLeaveType(adminCtx(b), { code: 'EMERG2', name: 'Emergency Leave 2' });
    await owner.db
      .update(schema.leaveType)
      .set({ balanceSourceTypeId: b.annualLeaveTypeId })
      .where(eq(schema.leaveType.id, pooled.id));
    await setCarry(b.annualLeaveTypeId, { max: null, percent: null, enabled: null });
    const row = await firstRow({ leave_code: 'EMERG2' });
    // The lender's rule is what will bite, so the message must name the lender rather than the code the
    // uploader typed — otherwise the correction they make is to the wrong leave type.
    expect(row.errors).toContain(
      "Carry forward is not enabled for ANNUAL, which is where EMERG2's balance is held",
    );
  });

  it('rejects the same employee + leave code + year twice in one file, and imports neither', async () => {
    const p = await validateLeaveBfImport(adminCtx(b), { records: recs([good(), good({ bf_days: '5' })]) });
    expect(p.rows[0].status).toBe('valid');
    expect(p.rows[1].errors).toContain(
      'Duplicate Employee ID + Leave Code + Entitlement Year in this file',
    );
    // The FIRST line is still valid — a file whose author repeated one pair does not lose its good rows.
    expect(p.validCount).toBe(1);
    expect(p.errorCount).toBe(1);
  });

  it('warns without blocking: over the cap, an inactive employee, and a figure already brought forward', async () => {
    await setCarry(b.annualLeaveTypeId, { max: 2, enabled: true });
    const over = await firstRow({ bf_days: '3.5' });
    expect(over.status).toBe('valid');
    expect(over.warnings.join(' ')).toMatch(/carry-forward limit/);
    expect(over.warnings.join(' ')).toMatch(/2\.00 will be brought forward and 1\.50 forfeited/);

    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: addDays(TODAY, -30) })
      .where(eq(schema.employment.id, emp.employmentId));
    expect((await firstRow({})).warnings).toContain('Employee is no longer active');
  });

  it('warns that days are ALREADY brought forward, counting real ledger history and not only past imports', async () => {
    // A real accrual in the prior cycle — the shape a migration reaches after Leave History Data Import,
    // and the shape Replace deliberately does NOT touch.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '4.00',
      effectiveOn: `${PRIOR_YEAR}-06-01`,
      reason: 'a real prior-year accrual',
    });
    const row = await firstRow({});
    expect(row.status).toBe('valid');
    expect(row.warnings.join(' ')).toMatch(/4\.00 day\(s\) are already brought forward/);
    expect(row.warnings.join(' ')).toMatch(/Replace removes only what a previous B\/F import put there/);
  });

  it('a validate writes nothing at all', async () => {
    await validateLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    expect(await ledgerRows()).toHaveLength(0);
    expect(await listLeaveBfImportRuns(adminCtx(b))).toEqual([]);
  });

  it('reports a missing required column rather than silently reading a blank', async () => {
    const p = await validateLeaveBfImport(adminCtx(b), {
      records: [{ employee_id: emp.code, leave_code: 'ANNUAL', bf_days: '3' }],
    });
    expect(p.missingColumns).toEqual(['entitlement_year']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — Replace and Add, and what Replace deliberately does NOT touch', () => {
  it('Replace negates the PREVIOUS import’s figure and writes the new one, never updating a row', async () => {
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    const second = await commitLeaveBfImport(adminCtx(b), {
      records: recs([good({ bf_days: '2' })]),
      mode: 'replace',
    });
    expect(second.imported).toBe(1);

    const rows = await ledgerRows();
    // Append-only: three rows, not one row edited twice (ADR-0006). The MULTISET, because the negation and
    // the new figure share one transaction and therefore one `created_at` — see `ledgerRows`.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => Number(r.days)).sort((x, y) => x - y)).toEqual([-3.5, 2, 3.5]);
    expect(new Set(rows.map((r) => r.entryType))).toEqual(new Set(['adjustment']));
    // …and the negation is the one carrying the replaced-reason, so a Replace that negated the wrong row
    // (or negated nothing and merely added) fails here rather than only in the arithmetic below.
    const negation = rows.find((r) => Number(r.days) === -3.5)!;
    expect(negation.reason).toBe('Brought forward replaced (B/F import)');
    // …and the arithmetic the reader cares about: Brought Forward now reads the second figure exactly.
    const bd = await leaveEntitlementBreakdown(
      adminCtx(b),
      emp.employmentId,
      b.annualLeaveTypeId,
      `${TARGET_YEAR}-06-30`,
    );
    expect(bd!.broughtForward).toBe(2);
  });

  it('Add stacks on what is already there and negates nothing', async () => {
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '2' })]), mode: 'add' });
    const rows = await ledgerRows();
    expect(rows.map((r) => Number(r.days))).toEqual([3.5, 2]);
    const bd = await leaveEntitlementBreakdown(
      adminCtx(b),
      emp.employmentId,
      b.annualLeaveTypeId,
      `${TARGET_YEAR}-06-30`,
    );
    expect(bd!.broughtForward).toBe(5.5);
  });

  /**
   * ⚠️ THE SAFETY PROPERTY OF REPLACE, and the one that would be a data-destroying defect if it were
   * wrong: Replace sums only rows carrying a `bf_import_run_id`. The rest of the prior-cycle balance is
   * real accruals, real debits and real adjustments, and negating those would move days nobody asked it
   * to move — in a ledger that is encashed at resignation.
   */
  it('Replace leaves real prior-year accruals and debits alone', async () => {
    await owner.db.insert(schema.leaveLedger).values([
      {
        tenantId: b.tenantId,
        employmentId: emp.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        entryType: 'accrual',
        days: '12.00',
        effectiveOn: `${PRIOR_YEAR}-01-01`,
        reason: null,
      },
      {
        tenantId: b.tenantId,
        employmentId: emp.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        entryType: 'debit',
        days: '-4.00',
        effectiveOn: `${PRIOR_YEAR}-03-10`,
        reason: null,
      },
    ]);
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '1' })]), mode: 'replace' });

    const rows = await ledgerRows();
    // The two real rows survive untouched; only the import's own 3.5 was negated.
    expect(rows.filter((r) => r.runId == null).map((r) => Number(r.days)).sort((x, y) => x - y)).toEqual([
      -4, 12,
    ]);
    // The MULTISET again: the negation and the new figure share one transaction (see `ledgerRows`).
    expect(
      rows.filter((r) => r.runId != null).map((r) => Number(r.days)).sort((x, y) => x - y),
    ).toEqual([-3.5, 1, 3.5]);
    const bd = await leaveEntitlementBreakdown(
      adminCtx(b),
      emp.employmentId,
      b.annualLeaveTypeId,
      `${TARGET_YEAR}-06-30`,
    );
    // 12 − 4 + 1 = 9, not 1: Replace replaced the IMPORTED figure, not the year.
    expect(bd!.broughtForward).toBe(9);
  });

  it('Replace of ZERO removes what a previous import put there and writes no positive row', async () => {
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    const r = await commitLeaveBfImport(adminCtx(b), {
      records: recs([good({ bf_days: '0' })]),
      mode: 'replace',
    });
    expect(r.imported).toBe(1);
    const rows = await ledgerRows();
    // Two rows, not three: a 0.00 adjustment would be a ledger entry recording an event that did not happen.
    expect(rows.map((r2) => Number(r2.days))).toEqual([3.5, -3.5]);
    const bd = await leaveEntitlementBreakdown(
      adminCtx(b),
      emp.employmentId,
      b.annualLeaveTypeId,
      `${TARGET_YEAR}-06-30`,
    );
    expect(bd!.broughtForward).toBe(0);
  });

  it('the preview states the mode the SERVER resolved, and the net change rather than the file’s figure', async () => {
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    const p = await validateLeaveBfImport(adminCtx(b), {
      records: recs([good({ bf_days: '5' })]),
      mode: 'replace',
    });
    expect(p.mode).toBe('replace');
    expect(p.balanceImpact).toHaveLength(1);
    const i = p.balanceImpact[0];
    expect(i.fileDays).toBe(5);
    // 5 typed, but only 1.5 moves: the previous import's 3.5 is negated first.
    expect(i.netDays).toBe(1.5);
    expect(i.broughtForwardBefore).toBe(3.5);
    expect(i.broughtForwardAfter).toBe(5);
    expect(i.effectiveOn).toBe(EXPECTED_EFFECTIVE_ON);
    // An omitted mode resolves to 'replace' in ONE place, so a caller that forgets gets the reporter's
    // own default rather than whichever branch happens to be first.
    expect((await validateLeaveBfImport(adminCtx(b), { records: recs([good()]) })).mode).toBe('replace');
  });

  it('the preview shows the capped figure and what lands in Forfeited BF, before Confirm import', async () => {
    await setCarry(b.annualLeaveTypeId, { max: 2, enabled: true });
    const p = await validateLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    const i = p.balanceImpact[0];
    expect(i.broughtForwardAfter).toBe(3.5);
    expect(i.carriedForwardAfter).toBe(2);
    expect(i.forfeitedBf).toBe(1.5);
    expect(i.capped).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — the run log, and the rollback the reporter asked for', () => {
  it('records the run with its mode, its three counts and its ledger-row count', async () => {
    const r = await commitLeaveBfImport(adminCtx(b), {
      records: recs([good(), good({ employee_id: 'NOPE999' })]),
      mode: 'add',
      source: { kind: 'file', name: 'bf.xlsx', format: 'xlsx' },
    });
    expect(r.total).toBe(2);
    expect(r.imported).toBe(1);
    expect(r.failed).toBe(1);
    // imported + failed = total, always.
    expect(r.imported + r.failed).toBe(r.total);

    const runs = await listLeaveBfImportRuns(adminCtx(b));
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(r.runId);
    expect(runs[0].mode).toBe('add');
    expect(runs[0].fileName).toBe('bf.xlsx');
    expect(runs[0].totalRows).toBe(2);
    expect(runs[0].importedRows).toBe(1);
    expect(runs[0].failedRows).toBe(1);
    // NOT the same number as importedRows, and deliberately so: see migration 0497's header.
    expect(runs[0].ledgerRows).toBe(1);
    expect(runs[0].reversedAt).toBeNull();
    expect(runs[0].errors.map((e) => e.employeeId)).toEqual(['NOPE999']);
    expect(await eventTypesFor(b.tenantId, r.runId)).toContain('leave-bf-import.completed');
  });

  it('the log is most recent first — an explicit order, not the scan’s', async () => {
    const first = await commitLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    const second = await commitLeaveBfImport(adminCtx(b), {
      records: recs([good({ entitlement_year: String(TARGET_YEAR + 1) })]),
    });
    const runs = await listLeaveBfImportRuns(adminCtx(b));
    expect(runs.map((x) => x.id)).toEqual([second.runId, first.runId]);
  });

  it('rolling back writes the reversing entries on THEIR OWN dates and restores Brought Forward', async () => {
    const r = await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    const out = await reverseLeaveBfImportRun(adminCtx(b), { runId: r.runId });
    expect(out.reversed).toBe(1);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(2);
    // Nothing deleted; the negation is a new row, and it is an adjustment too.
    expect(rows.map((x) => Number(x.days))).toEqual([3.5, -3.5]);
    expect(new Set(rows.map((x) => x.entryType))).toEqual(new Set(['adjustment']));
    // ⚠️ ON ITS OWN DATE. A reversal dated today would leave the prior-cycle sum wrong forever AND credit
    // the current cycle by the same amount — two wrong figures from one convenience.
    expect(rows[1].effectiveOn).toBe(EXPECTED_EFFECTIVE_ON);
    expect(rows[1].reason?.startsWith(LEAVE_BF_REVERSAL_REASON_PREFIX)).toBe(true);
    expect(rows[1].reason?.startsWith('sys:')).toBe(false);

    const bd = await leaveEntitlementBreakdown(
      adminCtx(b),
      emp.employmentId,
      b.annualLeaveTypeId,
      `${TARGET_YEAR}-06-30`,
    );
    expect(bd!.broughtForward).toBe(0);
    const runs = await listLeaveBfImportRuns(adminCtx(b));
    expect(runs[0].reversedAt).not.toBeNull();
    expect(await eventTypesFor(b.tenantId, r.runId)).toContain('leave-bf-import.reversed');
  });

  it('a run cannot be rolled back twice, so the days cannot be handed back twice', async () => {
    const r = await commitLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    await reverseLeaveBfImportRun(adminCtx(b), { runId: r.runId });
    await expect(reverseLeaveBfImportRun(adminCtx(b), { runId: r.runId })).rejects.toThrow(
      /already been rolled back/,
    );
    // …and the second attempt wrote nothing, which is the assertion that would catch a reversal that
    // compounded by sweeping in its own compensating rows.
    expect(await ledgerRows()).toHaveLength(2);
  });

  it('a rolled-back run’s figure nets to zero, so a later Replace does not negate it a second time', async () => {
    const r = await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '3.5' })]) });
    await reverseLeaveBfImportRun(adminCtx(b), { runId: r.runId });
    await commitLeaveBfImport(adminCtx(b), { records: recs([good({ bf_days: '2' })]), mode: 'replace' });
    const rows = await ledgerRows();
    // 3.5, −3.5 (rollback), then 2 — and NO third negation, because the rolled-back pair already sums to 0.
    expect(rows.map((x) => Number(x.days))).toEqual([3.5, -3.5, 2]);
    const bd = await leaveEntitlementBreakdown(
      adminCtx(b),
      emp.employmentId,
      b.annualLeaveTypeId,
      `${TARGET_YEAR}-06-30`,
    );
    expect(bd!.broughtForward).toBe(2);
  });

  it('every ledger row a run writes carries its run id, and the DB confines that column to adjustments', async () => {
    const r = await commitLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    const rows = await ledgerRows();
    expect(rows.every((x) => x.runId === r.runId)).toBe(true);
    // The constraint is what makes the rollback arithmetic sound: it sums the rows carrying the id, so a
    // debit swept in by mistake would be handed back as entitlement (0353's words, same failure here).
    //
    // ⚠️ THE CONSTRAINT NAME IS READ OFF THE PG ERROR'S `cause`, NOT off the thrown message. drizzle wraps
    // a failed query in its own error whose message is "Failed query: insert into …", so a bare
    // `rejects.toThrow(/name/)` never matches and a bare `rejects.toThrow()` would pass on ANY rejection —
    // including a typo in the fixture. The name is the whole point of the assertion.
    const err = await owner.db
      .insert(schema.leaveLedger)
      .values({
        tenantId: b.tenantId,
        employmentId: emp.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        entryType: 'debit',
        days: '-1.00',
        effectiveOn: EXPECTED_EFFECTIVE_ON,
        bfImportRunId: r.runId,
      })
      .then(
        () => null,
        (e: unknown) => e as { message?: string; cause?: { constraint?: string; message?: string } },
      );
    expect(err, 'a debit carrying a B/F run id must be refused by the database').not.toBeNull();
    const detail = `${err!.cause?.constraint ?? ''} ${err!.cause?.message ?? ''} ${err!.message ?? ''}`;
    expect(detail).toContain('leave_ledger_bf_import_is_adjustment_check');
  });

  it('the run table is tenant-scoped and admin-only at the row level (migration 0497 RLS)', async () => {
    await commitLeaveBfImport(adminCtx(b), { records: recs([good()]) });
    const [{ n }] = await owner.db
      .select({ n: sql<string>`count(*)` })
      .from(schema.leaveBfImportRun)
      .where(eq(schema.leaveBfImportRun.tenantId, b.tenantId));
    expect(Number(n)).toBe(1);
  });
});
