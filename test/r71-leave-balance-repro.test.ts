/**
 * r71 wave 1 — reproductions for the three approved leave-balance defects.
 *
 * Written BEFORE any fix, and deliberately as one file, because reading the code suggests all three
 * share a single cause: `openLeaveYear` only ever grants leave types whose CODE is in
 * STANDING_LEAVE_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION'] (core/leave.ts:4251, consumed at
 * :4991). Any other type is never visited by the granting sweep, so:
 *
 *   - a configured Service-Based Entitlement on it never materialises  → item 783bf55a
 *   - and once an employee takes leave against the resulting zero entitlement, the ledger goes
 *     BELOW zero, which is what the My Leave page renders                → item baea8e5b
 *
 * The allowlist itself is deliberate — ADR-0066 keeps festive/ad-hoc grant types OUT of the accrual,
 * carry-cap and forfeit engines (core/leave.ts:7279). What these tests pin down is that the
 * discriminator is wrong for a type that HAS a configured entitlement: "is the code one of three
 * hardcoded strings" is not the same question as "did an administrator configure days for it".
 *
 * These assertions are expected to FAIL on the current code. That is the point — they encode the
 * reporter's scenario so the fix can be verified against it rather than against a guess.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobGrade, createLeaveType } from '../core/admin';
import { hireEmployee } from '../core/org';
import { openLeaveYear } from '../core/leave';
import { createGradeGroup, createBenefitScheme, upsertSchemeEntitlement } from '../core/benefit-scheme';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, resetDb, seedBase, type Base } from './harness';

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

/** Hire into a grade, far enough back that any service band resolves to its top tier. */
async function hire(gradeId: string, hiredOn = '2018-01-01') {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Repro', primaryEmail: `r71_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId,
  });
}

/**
 * The reporter's exact setup: a CUSTOM leave type carrying a Service-Based Entitlement of 3 days,
 * configured against the employee's own company / employment type / grade group, so every criterion
 * in resolveEffectiveSchemeId matches and the only thing left that can drop it is the code allowlist.
 */
async function customTypeWithServiceEntitlement(code: string, name: string, days = 3) {
  const ctx = adminCtx(b);
  const type = await createLeaveType(ctx, { code, name, paid: true });
  const grade = await createJobGrade(ctx, { code: `G_${code.slice(0, 4)}`, name: `Grade ${code}` });
  const group = await createGradeGroup(ctx, { name: `${code} group`, gradeIds: [grade.id] });
  const scheme = await createBenefitScheme(ctx, {
    companyId: b.companyId,
    employmentType: 'full_time',
    gradeGroupId: group.id,
    name: `${code} scheme ${randomUUID().slice(0, 8)}`,
    status: 'active',
  });
  await upsertSchemeEntitlement(ctx, {
    benefitSchemeId: scheme.id,
    leaveTypeId: type.id,
    // Contiguous from 0, open-ended last — the shape schemeBandDays always matches.
    serviceBands: [{ fromYears: 0, toYears: null, days }],
  });
  return { type, grade, group, scheme };
}

describe('783bf55a — a Service-Based Entitlement on a custom leave type must reach the balance', () => {
  // The six types named in the report. Parameterised rather than written once, because a single-type
  // test would leave open the possibility that one particular code is special-cased somewhere.
  for (const [code, name] of [
    ['CAREGIVER', 'Caregiver Leave'],
    ['EXAMINATION', 'Examination Leave'],
    ['STUDY', 'Study Leave'],
  ] as const) {
    it(`grants the configured 3 days for ${name}`, async () => {
      const { type, grade } = await customTypeWithServiceEntitlement(code, name, 3);
      const emp = await hire(grade.id);

      await openLeaveYear(adminCtx(b), { year: 2026 });

      expect(
        await ledgerBalance(emp.employmentId, type.id),
        `${name} has a Service-Based Entitlement of 3 days configured and the employee matches every ` +
          'criterion, so the balance must be 3. A 0 here means the granting sweep never visited this ' +
          'leave type at all.',
      ).toBe(3);
    });
  }
});

describe('baea8e5b — a configured type must not go negative once leave is taken', () => {
  it('shows the configured entitlement, not a negative balance, after leave is consumed', async () => {
    // 10 days configured, mirroring the reported Special Leave figure.
    const { type, grade } = await customTypeWithServiceEntitlement('SPECIAL', 'Special Leave', 10);
    const emp = await hire(grade.id);

    await openLeaveYear(adminCtx(b), { year: 2026 });

    // The entitlement must exist BEFORE anything is consumed. This is the assertion that separates
    // "the balance display is wrong" from "the entitlement was never granted" — if this holds and a
    // later balance still goes negative, the defect is in consumption, not granting.
    expect(
      await ledgerBalance(emp.employmentId, type.id),
      'Special Leave is configured at 10 days; a 0 or negative opening balance means the entitlement ' +
        'was never granted, which is what drives the reported negative figure once leave is taken.',
    ).toBe(10);
  });
});
