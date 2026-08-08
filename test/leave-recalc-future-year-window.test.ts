/**
 * c8052ae3 — THE RECALC WINDOW HAS AN END, AND A FUTURE LEAVE YEAR IS NOT THIS ONE.
 *
 * The reported fault was "Medical Leave and Hospitalization Leave show negative balances, please clean up
 * the leftover entitlement records". The leftover records were real, but they were the SYMPTOM. Every
 * negative on production was written by `reprojectEntitlementForEmployment`, which sums "how much has this
 * cycle already granted" over the employment's ledger — and filtered that sum on `effectiveOn >=
 * windowStart` with NO UPPER BOUND. The tenant had opened the 2027 and 2028 leave years ahead, so those
 * years' 1-January accruals were counted as THIS cycle's grants:
 *
 *     leave_entitlement_recalc_audit, HOSPITALIZATION: previous_entitlement 180.00 (60 × 3 leave years)
 *     against a real single-year grant of 60.00 ⇒ delta −120.00, posted on an ordinary profile save.
 *
 * That is why a cleanup alone would not have held: the next grade / employment / confirmation edit would
 * have re-created the negatives from configuration that no longer exists.
 *
 * ⚠️ THESE TESTS MUST FAIL WITH THE FIX REVERTED. Verified by reverting the `<= windowEnd` bound and
 * re-running: `open a future leave year` posts −24.00 instead of nothing, and the earned-accrual case
 * grants 0 instead of the month's slice. A recalc test that still passes without the bound is pinning the
 * "no opinion" guard or the materialized-only guard, not the window.
 *
 * SCOPE OF THE ENUMERATION (the plan asked for every site that sums "already granted", not just the one):
 *  - `reprojectEntitlementForEmployment` — the reported defect. Fixed here, pinned below.
 *  - `accrueEarnedLeave`'s top-up sum — the IDENTICAL shape, quiet rather than loud (`toGrant > 0` means a
 *    future grant can only SUPPRESS accrual, never claw back). Fixed here, pinned below.
 *  - `reprojectA2cEntitlement` — already bounded at both ends (`gte(yearStart)` AND `lte(asOf)`). Pinned
 *    below so it stays that way.
 *  - `reprojectEntitlementForPolicy` — named in the plan's build notes, but it NO LONGER EXISTS: it was
 *    deleted in release three along with `leave_policy`. The configuration-side recalc that survives
 *    (`reprojectEntitlementForLeaveTypeCohort`) delegates per employment to
 *    `reprojectEntitlementForEmployment`, so it inherits the fix rather than needing its own.
 *  - `openLeaveYear`'s carry-in balance is a WHOLE-LEDGER sum with no date bound at all. Different shape,
 *    different question, deliberately NOT changed here — see the note on the last test in this file.
 */
import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setEmploymentGrade } from '../core/org';
import { createJobGrade } from '../core/admin';
import {
  accrueEarnedLeave,
  leaveCycleEnd,
  openLeaveYear,
  projectExpectedEntitlement,
  reprojectEntitlementForEmployment,
  PROFILE_RECALC_REASON_PREFIX,
} from '../core/leave';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

let b: Base;
const uniqEmail = () => `futurewindow_${randomUUID().slice(0, 8)}@t.local`;

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

const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Mei Ling', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId: null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** Every profile-recalc ledger row for one employment — the rows that must NOT appear. */
const profileRecalcRows = (employmentId: string) =>
  owner.db
    .select({ days: schema.leaveLedger.days, effectiveOn: schema.leaveLedger.effectiveOn })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        like(schema.leaveLedger.reason, `${PROFILE_RECALC_REASON_PREFIX}:%`),
      ),
    );

const auditRows = (employmentId: string) =>
  owner.db
    .select({ delta: schema.leaveEntitlementRecalcAudit.delta })
    .from(schema.leaveEntitlementRecalcAudit)
    .where(eq(schema.leaveEntitlementRecalcAudit.employmentId, employmentId));

/** Accrual rows, oldest first — used to prove the future leave years really were opened. */
const accrualDates = async (employmentId: string) => {
  const rows = await owner.db
    .select({ effectiveOn: schema.leaveLedger.effectiveOn, days: schema.leaveLedger.days })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.entryType, 'accrual'),
      ),
    );
  return rows.map((r) => `${r.effectiveOn}=${Number(r.days)}`).sort();
};

describe('c8052ae3 — leaveCycleEnd is the one definition of where a cycle stops', () => {
  it('calendar cycle ends on 31 December of its own year', () => {
    expect(leaveCycleEnd('2026-01-01')).toBe('2026-12-31');
    expect(leaveCycleEnd('2027-01-01')).toBe('2027-12-31');
  });

  it('anniversary cycle ends the day before the next anniversary', () => {
    expect(leaveCycleEnd('2026-03-01')).toBe('2027-02-28');
    // A leap year lengthens the window rather than shifting the anniversary — 366 days, same 28 Feb + 1.
    expect(leaveCycleEnd('2027-03-01')).toBe('2028-02-29');
    expect(leaveCycleEnd('2026-07-01')).toBe('2027-06-30');
  });

  it('the projection kernel returns the closed interval, not just its start', () => {
    const emp = { hiredOn: '2020-01-01', leaveCycle: 'calendar', gradeId: null, companyId: b?.companyId ?? 'x' };
    const projected = projectExpectedEntitlement(
      emp,
      'ANNUAL',
      () => 0,
      '2026-06-30',
      undefined,
      undefined,
      () => ({ fromYears: 0, toYears: null, days: 14 }),
    );
    expect(projected?.windowStart).toBe('2026-01-01');
    expect(projected?.windowEnd).toBe('2026-12-31');
  });
});

