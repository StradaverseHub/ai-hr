/**
 * Wave 2A — HRD Corp (HRDF) levy (PSMB Act 2001). Two layers:
 *   • calculator (hrdfLevy): rate by registration band, employer-only, 2dp, floor at 0.
 *   • kernel (generatePayslips): the levy rides the payslip (employer-only) + batch totals + employer
 *     cost; the HRDF base is basic + FIXED allowance net of unpaid leave — NOT the EPF/SOCSO wage
 *     (overtime and bonus are excluded); and a not-registered company is byte-identical to pre-HRDF.
 * Sourced + re-verified in docs/wave2-payroll-design.md.
 *
 * ADR-0077 slice 3 — WHY THIS FILE DRIVES THE KERNEL THROUGH `entitledCtx`, NOT `adminCtx`.
 * Every assertion below is about the LEGACY earnings path: the HRDF base is `compensation.basic +
 * compensation.monthly_allowance`, and overtime/bonus come from `payroll_input`. That path is selected
 * by `typed_pay_components` being OFF (core/payroll.ts `earningsOf`) — under the typed path the kernel
 * reads the component tables instead, and a tenant with no `employment_pay_component` rows would
 * contribute a ZERO allowance, silently turning the 4500 base into 4000 and the 3200 base into 3000.
 * The gate used to be `process.env.TYPED_PAY_COMPONENTS_ENABLED`, which test/env.ts deletes, so
 * `adminCtx` was fine. It is a per-tenant entitlement now, and when this file was converted `adminCtx`
 * was `entitlementsExempt: 'harness'` — an exempt context answered TRUE for every catalogued module,
 * which would have put this file on the TYPED path and broken the very arithmetic it exists to pin.
 * (`adminCtx` now derives its snapshot from `legacyEnabledModulesIn(process.env)` and agrees with the
 * old env read; the hazard is recorded because it is what these figures are defended against.)
 * `entitledCtx` resolves a REAL snapshot from this tenant's rows; seedBase seeds no
 * `typed_pay_components` row (it is not in this process's parity set), and a missing row is disabled
 * (C7), so the legacy path is genuinely selected. Not a weakening: no assertion changed.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hrdfLevy } from '../localization/my/payroll';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { setCompensation } from '../core/comp';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { setOthersStatutoryMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { setComponentOverrideMY } from '../localization/my/statutory-config';
import { MY_REPORTS } from '../localization/my/reports';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  setPayrollBatchComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const payslipFor = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
};
const st = (ps: { statutory: unknown }) => ps.statutory as Record<string, number>;

describe('Wave 2A — hrdfLevy calculator', () => {
  it('is 0 when the employer is not registered (regardless of base)', () => {
    expect(hrdfLevy(5000, 'not_registered')).toBe(0);
  });
  it('mandatory band = 1% of the HRDF base', () => {
    expect(hrdfLevy(5000, 'mandatory')).toBe(50);
    expect(hrdfLevy(3210, 'mandatory')).toBe(32.1);
  });
  it('optional band = 0.5% of the HRDF base', () => {
    expect(hrdfLevy(5000, 'optional')).toBe(25);
    expect(hrdfLevy(4000, 'optional')).toBe(20);
  });
  it('carries sen, rounded to 2dp (HRD Corp prescribes no round-up-to-ringgit)', () => {
    expect(hrdfLevy(3333.33, 'mandatory')).toBe(33.33);
    expect(hrdfLevy(1234.5, 'optional')).toBe(6.17); // 6.1725 → 6.17
  });
  it('floors at 0 for a zero/negative base', () => {
    expect(hrdfLevy(0, 'mandatory')).toBe(0);
    expect(hrdfLevy(-100, 'mandatory')).toBe(0);
  });
});

// One migrate/close pair for the whole file: c2ea9567 adds a second DB-backed describe below, and a
// describe-level closeAll would close the pool before that block runs.
beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});

describe('Wave 2A — HRDF in the payroll kernel', () => {
  let base: Base;
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });

  it('not-registered company ⇒ no levy, byte-identical to pre-HRDF', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'NoHrdf');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    expect(st(ps).hrdf).toBe(0);
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBe(0);
  });

  it('mandatory (1%): levy = 1% of basic + fixed allowance; on the payslip, batch total, and employer cost', async () => {
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const e = await hire(a, base, 'Hrdf1');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    // HRDF base = 4000 + 500 = 4500 → 1% = 45.00.
    expect(st(ps).hrdf).toBeCloseTo(45, 2);
    // Employer-only: no employee deduction line moved; net is unaffected by the levy.
    expect(Number(ps.netPay)).toBeCloseTo(Number(ps.grossPay) - Number(ps.totalDeductions), 2);
    // Employer cost includes the levy.
    const empCostNoHrdf = 4500 + st(ps).epfEmployer + st(ps).socsoEmployer + st(ps).eisEmployer;
    expect(Number(ps.employerCost)).toBeCloseTo(empCostNoHrdf + 45, 2);

    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBeCloseTo(45, 2);
  });

  it('optional (0.5%): HRDF base EXCLUDES overtime and bonus (unlike the SOCSO/PCB base)', async () => {
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'optional' });
    const e = await hire(a, base, 'Hrdf2');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 200, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    // Overtime + bonus are paid this month but must NOT enter the HRDF base.
    await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 600, bonusAmount: 1000 });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    // HRDF base = basic 3000 + fixed allowance 200 = 3200 → 0.5% = 16.00 (NOT 0.5% of 3200+600+1000).
    expect(st(ps).hrdf).toBeCloseTo(16, 2);
  });

  it('c2ea9567 — the legacy untyped path is unchanged and stamps its compensation allowance as one line', async () => {
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const e = await hire(a, base, 'HrdfLegacy');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const ps = await payslipFor(batchId);
    expect(st(ps).hrdf).toBe(45);
    expect(hrdfWorkingOf(ps)).toEqual({
      version: 1,
      items: [
        { kind: 'basic', amount: 4000 },
        { kind: 'allowance', amount: 500 },
      ],
      wages: 4500,
      status: 'mandatory',
      subject: true,
      rate: 0.01,
      calculatedLevy: 45,
      levy: 45,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Feedback c2ea9567 — THE HRDF TICK IS THE ONLY RULE. Typed pay items, on generated payslips.
//
// Every expected figure below is worked out by hand in the comment beside it from the fixture's own
// amounts and the published rates (1% mandatory, 0.5% optional), never read back from the kernel.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

type HrdfItem = { kind: string; code?: string; name?: string; amount: number };
type HrdfWorking = {
  version: number; items: HrdfItem[]; wages: number; status: string; subject: boolean;
  rate: number; calculatedLevy: number; levy: number;
};
function hrdfWorkingOf(ps: { statutory: unknown }): HrdfWorking | undefined {
  return (ps.statutory as { hrdfWorking?: HrdfWorking }).hrdfWorking;
}
const basesOf = (ps: { statutory: unknown }) => (ps.statutory as { bases: { hrdf: number } }).bases;
const byCode = (items: HrdfItem[]) =>
  items.filter((i) => i.code).map((i) => [i.kind, i.code, i.amount] as const).sort((x, y) => String(x[1]).localeCompare(String(y[1])));

describe('c2ea9567 — HRDF wages follow the HRDF tick on every pay item', () => {
  let base: Base;
  let a: SessionContext;

  const item = (code: string, name: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
    label: name,
    code,
    name,
    kind: 'allowance',
    includedInEpf: true,
    includedInSocsoEis: true,
    includedInPcb: false,
    includedInHrdfBase: false,
    isNonPayable: false,
    prorates: false,
    ...over,
  });
  const idByCode = async (code: string) =>
    (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;
  const hireTyped = async (name: string, ic: string, basic: number, hiredOn = '2026-01-01') => {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: hiredOn });
    return e;
  };
  const assign = async (employmentId: string, code: string, amount: number, from = '2026-01-01') =>
    setEmploymentPayComponent(a, { employmentId, componentId: await idByCode(code), amount, effectiveFrom: from });
  const slipOf = async (batchId: string, employmentId: string) => {
    const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    return rows.find((r) => r.employmentId === employmentId)!;
  };
  /** The reporter's meal allowance: tax-exempt in full (PCB_NON-TAXABLE), not EPF, not SOCSO. */
  const meal = (code: string, hrdf: boolean, name = 'Meal Allowance') =>
    item(code, name, {
      includedInEpf: false, includedInSocsoEis: false, includedInPcb: true, includedInHrdfBase: hrdf,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_NON-TAXABLE',
    });

  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    a = await entitledCtx(base);
    await seedPayComponentCatalog(a);
  });

  it('the reporter’s case: basic 2,400 + ticked non-taxable meal 600 = 3,000 → RM30.00 at 1%; net pay unchanged', async () => {
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await upsertPayComponent(a, meal('A0040', true));
    await upsertPayComponent(a, meal('A0041', false, 'Meal Allowance (not HRDF)')); // HRDF NOT ticked
    const ticked = await hireTyped('Ticked', '900101016001', 2400);
    const unticked = await hireTyped('Unticked', '900101016002', 2400);
    await assign(ticked.employmentId, 'A0040', 600);
    await assign(unticked.employmentId, 'A0041', 600);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const t = await slipOf(batchId, ticked.employmentId);
    const u = await slipOf(batchId, unticked.employmentId);

    // Before c2ea9567 the ticked meal allowance counted its TAXABLE part, RM0, and the levy was 24.00.
    expect(basesOf(t).hrdf).toBe(3000);
    expect(st(t).hrdf).toBe(30);
    // The unticked twin stays out: 2,400 → 24.00.
    expect(basesOf(u).hrdf).toBe(2400);
    expect(st(u).hrdf).toBe(24);

    // The levy is an employer cost: everything the employee sees is identical between the two.
    for (const k of ['grossPay', 'totalDeductions', 'netPay', 'allowance', 'basicSalary'] as const) {
      expect(Number(t[k]), k).toBe(Number(u[k]));
    }
    for (const k of ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'eisEmployee', 'eisEmployer', 'pcb'] as const) {
      expect(Number(st(t)[k]), k).toBe(Number(st(u)[k]));
    }
    expect(Number(t.grossPay)).toBe(3000);
    expect(Number(t.netPay)).toBeCloseTo(3000 - Number(t.totalDeductions), 2);

    // The stamp the explanation reads: every line, the stamped rate, and the levy on the payslip.
    expect(hrdfWorkingOf(t)).toEqual({
      version: 1,
      items: [
        { kind: 'basic', amount: 2400 },
        { kind: 'earning', code: 'A0040', name: 'Meal Allowance', amount: 600 },
      ],
      wages: 3000,
      status: 'mandatory',
      subject: true,
      rate: 0.01,
      calculatedLevy: 30,
      levy: 30,
    });
    expect(hrdfWorkingOf(u)!.items).toEqual([{ kind: 'basic', amount: 2400 }]);

    // Everything downstream reads st.hrdf: the batch total and the HRD Corp levy report move with it.
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBe(54); // 30 + 24
    const report = MY_REPORTS.find((r) => r.id === 'my.hrd-levy')!;
    const result = await report.generate(a, { companyId: base.companyId, periodKey: '2026-05' });
    expect(result.rows.map((r) => r.levy).sort()).toEqual([24, 30]);
  });

  it('the same case at the optional rate: 3,000 × 0.5% = RM15.00, rate stamped as 0.005', async () => {
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'optional' });
    await upsertPayComponent(a, meal('A0040', true));
    const e = await hireTyped('Optional', '900101016003', 2400);
    await assign(e.employmentId, 'A0040', 600);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const ps = await slipOf(batchId, e.employmentId);
    expect(st(ps).hrdf).toBe(15);
    expect(hrdfWorkingOf(ps)).toMatchObject({ wages: 3000, status: 'optional', rate: 0.005, calculatedLevy: 15, levy: 15 });
  });

  it('every ticked earning counts once, whatever its EPF/SOCSO/PCB route; unticked is out; a ticked deduction subtracts', async () => {
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    // Ticked, NOT EPF, SOCSO → the overtime bucket. Was excluded.
    await upsertPayComponent(a, item('TRAVEL', 'Travel Allowance', { includedInEpf: false, includedInHrdfBase: true }));
    // Ticked, EPF, NOT SOCSO → the bonus bucket. Was excluded.
    await upsertPayComponent(a, item('PHONE', 'Handphone Allowance', { includedInSocsoEis: false, includedInHrdfBase: true }));
    // Ticked back pay on the ADDITIONAL PCB stream. Was excluded.
    await upsertPayComponent(a, item('BASICBP', 'Back Pay', {
      includedInPcb: true, includedInHrdfBase: true, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    // Ticked, EPF and SOCSO — paid as a recurring line AND a one-off line of the same code this month.
    await upsertPayComponent(a, item('FIXED', 'Fixed Allowance', { includedInHrdfBase: true }));
    // NOT ticked: stays out even though EPF and SOCSO are ticked.
    await upsertPayComponent(a, item('SHIFTX', 'Shift Allowance', { includedInHrdfBase: false }));
    // Ticked DEDUCTION: taken away, as it already was.
    await upsertPayComponent(a, item('DEDX', 'Unpaid Deduction', {
      kind: 'deduction', includedInEpf: false, includedInSocsoEis: false, includedInHrdfBase: true,
    }));

    const e = await hireTyped('Mixed', '900101016004', 3000);
    await assign(e.employmentId, 'TRAVEL', 200);
    await assign(e.employmentId, 'PHONE', 150);
    await assign(e.employmentId, 'FIXED', 300);
    await assign(e.employmentId, 'SHIFTX', 400);
    await assign(e.employmentId, 'DEDX', 100);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await setPayrollBatchComponent(a, { batchId, employmentId: e.employmentId, componentId: await idByCode('BASICBP'), amount: 1000 });
    await setPayrollBatchComponent(a, { batchId, employmentId: e.employmentId, componentId: await idByCode('FIXED'), amount: 200 });
    await generatePayslips(a, { batchId });
    const ps = await slipOf(batchId, e.employmentId);

    // 3,000 + TRAVEL 200 + PHONE 150 + BASICBP 1,000 + FIXED (300 + 200) − DEDX 100 = 4,750 → 1% = 47.50.
    // SHIFTX 400 is paid but not ticked, so it is not here.
    expect(basesOf(ps).hrdf).toBe(4750);
    expect(st(ps).hrdf).toBe(47.5);
    const w = hrdfWorkingOf(ps)!;
    expect(w.wages).toBe(4750);
    expect(w.levy).toBe(47.5);
    expect(w.items[0]).toEqual({ kind: 'basic', amount: 3000 });
    // FIXED appears ONCE, its two lines summed. SHIFTX does not appear at all.
    expect(byCode(w.items)).toEqual([
      ['earning', 'BASICBP', 1000],
      ['deduction', 'DEDX', -100],
      ['earning', 'FIXED', 500],
      ['earning', 'PHONE', 150],
      ['earning', 'TRAVEL', 200],
    ]);
    expect(w.items.filter((i) => i.code === 'FIXED')).toHaveLength(1);
    expect(Math.round(w.items.reduce((s, i) => s + i.amount, 0) * 100) / 100).toBe(4750);
    // Gross still pays every earning, ticked or not: 3,000 + 200 + 150 + 1,000 + 500 + 400 = 5,250.
    expect(Number(ps.grossPay)).toBe(5250);
  });

  it('a mid-month joiner: prorated basic and prorated ticked item, 1,600 + 320 = 1,920 → RM19.20', async () => {
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await upsertPayComponent(a, item('FIXED', 'Fixed Allowance', { includedInHrdfBase: true, prorates: true }));
    // Employed 16 of May's 31 days: 3,100 × 16/31 = 1,600 and 620 × 16/31 = 320.
    const e = await hireTyped('Joiner', '900101016005', 3100, '2026-05-16');
    await assign(e.employmentId, 'FIXED', 620, '2026-05-16');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const ps = await slipOf(batchId, e.employmentId);
    expect(Number(ps.basicSalary)).toBe(1600);
    expect(basesOf(ps).hrdf).toBe(1920);
    expect(st(ps).hrdf).toBe(19.2);
    expect(hrdfWorkingOf(ps)!.items).toEqual([
      { kind: 'basic', amount: 1600 },
      { kind: 'earning', code: 'FIXED', name: 'Fixed Allowance', amount: 320 },
    ]);
  });

  it('a dated HRDF rate override is the rate applied AND the rate stamped (2% from June)', async () => {
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await upsertPayComponent(a, meal('A0040', true));
    await setComponentOverrideMY(adminCtx(base), {
      body: 'hrdf', version: 'hrdf-test-2026.06', effectiveFrom: '2026-06-01',
      data: { mandatoryRate: 0.02, optionalRate: 0.01 },
    });
    const e = await hireTyped('Dated', '900101016006', 2400);
    await assign(e.employmentId, 'A0040', 600);
    const may = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: may.batchId });
    const june = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: june.batchId });
    // May predates the override: 3,000 × 1% = 30.00. June: 3,000 × 2% = 60.00.
    const m = await slipOf(may.batchId, e.employmentId);
    const j = await slipOf(june.batchId, e.employmentId);
    expect(st(m).hrdf).toBe(30);
    expect(hrdfWorkingOf(m)).toMatchObject({ rate: 0.01, levy: 30 });
    expect(st(j).hrdf).toBe(60);
    expect(hrdfWorkingOf(j)).toMatchObject({ wages: 3000, rate: 0.02, calculatedLevy: 60, levy: 60 });
  });

  it('an unregistered company and a not-subject employee both owe 0, and the stamp says why', async () => {
    await upsertPayComponent(a, meal('A0040', true));
    const e = await hireTyped('NoLevy', '900101016007', 2400);
    await assign(e.employmentId, 'A0040', 600);
    // The seeded company is not registered.
    const first = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: first.batchId });
    const unreg = await slipOf(first.batchId, e.employmentId);
    expect(st(unreg).hrdf).toBe(0);
    expect(hrdfWorkingOf(unreg)).toMatchObject({ wages: 3000, status: 'not_registered', rate: 0, levy: 0 });

    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await setOthersStatutoryMY(a, { personId: e.personId, subjectToHrdf: false });
    const second = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: second.batchId });
    const notSubject = await slipOf(second.batchId, e.employmentId);
    expect(st(notSubject).hrdf).toBe(0);
    expect(hrdfWorkingOf(notSubject)).toMatchObject({ wages: 3000, status: 'mandatory', subject: false, rate: 0, levy: 0 });
  });

  it('an additional run still charges no levy and stamps no HRDF working, even for a ticked back pay', async () => {
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await upsertPayComponent(a, item('BASICBP', 'Back Pay', {
      includedInPcb: true, includedInHrdfBase: true, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    // Additional runs are entitlement-gated; the snapshot is point-in-time, so re-resolve after the grant.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    a = await entitledCtx(base);
    const e = await hireTyped('Extra', '900101016008', 3000);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    const run = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'off_cycle' });
    await setPayrollBatchComponent(a, { batchId: run.batchId, employmentId: e.employmentId, componentId: await idByCode('BASICBP'), amount: 1000 });
    await generatePayslips(a, { batchId: run.batchId });
    const extra = await slipOf(run.batchId, e.employmentId);
    expect(st(extra).hrdf).toBe(0);
    expect(hrdfWorkingOf(extra)).toBeUndefined();
    expect(st(await slipOf(reg.batchId, e.employmentId)).hrdf).toBe(30);
  });
});
