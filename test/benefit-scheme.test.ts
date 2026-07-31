/**
 * Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b).
 *
 * Pure-resolver tests exercise core/leave-compute.ts directly (resolveEffectiveSchemeId auto-match/override,
 * schemeBandDays). Integration tests exercise the full stack: a benefit scheme's service-band entitlement
 * supersedes the grade policy at openLeaveYear, the EA-1955 floor still clamps on top, and an employee with
 * no scheme falls back to the grade/floor behaviour unchanged.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createJobGrade, createLeavePolicy } from '../core/admin';
import { accrueEarnedLeave, openLeaveYear, reprojectEntitlementForSchemeCohort } from '../core/leave';
import {
  resolveEffectiveSchemeId,
  schemeBandDays,
  type BenefitSchemeRow,
} from '../core/leave-compute';
import {
  createGradeGroup,
  updateGradeGroup,
  createBenefitScheme,
  updateBenefitScheme,
  upsertSchemeEntitlement,
  listBenefitSchemes,
  setEmploymentBenefitScheme,
} from '../core/benefit-scheme';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

// Three-tier bands: <2y, 2–5y, ≥5y.
const tier = (d0: number, d1: number, d2: number) => [
  { fromYears: 0, toYears: 2, days: d0 },
  { fromYears: 2, toYears: 5, days: d1 },
  { fromYears: 5, toYears: null, days: d2 },
];

const hire = (hiredOn: string, gradeId: string | null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Scheme', primaryEmail: `scheme_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
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
});

describe('resolveEffectiveSchemeId (pure)', () => {
  const schemes: BenefitSchemeRow[] = [
    { id: 'aaa', companyId: 'C1', employmentType: 'full_time', gradeGroupId: 'G1', status: 'active' },
    { id: 'bbb', companyId: 'C1', employmentType: 'contract', gradeGroupId: 'G1', status: 'active' },
    { id: 'ccc', companyId: 'C1', employmentType: 'full_time', gradeGroupId: 'G1', status: 'inactive' },
  ];

  it('auto-matches by company + employment type + grade group', () => {
    expect(
      resolveEffectiveSchemeId(schemes, { companyId: 'C1', employmentType: 'full_time', gradeGroupId: 'G1', overrideSchemeId: null }),
    ).toBe('aaa');
    expect(
      resolveEffectiveSchemeId(schemes, { companyId: 'C1', employmentType: 'contract', gradeGroupId: 'G1', overrideSchemeId: null }),
    ).toBe('bbb');
  });

  it('returns null when nothing matches', () => {
    expect(
      resolveEffectiveSchemeId(schemes, { companyId: 'C2', employmentType: 'full_time', gradeGroupId: 'G1', overrideSchemeId: null }),
    ).toBeNull();
    expect(
      resolveEffectiveSchemeId(schemes, { companyId: 'C1', employmentType: 'intern', gradeGroupId: 'G1', overrideSchemeId: null }),
    ).toBeNull();
  });

  it('override to an active scheme wins over auto-match', () => {
    expect(
      resolveEffectiveSchemeId(schemes, { companyId: 'C1', employmentType: 'full_time', gradeGroupId: 'G1', overrideSchemeId: 'bbb' }),
    ).toBe('bbb');
  });

  it('override to an inactive/unknown scheme is ignored (falls to auto-match)', () => {
    expect(
      resolveEffectiveSchemeId(schemes, { companyId: 'C1', employmentType: 'full_time', gradeGroupId: 'G1', overrideSchemeId: 'ccc' }),
    ).toBe('aaa');
    expect(
      resolveEffectiveSchemeId(schemes, { companyId: 'C1', employmentType: 'full_time', gradeGroupId: 'G1', overrideSchemeId: 'zzz' }),
    ).toBe('aaa');
  });
});

describe('schemeBandDays (pure)', () => {
  it('resolves the matching band days per service length', () => {
    const bands = tier(12, 14, 16);
    expect(schemeBandDays(bands, 0)).toBe(12);
    expect(schemeBandDays(bands, 1)).toBe(12);
    expect(schemeBandDays(bands, 2)).toBe(14);
    expect(schemeBandDays(bands, 4)).toBe(14);
    expect(schemeBandDays(bands, 5)).toBe(16);
    expect(schemeBandDays(bands, 10)).toBe(16);
  });

  it('returns null for malformed / empty bands (⇒ caller falls back)', () => {
    expect(schemeBandDays([], 3)).toBeNull();
    expect(schemeBandDays(null, 3)).toBeNull();
    expect(schemeBandDays([{ fromYears: 1, toYears: null, days: 5 }], 3)).toBeNull(); // not starting at 0
  });
});

describe('scheme entitlement drives openLeaveYear grant', () => {
  async function setupScheme(days: readonly [number, number, number]) {
    const ctx = adminCtx(b);
    const grade = await createJobGrade(ctx, { code: 'GH', name: 'Grade H' });
    const group = await createGradeGroup(ctx, { name: 'Grade H group', gradeIds: [grade.id] });
    const scheme = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: group.id,
      name: `Permanent - Grade H ${randomUUID().slice(0, 8)}`,
      status: 'active',
    });
    await upsertSchemeEntitlement(ctx, {
      benefitSchemeId: scheme.id,
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: tier(days[0], days[1], days[2]),
    });
    return { grade, group, scheme };
  }

  it('grants the scheme band days when above the EA floor (≥5y)', async () => {
    const { grade } = await setupScheme([12, 18, 20]);
    const emp = await hire('2018-01-01', grade.id); // ~8 years at 2026-01-01 ⇒ ≥5y band = 20
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(20); // max(floor 16, scheme 20)
  });

  // fa3f4ccb: was "EA-1955 floor still clamps when the scheme band is below it". Approved in writing —
  // the scheme band is now granted as configured and flagged on screen, not silently raised to 16.
  it('fa3f4ccb: a scheme band below the EA minimum is granted as configured', async () => {
    const { grade } = await setupScheme([12, 14, 10]);
    const emp = await hire('2018-01-01', grade.id); // ≥5y band = 10, statutory minimum = 16
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(10);
  });

  it('picks the correct band for a shorter-service employee (2–5y)', async () => {
    const { grade } = await setupScheme([12, 15, 20]);
    const emp = await hire('2023-01-01', grade.id); // 3 years ⇒ 2–5y band = 15, floor = 12
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(15); // max(floor 12, scheme 15)
  });

  // fa3f4ccb: was "falls back to the EA floor when the employee has no scheme". The statutory pack no
  // longer BACKFILLS an unconfigured type: with no scheme AND no leave_policy row there is nothing to
  // grant, so the sweep grants nothing. This is the single most visible consequence of the approved
  // change and is asserted here deliberately rather than left to be discovered.
  it('fa3f4ccb: no scheme AND no policy ⇒ nothing granted (the floor no longer backfills)', async () => {
    // A graded employee whose grade is NOT in any scheme's group ⇒ no scheme ⇒ policy-only.
    const grade = await createJobGrade(adminCtx(b), { code: 'GX', name: 'Grade X' });
    const emp = await hire('2018-01-01', grade.id);
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(0);
  });

  it('a manual override supersedes auto-match', async () => {
    const ctx = adminCtx(b);
    const grade = await createJobGrade(ctx, { code: 'GH', name: 'Grade H' });
    const group = await createGradeGroup(ctx, { name: 'GH group', gradeIds: [grade.id] });
    // Auto-match scheme for full_time / GH grants 20 at ≥5y…
    await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: group.id,
      name: 'Auto scheme',
      status: 'active',
    });
    // …but a richer override scheme (no group) grants 25.
    const override = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: null,
      name: 'Override scheme',
      status: 'active',
    });
    const schemes = await listBenefitSchemes(ctx);
    const auto = schemes.find((s) => s.name === 'Auto scheme')!;
    await upsertSchemeEntitlement(ctx, { benefitSchemeId: auto.id, leaveTypeId: b.annualLeaveTypeId, serviceBands: tier(12, 18, 20) });
    await upsertSchemeEntitlement(ctx, { benefitSchemeId: override.id, leaveTypeId: b.annualLeaveTypeId, serviceBands: tier(15, 22, 25) });

    const emp = await hire('2018-01-01', grade.id);
    await setEmploymentBenefitScheme(ctx, { employmentId: emp.employmentId, benefitSchemeId: override.id });
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(25); // override scheme, not the auto-matched 20
  });
});

// ── Auto Link Leave Entitlement with Employee Profile (feedback ae5b84d5) ───────────────────────────────
// Scheme-side triggers: a manual override change corrects the balance on the spot; editing the scheme's
// entitlement table / the grade-group membership / the scheme itself trues up every covered employee —
// including downward corrections the granting engines can never post.
const ASOF = '2026-06-30';
const flat = (days: number) => [{ fromYears: 0, toYears: null, days }];

/** Recalc-audit reasons recorded for one employment (owner read — bypasses RLS for assertions). */
const auditReasons = async (employmentId: string) => {
  const rows = await owner.db
    .select({ reason: schema.leaveEntitlementRecalcAudit.reason })
    .from(schema.leaveEntitlementRecalcAudit)
    .where(eq(schema.leaveEntitlementRecalcAudit.employmentId, employmentId));
  return rows.map((r) => r.reason);
};

