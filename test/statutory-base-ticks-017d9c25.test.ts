/**
 * Feedback 017d9c25 — "Always apply the latest Pay Item statutory configuration".
 *
 * THE REPORTED DIAGNOSIS IS INVERTED, and this file is the proof plus the fix.
 *
 * Payroll has always read the Pay Item catalogue LIVE at generate time (core/payroll.ts joins
 * `pay_component` on every recurring and one-off fold). Nothing anywhere holds a stale copy — the
 * reporter's own data shows a pay item created on 10 Aug appearing on a January payslip processed on
 * 24 Jul, because they reprocessed the whole run. What the reprocess did was read the NEW catalogue
 * and then ignore the EPF box on it.
 *
 * The real fault: a declared `pcb_remuneration_type` short-circuited the EPF/SOCSO flag inference
 * entirely, and 'normal' routed the amount into the wage bucket that becomes `wagesExOt` — the single
 * figure EPF, SOCSO, EIS and PCB are all charged on. The Pay Item form makes that field compulsory
 * once PCB is ticked, so an operator cannot avoid it.
 *
 * MEASURED READ-ONLY ON PRODUCTION 2026-08-12, employee A0013, batch 368c67fc / pay_period 2026-01,
 * payslip version 3 — the fixture below reproduces this shape exactly:
 *   basic 5952.00 · allowance 1600.00 · gross 7552.00 · total_deductions 1476.30 · net 6075.70
 *   epfEmployee 836 · epfEmployer 912 · socsoEmployee 29.75 · socsoEmployer 104.15
 *   eisEmployee 11.90 · eisEmployer 11.90 · pcb 429.05 · hrdf 60.52
 *   componentLines: A0027 100 → wage · A0080 500 → wage · A0020 1000 → wage · D0030 169.60 → deduct
 * All three allowances are ticked NOT subject to EPF.
 *
 * EVERY ASSERTION HERE IS MONEY ON A GENERATED PAYSLIP, not row shape. The one exception is the pure
 * arithmetic check at the top, which exists to make the SIZE of the movement visible in the diff.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { statutory } from '../localization/my/payroll';
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
  prorates: false,
  ...over,
});

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

async function hire(email: string, ic: string, basic: number) {
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

type Stat = {
  epfEmployee: number; epfEmployer: number;
  socsoEmployee: number; socsoEmployer: number; socsoSkbbk: number;
  eisEmployee: number; eisEmployer: number;
  pcb: number; hrdf: number;
  bases?: { epf: number; epfAdditional: number; socsoEis: number; pcb: number; hrdf: number };
};
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;

const enableTypedComponents = async () => {
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  a = await entitledCtx(base);
};

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

describe('017d9c25 — the size of the movement, in ringgit', () => {
  /**
   * The pure arithmetic, so the diff SHOWS what changes rather than only what it becomes. Both calls
   * are the same function: the first is what the kernel asked for before r187 (the whole 7,552 in the
   * EPF wage), the second is what it asks for now (1,600 of non-EPF allowance carved out).
   *
   * EPF Third Schedule Part A (localization/my/statutory-tables.ts): RM20 bands to 5,000 then RM100
   * bands; employee ceil(0.11 × band upper), employer ceil(0.12 × band upper) above 5,000.
   *   7,552 → band 7,600 → 836 / 912   ← the figure stored on A0013's production payslip
   *   5,952 → band 6,000 → 660 / 720   ← the figure honouring the three "not subject to EPF" ticks
   */
  it('A0013 January: EPF employee 836 → 660, employer 912 → 720', () => {
    const before = statutory(7552, undefined, 0, 0, { month: 1 }, {});
    expect(before.epfEmployee).toBe(836);
    expect(before.epfEmployer).toBe(912);

    const after = statutory(7552, undefined, 0, 0, { month: 1 }, { epfWageExcluded: 1600 });
    expect(after.epfEmployee).toBe(660);
    expect(after.epfEmployer).toBe(720);

    // SOCSO/EIS do NOT move for A0013: the two SOCSO-exempt allowances (A0020 1,000 + A0080 500) take
    // the base from 7,552 to 6,052, still above the RM6,000 ceiling. Only EPF and PCB move for them.
    const socsoCarved = statutory(7552, undefined, 0, 0, { month: 1 }, { socsoWageExcluded: 1500 });
    expect(socsoCarved.socsoEmployee).toBeCloseTo(before.socsoEmployee, 2);
    expect(socsoCarved.eisEmployee).toBeCloseTo(before.eisEmployee, 2);
  });

  it('every carve-out defaults to 0 — an unsupplied opts object is byte-identical', () => {
    const bare = statutory(5000, undefined, 1000, 300, { month: 3 }, {});
    const zeroed = statutory(5000, undefined, 1000, 300, { month: 3 }, {
      epfWageExcluded: 0, epfAdditionalExcluded: 0, socsoWageExcluded: 0, socsoWageExtra: 0,
    });
    expect(zeroed).toEqual(bare);
  });
});

