/**
 * Auto Link Leave Entitlement with Employee Profile (feedback ae5b84d5) — PROFILE-path scheme cases.
 *
 * The Grade Group entitlement tables (benefit schemes) must follow the employee's Personnel Profile
 * end-to-end with no per-employee setup:
 *  - a NEW HIRE's first balance comes from the matching scheme straight away (hire-month pro-rated for
 *    ANNUAL, never below the EA floor) — including the bulk-import hire path;
 *  - a GRADE change into a grade group posts an upfront correcting adjustment (audit row + idempotent);
 *  - an EMPLOYMENT TYPE change re-matches to a different scheme and adjusts;
 *  - EARNED method: the recalc delta equals accrueEarnedLeave's target, so the next monthly run grants
 *    nothing extra (cron idempotency against the recalc credit);
 *  - a Maximum Balance cap bounds the recalc (never lifts the in-cycle total above the cap);
 *  - MATERIALIZED-only pin: a scheme type with no accrual row this cycle posts nothing (it waits for its
 *    granting engine run — documented intended behaviour).
 */
import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setEmploymentAssignment, setEmploymentGrade } from '../core/org';
import { createJobGrade, createLeavePolicy } from '../core/admin';
import {
  accrueEarnedLeave,
  reprojectEntitlementForEmployment,
  PROFILE_RECALC_REASON_PREFIX,
} from '../core/leave';
import { createGradeGroup, createBenefitScheme, upsertSchemeEntitlement } from '../core/benefit-scheme';
import { commitEmployeeImport } from '../core/import';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const ASOF = '2026-06-30';
const uniqEmail = () => `profrecalc_${randomUUID().slice(0, 8)}@t.local`;
const annualBalance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);
const flat = (days: number) => [{ fromYears: 0, toYears: null, days }];

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

