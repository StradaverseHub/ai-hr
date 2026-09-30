/**
 * Item b2713800 — AN IMPORTED BALANCE LINE CAN SILENTLY CANCEL AN EMPLOYEE'S WHOLE YEAR OF ENTITLEMENT.
 *
 * ── THE DEFECT, AS A MECHANISM ──────────────────────────────────────────────────────────────────────────
 * `yearOpenMarkerCond` (core/leave.ts) defines a leave year as "already opened" for an (employment, leave
 * type) pair by the presence of ANY `accrual` ledger row dated inside that year — deliberately with no
 * filter on `reason`, because the hire grant has to count as the marker for a joiner's first year. An
 * imported row carries `entryType = 'accrual'` when the file says `transaction_type = accrual`, so it
 * satisfies that predicate too. Import one such row into a year that has NOT yet been generated and the
 * next Generate Entitlement logs `already_open`, posts nothing, and the employee's entire year of
 * entitlement is gone. Leave balances are encashed at resignation, so those are missing ringgit.
 *
 * ── WHY THE OBVIOUS WARNING WOULD HAVE BEEN GREEN ON EXACTLY THESE ROWS ──────────────────────────────────
 * The importer already warned on a row landing in an already-rolled-over year, i.e. when it FOUND an
 * existing accrual. In the damaging case there is no pre-existing accrual at all — the imported line is
 * what lands first and is the thing that becomes the marker. So the new warning is conditioned on the
 * ABSENCE of a marker, and (a) below asserts that absence as a measured premise before importing anything,
 * rather than assuming the fixture is in the state the defect needs.
 *
 * ── WHAT EACH ARM PINS ──────────────────────────────────────────────────────────────────────────────────
 *  (a)  THE LOAD-BEARING CASE: no accrual row exists in the target year (queried, not assumed) → the
 *       warning fires, the row is NOT blocked, and the rolled-over warning does not fire.
 *  (b)  THE MONEY: commit that row, run the real openLeaveYear, and the year's entitlement never arrives —
 *       outcome `already_open`, and the only 2026 accrual the employee has is the 1.00 that was imported,
 *       beside an identical control employee who gets 8.00.
 *  (c)  THE REMEDY THE MESSAGE NAMES IS TRUE: the same row as `adjustment` raises no warning and the year
 *       is still granted in full. Without this, the warning could be telling HR to do something that does
 *       not help.
 *  (d)  THE OTHER DIRECTION, and the reason the marker key had to be widened: a March joiner's HIRE GRANT
 *       is their first year's marker and is not dated 1 January. Under the old 1-January-only key the year
 *       read as un-opened, so this row would have drawn the cancellation warning while cancelling nothing.
 *       It must draw the rolled-over warning instead.
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { openLeaveYear } from '../core/leave';
import { validateLeaveImport, commitLeaveImport } from '../core/leave-import';
import {
  adminCtx,
  closeAll,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

/** 8 days of ANNUAL, in force from long before any year these tests open. */
const entitle8 = () =>
  seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 8,
    validFrom: '2020-01-01',
  });

/** Hire with the ANNUAL grant, and return the employment id + its generated code (read back, not guessed). */
async function hire(hiredOn: string): Promise<{ employmentId: string; code: string }> {
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Year Open Emp', primaryEmail: `yo_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });
  const [row] = await owner.db
    .select({ code: schema.employment.employeeCode })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return { employmentId, code: row.code! };
}

/**
 * Every `accrual` row this employment holds for ANNUAL inside the given calendar year, ordered by date.
 *
 * This is `yearOpenMarkerCond`'s own question asked from the outside — the rows openLeaveYear would read as
 * "this year is already open". ORDER BY is explicit because the assertions read the array.
 */
async function accrualsIn(employmentId: string, year: number): Promise<number[]> {
  const rows = await owner.db
    .select({ days: schema.leaveLedger.days, on: schema.leaveLedger.effectiveOn })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
        eq(schema.leaveLedger.entryType, 'accrual'),
        gte(schema.leaveLedger.effectiveOn, `${year}-01-01`),
        lte(schema.leaveLedger.effectiveOn, `${year}-12-31`),
      ),
    )
    .orderBy(schema.leaveLedger.effectiveOn);
  return rows.map((r) => Number(r.days));
}

const row = (code: string, transaction_type: string, days: string, effective_date: string) => ({
  employee_id: code,
  leave_type: 'ANNUAL',
  transaction_type,
  days,
  effective_date,
});

const CANCELS = /Entitlement for 2026 will NOT be generated/;
const ROLLED_OVER = /already-rolled-over/i;

