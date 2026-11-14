/**
 * Statutory follow-ups to owner decisions A/B (2026-11-14). Through the kernel, on real payslips. Fictional
 * fixtures only. Owner rules: a PCB exemption reduces only the PCB base; only the EPF Bonus 2012 tick puts
 * money on the EPF bonus stream; SOCSO/EIS/SKBBK follow the SOCSO tick (EPF Bonus 2012 items stay out).
 *
 *   1. A PCB-exempt ONE-OFF keyed on an ADDITIONAL (bonus) run is paid by that run. Before this date the
 *      exempt slice went to the untaxed cash bucket, which an additional run does not pay, so a fully exempt
 *      award paid RM0. It is now paid on the allowance line, kept out of the PCB base, counted in EPF /
 *      SOCSO / EIS / SKBBK by the item's ticks, and carried so a later run in the month neither charges it
 *      again nor grants its annual exemption headroom again.
 *   2. A LEGACY pay item (no remuneration type, no EPF Bonus 2012) ticked EPF and not SOCSO keeps its PCB
 *      routing and payslip box (the Bonus line, PCB Yt), but its EPF is NORMAL wages.
 *
 * The oracle for item 1 is the same month paid by a different code path: a twin employee who receives the
 * same award on the REGULAR run (pinned by test/statutory-exemption-epf-stream-20261113-db.test.ts). Each
 * agency's month total must be equal to the cent, whichever run paid the award and in whichever order.
 * EPF rows are KWSP Third Schedule Part A: 3,734 → 412 / 487, 4,734 → 522 / 617, 4,000 → 440 / 520,
 * 6,500 → 715 / 780.
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
/** A tax-exempt long service award: PCB additional, PCB_PERQUISITE (RM2,000 a year), EPF + SOCSO ticked. */
const AWARD = item('A0097', 'LONG SERVICE AWARD (TAX EXEMPTED)', { pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_PERQUISITE' });
/** An 'additional'-classified item ticked EPF, NOT EPF Bonus 2012, not SOCSO, fully taxable. */
const PERF = item('PERF', 'Performance incentive', { includedInSocsoEis: false, pcbRemunerationType: 'additional' });
/** A declared bonus: EPF Bonus 2012 (SOCSO ticked, still excluded by law). */
const BNS = item('BNS', 'Bonus', { pcbRemunerationType: 'additional', epfBonus2012: true });
/** A LEGACY item: no remuneration type, no exemption code, no EPF Bonus 2012; ticked EPF, not SOCSO. */
const LEG = item('LEGINC', 'Legacy incentive', {
  includedInSocsoEis: false, pcbRemunerationType: undefined, pcbExemptionCode: undefined, epfBonus2012: undefined,
});

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
const oneOff = async (batchId: string, employmentId: string, code: string, amount: number) =>
  setPayrollBatchComponent(a, { batchId, employmentId, componentId: await idByCode(code), amount });

async function slipOf(batchId: string, employmentId: string) {
  const [row] = await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  return row!;
}
type Line = { kind: string; code?: string; epfNormal: number; epfBonus: number; socsoEis: number };
type Trace = {
  epf: { normalWage: number; bonusWage: number; employee: number; employer: number };
  socso: { wage: number };
  items: Line[];
  run: { kind: string; own: Record<string, number>; earlier?: Record<string, number> };
};
type Stat = Record<string, number> & {
  statutoryTrace?: Trace; bases?: Record<string, number>;
  exemptionUsed?: Record<string, number>; oneOffExemptionUsed?: Record<string, number>;
  componentLines?: { code: string; buckets: { bucket: string; amount: number }[] }[];
};
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;
const itemLine = (st: Stat, code: string) => st.statutoryTrace!.items.find((l) => l.code === code);
const AGENCY = ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer', 'pcb'] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;
const monthTotal = (...slips: Stat[]) =>
  Object.fromEntries(AGENCY.map((k) => [k, round2(slips.reduce((s, st) => s + Number(st[k] ?? 0), 0))]));

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

describe('item 1 — a PCB-exempt one-off keyed on an additional run is paid by that run', () => {
  it('fully exempt: the bonus run pays the RM1,000 award as cash, charges EPF/SOCSO/EIS/SKBBK on it and no PCB', async () => {
    await setup([AWARD]);
    const twin = await hire('twin-full@acme.test', 3734); // award on the regular run (the oracle)
    const e = await hire('bonusrun-full@acme.test', 3734); // award on the bonus run (the case under test)
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(reg.batchId, twin.employmentId, 'A0097', 1000);
    await generatePayslips(a, { batchId: reg.batchId });
    const run = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await oneOff(run.batchId, e.employmentId, 'A0097', 1000);
    await generatePayslips(a, { batchId: run.batchId });

    const slip = await slipOf(run.batchId, e.employmentId);
    const st = statOf(slip);
    // Paid: before this item the run paid 0.00 here.
    expect(Number(slip.allowance)).toBeCloseTo(1000, 2);
    expect(Number(slip.bonus)).toBeCloseTo(0, 2);
    expect(Number(slip.grossPay)).toBeCloseTo(1000, 2);
    expect(Number(slip.basicSalary)).toBeCloseTo(0, 2);
    // The itemised stamp is exactly the money this run paid.
    expect(st.componentLines).toEqual([expect.objectContaining({ code: 'A0097', buckets: [{ bucket: 'reimburse', amount: 1000 }] })]);
    // Exemption headroom spent by this run is stamped (YTD replay, EA) and separately as one-off usage.
    expect(st.exemptionUsed).toEqual({ PCB_PERQUISITE: 1000 });
    expect(st.oneOffExemptionUsed).toEqual({ PCB_PERQUISITE: 1000 });
    // EPF: the month's normal wages 3,734 + 1,000 = 4,734 → 522 / 617; the regular run charged 412 / 487.
    expect(st.bases).toMatchObject({ epf: 4734, epfAdditional: 0 });
    expect([st.epfEmployee, st.epfEmployer]).toEqual([110, 130]);
    // PCB: the award stays out of the income-tax base.
    expect(st.bases!.pcb).toBeCloseTo(3734, 2);
    expect(st.pcb).toBe(0);
    expect(itemLine(st, 'A0097')).toMatchObject({ epfNormal: 1000, epfBonus: 0, socsoEis: 1000 });
    expect(st.statutoryTrace!.run).toMatchObject({ kind: 'additional', own: { exemptEpfWage: 1000, exemptSocsoWage: 1000, exemptEpfAdditional: 0 } });
    expect(explainStatutory(st, 'bonus').traceStatus).toBe('recorded');

    // The month, two runs, equals the same month paid by one regular run, for every agency.
    const r = statOf(await slipOf(reg.batchId, e.employmentId));
    const tw = statOf(await slipOf(reg.batchId, twin.employmentId));
    expect([r.epfEmployee, r.epfEmployer]).toEqual([412, 487]);
    expect([tw.epfEmployee, tw.epfEmployer]).toEqual([522, 617]);
    expect(monthTotal(r, st)).toEqual(monthTotal(tw));
    expect(st.socsoEmployee, 'SOCSO is ticked, so the award moves the month into a higher SOCSO row').toBeGreaterThan(0);
  });

  it('partially exempt: RM2,000 exempt is paid as cash, RM500 taxable on the bonus line; EPF on the whole RM2,500', async () => {
    await setup([AWARD]);
    const twin = await hire('twin-part@acme.test', 4000);
    const e = await hire('bonusrun-part@acme.test', 4000);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(reg.batchId, twin.employmentId, 'A0097', 2500);
    await generatePayslips(a, { batchId: reg.batchId });
    const run = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await oneOff(run.batchId, e.employmentId, 'A0097', 2500);
    await generatePayslips(a, { batchId: run.batchId });

    const slip = await slipOf(run.batchId, e.employmentId);
    const st = statOf(slip);
    expect(Number(slip.allowance)).toBeCloseTo(2000, 2);
    expect(Number(slip.bonus)).toBeCloseTo(500, 2);
    expect(Number(slip.grossPay)).toBeCloseTo(2500, 2);
    expect(st.exemptionUsed).toEqual({ PCB_PERQUISITE: 2000 });
    // EPF: month normal wages 4,000 + 2,500 = 6,500 → 715 / 780, less the regular run's 440 / 520.
    expect(st.bases).toMatchObject({ epf: 6500, epfAdditional: 0 });
    expect([st.epfEmployee, st.epfEmployer]).toEqual([275, 260]);
    // PCB base: only the RM500 taxable remainder joins the month.
    expect(st.bases!.pcb).toBeCloseTo(4500, 2);
    expect(itemLine(st, 'A0097')).toMatchObject({ epfNormal: 2500, epfBonus: 0, socsoEis: 2500 });
    expect(explainStatutory(st, 'bonus').traceStatus).toBe('recorded');

    const r = statOf(await slipOf(reg.batchId, e.employmentId));
    const tw = statOf(await slipOf(reg.batchId, twin.employmentId));
    expect(monthTotal(r, st)).toEqual(monthTotal(tw));
  });

  it('no double count: bonus run (award) BEFORE the regular run — the restating regular run charges the month once', async () => {
    await setup([AWARD]);
    const twin = await hire('twin-order@acme.test', 3734);
    const e = await hire('bonusfirst@acme.test', 3734);
    const run = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await oneOff(run.batchId, e.employmentId, 'A0097', 1000);
    await generatePayslips(a, { batchId: run.batchId });
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(reg.batchId, twin.employmentId, 'A0097', 1000);
    await generatePayslips(a, { batchId: reg.batchId });

    const s = statOf(await slipOf(run.batchId, e.employmentId));
    const r = statOf(await slipOf(reg.batchId, e.employmentId));
    const tw = statOf(await slipOf(reg.batchId, twin.employmentId));
    expect([s.epfEmployee, s.epfEmployer]).toEqual([110, 130]);
    // The regular run reads the award back off the bonus run's stamp: in the month's base, not charged again.
    expect(r.statutoryTrace!.run.earlier).toMatchObject({ exemptEpfWage: 1000, exemptSocsoWage: 1000 });
    expect(r.bases).toMatchObject({ epf: 4734 });
    expect(monthTotal(s, r)).toEqual(monthTotal(tw));
    expect(explainStatutory(r, 'regular').traceStatus).toBe('recorded');
  });

  it('no double count: regular → bonus run 1 (award 1,000) → bonus run 2 (award 1,500): run 2 has only RM1,000 headroom left and charges the month once', async () => {
    await setup([AWARD]);
    const twin = await hire('twin-three@acme.test', 3734); // the same RM2,500 on one regular run
    const e = await hire('three@acme.test', 3734);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(reg.batchId, twin.employmentId, 'A0097', 2500);
    await generatePayslips(a, { batchId: reg.batchId });
    const run1 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await oneOff(run1.batchId, e.employmentId, 'A0097', 1000);
    await generatePayslips(a, { batchId: run1.batchId });
    const run2 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await oneOff(run2.batchId, e.employmentId, 'A0097', 1500);
    await generatePayslips(a, { batchId: run2.batchId });

    const r = statOf(await slipOf(reg.batchId, e.employmentId));
    const slip1 = await slipOf(run1.batchId, e.employmentId);
    const slip2 = await slipOf(run2.batchId, e.employmentId);
    const s1 = statOf(slip1), s2 = statOf(slip2);
    const tw = statOf(await slipOf(reg.batchId, twin.employmentId));
    // Run 2: PCB_PERQUISITE's RM2,000 a year less run 1's RM1,000 → RM1,000 exempt, RM500 taxable.
    expect(Number(slip2.allowance)).toBeCloseTo(1000, 2);
    expect(Number(slip2.bonus)).toBeCloseTo(500, 2);
    expect(s2.exemptionUsed).toEqual({ PCB_PERQUISITE: 1000 });
    // Run 2 carries run 1's exempt award into the month's EPF/SOCSO base on both sides.
    expect(s2.statutoryTrace!.run.earlier).toMatchObject({ runs: 2, exemptEpfWage: 1000, exemptSocsoWage: 1000 });
    expect(s2.bases).toMatchObject({ epf: 6234, epfAdditional: 0 });
    expect(s2.bases!.pcb).toBeCloseTo(4234, 2);
    // The month in three runs is the month in one.
    expect(monthTotal(r, s1, s2)).toEqual(monthTotal(tw));
    for (const [s, kind] of [[r, 'regular'], [s1, 'bonus'], [s2, 'bonus']] as const) {
      expect(explainStatutory(s, kind).traceStatus).toBe('recorded');
    }
  });
});

describe('item 2 — only EPF Bonus 2012 chooses the EPF bonus stream (legacy flag inference)', () => {
  it('a legacy item ticked EPF and not SOCSO is NORMAL EPF wages; its Bonus box and PCB Yt routing are unchanged', async () => {
    await setup([LEG, PERF, BNS]);
    // Basic 4,800 + 400: the two EPF streams give different employer figures here (KWSP 2012 bonus rule).
    const leg = await hire('legacy@acme.test', 4800);
    const perf = await hire('perf@acme.test', 4800);
    const bns = await hire('bns@acme.test', 4800);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await oneOff(reg.batchId, leg.employmentId, 'LEGINC', 400);
    await oneOff(reg.batchId, perf.employmentId, 'PERF', 400);
    await oneOff(reg.batchId, bns.employmentId, 'BNS', 400);
    await generatePayslips(a, { batchId: reg.batchId });

    const legSlip = await slipOf(reg.batchId, leg.employmentId);
    const L = statOf(legSlip);
    const P = statOf(await slipOf(reg.batchId, perf.employmentId));
    const B = statOf(await slipOf(reg.batchId, bns.employmentId));
    // Payslip box and PCB stream unchanged: the Bonus line, additional remuneration (Yt).
    expect(Number(legSlip.bonus)).toBeCloseTo(400, 2);
    expect(Number(legSlip.allowance)).toBeCloseTo(0, 2);
    expect(L.componentLines).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LEGINC', buckets: [{ bucket: 'bonus', amount: 400 }] })]));
    // EPF: normal wages, not the bonus stream; SOCSO unticked stays out.
    expect(L.bases).toMatchObject({ epf: 5200, epfAdditional: 0, socsoEis: 4800, pcb: 5200 });
    expect(itemLine(L, 'LEGINC')).toMatchObject({ epfNormal: 400, epfBonus: 0, socsoEis: 0 });
    expect(L.statutoryTrace!.run.own).toMatchObject({ epfAdditional: 0, epfWageExtra: 400 });
    // Identical to an 'additional'-classified non-2012 item, for every agency including PCB.
    expect(monthTotal(L)).toEqual(monthTotal(P));
    // EPF Bonus 2012 is unchanged: the bonus EPF stream, and it differs here.
    expect(B.bases).toMatchObject({ epf: 4800, epfAdditional: 400, socsoEis: 4800 });
    expect(itemLine(B, 'BNS')).toMatchObject({ epfNormal: 0, epfBonus: 400, socsoEis: 0 });
    expect(B.statutoryTrace!.run.own).toMatchObject({ epfAdditional: 400, epfWageExtra: 0 });
    expect(explainStatutory(L, 'regular').traceStatus).toBe('recorded');
  });

  it('on a bonus run the legacy item is likewise normal EPF wages, charged once across the month', async () => {
    await setup([LEG, PERF]);
    const leg = await hire('legacy-bonus@acme.test', 4800);
    const perf = await hire('perf-bonus@acme.test', 4800);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: reg.batchId });
    const run = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await oneOff(run.batchId, leg.employmentId, 'LEGINC', 400);
    await oneOff(run.batchId, perf.employmentId, 'PERF', 400);
    await generatePayslips(a, { batchId: run.batchId });
    const legSlip = await slipOf(run.batchId, leg.employmentId);
    const L = statOf(legSlip);
    const P = statOf(await slipOf(run.batchId, perf.employmentId));
    expect(Number(legSlip.bonus)).toBeCloseTo(400, 2);
    expect(L.bases).toMatchObject({ epf: 5200, epfAdditional: 0 });
    expect(monthTotal(L)).toEqual(monthTotal(P));
    expect(explainStatutory(L, 'bonus').traceStatus).toBe('recorded');
  });
});
