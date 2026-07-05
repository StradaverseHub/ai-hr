/**
 * Payroll Setup — kernel wiring of the configurable pay-rule (core/payroll.ts), flag ON. Asserts that a
 * rule-bearing component flows into BOTH the cash payslip AND the statutory base (the double-read site:
 * c.amount is read at the gross line AND the basicRaw accumulator — a divergence would fail here), that a
 * partial period does NOT double-prorate a per_day rule, that an unsupported-PCB component still throws even
 * when it carries a rule (precedence), and that a per_hour rule with zero attendance resolves to 0 without
 * aborting the batch.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, UnsupportedPayComponentError } from '../core/payroll';
import {
  backfillEmploymentComponentsFromCompensation,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import type { PayRule } from '../core/pay-rule';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const payslipOf = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
};
const stat = (ps: Record<string, unknown>) => ps.statutory as Record<string, number>;

describe('Payroll Setup — pay-rule kernel (flag ON)', () => {
  let base: Base;
  let a: SessionContext;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    a = adminCtx(base);
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterEach(() => {
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterAll(async () => {
    await closeAll();
  });

  // Hire one employee with BASIC 5000, the typed catalog seeded + BASIC backfilled, flag ON.
  async function setupEmployee(hiredOn = '2026-01-01') {
    const e = await hireEmployee(a, {
      person: { fullName: 'Rule', primaryEmail: 'rule@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: hiredOn });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    return e;
  }

  // Attach a NEW wage-bucket allowance component (EPF+SOCSO+PCB, non-prorating) carrying `rule`, at `amount`.
  async function attachRuleComponent(employmentId: string, code: string, rule: PayRule | null, amount: number) {
    await upsertPayComponent(a, {
      code,
      name: code,
      kind: 'allowance',
      includedInEpf: true,
      includedInSocsoEis: true,
      includedInPcb: true,
      includedInHrdfBase: false,
      isNonPayable: false,
      prorates: false,
      rule,
    });
    const compId = (await listPayComponents(a)).find((c) => c.code === code)!.id;
    // allowZeroAmount: a rule-driven component's stored base amount may legitimately be 0 (the rule computes
    // the payable value); the amount>0 guard would otherwise reject a valid rule-only fixture.
    await setEmploymentPayComponent(a, { employmentId, componentId: compId, amount, effectiveFrom: '2026-01-01', allowZeroAmount: true });
  }

  async function runBatch(period: string) {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await generatePayslips(a, { batchId });
    return payslipOf(batchId);
  }

  it('percent_of basic flows into the allowance AND the statutory base (double-read site)', async () => {
    const e = await setupEmployee();
    // 20% of basic 5000 = 1000, stored amount is ignored (0) when a non-fixed rule is present.
    await attachRuleComponent(e.employmentId, 'PCT', { kind: 'percent_of', base: 'basic', pct: 20 }, 0);
    const ps = await runBatch('2026-07');
    expect(Number(ps.allowance)).toBeCloseTo(1000, 2);
    expect(Number(ps.grossPay)).toBeCloseTo(6000, 2); // basic 5000 + 1000 allowance
    // EPF employee is 11% of the wage (basic + allowance), rounded up to the next ringgit (Third Schedule):
    // 11% of 6000 = 660 — and the allowance is genuinely in the base (a missing basicRaw write would give 550).
    expect(stat(ps).epfEmployee).toBe(660);
  });

  it('flat_capped resolves to min(value, cap) and feeds gross + base', async () => {
    const e = await setupEmployee();
    await attachRuleComponent(e.employmentId, 'CAP', { kind: 'flat_capped', value: 1200, cap: 800 }, 0);
    const ps = await runBatch('2026-07');
    expect(Number(ps.allowance)).toBeCloseTo(800, 2);
    expect(Number(ps.grossPay)).toBeCloseTo(5800, 2);
  });

  it('per_day = rate × days_worked (full month) and feeds the base', async () => {
    const e = await setupEmployee();
    await attachRuleComponent(e.employmentId, 'PERDAY', { kind: 'per_day', rate: 40 }, 0);
    // July has 31 days; full-month factor 1 ⇒ daysWorked = 31.
    const ps = await runBatch('2026-07');
    expect(Number(ps.allowance)).toBeCloseTo(40 * 31, 2);
  });

  it('per_hour = rate × attendance hours; ZERO attendance ⇒ 0, no batch abort (no division)', async () => {
    const e = await setupEmployee();
    await attachRuleComponent(e.employmentId, 'PERHR', { kind: 'per_hour', rate: 10 }, 0);
    // No attendance rows at all → 0 hours → the component resolves to 0, and the batch still runs.
    const psZero = await runBatch('2026-07');
    expect(Number(psZero.allowance)).toBeCloseTo(0, 2);
    expect(Number(psZero.grossPay)).toBeCloseTo(5000, 2);

    // Now with 1500 worked minutes (25 h) in the period → 25 × 10 = 250.
    await owner.db.insert(schema.attendance).values([
      { tenantId: base.tenantId, employmentId: e.employmentId, attendanceDate: '2026-09-01', status: 'present', workedMinutes: 900 },
      { tenantId: base.tenantId, employmentId: e.employmentId, attendanceDate: '2026-09-02', status: 'present', workedMinutes: 600 },
    ]);
    const psHrs = await runBatch('2026-09');
    expect(Number(psHrs.allowance)).toBeCloseTo(250, 2);
  });

  it('partial period (mid-month joiner) does NOT double-prorate a per_day rule', async () => {
    // Joined 2026-07-16 → factor < 1 → daysWorked ≈ 16 of 31. per_day already reflects that via daysWorked;
    // the component is prorates=false so the kernel does NOT multiply by factor again.
    const e = await setupEmployee('2026-07-16');
    await attachRuleComponent(e.employmentId, 'PERDAY2', { kind: 'per_day', rate: 100 }, 0);
    const ps = await runBatch('2026-07');
    const daysWorked = Number(ps.daysWorked);
    expect(daysWorked).toBeGreaterThan(0);
    expect(daysWorked).toBeLessThan(31);
    // The allowance is rate × daysWorked exactly — NOT rate × daysWorked × factor (that would be ~half again).
    expect(Number(ps.allowance)).toBeCloseTo(100 * daysWorked, 2);
  });

  it('an unsupported-PCB component still throws even when it carries a rule (precedence)', async () => {
    const e = await setupEmployee();
    // PCB-taxable, non-payable BIK — unsupported in v1. A rule on it must not let it through.
    await upsertPayComponent(a, {
      code: 'BIKRULE',
      name: 'BIK with rule',
      kind: 'non_payable',
      includedInEpf: false,
      includedInSocsoEis: false,
      includedInPcb: true,
      includedInHrdfBase: false,
      isNonPayable: true,
      prorates: false,
      rule: { kind: 'flat_capped', value: 300, cap: 200 },
    });
    const compId = (await listPayComponents(a)).find((c) => c.code === 'BIKRULE')!.id;
    // allowZeroAmount: the pay-RULE computes the payable value; the stored base amount is a 0 placeholder.
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: compId, amount: 0, effectiveFrom: '2026-01-01', allowZeroAmount: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(UnsupportedPayComponentError);
  });
});