describe('b2713800 · the damaging case: an accrual row in a year with NO pre-existing accrual', () => {
  it('(a) warns that the year will not be generated, and does not block the row', async () => {
    await entitle8();
    const e = await hire('2025-01-01');

    // THE PREMISE, MEASURED. The whole point of this item is that the harm needs no pre-existing accrual;
    // a fixture that quietly had one would make the assertion below prove the opposite warning.
    expect(await accrualsIn(e.employmentId, 2026)).toEqual([]);
    // …while 2025 DOES carry the hire grant, so "empty" above is a fact about 2026, not a broken fixture.
    expect((await accrualsIn(e.employmentId, 2025)).length).toBe(1);

    const preview = await validateLeaveImport(adminCtx(b), {
      records: [row(e.code, 'accrual', '1', '2026-03-15')],
    });

    expect(preview.rows[0].ok).toBe(true); // non-blocking: HR is told, not stopped
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[0].warnings.join(' ')).toMatch(CANCELS);
    // It names the remedy, and the remedy is asserted to work in (c).
    expect(preview.rows[0].warnings.join(' ')).toMatch(/adjustment/);
    // The OLD warning must not fire here — there is no rolled-over year, and saying there is would be the
    // false reassurance this item exists to remove.
    expect(preview.rows[0].warnings.join(' ')).not.toMatch(ROLLED_OVER);
  });

  it('(b) and the year really is cancelled: openLeaveYear posts nothing for that employee', async () => {
    await entitle8();
    const imported = await hire('2025-01-01');
    const control = await hire('2025-01-01'); // identical in every way except the import

    await commitLeaveImport(adminCtx(b), { records: [row(imported.code, 'accrual', '1', '2026-03-15')] });

    const res = await openLeaveYear(adminCtx(b), { year: 2026 });
    const lineFor = (employmentId: string) =>
      res.rows.find((r) => r.employmentId === employmentId && r.leaveTypeId === b.annualLeaveTypeId)!;

    // The imported row was read as 2026's open-marker, so the grant was skipped…
    expect(lineFor(imported.employmentId).outcome).toBe('already_open');
    expect(lineFor(imported.employmentId).days).toBe(0);
    // …while the control employee, who differs only by not having been imported, is granted the 8 days.
    expect(lineFor(control.employmentId).outcome).toBe('granted');
    expect(lineFor(control.employmentId).days).toBe(8);

    // THE ENTITLEMENT AFTERWARDS, in the ledger rather than in the log: one 1.00 imported accrual and no
    // grant at all, against the control's 8.00. Seven of the employee's eight days never existed.
    expect(await accrualsIn(imported.employmentId, 2026)).toEqual([1]);
    expect(await accrualsIn(control.employmentId, 2026)).toEqual([8]);
  });

  it('(c) the remedy the message names is true: the same row as `adjustment` costs nothing', async () => {
    await entitle8();
    const e = await hire('2025-01-01');

    const preview = await validateLeaveImport(adminCtx(b), {
      records: [row(e.code, 'adjustment', '1', '2026-03-15')],
    });
    expect(preview.rows[0].warnings.join(' ')).not.toMatch(CANCELS);

    await commitLeaveImport(adminCtx(b), { records: [row(e.code, 'adjustment', '1', '2026-03-15')] });
    const res = await openLeaveYear(adminCtx(b), { year: 2026 });
    const line = res.rows.find(
      (r) => r.employmentId === e.employmentId && r.leaveTypeId === b.annualLeaveTypeId,
    )!;
    expect(line.outcome).toBe('granted');
    expect(line.days).toBe(8);
    // The adjustment is not an accrual, so it is not a marker and it is not in this list.
    expect(await accrualsIn(e.employmentId, 2026)).toEqual([8]);
  });
});

describe('b2713800 · the other direction: a year that IS open keeps the rolled-over warning', () => {
  it('(d) a March joiner’s hire grant is their first year’s marker, though it is not dated 1 January', async () => {
    await entitle8();
    const e = await hire('2026-03-01');

    // The marker for 2026 exists and is NOT 1 January — the case a 1-January-only key could not see.
    const [only] = await owner.db
      .select({ on: schema.leaveLedger.effectiveOn })
      .from(schema.leaveLedger)
      .where(
        and(
          eq(schema.leaveLedger.employmentId, e.employmentId),
          eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
          eq(schema.leaveLedger.entryType, 'accrual'),
        ),
      )
      .orderBy(schema.leaveLedger.effectiveOn);
    expect(only.on).toBe('2026-03-01');

    const preview = await validateLeaveImport(adminCtx(b), {
      records: [row(e.code, 'accrual', '1', '2026-06-01')],
    });
    // This row cancels nothing — the year was already opened by the hire grant — so it must draw the
    // rolled-over warning and NOT the cancellation one.
    expect(preview.rows[0].warnings.join(' ')).toMatch(ROLLED_OVER);
    expect(preview.rows[0].warnings.join(' ')).not.toMatch(CANCELS);
  });
});
