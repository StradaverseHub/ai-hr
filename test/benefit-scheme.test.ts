/**
 * Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b).
 *
 * Pure-resolver tests exercise core/leave-compute.ts directly (resolveEffectiveSchemeId auto-match/override,
 * schemeBandDays). Integration tests exercise the full stack: a benefit scheme's service-band entitlement
 * supersedes the grade policy at openLeaveYear, the EA-1955 floor still clamps on top, and an employee with
 * no scheme falls back to the grade/floor behaviour unchanged.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { createJobGrade } from '../core/admin';
import { openLeaveYear } from '../core/leave';
import {
  resolveEffectiveSchemeId,
  schemeBandDays,
  type BenefitSchemeRow,
} from '../core/leave-compute';
import {
  createGradeGroup,
  createBenefitScheme,
  upsertSchemeEntitlement,
  listBenefitSchemes,
  setEmploymentBenefitScheme,
} from '../core/benefit-scheme';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, resetDb, seedBase, type Base } from './harness';

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

  it('EA-1955 floor still clamps when the scheme band is below it', async () => {
    const { grade } = await setupScheme([12, 14, 10]);
    const emp = await hire('2018-01-01', grade.id); // ≥5y band = 10, floor = 16
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(16); // floor wins
  });

  it('picks the correct band for a shorter-service employee (2–5y)', async () => {
    const { grade } = await setupScheme([12, 15, 20]);
    const emp = await hire('2023-01-01', grade.id); // 3 years ⇒ 2–5y band = 15, floor = 12
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(15); // max(floor 12, scheme 15)
  });

  it('falls back to the EA floor when the employee has no scheme (back-compat)', async () => {
    // A graded employee whose grade is NOT in any scheme's group ⇒ no scheme ⇒ floor-only.
    const grade = await createJobGrade(adminCtx(b), { code: 'GX', name: 'Grade X' });
    const emp = await hire('2018-01-01', grade.id);
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(16); // EA floor at ≥5y, no scheme override
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