describe('017d9c25 — the ticks decide the statutory bases, on a generated payslip', () => {
  /**
   * The reporter's exact shape, rebuilt: basic 5,952 plus the three allowances they ticked "not
   * subject to EPF", plus the Monthly Parking DEDUCTION. Asserted on the stored payslip, in ringgit.
   */
  it('A0013 January reproduced: EPF falls to 660/720, SOCSO/EIS/HRDF hold, net pay rises', async () => {
    await seedPayComponentCatalog(a);
    // The seeded company is `not_registered` for HRD Corp (levy 0); the reporter's is mandatory (1%).
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    // A0027 HANDPHONE ALLOWANCE — not EPF, yes SOCSO/EIS, yes HRDF, PCB normal.
    await upsertPayComponent(a, input('A0027', {
      includedInEpf: false, includedInSocsoEis: true, includedInHrdfBase: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    // A0080 TRAVEL ALLOWANCE — not EPF, not SOCSO/EIS, PCB normal.
    await upsertPayComponent(a, input('A0080', {
      includedInEpf: false, includedInSocsoEis: false,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    // A0020 DIRECTOR FEE — not EPF, not SOCSO/EIS, PCB normal.
    await upsertPayComponent(a, input('A0020', {
      includedInEpf: false, includedInSocsoEis: false,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    // D0030 MONTHLY PARKING — a DEDUCTION. Half the ticket's premise is already correct behaviour:
    // deductions come off AFTER the statutory figures, so this can never have been in the EPF base.
    await upsertPayComponent(a, input('D0030', {
      kind: 'deduction', includedInEpf: false, includedInSocsoEis: false, includedInPcb: false,
    }));

    const e = await hire('a0013@acme.test', '900101015101', 5952);
    for (const [code, amount] of [['A0027', 100], ['A0080', 500], ['A0020', 1000], ['D0030', 169.6]] as const) {
      await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode(code), amount, effectiveFrom: '2026-01-01' });
    }

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const s = await slipOf(batchId, e.employmentId);
    const st = statOf(s);

    // Gross is untouched — the fix moves no earnings, only which agency is charged on them.
    expect(Number(s.basicSalary)).toBeCloseTo(5952, 2);
    expect(Number(s.allowance)).toBeCloseTo(1600, 2);
    expect(Number(s.grossPay)).toBeCloseTo(7552, 2);

    // EPF honours the three ticks: charged on 5,952 (band 6,000), not on 7,552 (band 7,600).
    expect(st.epfEmployee).toBe(660);
    expect(st.epfEmployer).toBe(720);

    // SOCSO/EIS hold at the production figures. Base 5,952 + 100 (A0027 is SOCSO-ticked) = 6,052,
    // still over the RM6,000 ceiling, so the band does not move even though 1,500 left the base.
    expect(Number(st.socsoEmployee)).toBeCloseTo(29.75, 2);
    expect(Number(st.socsoEmployer)).toBeCloseTo(104.15, 2);
    expect(Number(st.eisEmployee)).toBeCloseTo(11.9, 2);
    expect(Number(st.eisEmployer)).toBeCloseTo(11.9, 2);

    // HRDF holds at the production figure: base = basic 5,952 + the HRDF-ticked A0027 100 = 6,052 @ 1%.
    expect(Number(st.hrdf)).toBeCloseTo(60.52, 2);

    // PCB DOES NOT MOVE, and this is worth stating because it contradicts the natural expectation.
    // EPF is a relief against chargeable income, so a smaller EPF deduction should leave more to tax —
    // but the LHDN annual EPF+life relief cap (RM4,000) was already reached at BOTH figures
    // (660 × 12 = 7,920 and 836 × 12 = 10,032 are both over it), so K is identical and so is the MTD.
    // The remuneration PCB is charged on never moved either: the ticks are about agency liability.
    expect(Number(st.pcb)).toBeCloseTo(429.05, 2);

    // The working between the pay items and the answers.
    expect(st.bases).toBeTruthy();
    expect(st.bases!.epf).toBeCloseTo(5952, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(6052, 2);
    expect(st.bases!.pcb).toBeCloseTo(7552, 2);
    expect(st.bases!.hrdf).toBeCloseTo(6052, 2);

    // THE MONEY, to the cent, against the stored production payslip (1,476.30 / 6,075.70):
    //   deductions 660 + 29.75 + 11.90 + 429.05 + parking 169.60 = 1,300.30  (was 1,476.30)
    //   net        7,552.00 − 1,300.30                           = 6,251.70  (was 6,075.70)
    // The whole movement is the RM176.00 of EPF that should never have been charged. The parking
    // deduction sits OUTSIDE every statutory base and comes off the bottom, exactly as it always did.
    expect(Number(s.totalDeductions)).toBeCloseTo(1300.3, 2);
    expect(Number(s.netPay)).toBeCloseTo(6251.7, 2);
    expect(Number(s.netPay) - 6075.7).toBeCloseTo(176, 2);
    // Employer side: EPF employer 912 → 720, so employer cost falls by exactly RM192.00 (8,640.57 →
    // 8,448.57). Nothing else on the employer side moves.
    expect(Number(s.employerCost)).toBeCloseTo(8448.57, 2);
  });

  it("a 'normal' item ticked not-EPF leaves the EPF base and stays in SOCSO/EIS", async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('NOEPF', {
      includedInEpf: false, includedInSocsoEis: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    const e = await hire('noepf@acme.test', '900101015102', 4000);
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('NOEPF'), amount: 1000, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const st = statOf(await slipOf(batchId, e.employmentId));

    // EPF on 4,000 only (440 / 520). Before r187 it was on 5,000 (550 / 650).
    expect(st.epfEmployee).toBe(440);
    expect(st.epfEmployer).toBe(520);
    // SOCSO/EIS still see the whole 5,000 — the SOCSO tick is on.
    expect(Number(st.socsoEmployee)).toBeCloseTo(24.75, 2);
    expect(Number(st.eisEmployee)).toBeCloseTo(9.9, 2);
    expect(st.bases!.epf).toBeCloseTo(4000, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(5000, 2);
    // …and PCB is still charged on the full 5,000: the ticks are about agency liability, not tax.
    expect(st.bases!.pcb).toBeCloseTo(5000, 2);
  });

  it("a 'normal' item ticked not-SOCSO leaves the SOCSO/EIS base and stays in EPF", async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('NOSOCSO', {
      includedInEpf: true, includedInSocsoEis: false,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    const e = await hire('nosocso@acme.test', '900101015103', 4000);
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('NOSOCSO'), amount: 1000, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const st = statOf(await slipOf(batchId, e.employmentId));

    expect(st.epfEmployee).toBe(550); // the whole 5,000 is EPF-liable
    expect(Number(st.socsoEmployee)).toBeCloseTo(19.75, 2); // …but SOCSO sees 4,000
    expect(Number(st.eisEmployee)).toBeCloseTo(7.9, 2);
    expect(st.bases!.epf).toBeCloseTo(5000, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(4000, 2);
  });

  /**
   * OT1_5 on the reporter's tenant: ticked "not EPF, yes SOCSO/EIS" but classified 'additional', so
   * before r187 it was charged EPF (the bonus leg IS EPF-liable) and left out of SOCSO/EIS — the exact
   * opposite of its own settings, in both directions. This is the ONE carve-out that ADDS a
   * contribution, which is why it gets its own test.
   */
  it("an 'additional' item ticked not-EPF/yes-SOCSO leaves EPF and ENTERS SOCSO/EIS", async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('OT1_5', {
      includedInEpf: false, includedInSocsoEis: true,
      pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    const e = await hire('ot15@acme.test', '900101015104', 4000);
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('OT1_5'), amount: 1000, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const s = await slipOf(batchId, e.employmentId);
    const st = statOf(s);

    // Routing is UNCHANGED: the declaration still puts it in the Yt/bonus stream and the bonus box.
    expect(Number(s.bonus)).toBeCloseTo(1000, 2);
    expect(Number(s.allowance)).toBeCloseTo(0, 2);

    // EPF: the wage band only. Before r187 this was 440 + ceil(0.11 × 1000) = 550.
    expect(st.epfEmployee).toBe(440);
    expect(st.epfEmployer).toBe(520);
    expect(st.bases!.epfAdditional).toBeCloseTo(0, 2);

    // SOCSO/EIS: 4,000 + 1,000 = 5,000. Before r187 the bonus stream was excluded ⇒ 19.75 / 7.90.
    expect(Number(st.socsoEmployee)).toBeCloseTo(24.75, 2);
    expect(Number(st.eisEmployee)).toBeCloseTo(9.9, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(5000, 2);
  });

  /**
   * The half of the ticket that is ALREADY correct and must not be "fixed": Monthly Parking is a
   * deduction, and a deduction has never been inside any statutory base. Proven by paying two
   * identical employees, one with the deduction, and showing every statutory figure is identical.
   */
  it('a deduction was never in the EPF base — Monthly Parking changes no statutory figure', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('D0030', {
      kind: 'deduction', includedInEpf: false, includedInSocsoEis: false, includedInPcb: false,
    }));
    const withPark = await hire('park@acme.test', '900101015105', 4000);
    const without = await hire('nopark@acme.test', '900101015106', 4000);
    await setEmploymentPayComponent(a, { employmentId: withPark.employmentId, componentId: await idByCode('D0030'), amount: 169.6, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const sWith = await slipOf(batchId, withPark.employmentId);
    const sWithout = await slipOf(batchId, without.employmentId);

    for (const k of ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'eisEmployee', 'eisEmployer', 'pcb', 'hrdf'] as const) {
      expect(Number(statOf(sWith)[k])).toBeCloseTo(Number(statOf(sWithout)[k]), 2);
    }
    // It comes off the bottom instead, to the cent.
    expect(Number(sWith.netPay)).toBeCloseTo(Number(sWithout.netPay) - 169.6, 2);
  });

  /**
   * The catalogue is read LIVE — the ticket's own scenario 2/4, end to end. The transaction is never
   * re-keyed; only the Pay Item changes; the reprocessed run moves.
   */
  it('unticking EPF on a Pay Item and reprocessing moves EPF without re-keying the transaction', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('PARK', {
      includedInEpf: true, includedInSocsoEis: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    const e = await hire('reproc@acme.test', '900101015107', 4000);
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('PARK'), amount: 1000, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    expect(statOf(await slipOf(batchId, e.employmentId)).epfEmployee).toBe(550);

    // Change ONLY the Pay Item — no transaction is touched.
    await upsertPayComponent(a, input('PARK', {
      includedInEpf: false, includedInSocsoEis: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    // Reprocess in place, exactly as the Reprocess screen does on a processed-but-not-closed run.
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });

    const after = await slipOf(batchId, e.employmentId);
    expect(statOf(after).epfEmployee).toBe(440);
    expect(Number(after.grossPay)).toBeCloseTo(5000, 2); // the RM1,000 transaction is still paid
  });
});

describe('017d9c25 — a DECLARED bonus stays out of SOCSO/EIS even when the box is ticked', () => {
  /**
   * The one exception to tick authority, and the reason it exists. `epfBonus2012` is not an "is this in
   * that agency's base" answer like the other flags — it is the operator saying "this money IS a bonus"
   * (it forces the additional-remuneration EPF rate). SOCSO Act 1969 s.2 excludes a bonus from wages, so
   * honouring a ticked SOCSO box on a declared bonus would compute an illegal contribution. The seeded
   * BONUS code carries epfBonus2012, so the ordinary bonus is covered without anyone knowing the rule.
   */
  it('epfBonus2012 + SOCSO ticked: EPF charged on the bonus, SOCSO is not', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, input('DECLBONUS', {
      includedInEpf: true, includedInSocsoEis: true,
      epfBonus2012: true, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    const e = await hire('declbonus@acme.test', '900101015108', 4000);
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('DECLBONUS'), amount: 1000, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const st = statOf(await slipOf(batchId, e.employmentId));

    // EPF: wage band 4,000 (440) + the bonus at the normal-wage-band employee rate (11% of 1,000).
    expect(st.epfEmployee).toBe(440 + 110);
    // SOCSO/EIS: the RM4,000 band only — the bonus is NOT wages under the SOCSO Act.
    expect(Number(st.socsoEmployee)).toBeCloseTo(19.75, 2);
    expect(Number(st.eisEmployee)).toBeCloseTo(7.9, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(4000, 2);
  });
});

describe('017d9c25 — the working is recoverable from the payslip', () => {
  /**
   * `statutory.bases` is what makes "why was EPF charged on that?" answerable after the fact. It is a
   * SEPARATE member, not new statutory line keys: diffPayslipVersions reports the nine money lines and
   * must not start reporting a base movement as a statutory movement.
   */
  it('diffPayslipVersions surfaces the bases and does NOT report them as statutory movements', async () => {
    const { diffPayslipVersions, payslipStatutoryBases, STATUTORY_LINE_KEYS } = await import('../core/payslip-recompute');
    const before = { grossPay: 7552, netPay: 6075.7, version: 1, statutory: { epfEmployee: 836, bases: { epf: 7552, epfAdditional: 0, socsoEis: 7552, pcb: 7552, hrdf: 7552 } } };
    const after = { grossPay: 7552, netPay: 6251.7, version: 2, statutory: { epfEmployee: 660, bases: { epf: 5952, epfAdditional: 0, socsoEis: 6052, pcb: 7552, hrdf: 6052 } } };
    const d = diffPayslipVersions(before, after);
    expect(d.basesBefore!.epf).toBe(7552);
    expect(d.basesAfter!.epf).toBe(5952);
    expect(d.basesAfter!.socsoEis).toBe(6052);
    // The ONLY reported movement is the money line. A base is the explanation, not the movement.
    expect(d.moved.map((m) => m.key)).toEqual(['epfEmployee']);
    expect(STATUTORY_LINE_KEYS as readonly string[]).not.toContain('bases');

    // A payslip written before r187 carries no stamp — and that reads as UNKNOWN, never as zero.
    expect(payslipStatutoryBases({ epfEmployee: 836 })).toBeNull();
    expect(diffPayslipVersions({ statutory: { epfEmployee: 836 } }, { statutory: { epfEmployee: 660 } }).basesAfter).toBeNull();
  });
});
