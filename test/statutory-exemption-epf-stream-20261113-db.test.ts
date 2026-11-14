/**
 * Owner decisions A and B (2026-11-13) — a PCB exemption is INCOME-TAX only, and the PCB remuneration type
 * does not choose the EPF stream. Through the kernel, on real payslips. Fictional fixtures only.
 *
 *   A. A pay item's `pcb_exemption_code` (e.g. PCB_PERQUISITE, RM2,000 a year) reduces ONLY the PCB base.
 *      EPF, SOCSO, EIS and SKBBK follow the item's own ticks on the WHOLE amount, exempt or not.
 *   B. 'normal' | 'additional' is a PCB-only classification (Y1 vs Yt, and the payslip box). EPF has only
 *      normal wages, except money on an item ticked EPF Bonus 2012, which keeps the bonus EPF stream and
 *      stays out of SOCSO/EIS (SOCSO Act 1969 s.2).
 *
 * The pinned case is a production payslip shape (October 2026): Basic 3,734 + overtime (EPF no, SOCSO yes)
 * + a RM1,000 tax-exempt long service award (EPF yes, EPF Bonus 2012 no, SOCSO/EIS yes, PCB additional,
 * PCB_PERQUISITE). Expected figures are the KWSP Third Schedule Part A / PERKESO Act 4 / Act 800 rows:
 *   EPF wages 3,734 + 1,000 = 4,734 → row 4,720.01–4,740.00 → 522 / 617   (before the fix: 3,734 → 412 / 487)
 *   SOCSO wages 3,734 + 500 + 1,000 = 5,234 → row 5,200.01–5,300.00 → 26.25 / 91.85, SKBBK 39.35, EIS 10.50
 *   PCB base 3,734 + 500 = 4,234 — the award stays exempt from income tax.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  setPayrollBatchComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { explainStatutory } from '../core/statutory-explain';
import { epfTraceItemRows, scheduleTraceItemRows } from '../app/payroll/statutory-detail/statutory-trace';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let a: SessionContext;
const PERIOD = '2026-10';

const item = (code: string, name: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  label: name, code, name, kind: 'allowance',
  includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
  isNonPayable: false, prorates: false,
  pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE', epfBonus2012: false,
  ...over,
});
/** A0097 LONG SERVICE AWARD (TAX EXEMPTED), as configured on the production tenant. */
const AWARD = (over: Partial<PayComponentInput> = {}) =>
  item('A0097', 'LONG SERVICE AWARD (TAX EXEMPTED)', { pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_PERQUISITE', ...over });
// Legacy unclassified overtime: not EPF, SOCSO/EIS yes → the overtime bucket.
const OT = item('OTX', 'Overtime', { includedInEpf: false, pcbRemunerationType: undefined, pcbExemptionCode: undefined, epfBonus2012: undefined });
/** An 'additional'-classified item ticked EPF, NOT EPF Bonus 2012, not SOCSO, fully taxable. */
const PERF = item('PERF', 'Performance incentive', { includedInSocsoEis: false, pcbRemunerationType: 'additional' });
/** A declared bonus: EPF Bonus 2012, SOCSO ticked (and still excluded by law). */
const BNS = item('BNS', 'Bonus', { pcbRemunerationType: 'additional', epfBonus2012: true });

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

async function setup(items: PayComponentInput[]) {
  await seedPayComponentCatalog(a);
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  a = await entitledCtx(base);
  for (const i of items) await upsertPayComponent(a, i);
}

async function hire(email: string, basic: number) {
  const e = await hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  // Born 1 Jan 1990: a Malaysian citizen below 60 — KWSP Part A, SOCSO First Category, EIS eligible.
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015401', subjectToSkbbk: true });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('BASIC'), amount: basic, effectiveFrom: '2026-01-01' });
  return e;
}
const recurring = async (employmentId: string, code: string, amount: number) =>
  setEmploymentPayComponent(a, { employmentId, componentId: await idByCode(code), amount, effectiveFrom: '2026-01-01' });
const oneOff = async (batchId: string, employmentId: string, code: string, amount: number) =>
  setPayrollBatchComponent(a, { batchId, employmentId, componentId: await idByCode(code), amount });

async function slipOf(batchId: string, employmentId: string) {
  const [row] = await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  return row!;
}
type Line = { kind: string; code?: string; epfNormal: number; epfBonus: number; socsoEis: number };
type Trace = {
  epf: { normalWage: number; bonusWage: number; employee: number; employer: number; band?: unknown };
  socso: { wage: number; band?: unknown };
  items: Line[];
  run: { kind: string; own: Record<string, number>; earlier?: Record<string, number> };
};
type Stat = Record<string, number> & { statutoryTrace?: Trace; bases?: Record<string, number>; exemptionUsed?: Record<string, number> };
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;
const itemLine = (st: Stat, code: string) => st.statutoryTrace!.items.find((l) => l.code === code)!;
// The Statutory Explanation's own row builders, with identity t/money, so the rendered words are the keys.
const t = (key: string) => key;
const money = (n: number) => n.toFixed(2);

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

describe('owner decision A — a PCB exemption is income-tax only', () => {
  it('B0141 (production, Oct 2026): the exempt RM1,000 award is EPF normal wages and SOCSO/EIS/SKBBK wages; PCB still treats it as exempt', async () => {
    await setup([AWARD(), OT]);
    const e = await hire('b0141@acme.test', 3734);
    await recurring(e.employmentId, 'OTX', 500);
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(batch.batchId, e.employmentId, 'A0097', 1000);
    await generatePayslips(a, { batchId: batch.batchId });
    const slip = await slipOf(batch.batchId, e.employmentId);
    const st = statOf(slip);

    // Cash is unchanged by the fix: the exempt award is paid in the untaxed allowance bucket, not as bonus.
    expect(Number(slip.allowance)).toBeCloseTo(1000, 2);
    expect(Number(slip.bonus)).toBeCloseTo(0, 2);
    expect(st.exemptionUsed).toEqual({ PCB_PERQUISITE: 1000 });

    // EPF normal wages 4,734, bonus stream 0 → 522 / 617 (row 4,720.01–4,740.00).
    expect(st.bases).toMatchObject({ epf: 4734, epfAdditional: 0, socsoEis: 5234 });
    expect([st.epfEmployee, st.epfEmployer]).toEqual([522, 617]);
    // SOCSO/EIS/SKBBK wages include the award: 5,234 → row 5,200.01–5,300.00.
    expect([st.socsoEmployee, st.socsoEmployer, st.socsoSkbbk, st.eisEmployee, st.eisEmployer]).toEqual([26.25, 91.85, 39.35, 10.5, 10.5]);
    // PCB is unchanged: the award stays out of the income-tax base.
    expect(st.bases!.pcb).toBeCloseTo(4234, 2);

    const tr = st.statutoryTrace!;
    expect(tr.epf).toMatchObject({ normalWage: 4734, bonusWage: 0, band: { from: 4720.01, upTo: 4740 } });
    expect(tr.socso).toMatchObject({ wage: 5234, band: { from: 5200.01, upTo: 5300 } });
    expect(itemLine(st, 'A0097')).toMatchObject({ epfNormal: 1000, epfBonus: 0, socsoEis: 1000 });
    expect(tr.items.some((l) => l.kind === 'other'), 'the items account for every ringgit of each base').toBe(false);
    // A regular run's one-off exempt money is stamped for any later run in the same month.
    expect(tr.run.own).toMatchObject({ epfAdditional: 0, epfWageExtra: 0, exemptEpfWage: 1000, exemptEpfAdditional: 0, exemptSocsoWage: 1000 });

    // The Statutory Explanation reconciles, and its Treatment column says what was done.
    const ex = explainStatutory(st, 'regular');
    expect(ex.traceStatus).toBe('recorded');
    const epfRow = epfTraceItemRows(ex.trace!, t, money).find((r) => r.code === 'A0097')!;
    expect(epfRow).toMatchObject({ treatment: 'traceTreatEpfNormal', contribution: '1000.00' });
    for (const key of ['socso', 'skbbk', 'eis'] as const) {
      const row = scheduleTraceItemRows(ex.trace!, key, t, money).find((r) => r.code === 'A0097')!;
      expect(row.contribution, key).toBe('1000.00');
      expect(row.treatment, key).toMatch(/Included$/);
    }
  });

  it('partial exemption: above the remaining cap, the WHOLE amount is EPF normal wages; only the excess is taxable for PCB', async () => {
    await setup([AWARD()]);
    const e = await hire('partial@acme.test', 4000);
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(batch.batchId, e.employmentId, 'A0097', 2500);
    await generatePayslips(a, { batchId: batch.batchId });
    const slip = await slipOf(batch.batchId, e.employmentId);
    const st = statOf(slip);
    // RM2,000 exempt (paid untaxed), RM500 taxable on the additional (Yt) stream — unchanged cash routing.
    expect(Number(slip.allowance)).toBeCloseTo(2000, 2);
    expect(Number(slip.bonus)).toBeCloseTo(500, 2);
    expect(st.exemptionUsed).toEqual({ PCB_PERQUISITE: 2000 });
    // EPF 4,000 + 2,500 = 6,500 normal → 715 / 780; SOCSO 6,500 capped at the RM6,000 ceiling row.
    expect(st.bases).toMatchObject({ epf: 6500, epfAdditional: 0, socsoEis: 6500 });
    expect([st.epfEmployee, st.epfEmployer]).toEqual([715, 780]);
    expect(st.bases!.pcb).toBeCloseTo(4500, 2);
    expect(itemLine(st, 'A0097')).toMatchObject({ epfNormal: 2500, epfBonus: 0, socsoEis: 2500 });
    expect(explainStatutory(st, 'regular').traceStatus).toBe('recorded');
  });

  it('an exempt item with EPF unticked stays out of EPF (but its SOCSO tick is still honoured)', async () => {
    await setup([AWARD({ includedInEpf: false })]);
    const e = await hire('noepf@acme.test', 4000);
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(batch.batchId, e.employmentId, 'A0097', 1000);
    await generatePayslips(a, { batchId: batch.batchId });
    const st = statOf(await slipOf(batch.batchId, e.employmentId));
    expect(st.bases).toMatchObject({ epf: 4000, epfAdditional: 0, socsoEis: 5000, pcb: 4000 });
    expect([st.epfEmployee, st.epfEmployer]).toEqual([440, 520]);
    expect([st.socsoEmployee, st.socsoEmployer]).toEqual([24.75, 86.65]);
    expect(itemLine(st, 'A0097')).toMatchObject({ epfNormal: 0, epfBonus: 0, socsoEis: 1000 });
    const ex = explainStatutory(st, 'regular');
    expect(ex.traceStatus).toBe('recorded');
    expect(epfTraceItemRows(ex.trace!, t, money).find((r) => r.code === 'A0097')!.treatment).toBe('traceTreatEpfExcluded');
  });
});

describe('owner decision B — the PCB remuneration type does not choose the EPF stream', () => {
  it("an 'additional' item without EPF Bonus 2012 is NORMAL EPF wages; its PCB stream (Yt) and payslip box are unchanged", async () => {
    await setup([PERF]);
    const e = await hire('perf@acme.test', 4000);
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(batch.batchId, e.employmentId, 'PERF', 800);
    await generatePayslips(a, { batchId: batch.batchId });
    const slip = await slipOf(batch.batchId, e.employmentId);
    const st = statOf(slip);
    expect(Number(slip.bonus)).toBeCloseTo(800, 2); // still additional remuneration for PCB, in the bonus box
    expect(st.bases).toMatchObject({ epf: 4800, epfAdditional: 0, socsoEis: 4000, pcb: 4800 });
    expect([st.epfEmployee, st.epfEmployer]).toEqual([528, 624]);
    expect(st.statutoryTrace!.epf).toMatchObject({ normalWage: 4800, bonusWage: 0 });
    expect(itemLine(st, 'PERF')).toMatchObject({ epfNormal: 800, epfBonus: 0, socsoEis: 0 });
    expect(st.statutoryTrace!.run.own).toMatchObject({ epfAdditional: 0, epfWageExtra: 800 });
    const ex = explainStatutory(st, 'regular');
    expect(ex.traceStatus).toBe('recorded');
    expect(epfTraceItemRows(ex.trace!, t, money).find((r) => r.code === 'PERF')!.treatment).toBe('traceTreatEpfNormal');
  });

  it('an EPF Bonus 2012 item is unchanged: bonus EPF stream, and not SOCSO wages even with SOCSO ticked', async () => {
    await setup([BNS]);
    const e = await hire('bns@acme.test', 4000);
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(batch.batchId, e.employmentId, 'BNS', 800);
    await generatePayslips(a, { batchId: batch.batchId });
    const st = statOf(await slipOf(batch.batchId, e.employmentId));
    expect(st.bases).toMatchObject({ epf: 4000, epfAdditional: 800, socsoEis: 4000 });
    expect([st.epfEmployee, st.epfEmployer]).toEqual([528, 624]);
    expect([st.socsoEmployee, st.socsoEmployer]).toEqual([19.75, 69.15]);
    expect(itemLine(st, 'BNS')).toMatchObject({ epfNormal: 0, epfBonus: 800, socsoEis: 0 });
    expect(st.statutoryTrace!.run.own).toMatchObject({ epfAdditional: 800, epfWageExtra: 0 });
  });
});

describe('the month carry — later runs in the same wage month see both new figures', () => {
  it('regular (exempt award) → bonus run 1 (additional, not EPF Bonus 2012) → bonus run 2 (EPF Bonus 2012): the month charges once', async () => {
    await setup([AWARD(), PERF, BNS]);
    const e = await hire('carry@acme.test', 3734);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(reg.batchId, e.employmentId, 'A0097', 1000);
    await generatePayslips(a, { batchId: reg.batchId });
    const run1 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await oneOff(run1.batchId, e.employmentId, 'PERF', 600);
    await generatePayslips(a, { batchId: run1.batchId });
    const run2 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await oneOff(run2.batchId, e.employmentId, 'BNS', 2000);
    await generatePayslips(a, { batchId: run2.batchId });

    const r = statOf(await slipOf(reg.batchId, e.employmentId));
    const s1 = statOf(await slipOf(run1.batchId, e.employmentId));
    const s2 = statOf(await slipOf(run2.batchId, e.employmentId));

    // Regular: 3,734 + 1,000 exempt award → 522 / 617.
    expect([r.epfEmployee, r.epfEmployer]).toEqual([522, 617]);
    // Run 1: the month's normal wages become 3,734 + 1,000 (carried) + 600 = 5,334 → 594 / 648, so it adds 72 / 31.
    expect(s1.bases).toMatchObject({ epf: 5334, epfAdditional: 0 });
    expect(s1.statutoryTrace!.epf).toMatchObject({ normalWage: 5334, bonusWage: 0, employee: 594, employer: 648 });
    expect([s1.epfEmployee, s1.epfEmployer]).toEqual([72, 31]);
    expect(s1.statutoryTrace!.run).toMatchObject({ kind: 'additional', own: { epfWageExtra: 600 }, earlier: { exemptEpfWage: 1000, exemptSocsoWage: 1000 } });
    expect(s1.statutoryTrace!.items.find((l) => l.kind === 'earlier_runs')).toMatchObject({ epfNormal: 1000, epfBonus: 0 });
    // Run 2: normal 5,334 + bonus 2,000 = 7,334 → row 7,300.01–7,400.00 → 814 / 888, so it adds 220 / 240.
    expect(s2.bases).toMatchObject({ epf: 5334, epfAdditional: 2000 });
    expect(s2.statutoryTrace!.epf).toMatchObject({ normalWage: 5334, bonusWage: 2000, employee: 814, employer: 888 });
    expect([s2.epfEmployee, s2.epfEmployer]).toEqual([220, 240]);
    expect(s2.statutoryTrace!.run.earlier).toMatchObject({ runs: 2, additional: 600, epfAdditional: 0, epfWageExtra: 600, exemptEpfWage: 1000 });
    expect(s2.statutoryTrace!.items.find((l) => l.kind === 'earlier_runs')).toMatchObject({ epfNormal: 1600, epfBonus: 0 });
    // The month as ONE computation, whichever run charged which part.
    expect(r.epfEmployee + s1.epfEmployee + s2.epfEmployee).toBe(814);
    expect(r.epfEmployer + s1.epfEmployer + s2.epfEmployer).toBe(888);
    // SOCSO: the award is in the month's SOCSO wage on every run, and neither bonus run adds any (PERF is not
    // SOCSO-ticked; BNS is an EPF Bonus 2012 bonus).
    expect([s1.socsoEmployee, s1.socsoEmployer, s2.socsoEmployee, s2.socsoEmployer]).toEqual([0, 0, 0, 0]);
    expect(s2.statutoryTrace!.socso.wage).toBeCloseTo(4734, 2);
    for (const [s, kind] of [[r, 'regular'], [s1, 'bonus'], [s2, 'bonus']] as const) {
      expect(explainStatutory(s, kind).traceStatus).toBe('recorded');
    }
  });
});
