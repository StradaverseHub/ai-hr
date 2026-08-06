/**
 * Auto Link Leave Entitlement with Employee Profile (feedback ae5b84d5) — the PROFILE path.
 *
 * The entitlement configuration must follow the employee's Personnel Profile end-to-end with no
 * per-employee setup:
 *  - a NEW HIRE's first balance comes from the matching entitlement table straight away (hire-month
 *    pro-rated for ANNUAL) — including the bulk-import hire path;
 *  - a GRADE change into a grade the configuration targets posts an upfront correcting adjustment (audit
 *    row + idempotent);
 *  - an EMPLOYMENT TYPE change re-matches to a different table and adjusts;
 *  - EARNED method: the recalc delta equals accrueEarnedLeave's target, so the next monthly run grants
 *    nothing extra (cron idempotency against the recalc credit);
 *  - a Maximum Balance cap bounds the recalc (never lifts the in-cycle total above the cap);
 *  - MATERIALIZED-only pin: a type the configuration covers but with no accrual row this cycle posts
 *    nothing (it waits for its granting engine run — documented intended behaviour).
 *
 * ── 6e9a126e RELEASE THREE — REPOINTED, AND RENAMED WITH ITS SUBJECT ─────────────────────────────────
 *
 * Was `test/benefit-scheme-profile-recalc.test.ts`. Not one assertion below is about a benefit scheme:
 * every one is about `reprojectEntitlementForEmployment`, which survives the entitlement reset unchanged,
 * and about the arithmetic it posts. What moved is only where the fixture writes the configuration — a
 * benefit scheme keyed on (company, employment type, grade group) with its days in
 * `scheme_leave_entitlement` becomes an entitlement template holding the days plus an eligibility rule
 * holding the targeting. Every day count, delta, audit figure and idempotency claim is the figure it was.
 *
 * TWO THINGS GENUINELY CHANGED SHAPE, and both are stated where they happen rather than absorbed silently:
 *
 *  ① THE GRADE GROUP IS NO LONGER IN THE PATH. A scheme matched a grade only through a grade_group_member
 *    row; an eligibility rule names grades directly (`criteria.gradeIds`). Grade groups SURVIVE — 205 live
 *    leave_approval_policy rows scope by them — they simply stopped being an entitlement mechanism. So the
 *    fixtures here create one fewer object and the tests read more like what they always meant.
 *
 *  ② THE MAXIMUM BALANCE CAP HAS ONE HOME INSTEAD OF TWO. It used to come from the `leave_policy` band
 *    while the DAYS came from the scheme, so a test could set them independently. There is one layer now:
 *    the winning table supplies both, so the cap is stated on the table that wins. Same clamp, same
 *    numbers — see the case itself, which spells the arithmetic out.
 */
import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setEmploymentAssignment, setEmploymentGrade } from '../core/org';
import { createJobGrade } from '../core/admin';
import {
  accrueEarnedLeave,
  reprojectEntitlementForEmployment,
  PROFILE_RECALC_REASON_PREFIX,
} from '../core/leave';
import { createEntitlementTemplate, createEligibilityRule } from '../core/entitlement-template';
import { commitEmployeeImport } from '../core/import';
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
const ASOF = '2026-06-30';
const uniqEmail = () => `profrecalc_${randomUUID().slice(0, 8)}@t.local`;
const annualBalance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

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

const hire = (opts: { hiredOn: string; gradeId?: string | null; employmentType?: 'full_time' | 'contract' }) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Taylor Swift', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: opts.employmentType ?? 'full_time',
    hiredOn: opts.hiredOn,
    gradeId: opts.gradeId ?? null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** Grade H + an entitlement table of `days` targeted at it. Was: grade + grade group + a full_time
 *  benefit scheme + a scheme_leave_entitlement row — four objects to say one thing (see note ① above). */
async function gradeHEntitlement(days: number) {
  const ctx = adminCtx(b);
  const grade = await createJobGrade(ctx, { code: 'GH', name: 'Grade H' });
  const template = await seedEntitlement(ctx, {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: days,
    gradeId: grade.id,
    validFrom: '2020-01-01',
  });
  return { grade, template };
}

/** Profile-recalc ledger adjustments for one employment. */
const profileRecalcRows = (employmentId: string) =>
  owner.db
    .select({ days: schema.leaveLedger.days, reason: schema.leaveLedger.reason, entryType: schema.leaveLedger.entryType })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        like(schema.leaveLedger.reason, `${PROFILE_RECALC_REASON_PREFIX}:%`),
      ),
    );

/** Recalc-audit history rows for one employment (owner read, oldest first by created_at). */
const auditRows = (employmentId: string) =>
  owner.db
    .select({
      reason: schema.leaveEntitlementRecalcAudit.reason,
      previousEntitlement: schema.leaveEntitlementRecalcAudit.previousEntitlement,
      newEntitlement: schema.leaveEntitlementRecalcAudit.newEntitlement,
      delta: schema.leaveEntitlementRecalcAudit.delta,
    })
    .from(schema.leaveEntitlementRecalcAudit)
    .where(eq(schema.leaveEntitlementRecalcAudit.employmentId, employmentId));