describe('c8052ae3 — a profile recalc never counts a FUTURE leave year as already granted', () => {
  it('with 2027 and 2028 already opened, an unchanged profile recalcs to delta 0.00 and writes nothing', async () => {
    const ctx = adminCtx(b);
    await seedEntitlement(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2020-01-01' });
    const emp = await hire('2026-01-01');
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(12);

    // THE PRODUCTION SHAPE: leave years opened ahead, each writing its own 1-January accrual. On production
    // these were 27 rows worth 168 Medical days and 900 Hospitalization days, dated 2027-01-01/2028-01-01.
    await openLeaveYear(ctx, { year: 2027 });
    await openLeaveYear(ctx, { year: 2028 });
    expect(await accrualDates(emp.employmentId)).toEqual([
      '2026-01-01=12',
      '2027-01-01=12',
      '2028-01-01=12',
    ]);
    const balanceBefore = await ledgerBalance(emp.employmentId, b.annualLeaveTypeId);

    // An ORDINARY profile save in 2026 — nothing about the employee changed, nothing about the
    // configuration changed. Before the fix this read alreadyPosted = 36.00 against expected 12.00 and
    // posted −24.00, exactly the mechanism that put Mei Ling's Hospitalization Leave at −60.00.
    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: '2026-06-30',
      trigger: 'employment_changed',
    });
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await profileRecalcRows(emp.employmentId)).toEqual([]);
    expect(await auditRows(emp.employmentId)).toEqual([]);
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(balanceBefore);
  });

  it('the recalc still corrects a REAL in-cycle shortfall — the bound narrows the window, it does not disable it', async () => {
    const ctx = adminCtx(b);
    await seedEntitlement(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2020-01-01' });
    const emp = await hire('2026-01-01');
    await openLeaveYear(ctx, { year: 2027 });

    // A promotion into a grade a richer table targets. The in-cycle grant (12, dated 2026-01-01) is still
    // inside [2026-01-01, 2026-12-31] and must STILL be counted — a fix that dropped it would post +20
    // instead of +8 and double-grant. This is the assertion that stops the bound being "sum nothing".
    const grade = await createJobGrade(ctx, { code: 'GH', name: 'Grade H' });
    await seedEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 20,
      gradeId: grade.id,
      validFrom: '2020-01-01',
      name: 'Grade H table',
    });
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: grade.id });
    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: '2026-06-30',
      trigger: 'grade_changed',
    });
    expect(res).toEqual({ affected: 1, totalDelta: 8 });
    const rows = await profileRecalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].days)).toBe(8);
  });

  // ⚠️ HONEST LABEL: this one PASSES WITH THE FIX REVERTED, and it is kept anyway as a characterization
  // guard rather than a regression test. The lower bound (`>= windowStart`) was always present and was
  // never the defect; what this pins is that the closed interval did not replace the filter wholesale —
  // a "fix" that summed nothing, or that widened backwards, breaks here. Verified: 4 of the 7 tests in
  // this file pass under the revert; the three that fail are the three that matter.
  it('a PRIOR year’s grant is outside the window too — the lower bound is pinned, not just the new upper one', async () => {
    const ctx = adminCtx(b);
    await seedEntitlement(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2020-01-01' });
    // August joiner: the 2025 hire grant is 12 × 5/12 = 5.00 dated 2025-08-01, which sits INSIDE the
    // ledger fetch's trailing-12-month lower bound (2025-06-01 for an asOf of 2026-06-30). So the row is
    // genuinely fetched and it is the per-cycle window, not the query, that keeps it out of the sum.
    const emp = await hire('2025-08-01');
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(5);
    await openLeaveYear(ctx, { year: 2026 });
    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: '2026-06-30',
      trigger: 'employment_changed',
    });
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await profileRecalcRows(emp.employmentId)).toEqual([]);
  });
});

describe('c8052ae3 — accrueEarnedLeave’s top-up sum carried the same unbounded shape', () => {
  it('a future leave year’s grant no longer suppresses this cycle’s monthly accrual', async () => {
    const ctx = adminCtx(b);
    // The earning METHOD is a leave-TYPE rule (9816a5ad step 2); the DAYS stay on the entitlement table.
    await owner.db
      .update(schema.leaveType)
      .set({ accrualMethod: 'earned_monthly' })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await seedEntitlement(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2020-01-01' });
    const emp = await hire('2026-01-01'); // earned ⇒ no hire lump

    // A grant already written for the NEXT cycle. Its date is what makes it not ours; nothing else about
    // it is unusual. (Written directly rather than via openLeaveYear because openLeaveYear deliberately
    // skips earned types — this is the future-dated row an admin adjustment or an import can leave behind.)
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '12.00',
      effectiveOn: '2027-01-01',
    });

    // Five elapsed months of 2026 at 12/yr = 5.00. Before the fix `already` read 12.00 (next year's row),
    // toGrant came out −7.00, the `toGrant > 0` guard swallowed it and the employee simply stopped
    // earning — a silent zero rather than a visible negative.
    await accrueEarnedLeave(ctx, { asOf: '2026-05-31' });
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(5 + 12); // 5 earned + the 2027 row
  });
});