/** Grade + group + active full_time scheme with an ANNUAL entitlement of `days`. */
async function schemeSetup(days: number, code = 'GH') {
  const ctx = adminCtx(b);
  const grade = await createJobGrade(ctx, { code, name: `Grade ${code}` });
  const group = await createGradeGroup(ctx, { name: `${code} group`, gradeIds: [grade.id] });
  const scheme = await createBenefitScheme(ctx, {
    companyId: b.companyId,
    employmentType: 'full_time',
    gradeGroupId: group.id,
    name: `Scheme ${code} ${randomUUID().slice(0, 8)}`,
    status: 'active',
  });
  await upsertSchemeEntitlement(ctx, {
    benefitSchemeId: scheme.id,
    leaveTypeId: b.annualLeaveTypeId,
    serviceBands: flat(days),
  });
  return { grade, group, scheme };
}

describe('ae5b84d5 — manual override corrects the balance on the spot', () => {
  it('assigning and clearing the override both post correcting adjustments immediately', async () => {
    const ctx = adminCtx(b);
    const { scheme } = await schemeSetup(15);
    // fa3f4ccb: an unconfigured type grants nothing now that the statutory pack no longer backfills, and
    // the recalc path only CORRECTS an existing grant — so the baseline this test is about (assign the
    // override, watch the balance move) needs a real configured entitlement. 8 days is the same baseline
    // figure the EA floor used to supply, so every assertion below is unchanged.
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 8,
      validFrom: '2020-01-01',
    });
    const emp = await hire('2026-01-01', null); // ungraded ⇒ no auto-match ⇒ the group-default policy
    expect(await balance(emp.employmentId)).toBe(8);

    await setEmploymentBenefitScheme(ctx, { employmentId: emp.employmentId, benefitSchemeId: scheme.id });
    expect(await balance(emp.employmentId)).toBe(15); // corrected on the spot, no engine run needed

    await setEmploymentBenefitScheme(ctx, { employmentId: emp.employmentId, benefitSchemeId: null });
    expect(await balance(emp.employmentId)).toBe(8); // cleared ⇒ reverted on the spot

    expect(await auditReasons(emp.employmentId)).toEqual(['benefit_scheme_override', 'benefit_scheme_override']);
  });
});