describe('ae5b84d5 — hire grants the matching table’s days immediately', () => {
  it('mid-year hire: ANNUAL pro-rates the CONFIGURED days by hire month (Taylor Swift case)', async () => {
    const { grade } = await gradeHEntitlement(12);
    // 1 May joiner: 12 × (12−4)/12 = 8 — from the entitlement table at hire, not the next year-open.
    const emp = await hire({ hiredOn: '2026-05-01', gradeId: grade.id });
    expect(await annualBalance(emp.employmentId)).toBe(8);
  });

  // fa3f4ccb: was "floor-prorated as before" (8 × 8/12 = 5.33). With nothing configured there is no
  // entitlement, and the statutory pack no longer backfills one, so the hire grants none.
  it('fa3f4ccb: nothing configured ⇒ the hire grants nothing', async () => {
    const emp = await hire({ hiredOn: '2026-05-01' });
    expect(await annualBalance(emp.employmentId)).toBe(0);
  });

  // fa3f4ccb: was "EA floor still clamps a below-floor scheme at hire".
  it('fa3f4ccb: a table below the EA minimum is granted as configured at hire', async () => {
    const { grade } = await gradeHEntitlement(4); // below the <2y statutory minimum of 8
    const emp = await hire({ hiredOn: '2026-01-01', gradeId: grade.id });
    expect(await annualBalance(emp.employmentId)).toBe(4);
  });

  it('the bulk-import hire path grants the configured days too (inherits hireEmployee)', async () => {
    const ctx = adminCtx(b);
    // Imported employees arrive ungraded, so the table that reaches them is the company-wide one.
    await seedEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      companyId: b.companyId,
      validFrom: '2020-01-01',
    });
    const result = await commitEmployeeImport(ctx, {
      companyId: b.companyId,
      records: [
        {
          full_name: 'Imported Swift',
          email: 'imported.swift@acme.test',
          department: 'Finance',
          hired_on: '2026-05-01',
          ic_number: '910505051234',
          basic_salary: '5200',
        },
      ],
    });
    expect(result.imported).toBe(1);
    const [row] = await owner.db
      .select({ employmentId: schema.employment.id })
      .from(schema.employment)
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .where(eq(schema.person.primaryEmail, 'imported.swift@acme.test'));
    expect(await annualBalance(row.employmentId)).toBe(8); // 12 × 8/12, entitlement-driven
  });
});

