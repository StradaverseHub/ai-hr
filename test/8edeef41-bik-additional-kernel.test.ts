/**
 * Board 8edeef41 — owner decision 2026-11-25 (amends ADR-0090) through the real payroll kernel and database.
 *
 * Fictional employees: resident, category 1, no children, EPF Part A citizen, basic RM9,000.00, no earlier 2026 payslip,
 * so July 2026 has ΣY−K = 0, K = 0, X = 0. The expected July MTDs are the hand-computed figures of
 * test/8edeef41-bik-additional-pcb.test.ts (written out there step by step from the LHDN 2026 specification):
 *   BKBOP RM4,111 as Normal     → P1 65,666.00, tax 3,223.26, MTD 537.21 → 5-sen 537.25.
 *   BKBOP RM4,111 as Additional → P1 41,000.00 (MTD 160.00), P2 45,111.00, tax 1,206.66, additional MTD 246.66 → 246.70,
 *                                 Kt 0, month 406.70.
 * Multi-run months are checked against the month computed as one by the pack's statutory function, which is the kernel's
 * own contract (ADR-0085 step 5): the runs' charges telescope to the single-month computation.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { requirePackFor } from '../localization/registry';
import { readPcbNonCash, pcbNonCashStreams } from '../localization/noncash-benefits';
import { createPayComponentsFromImport, PayComponentInputError, type PayComponentInput } from '../core/pay-components';
import { createBatch, createAdditionalRun, generatePayslips, reprocessSelectedEmployees, getReprocessJob, upsertPayComponent, setEmploymentPayComponent, setPayrollBatchComponent } from '../packs/payroll/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const pack = requirePackFor('MY');
const profile = { category: 1 as const, children: 0 };
const BASIC = 9000, BKBOP = 4111;
const AGENCY = ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer'] as const;

describe('8edeef41 BIK/VOLA Additional through the payroll kernel', () => {
  let base: Base; let ctx: SessionContext; let counter = 0;
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb(); base = await seedBase();
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active'); await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    ctx = await entitledCtx(base); counter = 0;
  });
  afterAll(closeAll);

  async function employee() {
    const e = await hireEmployee(ctx, { person: { fullName: `Synthetic BKBOP ${++counter}`, primaryEmail: `${randomUUID()}@bkbop.test` }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2025-01-01' });
    // A distinct fictional NRIC per employee (duplicate NRIC is refused); same birth date, so the same EPF age band.
    await pack.statutory.set(ctx, { personId: e.personId, icNumber: `900101880${String(counter).padStart(3, '0')}` });
    await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: BASIC, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    return e;
  }
  async function benefit(stream: 'normal' | 'additional', code = `BKBOP_${stream.toUpperCase()}_${++counter}`) {
    return upsertPayComponent(ctx, { label: code, code, name: 'BIK-Buyout Payment', kind: 'non_payable', isNonPayable: true, prorates: false, includedInPcb: true,
      includedInEpf: false, includedInSocsoEis: false, includedInHrdfBase: false, displayCategory: 'bik', eaFormLine: 'EA_B3', pcbRemunerationType: stream,
      pcbExemptionCode: 'PCB_TAXABLE', epfBonus2012: false });
  }
  async function cashBonus() {
    return upsertPayComponent(ctx, { label: 'Cash bonus', code: `BONUS_${++counter}`, name: 'Cash bonus', kind: 'allowance', isNonPayable: false, prorates: false, includedInPcb: true,
      includedInEpf: true, includedInSocsoEis: false, includedInHrdfBase: false, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE', epfBonus2012: true });
  }
  async function slip(batchId: string, employmentId: string) {
    return (await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId))))[0];
  }
  const st = (s: { statutory: unknown }) => s.statutory as Record<string, any>;
  const pcb = (s: { statutory: unknown }) => Number(st(s).pcb);

  it('regular run: BKBOP as Additional matches the hand calculation (406.70); as Normal keeps today\'s route (537.25); cash and agencies unchanged', async () => {
    const a = await employee(), n = await employee(), none = await employee();
    const additional = await benefit('additional'), normal = await benefit('normal');
    const july = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' });
    await setPayrollBatchComponent(ctx, { batchId: july.batchId, employmentId: a.employmentId, componentId: additional.id, amount: BKBOP });
    await setPayrollBatchComponent(ctx, { batchId: july.batchId, employmentId: n.employmentId, componentId: normal.id, amount: BKBOP });
    await generatePayslips(ctx, { batchId: july.batchId });
    const sa = await slip(july.batchId, a.employmentId), sn = await slip(july.batchId, n.employmentId), s0 = await slip(july.batchId, none.employmentId);
    // Additional: Y1 9,000, Yt 4,111, Kt 0, P1 41,000, P2 45,111, MTD 160.00 + 246.70.
    expect(st(sa).pcbMeta.trace).toMatchObject({ Y1: 9000, Yt: BKBOP, Kt: 0, taxOnP1: 960, totalTaxYear: 1206.66, mtdNormalCalc: 160, mtdAdditionalCalc: 246.7 });
    expect(st(sa).pcbMeta.P1).toBe(41000); expect(st(sa).pcbMeta.P2).toBe(45111);
    expect(pcb(sa)).toBe(406.7); expect(Number(st(sa).pcbBonus)).toBe(246.7);
    // Normal: Y1 13,111, P1 65,666, MTD 537.25, no Yt.
    expect(st(sn).pcbMeta.trace).toMatchObject({ Y1: 13111, Yt: 0, taxOnP1: 3223.26, mtdNormalCalc: 537.25 });
    expect(st(sn).pcbMeta.P1).toBe(65666); expect(pcb(sn)).toBe(537.25); expect(Number(st(sn).pcbBonus)).toBe(0);
    for (const s of [sa, sn]) {
      expect(s.grossPay).toBe(s0.grossPay); expect(Number(s.bonus)).toBe(0);
      for (const key of AGENCY) expect(st(s)[key]).toBe(st(s0)[key]);
      expect(st(s).bases.epf).toBe(st(s0).bases.epf); expect(st(s).bases.epfAdditional).toBe(st(s0).bases.epfAdditional); expect(st(s).bases.socsoEis).toBe(st(s0).bases.socsoEis);
      expect(st(s).bases.pcb).toBe(BASIC + BKBOP);
    }
    expect(st(sa).epfEmployee).toBe(990);
    // Saved working: Additional writes version 2 with the stream; Normal (and no benefit) still version 1 with no stream.
    const va = readPcbNonCash(st(sa).pcbNonCash)!;
    expect(va.version).toBe(2); expect(va.ownedEntries).toEqual([expect.objectContaining({ taxable: BKBOP, stream: 'additional' })]);
    for (const s of [sn, s0]) { expect(st(s).pcbNonCash.version).toBe(1); expect(JSON.stringify(st(s).pcbNonCash)).not.toContain('stream'); }
    // EA reporting evidence is identical for the two routes.
    expect(va.ownedEaEntries.map(({ code: _c, sourceId: _s, ...e }) => e)).toEqual(readPcbNonCash(st(sn).pcbNonCash)!.ownedEaEntries.map(({ code: _c, sourceId: _s, ...e }) => e));
  });

  it('additional run: a one-off Additional BKBOP is charged only on that run; regular + bonus equal the month as one; next month folds Σ(Y − K) exactly as Normal would', async () => {
    const a = await employee(), n = await employee();
    const additional = await benefit('additional'), normal = await benefit('normal'), cash = await cashBonus();
    const regular = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' }); await generatePayslips(ctx, { batchId: regular.batchId });
    const bonus = await createAdditionalRun(ctx, { companyId: base.companyId, payPeriod: '2026-07', runType: 'bonus' });
    for (const [e, c] of [[a, additional], [n, normal]] as const) {
      await setPayrollBatchComponent(ctx, { batchId: bonus.batchId, employmentId: e.employmentId, componentId: cash.id, amount: 3000 });
      await setPayrollBatchComponent(ctx, { batchId: bonus.batchId, employmentId: e.employmentId, componentId: c.id, amount: BKBOP });
    }
    await generatePayslips(ctx, { batchId: bonus.batchId });
    const ra = await slip(regular.batchId, a.employmentId), ba = await slip(bonus.batchId, a.employmentId);
    const month = pack.payroll.statutory(BASIC, profile, 3000, 0, { month: 7 }, { pcbNonCashAdditional: { bik: BKBOP, vola: 0 } });
    expect(pcb(ra)).toBe(160); // the regular run alone (hand step 1)
    expect(pcb(ra) + pcb(ba)).toBeCloseTo(month.pcb, 2);
    expect(st(ba).pcbMeta.trace.Y1).toBe(BASIC); expect(st(ba).pcbMeta.trace.Yt).toBe(3000 + BKBOP);
    expect(st(ba).pcbMeta.trace.Kt).toBe(month.pcbMeta && (month.pcbMeta as any).trace.Kt);
    const nc = readPcbNonCash(st(ba).pcbNonCash)!;
    expect(nc.version).toBe(2); expect(pcbNonCashStreams(nc).owned.additional.bik).toBe(BKBOP); expect(pcbNonCashStreams(nc).owned.normal.bik).toBe(0);
    // The Normal twin keeps today's route: BKBOP in Y1 of the month.
    const rn = await slip(regular.batchId, n.employmentId), bn = await slip(bonus.batchId, n.employmentId);
    const normalMonth = pack.payroll.statutory(BASIC, profile, 3000, 0, { month: 7 }, { pcbNonCashNormal: { bik: BKBOP, vola: 0 } });
    expect(pcb(rn) + pcb(bn)).toBeCloseTo(normalMonth.pcb, 2);
    expect(st(bn).pcbNonCash.version).toBe(1);
    // August: the accumulated remuneration is the same figure whichever stream July used.
    const august = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-08' }); await generatePayslips(ctx, { batchId: august.batchId });
    const aa = await slip(august.batchId, a.employmentId), an = await slip(august.batchId, n.employmentId);
    expect(st(aa).pcbMeta.ytdGross).toBe(st(an).pcbMeta.ytdGross); expect(st(aa).pcbMeta.ytdNet).toBe(st(an).pcbMeta.ytdNet);
    expect(readPcbNonCash(st(aa).pcbNonCash)!.accumulated).toEqual({ bik: BKBOP, vola: 0, complete: true });
  });

  it('restating month: bonus run first with Additional BKBOP, then the regular run — the regular never re-folds BKBOP as normal', async () => {
    const e = await employee(); const additional = await benefit('additional'), cash = await cashBonus();
    const bonus = await createAdditionalRun(ctx, { companyId: base.companyId, payPeriod: '2026-07', runType: 'bonus' });
    await setPayrollBatchComponent(ctx, { batchId: bonus.batchId, employmentId: e.employmentId, componentId: cash.id, amount: 3000 });
    await setPayrollBatchComponent(ctx, { batchId: bonus.batchId, employmentId: e.employmentId, componentId: additional.id, amount: BKBOP });
    await generatePayslips(ctx, { batchId: bonus.batchId });
    const regular = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' }); await generatePayslips(ctx, { batchId: regular.batchId });
    const b = await slip(bonus.batchId, e.employmentId), r = await slip(regular.batchId, e.employmentId);
    const month = pack.payroll.statutory(BASIC, profile, 3000, 0, { month: 7 }, { pcbNonCashAdditional: { bik: BKBOP, vola: 0 } });
    expect(pcb(b) + pcb(r)).toBeCloseTo(month.pcb, 2);
    expect(st(r).pcbMeta.trace.Y1).toBe(BASIC); // not 13,111: the earlier run's Additional benefit stays in Yt
    expect(st(r).pcbMeta.trace.Yt).toBe(3000 + BKBOP);
    const rnc = readPcbNonCash(st(r).pcbNonCash)!;
    expect(rnc.version).toBe(2); expect(rnc.owned.bik).toBe(0); expect(pcbNonCashStreams(rnc).cumulative.additional.bik).toBe(BKBOP);
    expect(await slip(bonus.batchId, e.employmentId)).toEqual(b);
  });

  it('recurring Additional BIK: the regular run owns it; the bonus run carries it on both sides and charges only the bonus', async () => {
    const e = await employee(); const additional = await benefit('additional'), cash = await cashBonus();
    await setEmploymentPayComponent(ctx, { employmentId: e.employmentId, componentId: additional.id, amount: 1000, effectiveFrom: '2026-01-01' });
    const regular = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' }); await generatePayslips(ctx, { batchId: regular.batchId });
    const r = await slip(regular.batchId, e.employmentId);
    expect(pcb(r)).toBeCloseTo(pack.payroll.statutory(BASIC, profile, 0, 0, { month: 7 }, { pcbNonCashAdditional: { bik: 1000, vola: 0 } }).pcb, 2);
    expect(readPcbNonCash(st(r).pcbNonCash)!.ownedEntries).toEqual([expect.objectContaining({ source: 'recurring', taxable: 1000, stream: 'additional' })]);
    const bonus = await createAdditionalRun(ctx, { companyId: base.companyId, payPeriod: '2026-07', runType: 'bonus' });
    await setPayrollBatchComponent(ctx, { batchId: bonus.batchId, employmentId: e.employmentId, componentId: cash.id, amount: 3000 });
    await generatePayslips(ctx, { batchId: bonus.batchId });
    const b = await slip(bonus.batchId, e.employmentId), bnc = readPcbNonCash(st(b).pcbNonCash)!;
    expect(bnc.owned.bik).toBe(0); expect(bnc.cumulative.bik).toBe(1000); expect(bnc.version).toBe(2);
    const month = pack.payroll.statutory(BASIC, profile, 3000, 0, { month: 7 }, { pcbNonCashAdditional: { bik: 1000, vola: 0 } });
    expect(pcb(r) + pcb(b)).toBeCloseTo(month.pcb, 2);
    expect(st(b).pcbMeta.trace.Y1).toBe(BASIC);
  });

  it('reprocess applies a changed setting to the open month only; the earlier saved month is never rewritten', async () => {
    const e = await employee(); const item = await benefit('normal', 'BKBOP');
    const june = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-06' });
    await setPayrollBatchComponent(ctx, { batchId: june.batchId, employmentId: e.employmentId, componentId: item.id, amount: 500 });
    await generatePayslips(ctx, { batchId: june.batchId });
    const juneSlip = await slip(june.batchId, e.employmentId), frozen = JSON.stringify(juneSlip.statutory);
    expect(st(juneSlip).pcbNonCash.version).toBe(1);
    const july = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' });
    await setPayrollBatchComponent(ctx, { batchId: july.batchId, employmentId: e.employmentId, componentId: item.id, amount: BKBOP });
    await generatePayslips(ctx, { batchId: july.batchId });
    expect(st(await slip(july.batchId, e.employmentId)).pcbMeta.trace.Y1).toBe(BASIC + BKBOP);
    await benefit('additional', 'BKBOP');
    const run = await reprocessSelectedEmployees(ctx, { batchId: july.batchId, employmentIds: [e.employmentId], idempotencyKey: randomUUID() });
    const job = await getReprocessJob(ctx, run.jobId);
    expect((job!.result as any).outcomes[0]).toMatchObject({ status: 'reprocessed' });
    const after = await slip(july.batchId, e.employmentId);
    expect(st(after).pcbMeta.trace.Y1).toBe(BASIC); expect(st(after).pcbMeta.trace.Yt).toBe(BKBOP); expect(st(after).pcbMeta.trace.Kt).toBe(0);
    expect(readPcbNonCash(st(after).pcbNonCash)!.version).toBe(2);
    // June keeps the method it was calculated with.
    expect(JSON.stringify((await slip(june.batchId, e.employmentId)).statutory)).toBe(frozen);
  });

  it('Pay Item import creates an Additional BIK and still refuses Optional Deduction for a benefit', async () => {
    const item = (code: string, overrides: Partial<PayComponentInput>): PayComponentInput => ({ code, name: code, label: code, description: 'Fictional import', kind: 'non_payable', isNonPayable: true,
      prorates: false, includedInEpf: false, includedInSocsoEis: false, includedInPcb: true, includedInHrdfBase: false, epfBonus2012: false, displayCategory: 'bik', eaFormLine: 'EA_B3',
      pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE', ...overrides });
    await createPayComponentsFromImport(ctx, [{ input: item('BKBOP', {}), archived: false }], 'fictional-pay-items.xlsx');
    const [saved] = await owner.db.select().from(schema.payComponent).where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, 'BKBOP')));
    expect(saved).toMatchObject({ pcbRemunerationType: 'additional', displayCategory: 'bik', includedInPcb: true });
    const refused = await createPayComponentsFromImport(ctx, [{ input: item('BK_OPTIONAL', { pcbRemunerationType: 'optional_deduction', pcbExemptionCode: 'LP_VOLUNTARY_EPF' }), archived: false }], 'fictional-pay-items.xlsx').catch(error => error);
    expect(refused).toBeInstanceOf(PayComponentInputError);
    expect((refused as PayComponentInputError).issues.map(issue => issue.code)).toContain('remuneration_type_not_supported');
  });
});
