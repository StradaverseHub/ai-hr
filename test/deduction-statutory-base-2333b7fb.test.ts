/**
 * Feedback 2333b7fb — "a deduction pay item's own statutory ticks are read by NOTHING".
 *
 * THE REPORTED DIAGNOSIS IS CORRECT, which is the opposite of r187 (017d9c25, whose ticket was
 * inverted). This file is the proof and the fix.
 *
 * `earningsOf`'s component loop reached `if (c.kind === 'deduction') { … continue; }` BEFORE any
 * statutory flag was read — and before the declared-stream routing, so a deduction declaring
 * `pcb_remuneration_type = 'normal'` (which is what UNPAID LEAVE, ABSENT and SHORT NOTICE all do on
 * production) never reached a flag either. `included_in_epf` / `_socso_eis` / `_pcb` /
 * `_hrdf_base` therefore rendered on the Pay Item form, saved to the row, and were read by nothing.
 *
 * MEASURED READ-ONLY ON PRODUCTION 2026-08-13. Four payslips in the entire history carry a deduction
 * ticked into a government base; every figure below was reproduced by calling the pack at the stored
 * wage, matching the stored payslip to the cent, and then recomputing at the reduced base:
 *
 *   A0006 2026-01  UPL 322.58, ticked EPF/SOCSO/PCB/HRDF   base 5,100.00 → 4,777.42
 *   A0007 2026-01  ABSENT 122.58, ticked EPF/SOCSO/PCB     EPF 3,900 → 3,777.42, SOCSO/PCB 6,750 → 6,627.42
 *   A0002 2026-01  ABSENT 174.19                           base 5,500 → 5,325.81
 *   T100777 2026-07 DB018 SHORT NOTICE 500                 base 3,700 → 3,200
 *   D0030 MONTHLY PARKING is ticked into NOTHING on 4 payslips and must not move — that is the case
 *   the first test in this file exists to protect.
 *
 * ⚠️ NOTHING HERE RESTATES AN ISSUED PAYSLIP. The fix is forward-looking: the numbers above are what
 * a FUTURE run of that shape produces, asserted on payslips this file generates. January itself is
 * additionally blocked by 24 unconsumed import rows (item 0db616f3) and is deliberately not touched.
 *
 * EVERY ASSERTION IS MONEY ON A GENERATED PAYSLIP, except the two arithmetic checks at the top which
 * exist to make the SIZE of each movement visible in the diff.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  setPayrollBatchComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { statutory } from '../localization/my/payroll';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let a: SessionContext;

/** An EARNING pay item, ticked into everything unless overridden. */
const earning = (code: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
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

/**
 * A DEDUCTION pay item, ticked into NOTHING unless overridden — the shape of D0030 MONTHLY PARKING,
 * which is the behaviour this change must leave alone. The production items that DO move (UPL,
 * ABSENT, DB018) all declare `pcbRemunerationType: 'normal'`; that declaration is deliberately
 * reproduced in the tests below because it is what proves the fix sits ahead of the stream routing.
 */
const deduction = (code: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  code,
  name: `${code} component`,
  kind: 'deduction',
  includedInEpf: false,
  includedInSocsoEis: false,
  includedInPcb: false,
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

const assign = async (employmentId: string, code: string, amount: number) =>
  setEmploymentPayComponent(a, { employmentId, componentId: await idByCode(code), amount, effectiveFrom: '2026-01-01' });

async function slipOf(batchId: string, employmentId: string) {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return rows.find((r) => r.employmentId === employmentId)!;
}

type Bases = { epf: number; epfAdditional: number; socsoEis: number; pcb: number; hrdf: number };
type Stat = {
  epfEmployee: number; epfEmployer: number;
  socsoEmployee: number; socsoEmployer: number; socsoSkbbk: number;
  eisEmployee: number; eisEmployer: number;
  pcb: number; hrdf: number;
  bases?: Bases;
  componentLines?: { code: string; amount: number; epf?: boolean; socso?: boolean; pcb?: boolean; hrdf?: boolean }[];
};
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;

const enableTypedComponents = async () => {
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  a = await entitledCtx(base);
};

/** An APPROVED wholly-unpaid leave request — the OTHER, pre-existing route to a pre-statutory
 *  reduction (`unpaidDeduction`), used by the double-count test at the bottom. */
async function addUnpaidLeave(employmentId: string, from: string, to: string, days: number) {
  const code = `LT${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: base.tenantId, code, name: code, paid: false })
    .returning({ id: schema.leaveType.id });
  await owner.db.insert(schema.leaveRequest).values({
    tenantId: base.tenantId,
    employmentId,
    leaveTypeId: lt.id,
    startDate: from,
    endDate: to,
    days: String(days),
    durationType: 'full_day',
    status: 'approved',
  });
}

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

describe('2333b7fb — the size of the movement, in ringgit', () => {
  /**
   * The pure arithmetic, so the diff SHOWS what changes rather than only what it becomes. Both calls
   * are the same pack function: the first is what the kernel asked for before this change (the whole
   * 5,100 in every base), the second is what it asks for now (A0006's ticked UNPAID LEAVE carved out).
   */
  it('A0006 January: one carve-out moves EPF, SOCSO, EIS and PCB at once', () => {
    const before = statutory(5100, undefined, 0, 0, { month: 1 }, {});
    expect(before.epfEmployee).toBe(561);
    expect(before.epfEmployer).toBe(612);
    expect(Number(before.socsoEmployee)).toBeCloseTo(25.25, 2);
    expect(Number(before.pcb)).toBeCloseTo(116, 2);

    const after = statutory(5100, undefined, 0, 0, { month: 1 }, {
      epfWageDeduction: 322.58, socsoWageDeduction: 322.58, pcbWageDeduction: 322.58,
    });
    expect(after.epfEmployee).toBe(526);
    // ⚠️ THE COUNTER-INTUITIVE ONE, and the reason it is asserted separately rather than in a loop.
    // Taking the base from 5,100 to 4,777.42 crosses BELOW the RM5,000 line, and under that line the
    // EPF Third Schedule employer rate is 13% instead of 12%. The employer's EPF therefore goes UP
    // by RM10 even though the wage went down. A reader who "fixes" this to 602 has broken it.
    expect(after.epfEmployer).toBe(622);
    expect(Number(after.socsoEmployee)).toBeCloseTo(23.75, 2);
    expect(Number(after.pcb)).toBeCloseTo(96.65, 2);
  });

  it('every deduction carve-out defaults to 0 — an unsupplied opts object is byte-identical', () => {
    const bare = statutory(5000, undefined, 1000, 300, { month: 3 }, {});
    const zeroed = statutory(5000, undefined, 1000, 300, { month: 3 }, {
      epfWageDeduction: 0, socsoWageDeduction: 0, pcbWageDeduction: 0,
    });
    expect(zeroed).toEqual(bare);
    // …and the r187 carve-outs still compose with them rather than being displaced.
    const both = statutory(5000, undefined, 0, 0, { month: 3 }, { epfWageExcluded: 500, epfWageDeduction: 500 });
    expect(both.epfEmployee).toBe(statutory(4000, undefined, 0, 0, { month: 3 }, {}).epfEmployee);
  });

  /**
   * A deduction CAN exceed the month's wage (a full unpaid month with a fixed deduction still on the
   * employee). Every base clamps at zero rather than going negative, which for SOCSO/EIS means the
   * FIRST BAND — the RM0–30 band charges RM0.10 / RM0.40, not nothing. Asserted as equality with a
   * genuine zero-wage call rather than against hand-written figures, so the statement is "the base
   * became zero" and not a copy of today's first-band rates.
   */
  it('a carve-out larger than the wage clamps the base at zero, never negative', () => {
    const clamped = statutory(1000, undefined, 0, 0, { month: 1 }, {
      epfWageDeduction: 5000, socsoWageDeduction: 5000, pcbWageDeduction: 5000,
    });
    expect(clamped).toEqual(statutory(0, undefined, 0, 0, { month: 1 }, {}));
    expect(clamped.epfEmployee).toBe(0);
    expect(Number(clamped.pcb)).toBe(0);
  });
});

describe('2333b7fb — an UNTICKED deduction is untouched (D0030 MONTHLY PARKING)', () => {
  /**
   * THE REGRESSION THIS CHANGE IS MOST LIKELY TO CAUSE, so it is the first generated-payslip test.
   * Monthly Parking is ticked into nothing and appears on four production payslips. It must keep
   * coming off the bottom and changing no contribution — including no movement in `bases`, which is
   * the figure item 0253dc7c is about to put on screen.
   */
  it('changes no statutory figure and no wage base — it only comes off net', async () => {
    await seedPayComponentCatalog(a);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await upsertPayComponent(a, deduction('D0030'));

    const withPark = await hire('park@acme.test', '900101015105', 4000);
    const without = await hire('nopark@acme.test', '900101015106', 4000);
    await assign(withPark.employmentId, 'D0030', 169.6);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const sWith = await slipOf(batchId, withPark.employmentId);
    const sWithout = await slipOf(batchId, without.employmentId);

    for (const k of ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'eisEmployee', 'eisEmployer', 'pcb', 'hrdf'] as const) {
      expect(Number(statOf(sWith)[k])).toBeCloseTo(Number(statOf(sWithout)[k]), 2);
    }
    for (const k of ['epf', 'socsoEis', 'pcb', 'hrdf'] as const) {
      expect(statOf(sWith).bases![k]).toBeCloseTo(statOf(sWithout).bases![k], 2);
    }
    expect(statOf(sWith).bases!.epf).toBeCloseTo(4000, 2);
    // It comes off the bottom instead, to the cent.
    expect(Number(sWith.netPay)).toBeCloseTo(Number(sWithout.netPay) - 169.6, 2);
    expect(Number(sWith.employerCost)).toBeCloseTo(Number(sWithout.employerCost), 2);
  });
});

describe('2333b7fb — each tick is judged on its own', () => {
  it('an EPF-only-ticked deduction moves EPF and leaves SOCSO, EIS and PCB alone', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, deduction('DED_EPF_ONLY', { includedInEpf: true }));
    const e = await hire('epfonly@acme.test', '900101015201', 5000);
    await assign(e.employmentId, 'DED_EPF_ONLY', 500);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const st = statOf(await slipOf(batchId, e.employmentId));

    // EPF on 4,500 (495 / 585). Before this change it was on 5,000 (550 / 650).
    expect(st.epfEmployee).toBe(495);
    expect(st.epfEmployer).toBe(585);
    expect(st.bases!.epf).toBeCloseTo(4500, 2);
    // Everything the item is NOT ticked for holds at the full 5,000.
    expect(Number(st.socsoEmployee)).toBeCloseTo(24.75, 2);
    expect(Number(st.eisEmployee)).toBeCloseTo(9.9, 2);
    expect(Number(st.pcb)).toBeCloseTo(92.75, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(5000, 2);
    expect(st.bases!.pcb).toBeCloseTo(5000, 2);
  });

  it('a PCB-only-ticked deduction moves the tax base and leaves EPF and SOCSO alone', async () => {
    await seedPayComponentCatalog(a);
    // PCB ticked ⇒ the classification is compulsory (validateStatutoryClassification), exactly as the
    // Pay Item form enforces. 'normal' is what UPL/ABSENT/DB018 carry on production.
    await upsertPayComponent(a, deduction('DED_PCB_ONLY', {
      includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    const e = await hire('pcbonly@acme.test', '900101015202', 5000);
    await assign(e.employmentId, 'DED_PCB_ONLY', 500);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const st = statOf(await slipOf(batchId, e.employmentId));

    // The declared 'normal' does NOT route this into the wage stream — the deduction branch sits
    // ahead of the stream routing, which is precisely why the ticks were unreachable before.
    expect(st.epfEmployee).toBe(550);
    expect(Number(st.socsoEmployee)).toBeCloseTo(24.75, 2);
    expect(st.bases!.epf).toBeCloseTo(5000, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(5000, 2);
    expect(st.bases!.pcb).toBeCloseTo(4500, 2);
  });
});

describe("2333b7fb — the reporter's own figures, on a generated payslip", () => {
  /**
   * A0006 2026-01 rebuilt: basic 5,000 + HANDPHONE ALLOWANCE 100 (EPF/SOCSO/HRDF ticked) less UNPAID
   * LEAVE 322.58 ticked into all four bases. HRD Corp mandatory (1%), as on the reporter's company.
   */
  it("A0006's January shape: every base falls to 4,777.42 and take-home rises RM56.45", async () => {
    await seedPayComponentCatalog(a);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await upsertPayComponent(a, earning('A0027', {
      includedInEpf: true, includedInSocsoEis: true, includedInHrdfBase: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    await upsertPayComponent(a, deduction('UPL', {
      includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));

    const e = await hire('a0006@acme.test', '900101015301', 5000);
    await assign(e.employmentId, 'A0027', 100);
    await assign(e.employmentId, 'UPL', 322.58);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const s = await slipOf(batchId, e.employmentId);
    const st = statOf(s);

    // Gross is untouched — the deduction still comes off the bottom, in full.
    expect(Number(s.grossPay)).toBeCloseTo(5100, 2);

    // All four bases: 5,100.00 − 322.58.
    expect(st.bases!.epf).toBeCloseTo(4777.42, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(4777.42, 2);
    expect(st.bases!.pcb).toBeCloseTo(4777.42, 2);
    expect(st.bases!.hrdf).toBeCloseTo(4777.42, 2);

    // The contributions, against the stored production payslip (561 / 612 / 25.25 / 88.35 / 10.10 / 116 / 51):
    expect(st.epfEmployee).toBe(526);
    expect(st.epfEmployer).toBe(622); // ↑ RM10 — the 13% employer band below RM5,000. See the note above.
    expect(Number(st.socsoEmployee)).toBeCloseTo(23.75, 2);
    expect(Number(st.socsoEmployer)).toBeCloseTo(83.15, 2);
    expect(Number(st.eisEmployee)).toBeCloseTo(9.5, 2);
    expect(Number(st.eisEmployer)).toBeCloseTo(9.5, 2);
    expect(Number(st.pcb)).toBeCloseTo(96.65, 2);
    expect(Number(st.hrdf)).toBeCloseTo(47.77, 2);

    // THE MONEY, to the cent, against the stored production payslip (1,034.93 / 4,065.07 / 5,861.45):
    //   deductions 526 + 23.75 + 9.50 + 96.65 + UPL 322.58 = 978.48
    //   net        5,100.00 − 978.48                       = 4,121.52   (+56.45)
    //   employer   5,100 + 622 + 83.15 + 9.50 + 47.77      = 5,862.42   (+0.97 — the EPF band again)
    expect(Number(s.totalDeductions)).toBeCloseTo(978.48, 2);
    expect(Number(s.netPay)).toBeCloseTo(4121.52, 2);
    expect(Number(s.netPay) - 4065.07).toBeCloseTo(56.45, 2);
    expect(Number(s.employerCost)).toBeCloseTo(5862.42, 2);
  });

  /**
   * A0007 2026-01 — the GOOD REGRESSION CASE. Their ABSENT is ticked EPF/SOCSO/PCB but NOT HRDF, and
   * both the SOCSO and the EIS base clear the RM6,000 ceiling before AND after the carve-out, so
   * those two contributions must NOT move at all while EPF and PCB do. A change that moved them
   * would be computing an illegal figure, and a test that only ever asserts movement would miss it.
   */
  it("A0007's January shape: EPF and PCB move, SOCSO/EIS hold at the ceiling, HRDF is untouched", async () => {
    await seedPayComponentCatalog(a);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await upsertPayComponent(a, earning('A0027', {
      includedInEpf: true, includedInSocsoEis: true, includedInHrdfBase: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    // ABSENT: EPF/SOCSO/PCB ticked, HRDF NOT — exactly the production row.
    await upsertPayComponent(a, deduction('ABSENT', {
      includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));

    const e = await hire('a0007@acme.test', '900101015302', 3800);
    await assign(e.employmentId, 'A0027', 100);
    await assign(e.employmentId, 'OVERTIME', 2850); // seeded catalogue: not EPF, yes SOCSO/PCB ⇒ the OT leg
    await assign(e.employmentId, 'ABSENT', 122.58);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const s = await slipOf(batchId, e.employmentId);
    const st = statOf(s);

    expect(Number(s.grossPay)).toBeCloseTo(6750, 2); // 3,800 + 100 + 2,850, as on production

    // EPF is charged on the wage EX-overtime: 3,900 − 122.58. SOCSO/EIS/PCB include the OT: 6,750 − 122.58.
    expect(st.bases!.epf).toBeCloseTo(3777.42, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(6627.42, 2);
    expect(st.bases!.pcb).toBeCloseTo(6627.42, 2);
    // HRDF is NOT ticked on this item, so its base keeps the full 3,900 (basic + the HRDF-ticked A0027).
    expect(st.bases!.hrdf).toBeCloseTo(3900, 2);

    expect(st.epfEmployee).toBe(416); // was 429
    expect(st.epfEmployer).toBe(492); // was 507
    // …and these two DO NOT MOVE: 6,750 and 6,627.42 are both above the RM6,000 SOCSO/EIS ceiling.
    expect(Number(st.socsoEmployee)).toBeCloseTo(29.75, 2);
    expect(Number(st.socsoEmployer)).toBeCloseTo(104.15, 2);
    expect(Number(st.eisEmployee)).toBeCloseTo(11.9, 2);
    expect(Number(st.eisEmployer)).toBeCloseTo(11.9, 2);
    expect(Number(st.pcb)).toBeCloseTo(276.55, 2); // was 290
    expect(Number(st.hrdf)).toBeCloseTo(39, 2); // unchanged: 1% of 3,900

    // Net: 6,750 − (416 + 29.75 + 11.90 + 276.55 + 122.58) = 5,893.22, against the stored 5,866.77.
    expect(Number(s.netPay)).toBeCloseTo(5893.22, 2);
    expect(Number(s.netPay) - 5866.77).toBeCloseTo(26.45, 2);
  });
});

describe('2333b7fb — an additional run carries the deduction on BOTH sides of the delta', () => {
  /**
   * The additional-run statutory figure is an INCREMENT: the cumulative month re-run with and without
   * this run's additional remuneration. A carve-out describing money the REGULAR run pays must appear
   * on BOTH sides or the increment comes out wrong in both directions — which is why the baseline
   * override drops only `epfAdditionalExcluded` / `socsoWageExtra` and leaves the deduction ones alone.
   *
   * Asserted as a cross-run invariant rather than by reading the override: the two runs together must
   * charge exactly what one call at the carved base with the bonus charges, and no more.
   */
  it('regular + bonus together charge the month once, on the CARVED base', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, deduction('DED_MULTI', {
      includedInEpf: true, includedInSocsoEis: true, includedInPcb: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    a = await entitledCtx(base);

    const e = await hire('multi@acme.test', '900101015401', 5000);
    await assign(e.employmentId, 'DED_MULTI', 500);

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    const bonusRun = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' });
    await setPayrollBatchComponent(a, {
      batchId: bonusRun.batchId, employmentId: e.employmentId, componentId: await idByCode('BONUS'), amount: 1000,
    });
    await generatePayslips(a, { batchId: bonusRun.batchId });

    const regSt = statOf(await slipOf(reg.batchId, e.employmentId));
    const bonusSt = statOf(await slipOf(bonusRun.batchId, e.employmentId));

    // The regular run is charged on 4,500, not 5,000 (550/650 before this change).
    expect(regSt.epfEmployee).toBe(495);
    expect(regSt.epfEmployer).toBe(585);
    expect(regSt.bases!.epf).toBeCloseTo(4500, 2);

    // THE INVARIANT: the two runs together equal one call at the carved base carrying the bonus.
    // If the deduction carve-out were dropped from the baseline side, the increment would be 55
    // instead of 110 and this sum would be 550 instead of 605.
    const cumulative = statutory(4500, undefined, 1000, 0, { month: 5 }, {});
    expect(cumulative.epfEmployee).toBe(605);
    expect(regSt.epfEmployee + bonusSt.epfEmployee).toBe(cumulative.epfEmployee);
    expect(regSt.epfEmployer + bonusSt.epfEmployer).toBe(cumulative.epfEmployer);
    // SOCSO/EIS exclude a bonus by law, so the bonus run adds nothing to either.
    expect(Number(bonusSt.socsoEmployee)).toBeCloseTo(0, 2);
    expect(Number(bonusSt.eisEmployee)).toBeCloseTo(0, 2);
    // The cash deduction itself is charged by the REGULAR run only — never twice in one month.
    expect(Number((await slipOf(bonusRun.batchId, e.employmentId)).otherDeductions ?? 0)).toBeCloseTo(0, 2);
  });
});

describe('2333b7fb — the two pre-statutory paths stay independent', () => {
  /**
   * `unpaidDeduction` (leave-derived unpaid leave + absence + one-off 'unpaid' ledger rows) has ALWAYS
   * reduced `wagesExOt` and `hrdfBase` before the statutory call. The ticked-deduction path added here
   * is a SECOND, separate reduction. A tenant that records the same absence BOTH ways would reduce
   * twice — that is a data question, not a kernel one, and the point of this test is to pin the two as
   * independent so a future change cannot "tidy" them into one and silently halve or double a base.
   *
   * Basic 3,100 in a 31-day January: one unpaid leave day = RM100. Plus a ticked deduction of RM200.
   * The EPF base must be 3,100 − 100 − 200 = 2,800 — each reduction applied exactly once.
   */
  it('leave-derived unpaid leave and a ticked deduction pay item each reduce the base once', async () => {
    await seedPayComponentCatalog(a);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await upsertPayComponent(a, deduction('DED_BOTH', {
      includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));

    const e = await hire('both@acme.test', '900101015501', 3100);
    await assign(e.employmentId, 'DED_BOTH', 200);
    await addUnpaidLeave(e.employmentId, '2026-01-12', '2026-01-12', 1);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const s = await slipOf(batchId, e.employmentId);
    const st = statOf(s);

    // Stated absolutely: 2,900 would mean the pay item was ignored (today's bug), 3,000 that the leave
    // was, and 2,600 that one of them was counted twice.
    // `other_deductions` is the merged post-tax figure (unpaid 100 + the item 200): 200 alone would
    // mean the leave day never landed, so this also proves the fixture really produced one.
    expect(Number(s.otherDeductions)).toBeCloseTo(300, 2);
    expect(st.bases!.epf).toBeCloseTo(2800, 2);
    expect(st.bases!.socsoEis).toBeCloseTo(2800, 2);
    expect(st.bases!.pcb).toBeCloseTo(2800, 2);
    expect(st.bases!.hrdf).toBeCloseTo(2800, 2);
    expect(st.epfEmployee).toBe(308);
    expect(Number(st.hrdf)).toBeCloseTo(28, 2);

    // …and both amounts still reach the employee's payslip as cash reductions, once each.
    expect(Number(s.grossPay)).toBeCloseTo(3100, 2);
    expect(Number(s.netPay)).toBeCloseTo(
      round2(3100 - (308 + 13.75 + 5.5 + Number(st.pcb)) - 100 - 200), 2,
    );
  });
});

describe('2333b7fb — the ticks are stamped on the payslip, not re-derived later', () => {
  /**
   * Item 0253dc7c shows these on Transaction Detail beside the wage bases. Stamping them at generate
   * time from the row THIS run folded is the only version that reports last month's answer about last
   * month's pay; reading today's catalogue to caption an old payslip is the mistake that already had
   * to be corrected once for `recordLines.nonPayable`.
   */
  it('componentLines carry the four ticks as the run folded them, and survive a catalogue change', async () => {
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, earning('ALW_X', {
      includedInEpf: true, includedInSocsoEis: false, includedInHrdfBase: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    }));
    await upsertPayComponent(a, deduction('DED_X', { includedInEpf: true }));

    const e = await hire('stamp@acme.test', '900101015601', 4000);
    await assign(e.employmentId, 'ALW_X', 200);
    await assign(e.employmentId, 'DED_X', 100);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await enableTypedComponents();
    await generatePayslips(a, { batchId });
    const lines = statOf(await slipOf(batchId, e.employmentId)).componentLines ?? [];
    const byCode = new Map(lines.map((l) => [l.code, l]));

    expect(byCode.get('ALW_X')).toMatchObject({ epf: true, socso: false, pcb: true, hrdf: true });
    expect(byCode.get('DED_X')).toMatchObject({ epf: true, socso: false, pcb: false, hrdf: false });

    // Change the catalogue AFTER the run. The stored slip must keep saying what was true when it was
    // produced — the screen reads the stamp, so a later edit cannot rewrite history on an old payslip.
    await upsertPayComponent(a, deduction('DED_X', { includedInEpf: false, includedInSocsoEis: true }));
    const after = statOf(await slipOf(batchId, e.employmentId)).componentLines ?? [];
    expect(new Map(after.map((l) => [l.code, l])).get('DED_X')).toMatchObject({ epf: true, socso: false });
    // …and the live catalogue really did change, so the assertion above is not vacuous.
    const cat = (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === 'DED_X')!;
    expect(cat.includedInEpf).toBe(false);
    expect(cat.includedInSocsoEis).toBe(true);
  });
});

/** 2dp rounding, mirroring the kernel's own helper (kept local — core's is not exported). */
function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