describe('ae5b84d5 — profile-change recalc re-resolves the entitlement', () => {
  it('a grade change into a targeted grade posts the upfront delta, records the audit row, and is idempotent', async () => {
    const { grade } = await gradeHEntitlement(16);
    // fa3f4ccb: an unconfigured type grants nothing, and the recalc path only CORRECTS an existing grant.
    // This test is about the grade change moving the balance, so it needs a configured baseline — 8 days,
    // the same figure the EA floor used to supply, so the delta and final balance below are unchanged.
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 8,
      validFrom: '2020-01-01',
    });
    const emp = await hire({ hiredOn: '2026-01-01' }); // ungraded ⇒ the unrestricted table
    expect(await annualBalance(emp.employmentId)).toBe(8);

    await setEmploymentGrade(adminCtx(b), { employmentId: emp.employmentId, gradeId: grade.id });
    const res = await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    expect(res).toEqual({ affected: 1, totalDelta: 8 });
    expect(await annualBalance(emp.employmentId)).toBe(16); // the grade-targeted table's 16

    const rows = await profileRecalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].days)).toBe(8);
    expect(rows[0].entryType).toBe('adjustment');
    expect(rows[0].reason).toBe(`${PROFILE_RECALC_REASON_PREFIX}:${emp.employmentId}`);
    const audit = await auditRows(emp.employmentId);
    expect(audit.length).toBe(1);
    expect(audit[0].reason).toBe('grade_changed');
    expect(Number(audit[0].previousEntitlement)).toBe(8);
    expect(Number(audit[0].newEntitlement)).toBe(16);
    expect(Number(audit[0].delta)).toBe(8);

    // Idempotent — an immediate re-run computes delta 0 and posts nothing.
    const again = await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    expect(again).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(emp.employmentId)).toBe(16);
  });

  it('an employment type change re-matches to a different table and adjusts', async () => {
    const ctx = adminCtx(b);
    const { grade } = await gradeHEntitlement(16); // targets the grade alone — 1 narrowed axis
    // The contract table narrows TWO axes (grade + employment type), so it outranks the one above for a
    // contract employee and is invisible to a full_time one. `seedEntitlement` deliberately exposes only
    // grade and company (the two columns leave_policy had), so this rule is written through the real
    // writers rather than by widening the shared fixture.
    const contract = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Contract Grade H',
      serviceBands: [{ fromYears: 0, toYears: null, days: 10 }],
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Contract Grade H — eligibility',
      templateLineageId: contract.lineageId,
      criteria: { gradeIds: [grade.id], employmentTypes: ['contract'] },
      validFrom: '2020-01-01',
    });

    const emp = await hire({ hiredOn: '2026-01-01', gradeId: grade.id });
    expect(await annualBalance(emp.employmentId)).toBe(16); // full_time ⇒ the grade-only table at hire

    await setEmploymentAssignment(ctx, {
      employmentId: emp.employmentId,
      effectiveDate: '2026-06-01',
      employmentType: 'contract',
    });
    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'employment_changed',
    });
    expect(res).toEqual({ affected: 1, totalDelta: -6 });
    expect(await annualBalance(emp.employmentId)).toBe(10); // the contract table
  });

  it('earned method: the recalc delta equals the cron target, so the next run grants nothing extra', async () => {
    const ctx = adminCtx(b);
    // The earning METHOD is a leave-TYPE rule since 9816a5ad step 2; the DAYS stay per-table.
    await owner.db
      .update(schema.leaveType)
      .set({ accrualMethod: 'earned_monthly' })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await seedEntitlement(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2020-01-01' });
    const { grade } = await gradeHEntitlement(24); // targeted table: 24/yr = 2/mo
    const gradeX = await createJobGrade(ctx, { code: 'GX', name: 'Grade X' }); // targeted by nothing

    const emp = await hire({ hiredOn: '2026-01-01', gradeId: gradeX.id }); // earned ⇒ no hire lump
    await accrueEarnedLeave(ctx, { asOf: '2026-05-31' }); // 12/12 × 5 = 5, via the unrestricted table
    expect(await annualBalance(emp.employmentId)).toBe(5);

    // Promotion into Grade H mid-cycle: recalc trues the elapsed periods up to the new rate.
    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: grade.id });
    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: '2026-05-31',
      trigger: 'grade_changed',
    });
    expect(res).toEqual({ affected: 1, totalDelta: 5 }); // 24/12 × 5 = 10 ⇒ +5
    expect(await annualBalance(emp.employmentId)).toBe(10);

    // The cron sees the recalc credit in its `already` sum — an immediate re-run grants nothing…
    await accrueEarnedLeave(ctx, { asOf: '2026-05-31' });
    expect(await annualBalance(emp.employmentId)).toBe(10);
    // …and the next month tops up exactly one more period at the new rate (24/12 × 6 = 12).
    await accrueEarnedLeave(ctx, { asOf: '2026-06-30' });
    expect(await annualBalance(emp.employmentId)).toBe(12);
  });

  it('Maximum Balance cap: the recalc never lifts the in-cycle total above maxBalanceDays', async () => {
    const ctx = adminCtx(b);
    // Note ② in the header: the cap used to come from the leave_policy band while the days came from the
    // scheme. One layer now, so the cap is stated on the table that WINS — the arithmetic is untouched
    // (expected = min(configured 20, cap 12) = 12 ⇒ +2, NOT +10), it is simply read from one row.
    await seedEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 10, maxBalanceDays: 12 }],
      validFrom: '2020-01-01',
    });
    const grade = await createJobGrade(ctx, { code: 'GH', name: 'Grade H' });
    await seedEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 20, maxBalanceDays: 12 }],
      gradeId: grade.id,
      validFrom: '2020-01-01',
    });
    const emp = await hire({ hiredOn: '2026-01-01' }); // ungraded: 10, under the cap
    expect(await annualBalance(emp.employmentId)).toBe(10);

    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: grade.id });
    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    expect(res).toEqual({ affected: 1, totalDelta: 2 });
    expect(await annualBalance(emp.employmentId)).toBe(12);
    const again = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    expect(again).toEqual({ affected: 0, totalDelta: 0 }); // never creeps past the cap
  });

  it('materialized-only pin: a type with NO accrual row this cycle posts nothing (waits for its engine run)', async () => {
    const ctx = adminCtx(b);
    const { grade } = await gradeHEntitlement(12);
    // A second leave type the configuration covers — but the employee has never had it materialized.
    const [sick] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'SICK', name: 'Sick Leave', paid: true })
      .returning({ id: schema.leaveType.id });
    await seedEntitlement(ctx, {
      leaveTypeId: sick.id,
      annualDays: 20,
      gradeId: grade.id,
      validFrom: '2020-01-01',
    });

    const emp = await hire({ hiredOn: '2026-01-01', gradeId: grade.id }); // grants ANNUAL only (12)
    expect(await annualBalance(emp.employmentId)).toBe(12);

    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    // ANNUAL is already at the configured amount (delta 0); SICK has no accrual row ⇒ skipped, not seeded.
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await ledgerBalance(emp.employmentId, sick.id)).toBe(0);
  });
});
