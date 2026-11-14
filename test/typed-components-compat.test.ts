/**
 * Wave 3 #9-3 — the byte-identical gate. With the `typed_pay_components` module entitled, the kernel
 * reads the typed component tables instead of compensation + payroll_input; back-filled from the legacy
 * data it must produce IDENTICAL payslips. We generate a batch with the module OFF, reset it, back-fill
 * components, regenerate with the module ON, and assert every payslip column + the full statutory object
 * match. Exercised across basic + allowance + overtime + bonus + taxable claim + HRDF + EPF/SOCSO/EIS/PCB,
 * for a full month and a prorated mid-month joiner.
 *
 * ADR-0077 slice 3: the gate is a per-tenant entitlement row, not TYPED_PAY_COMPONENTS_ENABLED. This file
 * therefore drives the kernel through `entitledCtx` (a snapshot resolved from this tenant's ROWS)
 * rather than `adminCtx`, whose snapshot is SYNTHETIC — derived from `legacyEnabledModulesIn(process.env)`,
 * so a `setModule` grant reaches it only through the harness's in-memory mirror of that write. The
 * snapshot is point-in-time, so the ON half re-resolves after setModule. (Until slice 3 `adminCtx` was
 * `entitlementsExempt: 'harness'` and answered TRUE for every catalogued module, under which BOTH halves
 * of this comparison would have taken the typed path and the test would have compared the typed kernel
 * against itself — the reason this file was converted.)
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips, setPayrollInput, UnsupportedPayComponentError } from '../core/payroll';
import {
  backfillBatchComponentsFromInput,
  backfillEmploymentComponentsFromCompensation,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const payslipOf = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
};
// The fields that must be byte-identical between the legacy and typed paths.
const COLS = ['basicSalary', 'allowance', 'overtimePay', 'bonus', 'daysWorked', 'grossPay', 'otherDeductions', 'totalDeductions', 'netPay', 'employerCost'] as const;
const snap = (ps: Record<string, unknown>) => ({
  cols: Object.fromEntries(COLS.map((c) => [c, ps[c]])),
  statutory: ps.statutory,
});

/**
 * 862ed0ad NARROWS THIS GUARD BY EXACTLY ONE KEY, and the narrowing is itself asserted.
 *
 * `componentLines` is PROVENANCE, not arithmetic: which pay item put how much into which figure. The
 * legacy path structurally CANNOT produce it — it has no typed components to name, it reads compensation
 * + payroll_input — so demanding byte-identity on it would forbid the typed kernel from ever recording
 * anything the legacy kernel cannot express, which is not what this gate is for. Every figure both
 * kernels compute is still compared byte-for-byte.
 *
 * The narrowing is deliberately not "ignore keys the legacy path lacks": `noUnexpectedNewKeys` fails if
 * the typed path grows ANY other key, so a future stamp cannot quietly ride in behind this exemption.
 */
const PROVENANCE_ONLY = ['componentLines'] as const;
const money = (st: unknown) => {
  const rest = { ...((st ?? {}) as Record<string, unknown>) };
  const context=rest.reportContext as Record<string,unknown>;
  expect(context.itemization).toBe('componentLines' in rest?'complete':'partial');
  rest.reportContext={...context,itemization:'validated-itemization'};
  for (const k of PROVENANCE_ONLY) delete rest[k];
  // c2ea9567 — the HRDF wages' ITEMISATION is provenance in exactly the sense componentLines is: the legacy
  // path can only name its compensation allowance ("allowance" line), the typed path names the pay item
  // behind it. The money in the stamp — wages, rate, calculated and charged levy — is still compared
  // byte-for-byte, and the items must still sum to the same wages on both paths.
  if (rest.hrdfWorking && typeof rest.hrdfWorking === 'object') {
    const { items, ...figures } = rest.hrdfWorking as { items: { amount: number }[] } & Record<string, unknown>;
    expect(Math.round(items.reduce((sum, it) => sum + it.amount, 0) * 100) / 100).toBe(figures.wages);
    rest.hrdfWorking = figures;
  }
  // 69d6ed3c — statutory trace v1 likewise: its ITEM LINES are provenance (the legacy path can only name Basic
  // and one residual line; the typed path names each pay item). Every other trace figure — the wages, the
  // schedule rows, both shares, this run's amounts — is still compared byte-for-byte, and on BOTH paths the
  // lines must add up to the very wages the lookups were made on.
  if (rest.statutoryTrace && typeof rest.statutoryTrace === 'object') {
    type Line = { epfNormal: number; epfBonus: number; socsoEis: number };
    const { items, ...figures } = rest.statutoryTrace as { items: Line[]; epf: { normalWage: number; bonusWage: number }; socso: { wage: number } } & Record<string, unknown>;
    const sum = (k: keyof Line) => Math.round(items.reduce((s, l) => s + l[k], 0) * 100) / 100;
    expect([sum('epfNormal'), sum('epfBonus'), sum('socsoEis')]).toEqual([figures.epf.normalWage, figures.epf.bonusWage, figures.socso.wage]);
    rest.statutoryTrace = figures;
  }
  return rest;
};
const noUnexpectedNewKeys = (typed: unknown, legacy: unknown) =>
  Object.keys((typed ?? {}) as object)
    .filter((k) => !(k in ((legacy ?? {}) as object)))
    .filter((k) => !(PROVENANCE_ONLY as readonly string[]).includes(k));