/** Grade H + its grade group + an active full_time scheme with an ANNUAL entitlement of `days`. */
async function gradeHScheme(days: number) {
  const ctx = adminCtx(b);
  const grade = await createJobGrade(ctx, { code: 'GH', name: 'Grade H' });
  const group = await createGradeGroup(ctx, { name: 'Grade H group', gradeIds: [grade.id] });
  const scheme = await createBenefitScheme(ctx, {
    companyId: b.companyId,
    employmentType: 'full_time',
    gradeGroupId: group.id,
    name: `Permanent Grade H ${randomUUID().slice(0, 8)}`,
    status: 'active',
  });
  await upsertSchemeEntitlement(ctx, {
    benefitSchemeId: scheme.id,
    leaveTypeId: b.annualLeaveTypeId,
    serviceBands: flat(days),
  });
  return { grade, group, scheme };
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

describe('ae5b84d5 — hire grants scheme band days immediately', () => {
  it('mid-year hire: ANNUAL pro-rates the SCHEME days by hire month (Taylor Swift case)', async () => {
    const { grade } = await gradeHScheme(12);
    // 1 May joiner: 12 × (12−4)/12 = 8 — from the scheme table at hire, not the next year-open.
    const emp = await hire({ hiredOn: '2026-05-01', gradeId: grade.id });
    expect(await annualBalance(emp.employmentId)).toBe(8);
  });

  // fa3f4ccb: was "floor-prorated as before" (8 × 8/12 = 5.33). With no scheme and no policy row there
  // is no configured entitlement, and the statutory pack no longer backfills one, so the hire grants none.
  it('fa3f4ccb: no scheme AND no policy ⇒ the hire grants nothing', async () => {
    const emp = await hire({ hiredOn: '2026-05-01' });
    expect(await annualBalance(emp.employmentId)).toBe(0);
  });

  // fa3f4ccb: was "EA floor still clamps a below-floor scheme at hire".
  it('fa3f4ccb: a scheme below the EA minimum is granted as configured at hire', async () => {
    const { grade } = await gradeHScheme(4); // below the <2y statutory minimum of 8
    const emp = await hire({ hiredOn: '2026-01-01', gradeId: grade.id });
    expect(await annualBalance(emp.employmentId)).toBe(4);
  });

  it('the bulk-import hire path grants scheme days too (inherits hireEmployee)', async () => {
    const ctx = adminCtx(b);
    // Ungraded imports resolve gradeGroupId null ⇒ match a null-group full_time scheme.
    const scheme = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: null,
      name: 'Company-wide permanent',
      status: 'active',
    });
    await upsertSchemeEntitlement(ctx, {
      benefitSchemeId: scheme.id,
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: flat(12),
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
    expect(await annualBalance(row.employmentId)).toBe(8); // 12 × 8/12, scheme-driven
  });
});

describe('ae5b84d5 — profile-change recalc reads the scheme table', () => {
  it('a grade change into a grade group posts the upfront delta, records the audit row, and is idempotent', async () => {
    const { grade } = await gradeHScheme(16);
    // fa3f4ccb: an unconfigured type grants nothing now that the statutory pack no longer backfills, and
    // the recalc path only CORRECTS an existing grant. This test is about the grade change moving the
    // balance, so it needs a configured baseline — 8 days, the same figure the EA floor used to supply, so
    // the delta and final balance asserted below are unchanged.
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 8,
      validFrom: '2020-01-01',
    });
    const emp = await hire({ hiredOn: '2026-01-01' }); // ungraded ⇒ the group-default policy
    expect(await annualBalance(emp.employmentId)).toBe(8);

    await setEmploymentGrade(adminCtx(b), { employmentId: emp.employmentId, gradeId: grade.id });
    const res = await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    expect(res).toEqual({ affected: 1, totalDelta: 8 });
    expect(await annualBalance(emp.employmentId)).toBe(16); // scheme band 16

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

  it('an employment type change re-matches to a different scheme and adjusts', async () => {
    const ctx = adminCtx(b);
    const { grade, group } = await gradeHScheme(16); // full_time scheme = 16
    const contractScheme = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'contract',
      gradeGroupId: group.id,
      name: 'Contract Grade H',
      status: 'active',
    });
    await upsertSchemeEntitlement(ctx, {
      benefitSchemeId: contractScheme.id,
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: flat(10),
    });

    const emp = await hire({ hiredOn: '2026-01-01', gradeId: grade.id });
    expect(await annualBalance(emp.employmentId)).toBe(16); // full_time scheme at hire

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
    expect(await annualBalance(emp.employmentId)).toBe(10); // contract scheme (≥ floor 8)
  });

  it('earned method: the recalc delta equals the cron target, so the next run grants nothing extra', async () => {
    const ctx = adminCtx(b);
    await createLeavePolicy(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      method: 'earned_monthly',
      validFrom: '2026-01-01',
    });
    const { grade } = await gradeHScheme(24); // scheme target 24/yr = 2/mo
    const gradeX = await createJobGrade(ctx, { code: 'GX', name: 'Grade X' }); // in no group ⇒ no scheme

    const emp = await hire({ hiredOn: '2026-01-01', gradeId: gradeX.id }); // earned ⇒ no hire lump
    await accrueEarnedLeave(ctx, { asOf: '2026-05-31' }); // 12/12 × 5 = 5
    expect(await annualBalance(emp.employmentId)).toBe(5);

    // Promotion into the Grade H group mid-cycle: recalc trues the elapsed periods up to the scheme rate.
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
    // …and the next month tops up exactly one more scheme-rate period (24/12 × 6 = 12).
    await accrueEarnedLeave(ctx, { asOf: '2026-06-30' });
    expect(await annualBalance(emp.employmentId)).toBe(12);
  });

  it('Maximum Balance cap: the recalc never lifts the in-cycle total above maxBalanceDays', async () => {
    const ctx = adminCtx(b);
    await createLeavePolicy(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 10,
      serviceBands: [{ fromYears: 0, toYears: null, days: 10, maxBalanceDays: 12 }],
      validFrom: '2026-01-01',
    });
    const { grade } = await gradeHScheme(20); // scheme says 20 — above the cap
    const emp = await hire({ hiredOn: '2026-01-01' }); // ungraded: policy 10 (≥ floor 8), under the cap
    expect(await annualBalance(emp.employmentId)).toBe(10);

    await setEmploymentGrade(ctx, { employmentId: emp.employmentId, gradeId: grade.id });
    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    // expected = min(max(floor 8, scheme 20), cap 12) = 12 ⇒ +2, NOT +10.
    expect(res).toEqual({ affected: 1, totalDelta: 2 });
    expect(await annualBalance(emp.employmentId)).toBe(12);
    const again = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    expect(again).toEqual({ affected: 0, totalDelta: 0 }); // never creeps past the cap
  });

  it('materialized-only pin: a scheme type with NO accrual row this cycle posts nothing (waits for its engine run)', async () => {
    const ctx = adminCtx(b);
    const { grade, scheme } = await gradeHScheme(12);
    // A second leave type the scheme grants — but the employee has never had it materialized this cycle.
    const [sick] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'SICK', name: 'Sick Leave', paid: true })
      .returning({ id: schema.leaveType.id });
    await upsertSchemeEntitlement(ctx, {
      benefitSchemeId: scheme.id,
      leaveTypeId: sick.id,
      serviceBands: flat(20),
    });

    const emp = await hire({ hiredOn: '2026-01-01', gradeId: grade.id }); // grants ANNUAL only (12)
    expect(await annualBalance(emp.employmentId)).toBe(12);

    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'grade_changed',
    });
    // ANNUAL is already at the scheme amount (delta 0); SICK has no accrual row ⇒ skipped, not seeded.
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await ledgerBalance(emp.employmentId, sick.id)).toBe(0);
  });
});