describe('ae5b84d5 — scheme-side config edits true the covered cohort up', () => {
  it('an entitlement band edit trues up AND down; re-saving the same values posts nothing', async () => {
    const ctx = adminCtx(b);
    const { grade, scheme } = await schemeSetup(12);
    const emp = await hire('2026-01-01', grade.id);
    expect(await balance(emp.employmentId)).toBe(12); // scheme days at hire

    await upsertSchemeEntitlement(ctx, { benefitSchemeId: scheme.id, leaveTypeId: b.annualLeaveTypeId, serviceBands: flat(15) });
    const up = await reprojectEntitlementForSchemeCohort(ctx, { schemeId: scheme.id, trigger: 'scheme_entitlement_changed', asOf: ASOF });
    expect(up.affected).toBe(1);
    expect(await balance(emp.employmentId)).toBe(15);

    await upsertSchemeEntitlement(ctx, { benefitSchemeId: scheme.id, leaveTypeId: b.annualLeaveTypeId, serviceBands: flat(10) });
    const down = await reprojectEntitlementForSchemeCohort(ctx, { schemeId: scheme.id, trigger: 'scheme_entitlement_changed', asOf: ASOF });
    expect(down.affected).toBe(1);
    expect(await balance(emp.employmentId)).toBe(10); // downward, openly (still ≥ the floor 8)

    await upsertSchemeEntitlement(ctx, { benefitSchemeId: scheme.id, leaveTypeId: b.annualLeaveTypeId, serviceBands: flat(10) });
    const again = await reprojectEntitlementForSchemeCohort(ctx, { schemeId: scheme.id, trigger: 'scheme_entitlement_changed', asOf: ASOF });
    expect(again.affected).toBe(0); // idempotent — nothing re-posts
    expect(await balance(emp.employmentId)).toBe(10);
  });

  it('an EARNED downward correction lands as a negative adjustment (the monthly run alone can never post it)', async () => {
    const ctx = adminCtx(b);
    await createLeavePolicy(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, method: 'earned_monthly', validFrom: '2026-01-01' });
    const { grade, scheme } = await schemeSetup(24);
    const emp = await hire('2026-01-01', grade.id); // earned ⇒ no hire lump
    await accrueEarnedLeave(ctx, { asOf: '2026-05-31' }); // scheme target: 24/12 × 5 = 10
    expect(await balance(emp.employmentId)).toBe(10);

    await upsertSchemeEntitlement(ctx, { benefitSchemeId: scheme.id, leaveTypeId: b.annualLeaveTypeId, serviceBands: flat(12) });
    const res = await reprojectEntitlementForSchemeCohort(ctx, { schemeId: scheme.id, trigger: 'scheme_entitlement_changed', asOf: '2026-05-31' });
    expect(res.affected).toBe(1);
    expect(await balance(emp.employmentId)).toBe(5); // 12/12 × 5 — trued DOWN

    const [adj] = await owner.db
      .select({ days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.employmentId, emp.employmentId), eq(schema.leaveLedger.entryType, 'adjustment')));
    expect(Number(adj.days)).toBe(-5); // a signed negative adjustment — accrueEarnedLeave only grants positives

    await accrueEarnedLeave(ctx, { asOf: '2026-05-31' }); // the cron sees the recalc credit — no re-grant
    expect(await balance(emp.employmentId)).toBe(5);
  });

  it('moving a grade between groups trues up the moved cohort (config-side group transfer)', async () => {
    const ctx = adminCtx(b);
    const a = await schemeSetup(16, 'GA');
    const z = await schemeSetup(20, 'GB');
    const empA = await hire('2026-01-01', a.grade.id);
    const empB = await hire('2026-01-01', z.grade.id);
    expect(await balance(empA.employmentId)).toBe(16);
    expect(await balance(empB.employmentId)).toBe(20);

    // Move grade GA into GB's group — updateGradeGroup returns the UNION of before/after members.
    const { gradeIds } = await updateGradeGroup(ctx, { id: z.group.id, name: 'GB group', gradeIds: [z.grade.id, a.grade.id] });
    expect([...gradeIds].sort()).toEqual([a.grade.id, z.grade.id].sort());
    const res = await reprojectEntitlementForSchemeCohort(ctx, { gradeIds, trigger: 'grade_group_changed', asOf: ASOF });
    expect(res.affected).toBe(1); // only the moved grade's employee posts a delta
    expect(await balance(empA.employmentId)).toBe(20); // re-matched to GB's scheme
    expect(await balance(empB.employmentId)).toBe(20); // superset cohort ⇒ delta 0, untouched
    expect(await auditReasons(empA.employmentId)).toEqual(['grade_group_changed']);
  });

  it('deactivating a scheme reverts covered employees to policy days with the scheme_updated trigger', async () => {
    const ctx = adminCtx(b);
    await createLeavePolicy(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2026-01-01' });
    const { grade, group, scheme } = await schemeSetup(20);
    const emp = await hire('2026-01-01', grade.id);
    expect(await balance(emp.employmentId)).toBe(20);

    const { changed } = await updateBenefitScheme(ctx, {
      id: scheme.id,
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: group.id,
      name: 'Deactivated scheme',
      status: 'inactive',
    });
    expect(changed).toBe(true); // status is a match-identity change ⇒ the action fires the cohort recalc
    const res = await reprojectEntitlementForSchemeCohort(ctx, { schemeId: scheme.id, trigger: 'scheme_updated', asOf: ASOF });
    expect(res.affected).toBe(1);
    expect(await balance(emp.employmentId)).toBe(12); // back to the grade-policy days
    expect(await auditReasons(emp.employmentId)).toEqual(['scheme_updated']);

    // A pure rename is NOT a match-identity change — the action skips the cohort recalc.
    const renamed = await updateBenefitScheme(ctx, {
      id: scheme.id,
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: group.id,
      name: 'Renamed scheme',
      status: 'inactive',
    });
    expect(renamed.changed).toBe(false);
  });
});
