/**
 * 3a092cf0 — ZAKAT IS A DEDUCTION, AND IT WAS NOT IN TOTAL DEDUCTIONS.
 *
 * THE DEFECT, MEASURED ON PRODUCTION 2026-09-08 BEFORE ANYTHING WAS PLANNED. SIG01's January 2026
 * payslip: basic 3,708.00 + travel allowance 600.00 = gross 4,308.00; EPF 410.00, SOCSO 18.75,
 * SKBBK 0, EIS 7.50, PCB 0.00, zakat 30.00; total_deductions 436.25 and net_pay 3,871.75.
 * 410 + 18.75 + 0 + 7.50 + 0 = 436.25 EXACTLY — the zakat is on the payslip and is not in the total.
 * `core/payroll.ts` composed `statDeductions` from the five statutory legs and left `st.zakat` out, and
 * because `totalDeductionsRaw` and `net` are both composed FROM `statDeductions`, the omission
 * propagated consistently: every affected payslip reconciled with itself and nothing looked wrong.
 * Nine payslips, four employees, seven runs, 2,569.23 of zakat never taken.
 *
 * ⚠️ THIS FILE ASSERTS A LOWER NET PAY THAN THE SYSTEM USED TO PRODUCE, AND THAT IS THE POINT. The
 * money was left in the employee's pay instead of being deducted and remitted as zakat. There is no
 * "preserve behaviour" case to make here — the old behaviour is the defect.
 *
 * WHY TWO SHAPES, AND WHY NEITHER ALONE WOULD DO. The reporter's fear is a DOUBLE CHARGE: the engine
 * already applies zakat against the PCB liability (LHDN MTD §E.5), so "add zakat to the total" sounds
 * like charging it twice. It is not, and the two cases below are what separate the claims:
 *
 *   (a) THE FLOOR CASE (SIG01's own shape). Tax before zakat was 7.90, which is under the RM10
 *       remittance floor (§E.3), so the PCB line is zero BECAUSE OF THE FLOOR — not because zakat
 *       consumed it. `zakatLeftover` is the whole 30.00, so the whole 30.00 is genuinely owed and must
 *       come off pay. Total 466.25, net 3,841.75.
 *
 *   (b) THE ABSORBED CASE. Tax before zakat EXCEEDS the zakat, so the offset takes the whole zakat out
 *       of the PCB line. Two employees identical but for the election are run side by side, and the
 *       employee WITH zakat pays exactly the same total and takes home exactly the same net as the one
 *       without. That is the proof that nobody pays twice — and it is a proof the offset gives us, not
 *       one that excluding zakat from the total gives us.
 *
 * Case (a) also pins the arithmetic the reporter actually asked for: net = gross − (every deduction
 * line the payslip displays, zakat included), asserted line by line rather than against a stored total,
 * because a stored total is exactly what was wrong.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  backfillEmploymentComponentsFromCompensation,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import { closeAll, entitledCtx, migrateTestDb, resetDb, seedBase, setModule, type Base } from './harness';

/** One payslip's stored money columns + its statutory blob, read exactly as every screen reads them. */
type Slip = {
  gross: number;
  totalDeductions: number;
  otherDeductions: number;
  net: number;
  st: Record<string, number> & { pcbMeta?: { trace?: Record<string, number> } };
};

async function slipFor(ctx: SessionContext, employmentId: string, period: string): Promise<Slip> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        gross: schema.payslip.grossPay,
        totalDeductions: schema.payslip.totalDeductions,
        otherDeductions: schema.payslip.otherDeductions,
        net: schema.payslip.netPay,
        statutory: schema.payslip.statutory,
      })
      .from(schema.payslip)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(
        and(eq(schema.payslip.employmentId, employmentId), eq(schema.payrollBatch.payPeriod, period)),
      )
      .limit(1);
    if (!row) throw new Error(`no payslip for ${employmentId} in ${period}`);
    return {
      gross: Number(row.gross),
      totalDeductions: Number(row.totalDeductions),
      otherDeductions: Number(row.otherDeductions),
      net: Number(row.net),
      st: (row.statutory ?? {}) as Slip['st'],
    };
  });
}

const money = (n: number) => Math.round(n * 100) / 100;

