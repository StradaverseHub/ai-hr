/**
 * Feedback 09b554e9 — Pay Code PCB classification per the LHDN "Spesifikasi Pengiraan PCB 2026 Menggunakan
 * Pengiraan Berkomputer" + EPF Bonus 2012.
 *
 *  - Schema/service round-trip: epf_bonus_2012 / pcb_remuneration_type / pcb_exemption_code persist, and
 *    the save-time guard enforces the mandatory PCB pair, wrong-list rejection and epf-bonus-without-epf
 *    (only when the input SUPPLIES the fields — legacy callers stay untouched).
 *  - Engine: a DECLARED remuneration type overrides the epf/socso flag inference (normal → Y1 wage stream,
 *    additional → Yt bonus stream); an optional-deduction pay code reduces PCB exactly like an approved TP1
 *    deduction; per-code annual exemption caps apply with YTD carry across months (under / at / over);
 *    EPF Bonus 2012 routes an epf+socso code down the additional-remuneration EPF path; a legacy
 *    null-classification row calculates exactly as before, and the fail-closed guard still fires for a
 *    PCB-ticked code LACKING classification (but no longer for a classified one).
 *  - EA: the exempt PCB_* portions accumulate to the EA exempt-allowances figure.
 *  - Statutory pack: the bundled MY pack carries the new exemption tables (version 2026.5 round-trip).
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, setPayrollInput, UnsupportedPayComponentError } from '../core/payroll';
import {
  listPayComponents,
  PayComponentStatutoryConfigError,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
  validateStatutoryClassification,
  type PayComponentInput,
} from '../core/pay-components';
import { DEFAULT_MY_STATUTORY, MY_STATUTORY_VERSION } from '../localization/my/statutory-tables';
import { validateStatutoryRuleset } from '../localization/my/statutory-config';
import { eaStatement } from '../localization/my/reports';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let a: SessionContext;

const input = (code: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  code,
  name: `${code} component`,
  kind: 'allowance',
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  prorates: true,
  ...over,
});

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

/** Hire + statutory profile + compensation + BASIC recurring component (the typed-path roster shape). */
async function hire(email: string, ic: string, basic = 4000) {
  const e = await hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('BASIC'), amount: basic, effectiveFrom: '2026-01-01' });
  return e;
}

async function slipOf(batchId: string, employmentId: string) {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return rows.find((r) => r.employmentId === employmentId)!;
}

beforeAll(async () => {
  await migrateTestDb();
});
/**
 * ADR-0077 slice 3 — `typed_pay_components` is a per-tenant entitlement row, not an env flag.
 *
 * OFF is the default and needs no statement: `seedBase` seeds NO `tenant_module` row for it (the
 * suite's env has TYPED_PAY_COMPONENTS_ENABLED unset), and a missing row is disabled (C7). The old
 * beforeEach/afterEach env deletes are therefore gone rather than translated — there is nothing left
 * to turn off. (Stated without the literal env expression on purpose: `module-catalog-drift.test.ts`
 * greps every test file for one, and a mention inside a comment would read as a live mutation.)
 *
 * ON is stated per test with `setModule(...,'active')`, and the session must then be RE-RESOLVED
 * through `entitledCtx`: `adminCtx`'s snapshot is synthetic (derived from the env parity helpers) and
 * point-in-time, so a row written afterwards is invisible to it. Setup that must run with the gate
 * still OFF keeps using the `adminCtx` value of `a`; each test flips at exactly the line the env
 * write used to sit on, so the on/off boundary within every test is unchanged.
 */
const enableTypedComponents = async () => {
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  a = await entitledCtx(base);
};

beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