describe('Wave 3 #9-3 — typed components are byte-identical to the legacy kernel', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    // No explicit "turn it off" step: seedBase seeds NO tenant_module row for typed_pay_components
    // (test/env.ts deletes TYPED_PAY_COMPONENTS_ENABLED, so it is not in this process's parity set),
    // and a missing row IS disabled (C7). Each test grants the row when it wants the typed path.
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  async function runCompat(b: Base, hiredOn: string) {
    // Snapshot resolved with NO typed_pay_components row ⇒ the module is genuinely off for this context.
    const a = await entitledCtx(b);
    await setCompanyStatutoryMY(a, { companyId: b.companyId, hrdfStatus: 'mandatory' }); // exercise HRDF
    const e = await hireEmployee(a, {
      person: { fullName: 'Compat', primaryEmail: 'compat@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 500, effectiveFrom: hiredOn });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 600, bonusAmount: 1000 });
    // A taxable claim allowance (ADR-0021) — set directly so the backfill picks it up as a CLAIM component.
    await owner.db.update(schema.payrollInput).set({ claimAllowance: '200.00' }).where(eq(schema.payrollInput.batchId, batchId));

    // ── Legacy path (module off) ──
    await generatePayslips(a, { batchId });
    const legacy = snap(await payslipOf(batchId));

    // Reset the batch to draft and clear the payslip so we can regenerate the same period cleanly.
    await owner.db.delete(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    await owner.db.update(schema.payrollBatch).set({ status: 'draft' }).where(eq(schema.payrollBatch.id, batchId));

    // ── Back-fill the components, then the typed path (module on) ──
    await seedPayComponentCatalog(a);
    // RESTATED 2026-11-14 (statutory follow-ups, item 2) — owner rule: ONLY the EPF Bonus 2012 tick puts money
    // on the EPF bonus stream. The seeded BONUS code is a legacy row (EPF yes, SOCSO no, no remuneration type,
    // no EPF Bonus 2012), so on the typed path it is now NORMAL EPF wages, while the legacy path keeps
    // `payroll_input.bonus` on the bonus stream. Before this date the two matched without the tick. The
    // byte-identity this file guards holds for a BONUS row that says what the legacy contract means — a bonus
    // for EPF — which is the tick HR is asked to set on such rows before release; set it here, on the row only.
    await owner.db.update(schema.payComponent).set({ epfBonus2012: true })
      .where(and(eq(schema.payComponent.tenantId, b.tenantId), eq(schema.payComponent.code, 'BONUS')));
    await backfillEmploymentComponentsFromCompensation(a);
    await backfillBatchComponentsFromInput(a, batchId);
    // Grant the module, then RE-RESOLVE: the snapshot is point-in-time, so `a` would still say off.
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const on = await entitledCtx(b);
    await generatePayslips(on, { batchId });
    const typed = snap(await payslipOf(batchId));

    return { legacy, typed };
  }

  it('full month: identical payslip + statutory', async () => {
    const { legacy, typed } = await runCompat(base, '2026-01-01');
    expect(typed.cols).toEqual(legacy.cols);
    expect(noUnexpectedNewKeys(typed.statutory, legacy.statutory)).toEqual([]);
    expect(money(typed.statutory)).toEqual(money(legacy.statutory));
    // Sanity: this scenario actually produced non-trivial figures (basic 5000 + allowance 500 +
    // claim 200 + overtime 600 + bonus 1000 = 7300).
    expect(Number((legacy.cols as Record<string, string>).grossPay)).toBeCloseTo(7300, 2);
  });

  it('prorated mid-month joiner: identical payslip + statutory', async () => {
    const { legacy, typed } = await runCompat(base, '2026-05-16');
    expect(typed.cols).toEqual(legacy.cols);
    expect(noUnexpectedNewKeys(typed.statutory, legacy.statutory)).toEqual([]);
    expect(money(typed.statutory)).toEqual(money(legacy.statutory));
  });

  // Payroll Setup — the configurable pay-rule column is nullable. The real regression surface is the
  // flag-ON + every-rule-null path: the new resolver branch must be byte-identical to the legacy golden when
  // no component carries a rule (i.e. `rule == null`, which the backfill always produces). This guards the
  // "new branch entered, rule skipped" path.
  it('flag ON with every rule = null: identical payslip + statutory (rule column is inert when null)', async () => {
    const { legacy, typed } = await runCompat(base, '2026-01-01');
    // Sanity: the backfilled components really do all have a null rule (so this exercises the null branch).
    const rules = await owner.db.select({ rule: schema.payComponent.rule }).from(schema.payComponent);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.rule == null)).toBe(true);
    expect(typed.cols).toEqual(legacy.cols);
    expect(noUnexpectedNewKeys(typed.statutory, legacy.statutory)).toEqual([]);
    expect(money(typed.statutory)).toEqual(money(legacy.statutory));
  });

  it('RECORD-ONLY: a non-payable, non-taxable component is recorded on the payslip with zero gross/net delta', async () => {
    // This test runs entirely on the typed path (both the baseline and the with-BIK batch), so the
    // module is granted up front and the snapshot resolved after it.
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Rec', primaryEmail: 'rec@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);

    // ── Baseline (no non-payable component) ──
    const { batchId: baseBatch } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: baseBatch });
    const baseline = snap(await payslipOf(baseBatch));
    expect((baseline.statutory as Record<string, unknown>).recordLines).toBeUndefined(); // no record lines when none exist

    // ── With a record-only BIK: non-payable AND not PCB-taxable ──
    await upsertPayComponent(a, { label: 'Parking (record only)', code: 'BIK_PARK', name: 'Parking (record only)', kind: 'non_payable', includedInEpf: false, includedInSocsoEis: false, includedInPcb: false, includedInHrdfBase: false, isNonPayable: true, prorates: false });
    const recId = (await listPayComponents(a)).find((c) => c.code === 'BIK_PARK')!.id;
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: recId, amount: 120, effectiveFrom: '2026-01-01' });

    // Same period length as the baseline (31-day month) so daysWorked is comparable — the BIK alone must
    // not change any cash column.
    const { batchId: recBatch } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId: recBatch });
    const withRec = snap(await payslipOf(recBatch));

    // Every cash column is identical to the baseline — the record line does NOT affect take-home pay.
    expect(withRec.cols).toEqual(baseline.cols);
    // …but the non-payable line IS recorded on the payslip for transparency.
    const recordLines = (withRec.statutory as Record<string, unknown>).recordLines as { code: string; name: string; amount: number }[];
    expect(recordLines).toHaveLength(1);
    expect(recordLines[0]).toMatchObject({ code: 'BIK_PARK', amount: 120 });
  });

  it('FAIL-CLOSED: a taxable non-payable (BIK) component is rejected, not silently under-taxed', async () => {
    // The refusal is a property of the TYPED path, so the module is granted before the snapshot.
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Bik', primaryEmail: 'bik@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    // A BIK: taxable (PCB) but non-payable — v1 cannot place it in a cash bucket.
    await upsertPayComponent(a, { label: 'Company car (BIK)', code: 'BIK_CAR', name: 'Company car (BIK)', kind: 'non_payable', includedInEpf: false, includedInSocsoEis: false, includedInPcb: true, includedInHrdfBase: false, isNonPayable: true, prorates: false });
    await backfillEmploymentComponentsFromCompensation(a);
    const bikId = (await listPayComponents(a)).find((c) => c.code === 'BIK_CAR')!.id;
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: bikId, amount: 250, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(UnsupportedPayComponentError);
  });
});