/** Every EMPLOYEE-side deduction line a payslip displays, summed the way a reader adds up the column. */
const displayedDeductionLines = (st: Slip['st']) =>
  money(
    Number(st.epfEmployee ?? 0) +
      Number(st.socsoEmployee ?? 0) +
      Number(st.socsoSkbbk ?? 0) +
      Number(st.eisEmployee ?? 0) +
      Number(st.pcb ?? 0) +
      Number(st.cp38 ?? 0) +
      Number(st.zakat ?? 0),
  );

describe('3a092cf0 — zakat belongs in Total Deductions', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  /**
   * (a) SIG01's own shape, rebuilt from the measured production figures.
   *
   * The 600.00 travel allowance is a pay item ticked out of EVERY agency base (the "all-false"
   * reimbursement bucket), which is what makes EPF/SOCSO/EIS/PCB fall on the 3,708.00 basic alone and
   * reproduces the production trace to the cent — including mtdNormalCalc 7.90 under the RM10 floor.
   */
  it('the floor case: PCB is zero because of the RM10 rule, so the WHOLE zakat is charged', async () => {
    const a0 = await entitledCtx(base);
    const e = await hireEmployee(a0, {
      person: { fullName: 'Tengku bin Tengku', primaryEmail: 'sig01@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a0, {
      employmentId: e.employmentId,
      basicSalary: 3708,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a0, {
      personId: e.personId,
      icNumber: '900101011111',
      taxCategory: 1,
      // Production SIG01 carries socsoSkbbk 0; the SKBBK leg is off for this employee.
      subjectToSkbbk: false,
      zakatActive: true,
      zakatMethod: 'fixed',
      zakatFixed: 30,
    });

    // The travel allowance as a real pay item, out of every statutory base.
    await seedPayComponentCatalog(a0);
    await backfillEmploymentComponentsFromCompensation(a0);
    await upsertPayComponent(a0, {
      code: 'TRAVEL_R255',
      name: 'Travel Allowance',
      kind: 'allowance',
      includedInEpf: false,
      includedInSocsoEis: false,
      includedInPcb: false,
      includedInHrdfBase: false,
      isNonPayable: false,
      prorates: false,
    });
    const travelId = (await listPayComponents(a0)).find((c) => c.code === 'TRAVEL_R255')!.id;
    await setEmploymentPayComponent(a0, {
      employmentId: e.employmentId,
      componentId: travelId,
      amount: 600,
      effectiveFrom: '2026-01-01',
    });
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base); // the entitlement snapshot is point-in-time — re-resolve after the grant

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId });
    const slip = await slipFor(a, e.employmentId, '2026-01');

    // The fixture really is SIG01's: the same gross and the same five statutory legs.
    expect(slip.gross).toBe(4308);
    expect(slip.st.epfEmployee).toBe(410);
    expect(slip.st.socsoEmployee).toBe(18.75);
    expect(slip.st.socsoSkbbk).toBe(0);
    expect(slip.st.eisEmployee).toBe(7.5);
    expect(slip.st.zakat).toBe(30);

    // …and the PCB is zero for the reason that decides whether the 30.00 is genuinely extra: the
    // RM10 remittance floor, NOT the zakat offset. `zakatLeftover` is the whole 30.00.
    const trace = slip.st.pcbMeta!.trace!;
    expect(trace.mtdNormalCalc, 'tax before the floor and before the offset').toBe(7.9);
    expect(trace.mtdNormalFloored, 'the RM10 rule zeroed it on its own').toBe(0);
    expect(trace.zakatCurrent).toBe(30);
    expect(trace.zakatLeftover, 'the offset consumed none of it, so all 30 is still owed').toBe(30);
    expect(slip.st.pcb).toBe(0);

    // THE REPORTER'S ARITHMETIC. 410 + 18.75 + 0 + 7.50 + 0 + 30 = 466.25 (it was 436.25).
    expect(slip.totalDeductions).toBe(466.25);
    expect(slip.net).toBe(3841.75);

    // And the property behind the figures, so this cannot pass with a coincidence: the displayed
    // deduction lines add up to the stored total, and net follows from gross minus that total.
    expect(slip.otherDeductions).toBe(0);
    expect(displayedDeductionLines(slip.st) + slip.otherDeductions).toBe(slip.totalDeductions);
    expect(money(slip.gross - slip.totalDeductions)).toBe(slip.net);

    // 3a092cf0 — AND THE SLIP SAYS SO ON ITS OWN BLOB. Every display surface gates on this stamp to
    // decide whether to print zakat as a COUNTED deduction, because a slip written before this round has
    // a total that excludes it and would otherwise render lines that sum above its own total. Without
    // this assertion the stamp is unguarded: the kernel could stop writing it and every new payslip would
    // silently render as legacy — zakat charged but shown as informational — which is the reporter's
    // original complaint returning by a different door.
    expect(
      (slip.st as unknown as { zakatInTotal?: unknown }).zakatInTotal,
      'the kernel must stamp the slip it just charged zakat on',
    ).toBe(true);
  });

  /**
   * (b) The absorbed case — the double charge the reporter feared, shown not to happen.
   *
   * Basic 8,000: tax before zakat is 514.20, comfortably over the 100.00 zakat, so the offset takes the
   * whole 100.00 out of the PCB line. Charging the zakat as a deduction then adds back exactly what the
   * PCB line lost, and the two employees' totals and nets are identical to the cent.
   */
  it('the absorbed case: the offset takes zakat off the tax, so charging it adds NOTHING extra', async () => {
    const a = await entitledCtx(base);
    const hire = async (name: string, ic: string, zakat: number | null) => {
      const e = await hireEmployee(a, {
        person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 8000,
        monthlyAllowance: 0,
        effectiveFrom: '2026-01-01',
      });
      await setStatutoryProfileMY(a, {
        personId: e.personId,
        icNumber: ic,
        taxCategory: 1,
        subjectToSkbbk: false,
        ...(zakat == null
          ? { zakatActive: false }
          : { zakatActive: true, zakatMethod: 'fixed' as const, zakatFixed: zakat }),
      });
      return e.employmentId;
    };
    const withZakat = await hire('Zakati', '900101012222', 100);
    const without = await hire('Nozakat', '900101013333', null);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId });
    const z = await slipFor(a, withZakat, '2026-01');
    const n = await slipFor(a, without, '2026-01');

    // The offset really did absorb it: same gross, same EPF/SOCSO/EIS, tax lower by exactly the zakat.
    expect(z.gross).toBe(n.gross);
    expect(z.st.epfEmployee).toBe(n.st.epfEmployee);
    expect(z.st.socsoEmployee).toBe(n.st.socsoEmployee);
    expect(z.st.eisEmployee).toBe(n.st.eisEmployee);
    expect(n.st.pcb).toBe(514.2);
    expect(z.st.pcb).toBe(414.2);
    expect(money(n.st.pcb - z.st.pcb)).toBe(100);
    expect(z.st.zakat).toBe(100);
    expect(z.st.pcbMeta!.trace!.zakatLeftover, 'the tax leg swallowed the lot').toBe(0);

    // NOBODY PAYS TWICE. The zakat employee's total and net are the same as the employee without one —
    // the 100.00 moved from the tax line to the zakat line, it was not charged on top of it.
    expect(z.totalDeductions).toBe(n.totalDeductions);
    expect(z.net).toBe(n.net);

    // And each slip still adds up on its own terms.
    for (const s of [z, n]) {
      expect(displayedDeductionLines(s.st) + s.otherDeductions).toBe(s.totalDeductions);
      expect(money(s.gross - s.totalDeductions)).toBe(s.net);
    }
  });
  /**
   * ⚠️ THE VERIFY PASS FOUND THIS, AND THE FIX ITSELF CREATED IT. Putting zakat into `statDeductions`
   * put it OUTSIDE the EA s.24 net-floor clamp, which guards only the manual deduction, CP38 and the
   * loan. Measured on the first build: basic 1,000 with a 2,000 election gave total_deductions 2,116.65
   * and a NET PAY OF -1,116.65 — silently, with no clamp entry and no warning.
   *
   * Zakat is charged through the clamp chain now, so net >= 0 by construction.
   */
  it('an election larger than take-home is clamped — never a negative net', async () => {
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Over Take Home', primaryEmail: 'overzakat@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 1000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101012222',
      taxCategory: 1,
      subjectToSkbbk: false,
      zakatActive: true,
      zakatMethod: 'fixed',
      // Far more than the take-home this basic can produce.
      zakatFixed: 2000,
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId });
    const slip = await slipFor(a, e.employmentId, '2026-02');

    expect(slip.net, 'EA s.24 — net pay can never go negative').toBeGreaterThanOrEqual(0);
    expect(slip.totalDeductions).toBeLessThanOrEqual(slip.gross);
    // And the arithmetic still reconciles at whatever the clamp allowed.
    expect(money(slip.gross - slip.totalDeductions)).toBe(slip.net);
  });
});