describe('09b554e9 — classification round-trip + save-time validation', () => {
  it('persists epfBonus2012 / pcbRemunerationType / pcbExemptionCode and clears them when PCB is unticked', async () => {
    await upsertPayComponent(a, input('CHILDCARE', {
      epfBonus2012: false, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_CHILD_CARE',
    }));
    let row = (await listPayComponents(a)).find((c) => c.code === 'CHILDCARE')!;
    expect(row.pcbRemunerationType).toBe('normal');
    expect(row.pcbExemptionCode).toBe('PCB_CHILD_CARE');
    expect(row.epfBonus2012).toBe(false);

    // EPF Bonus 2012 sticks with EPF ticked.
    await upsertPayComponent(a, input('CHILDCARE', {
      epfBonus2012: true, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    row = (await listPayComponents(a)).find((c) => c.code === 'CHILDCARE')!;
    expect(row.epfBonus2012).toBe(true);
    expect(row.pcbRemunerationType).toBe('additional');

    // Unticking PCB clears the classification pair (an untaxed code carries none).
    await upsertPayComponent(a, input('CHILDCARE', {
      includedInPcb: false, epfBonus2012: true, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    row = (await listPayComponents(a)).find((c) => c.code === 'CHILDCARE')!;
    expect(row.pcbRemunerationType).toBeNull();
    expect(row.pcbExemptionCode).toBeNull();
  });

  it('enforces the mandatory PCB pair, wrong-list rejection and epf-bonus-without-epf', async () => {
    // PCB ticked + fields supplied but empty ⇒ remuneration type mandatory.
    let err = await upsertPayComponent(a, input('X1', { pcbRemunerationType: null, pcbExemptionCode: null })).catch((e) => e);
    expect(err).toBeInstanceOf(PayComponentStatutoryConfigError);
    expect(err.code).toBe('pcbRemunerationTypeRequired');

    // Type without exemption code ⇒ exemption mandatory.
    err = await upsertPayComponent(a, input('X2', { pcbRemunerationType: 'normal', pcbExemptionCode: null })).catch((e) => e);
    expect(err).toBeInstanceOf(PayComponentStatutoryConfigError);
    expect(err.code).toBe('pcbExemptionTypeRequired');

    // Wrong list both ways (LP code under normal; PCB code under optional deduction).
    err = await upsertPayComponent(a, input('X3', { pcbRemunerationType: 'normal', pcbExemptionCode: 'LP_LIFESTYLE' })).catch((e) => e);
    expect(err.code).toBe('pcbExemptionTypeInvalid');
    err = await upsertPayComponent(a, input('X4', { pcbRemunerationType: 'optional_deduction', pcbExemptionCode: 'PCB_TAXABLE' })).catch((e) => e);
    expect(err.code).toBe('pcbExemptionTypeInvalid');

    // EPF Bonus 2012 without EPF ⇒ refused.
    err = await upsertPayComponent(a, input('X5', { includedInEpf: false, epfBonus2012: true, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' })).catch((e) => e);
    expect(err.code).toBe('epfBonusRequiresEpf');

    // Nothing was persisted by the refused saves.
    expect((await listPayComponents(a)).map((c) => c.code)).not.toContain('X1');
  });

  it('legacy callers that do not supply the fields keep saving (seed regression) and skip the guard', async () => {
    await expect(seedPayComponentCatalog(a)).resolves.toMatchObject({ created: expect.any(Number) });
    // A PCB-ticked upsert with NO classification fields (the pre-feature shape) still saves.
    await expect(upsertPayComponent(a, input('LEGACY'))).resolves.toMatchObject({ id: expect.any(String) });
    const row = (await listPayComponents(a)).find((c) => c.code === 'LEGACY')!;
    expect(row.pcbRemunerationType).toBeNull();
    // The pure validator mirrors the same contract.
    expect(validateStatutoryClassification({ includedInEpf: true, includedInPcb: true })).toEqual({ ok: true });
    expect(validateStatutoryClassification({ includedInEpf: true, includedInPcb: true, pcbRemunerationType: null, pcbExemptionCode: null })).toEqual({ ok: false, code: 'pcbRemunerationTypeRequired' });
  });
});

describe('09b554e9 — engine: declared classification drives the PCB/EPF streams', () => {
  it('declared additional overrides the epf+socso inference (Yt stream); declared normal overrides the bonus inference (Y1 stream)', async () => {
    await seedPayComponentCatalog(a);
    // TRAVEL: flags say wage-bucket (epf+socso) but the declaration says ADDITIONAL remuneration.
    await upsertPayComponent(a, input('TRAVEL', { pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE' }));
    // FIXEDPAY: flags say bonus-bucket (epf, no socso) but the declaration says NORMAL remuneration.
    await upsertPayComponent(a, input('FIXEDPAY', { includedInSocsoEis: false, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' }));
    // LEGBONUS: same epf-only flags, NO declaration — the legacy inference must stay byte-identical (bonus).
    await upsertPayComponent(a, input('LEGBONUS', { includedInSocsoEis: false }));

    const e1 = await hire('travel@acme.test', '900101015001');
    await setEmploymentPayComponent(a, { employmentId: e1.employmentId, componentId: await idByCode('TRAVEL'), amount: 1000, effectiveFrom: '2026-01-01' });
    const e2 = await hire('fixedpay@acme.test', '900101015002');
    await setEmploymentPayComponent(a, { employmentId: e2.employmentId, componentId: await idByCode('FIXEDPAY'), amount: 500, effectiveFrom: '2026-01-01' });
    const e3 = await hire('legbonus@acme.test', '900101015003');
    await setEmploymentPayComponent(a, { employmentId: e3.employmentId, componentId: await idByCode('LEGBONUS'), amount: 500, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });

    const s1 = await slipOf(batchId, e1.employmentId);
    expect(Number(s1.bonus)).toBeCloseTo(1000, 2); // declared additional ⇒ Yt stream
    expect(Number(s1.allowance)).toBeCloseTo(0, 2);

    const s2 = await slipOf(batchId, e2.employmentId);
    expect(Number(s2.allowance)).toBeCloseTo(500, 2); // declared normal ⇒ Y1 stream
    expect(Number(s2.bonus)).toBeCloseTo(0, 2);

    const s3 = await slipOf(batchId, e3.employmentId);
    expect(Number(s3.bonus)).toBeCloseTo(500, 2); // legacy inference unchanged (regression)
    expect(Number(s3.allowance)).toBeCloseTo(0, 2);
  });

  it('an optional-deduction pay code reduces PCB exactly like an approved TP1 deduction (annual LP cap, YTD carry)', async () => {
    await seedPayComponentCatalog(a);
    // LP_SOCSO cap is RM350/year: a RM300 monthly claim is fully claimable in Jan, capped to RM50 in Feb.
    await upsertPayComponent(a, input('LPSOCSO', {
      kind: 'deduction', includedInEpf: false, includedInSocsoEis: false,
      pcbRemunerationType: 'optional_deduction', pcbExemptionCode: 'LP_SOCSO',
    }));

    const lpEmp = await hire('lp@acme.test', '900101015011', 5000);
    await setEmploymentPayComponent(a, { employmentId: lpEmp.employmentId, componentId: await idByCode('LPSOCSO'), amount: 300, effectiveFrom: '2026-01-01' });
    const tp1Emp = await hire('tp1@acme.test', '900101015012', 5000);
    const ctlEmp = await hire('ctl@acme.test', '900101015013', 5000);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await setPayrollInput(a, { batchId, employmentId: tp1Emp.employmentId, overtimeAmount: 0, tp1Deduction: 300 });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });

    const lpSlip = await slipOf(batchId, lpEmp.employmentId);
    const tp1Slip = await slipOf(batchId, tp1Emp.employmentId);
    const ctlSlip = await slipOf(batchId, ctlEmp.employmentId);
    const pcbOf = (s: { statutory: unknown }) => Number((s.statutory as { pcb: number }).pcb);
    const lpOf = (s: { statutory: unknown }) => Number((s.statutory as { lp?: number }).lp ?? 0);

    expect(lpOf(lpSlip)).toBeCloseTo(300, 2); // the declared LP claim feeds LP₁
    expect(pcbOf(lpSlip)).toBeCloseTo(pcbOf(tp1Slip), 2); // …and reduces PCB exactly like TP1
    expect(pcbOf(lpSlip)).toBeLessThan(pcbOf(ctlSlip)); // …which is genuinely less than no relief
    // Cash-wise the deduction still leaves net (kind: deduction).
    expect(Number(lpSlip.otherDeductions)).toBeCloseTo(300, 2);
    // Slip carries the per-code usage for the YTD replay.
    expect((lpSlip.statutory as { exemptionUsed?: Record<string, number> }).exemptionUsed).toEqual({ LP_SOCSO: 300 });

    // February: only RM50 of headroom remains under the RM350 annual cap.
    const feb = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: feb.batchId });
    const lpFeb = await slipOf(feb.batchId, lpEmp.employmentId);
    expect(lpOf(lpFeb)).toBeCloseTo(50, 2);
    expect((lpFeb.statutory as { exemptionUsed?: Record<string, number> }).exemptionUsed).toEqual({ LP_SOCSO: 50 });
  });

  it('PCB_* exemption caps: under in Jan, over in Feb (YTD carry) — the exempt slice is paid but leaves the statutory bases; EA accumulates it', async () => {
    await seedPayComponentCatalog(a);
    // PCB_CHILD_CARE cap RM3,000/year; RM2,000/month ⇒ Jan fully exempt, Feb 1,000 exempt + 1,000 taxable.
    await upsertPayComponent(a, input('CHILDCARE', { pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_CHILD_CARE' }));
    const e = await hire('cc@acme.test', '900101015021', 4000);
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('CHILDCARE'), amount: 2000, effectiveFrom: '2026-01-01' });

    await enableTypedComponents();
    const jan = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });
    const sJan = await slipOf(jan.batchId, e.employmentId);
    // Paid in full…
    expect(Number(sJan.allowance)).toBeCloseTo(2000, 2);
    // …but fully exempt: EPF sees the RM4,000 basic only (Third Schedule band ⇒ RM440 employee).
    expect(Number((sJan.statutory as { epfEmployee: number }).epfEmployee)).toBe(440);
    expect((sJan.statutory as { exemptionUsed?: Record<string, number> }).exemptionUsed).toEqual({ PCB_CHILD_CARE: 2000 });

    const feb = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: feb.batchId });
    const sFeb = await slipOf(feb.batchId, e.employmentId);
    expect(Number(sFeb.allowance)).toBeCloseTo(2000, 2); // still paid in full
    // Only RM1,000 headroom left ⇒ RM1,000 taxable rides the wage: EPF on RM5,000 ⇒ RM550 employee.
    expect(Number((sFeb.statutory as { epfEmployee: number }).epfEmployee)).toBe(550);
    expect((sFeb.statutory as { exemptionUsed?: Record<string, number> }).exemptionUsed).toEqual({ PCB_CHILD_CARE: 1000 });

    // EA: the exempt portions accumulate to the exempt-allowances figure (2,000 + 1,000).
    const ea = await eaStatement(a, { employmentId: e.employmentId, year: '2026' });
    expect(ea?.partB.exemptAllowances).toBeCloseTo(3000, 2);
    /**
     * r353 (item fda53352 point 3) — AND B.1(c) CARRIES THE TAXABLE EXCESS ONLY.
     *
     * RM4,000 was paid across the two months and RM3,000 of it was exempt, so the employment-income
     * line reports RM1,000. Section B's own sub-caption is "(EXCLUDING Tax Exempt Allowances /
     * Perquisites / Gifts / Benefits)" (docs/forms/ea-cp8a-pin-2023-transcription.txt:99-100) and the
     * exempt total has its own box, Section F (:153) — before this assertion existed the same RM3,000
     * was printed in both places.
     *
     * ⚠️ THE EXCESS IS NOT RE-DERIVED HERE AND MUST NOT BE. `roomFor()` already capped the exemption at
     * the annual headroom, so February's over-limit RM1,000 is already in the taxable wage; this case is
     * exactly the one that tells a subtraction apart from a `max(total − limit, 0)` recomputation.
     */
    expect(ea?.partB.allowances, 'B.1(c) must report the TAXABLE allowance only').toBeCloseTo(1000, 2);
    // …and the form's own total moves with it: the printed Part B lines sum to the printed JUMLAH, so a
    // net 1(c) with a gross total would be a page that does not add up.
    expect(ea?.partB.gross).toBeCloseTo(
      (ea?.partB.grossSalary ?? 0) + (ea?.partB.bonus ?? 0) + 1000,
      2,
    );

    // ⚠️ THE MARCH RUN BELOW MUST STAY AFTER THE EA ASSERTIONS ABOVE. It was first written before
    // them and broke B.1(c): the RM3,000 cap is spent by February, so March's whole 2,000 allowance
    // is taxable and the EA's taxable total becomes 3,000 rather than the 1,000 those lines pin.
    // The two-month EA figures and the three-month accumulator are different claims; order is what
    // keeps them both true.
    // ── 4011903e (r354) — AND THE SAME SPLIT MUST REACH Σ(Y−K) ──────────────────────────────────────
    //
    // This is the money case for that item, and this fixture is the only place in the suite where gross
    // pay and the PCB base genuinely differ, so it is the only place the assertion is non-vacuous.
    //   Jan: paid 6,000 (basic 4,000 + allowance 2,000), charged 4,000 — all 2,000 exempt.
    //   Feb: paid 6,000, charged 5,000 — 1,000 of headroom left, so 1,000 became taxable.
    // March's accumulator must therefore carry 9,000, not 12,000. The RM3,000 gap IS the exempt total
    // asserted two lines below, and before this item it was silently inflating P and over-deducting
    // every employee with a tax-exempt allowance. Spec rule 9, printed p.20:
    // "All the tax exemption ... shall be EXCLUDED FROM THE REMUNERATION for MTD purposes."
    const mar = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    await generatePayslips(a, { batchId: mar.batchId });
    const sMar = await slipOf(mar.batchId, e.employmentId);
    const marMeta = (sMar.statutory as { pcbMeta?: { ytdGross?: number; ytdNet?: number; epfClaimed?: number } }).pcbMeta;
    const janBase = Number((sJan.statutory as { bases?: { pcb?: number } }).bases?.pcb ?? 0);
    const febBase = Number((sFeb.statutory as { bases?: { pcb?: number } }).bases?.pcb ?? 0);
    expect(janBase, 'January charged the basic only').toBeCloseTo(4000, 2);
    expect(febBase, 'February charged the basic plus the taxable 1,000').toBeCloseTo(5000, 2);
    expect(
      Number(marMeta?.ytdGross ?? 0),
      'Y is the two CHARGED bases (9,000), never the two gross figures (12,000)',
    ).toBeCloseTo(9000, 2);
    expect(
      Number(marMeta?.ytdGross ?? 0),
      'the RM3,000 gap is exactly the exempt total — this is the over-deduction 4011903e reported',
    ).not.toBeCloseTo(12000, 2);
    // And the identity the explanation screen reconciles against.
    expect(
      Math.round((Number(marMeta?.ytdGross ?? 0) - Number(marMeta?.epfClaimed ?? 0)) * 100) / 100,
      'Y − K must equal Σ(Y−K)',
    ).toBeCloseTo(Number(marMeta?.ytdNet ?? 0), 2);

  });

  it('EPF Bonus 2012 on an epf+socso code routes the amount down the additional-remuneration EPF path', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('BON2012', {
      epfBonus2012: true, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    const e = await hire('bon@acme.test', '900101015031', 4000);
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('BON2012'), amount: 3000, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const s = await slipOf(batchId, e.employmentId);
    const st = s.statutory as { epfEmployee: number; epfEmployer: number; socsoEmployee: number };

    expect(Number(s.bonus)).toBeCloseTo(3000, 2); // bonus payment, Yt stream
    // EPF, RESTATED FOR bdf7d248 (r210). This case used to assert the rule that item reversed — that the
    // bonus is charged at the NORMAL wage's rates, so a ≤RM5,000 earner stayed at 13% even once wages +
    // bonus crossed RM5,000 (it read 440 + ceil(11%×3000) and 520 + ceil(13%×3000) = 910). The month is
    // now ONE Third Schedule lookup on RM4,000 + RM3,000 = RM7,000, which is above RM5,000, so the
    // employer rate for the month is 12%: 770 and 840. The employee figure is unchanged at 770 by
    // coincidence, not by rule — 11% of 7,000 and 440 + 11% of 3,000 are the same number.
    expect(st.epfEmployee).toBe(770); // 11% × 7,000, the combined month
    expect(st.epfEmployer).toBe(840); // 12% × 7,000 — was 910 under the pre-r210 additional-wage rule
    // ⚠️ WHAT THIS CASE STILL TESTS. The EPF Bonus 2012 flag no longer changes the EPF AMOUNT at all —
    // epf(4000, 3000) and epf(7000, 0) are now the same figures — so this is no longer an EPF assertion
    // in disguise. It remains the acceptance test for the classification because the flag still decides
    // the PCB stream (Yt, the difference method) and still keeps the bonus out of the SOCSO/EIS base,
    // which is what the two assertions below pin. Do not delete it as redundant.
    // SOCSO excludes the bonus (Act 4 wages): the RM4,000 band employee share.
    expect(st.socsoEmployee).toBeCloseTo(19.75, 2);
  });

  it('fail-closed guard: an unclassified PCB-only earning still throws; a classified one computes', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('PCBONLY', { includedInEpf: false, includedInSocsoEis: false }));
    const e = await hire('guard@acme.test', '900101015041');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('PCBONLY'), amount: 100, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await enableTypedComponents();
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(UnsupportedPayComponentError);

    // Declaring the classification makes the same code computable (routed by the declaration).
    await upsertPayComponent(a, input('PCBONLY', {
      includedInEpf: false, includedInSocsoEis: false,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    await expect(generatePayslips(a, { batchId })).resolves.toBeTruthy();
    const s = await slipOf(batchId, e.employmentId);
    expect(Number(s.allowance)).toBeCloseTo(100, 2); // normal ⇒ Y1 wage stream
  });
});

describe('09b554e9 — statutory pack round-trip', () => {
  it('DEFAULT_MY_STATUTORY validates and the bundled pack is the CODE DEFAULT, rebuilt and re-signed', () => {
    expect(validateStatutoryRuleset(DEFAULT_MY_STATUTORY)).toEqual([]);
    expect(Object.keys(DEFAULT_MY_STATUTORY.pcbExemptions!.pcb)).toHaveLength(7);
    expect(Object.keys(DEFAULT_MY_STATUTORY.pcbExemptions!.lp)).toHaveLength(24);
    expect(DEFAULT_MY_STATUTORY.pcbExemptions!.pcb['PCB_NON-TAXABLE']).toBe(-1);
    expect(DEFAULT_MY_STATUTORY.pcbExemptions!.lp.LP_OPTIONAL_REBATE).toBe(9999999);

    const envelope = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../localization/statutory-pack/bundled/my-2026.01.01.pack.json'), 'utf8'),
    ) as { payload: string };
    const payload = JSON.parse(envelope.payload) as { rulesets: { version: string; data: typeof DEFAULT_MY_STATUTORY }[] };
    // d64d0df4 — the two hard-coded '2026.5' literals here are GONE, replaced by the invariant they were a
    // proxy for. They asserted that 09b554e9's bump had happened; what the guard actually exists to protect
    // is that the SHIPPED, SIGNED pack is in step with the code default — which the literals could not say,
    // and which went stale the moment the next figure changed (this item's 2026.6). Comparing the whole
    // ruleset is strictly STRONGER: any edit to DEFAULT_MY_STATUTORY that is not followed by
    // `node --import tsx scripts/statutory-pack-build-my.ts` now fails here, whatever the figure was.
    // Both sides go through JSON so the last PCB band's `upTo: Infinity` serialises the same way on each.
    expect(payload.rulesets[0].version).toBe(MY_STATUTORY_VERSION);
    expect(payload.rulesets[0].data).toEqual(JSON.parse(JSON.stringify(DEFAULT_MY_STATUTORY)));
  });
});
