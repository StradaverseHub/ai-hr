/**
 * Item 23e7dac3 / ADR-0085 step 5 — PROCESS A CYCLE IN WHATEVER ORDER THE PAYMENTS HAPPEN.
 *
 * The reporter pays a BONUS, an Off Cycle or an advance salary BEFORE the monthly salary and was forced
 * to run Monthly first. ADR-0024 §6 put that out of scope for v1, and the reason was arithmetic, not
 * taste: EPF, SOCSO and PCB are worked out on what the employee has been paid so far in the month, so
 * whichever run lands second has to see the first one.
 *
 * WHAT THIS FILE HAS TO PROVE IS THE FIGURES, NOT THAT IT RAN. A test that only asserted the bonus run
 * was accepted would have gone green on the version of this change that UNDER-REMITS: before the regular
 * run learned to restate, a RM5,000 salary + RM3,000 bonus + RM500 overtime month paid RM60 of PCB
 * instead of RM100 when the bonus landed first, because the bonus run's increment had been taken on a
 * month with no overtime in it and the salary run never went back. So every arm below compares the
 * MONTH'S TOTAL against the same two payments run the conventional way, in a world seeded identically.
 *
 * THE COMPARISON IS BETWEEN TWO WORLDS, NOT TWO MONTHS OR TWO COMPANIES. PCB carries accumulators from
 * the months before it, so the same pair of runs in May and in June are not comparable figures; and a
 * second company would need its own masters. `resetDb()` + `seedBase()` mid-test gives the identical
 * starting state twice, which is the only honest way to attribute a difference to the ORDER.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import type { SessionContext } from '../db/client';

const MONTH = '2026-05';
const SALARY = 5000;
const BONUS = 3000;
const OVERTIME = 500;

/** The eight figures an accountant checks — the kernel's own DELTA_KEYS less `pcbBonus` (a component OF
 *  `pcb`, not a separate remittance), exactly as the ADR-0024 §7 worksheet lists them. */
const ITEMS = ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer', 'pcb'] as const;
type Figures = Record<(typeof ITEMS)[number], number>;
const round2 = (n: number) => Math.round(n * 100) / 100;

let base: Base;
let a: SessionContext;
let employmentId: string;

/** A pristine world: fresh database, fresh tenant, one RM5,000 employee, multi-cycle entitled. */
async function world() {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  a = await entitledCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: 'Order Test', primaryEmail: 'ot@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2025-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: SALARY, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
  employmentId = e.employmentId;
}

/** Every statutory figure the month's payslips carry, summed — what the month actually remitted. */
async function monthTotal(period = MONTH): Promise<Figures> {
  const rows = await owner.db
    .select({ statutory: schema.payslip.statutory })
    .from(schema.payslip)
    .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
    .where(eq(schema.payrollBatch.payPeriod, period))
    .orderBy(schema.payrollBatch.runSeq);
  const out = Object.fromEntries(ITEMS.map((k) => [k, 0])) as Figures;
  for (const r of rows) {
    const st = (r.statutory ?? {}) as Record<string, number>;
    for (const k of ITEMS) out[k] = round2(out[k] + Number(st[k] ?? 0));
  }
  return out;
}

/** One run's own figures. */
async function runFigures(batchId: string): Promise<Figures> {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  const st = (ps.statutory ?? {}) as Record<string, number>;
  return Object.fromEntries(ITEMS.map((k) => [k, round2(Number(st[k] ?? 0))])) as Figures;
}

/** The monthly salary run, carrying the month's overtime. */
async function monthlyRun(overtime = OVERTIME, bonus = 0) {
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
  if (overtime > 0 || bonus > 0) {
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: overtime, bonusAmount: bonus });
  }
  await generatePayslips(a, { batchId });
  return batchId;
}

/** A bonus run for the same month. */
async function bonusRun(amount = BONUS) {
  const { batchId } = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' });
  await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 0, bonusAmount: amount });
  await generatePayslips(a, { batchId });
  return batchId;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await world();
});
afterAll(async () => {
  await closeAll();
});

describe('23e7dac3 · a month with NOTHING filed accepts the bonus first, and the figures do not move', () => {
  it('(a) BONUS then MONTHLY produces the same EPF/SOCSO/PCB as MONTHLY then BONUS', async () => {
    // Conventional: the salary run leads, the bonus follows.
    await monthlyRun();
    await bonusRun();
    const conventional = await monthTotal();

    // …the identical pair the other way round, in an identically seeded world.
    await world();
    await bonusRun();
    await monthlyRun();
    const reversed = await monthTotal();

    expect(reversed).toEqual(conventional);

    // AND THE FIGURES THEMSELVES, as literals — `toEqual` between two runs of the same code would go
    // green if BOTH orders became wrong together. These are the RM5,000 + RM3,000 + RM500 May month:
    // one EPF Third Schedule lookup on RM8,000 (11% / 12%), ONE SOCSO/EIS charge on RM5,500 (the bonus
    // is outside the s.2(24) wage), and the month's MTD as a single computation.
    expect(conventional).toEqual({
      epfEmployee: 880,
      epfEmployer: 960,
      socsoEmployee: 27.25,
      socsoEmployer: 95.35,
      // SKBBK (Lindung 24 Jam) is an OPTIONAL per-employee election and this employee does not have it,
      // so the leg is 0 in every arm — a zero because the election is absent, not because the figure is.
      socsoSkbbk: 0,
      eisEmployee: 10.9,
      eisEmployer: 10.9,
      pcb: 100,
    });

    // …and the same month paid as ONE run is the same month. "One cycle and two cycles must not differ"
    // is the reporter's property, and it is asserted against a DIFFERENT code path (a plain regular run),
    // not against a second call of the path under test.
    await world();
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: OVERTIME, bonusAmount: BONUS });
    await generatePayslips(a, { batchId });
    expect(await monthTotal()).toEqual(conventional);
  });

  it('(a) the SPLIT moves with the order, and that is correct — only the month is invariant', async () => {
    // The reporter is paid what the month owes either way, but each RUN's own figure differs because a
    // different run is charged the normal wage's base. Asserting the month alone could hide a kernel
    // that simply charged everything twice, so the split is pinned too.
    await monthlyRun();
    const bonusLast = await runFigures(await bonusRun());
    await world();
    const bonusFirst = await runFigures(await bonusRun());
    const monthlyLast = await runFigures(await monthlyRun());

    // The bonus run pays the SAME increment whichever way round it is, because the month's normal wage
    // is read from compensation, not from whether the salary run has been processed.
    expect(bonusFirst.epfEmployee).toBe(bonusLast.epfEmployee);
    expect(bonusFirst.epfEmployer).toBe(bonusLast.epfEmployer);
    // SOCSO/EIS are charged ONCE for the month, by whichever run pays the wage — never by the bonus.
    expect(bonusFirst.socsoEmployee).toBe(0);
    expect(bonusLast.socsoEmployee).toBe(0);
    expect(monthlyLast.socsoEmployee).toBe(27.25);
    // PCB moves between the two runs — the salary run, landing last, is charged the overtime leg that
    // the bonus run could not see. The SUM is what the previous test pins.
    expect(round2(bonusFirst.pcb + monthlyLast.pcb)).toBe(100);
    expect(bonusFirst.pcb).not.toBe(bonusLast.pcb);

    // ── THE WORKSHEET'S OWN TRACE (ADR-0085 §7). Every per-run figure in the worked example an
    // accountant is asked to read is pinned here as a literal, so the document and the kernel cannot
    // drift apart without this failing. RM5,000 basic + RM500 overtime + a RM3,000 bonus, May, no priors.
    expect(bonusLast).toEqual({ epfEmployee: 330, epfEmployer: 310, socsoEmployee: 0, socsoEmployer: 0, socsoSkbbk: 0, eisEmployee: 0, eisEmployer: 0, pcb: 90 });
    expect(bonusFirst).toEqual({ epfEmployee: 330, epfEmployer: 310, socsoEmployee: 0, socsoEmployer: 0, socsoSkbbk: 0, eisEmployee: 0, eisEmployer: 0, pcb: 50 });
    expect(monthlyLast).toEqual({ epfEmployee: 550, epfEmployer: 650, socsoEmployee: 27.25, socsoEmployer: 95.35, socsoSkbbk: 0, eisEmployee: 10.9, eisEmployer: 10.9, pcb: 50 });
  });

  it('(a) an OFF-CYCLE advance salary before the monthly run behaves the same way', async () => {
    // The reporter names three cycles: BONUS, Off Cycle and an advance salary. `off_cycle` is the run
    // type both of the latter map to, so it is pinned rather than assumed to follow.
    const adv = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'off_cycle', remarks: 'Advance Salary' });
    await setPayrollInput(a, { batchId: adv.batchId, employmentId, overtimeAmount: 0, bonusAmount: 1200 });
    await generatePayslips(a, { batchId: adv.batchId });
    await monthlyRun();
    const reversed = await monthTotal();

    await world();
    await monthlyRun();
    const adv2 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'off_cycle', remarks: 'Advance Salary' });
    await setPayrollInput(a, { batchId: adv2.batchId, employmentId, overtimeAmount: 0, bonusAmount: 1200 });
    await generatePayslips(a, { batchId: adv2.batchId });
    expect(reversed).toEqual(await monthTotal());
  });

  it('the bonus run OPENS the month: it creates the pay period and takes run_seq 1', async () => {
    const batchId = await bonusRun();
    const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(b.runSeq).toBe(1);
    expect(b.runType).toBe('bonus');
    const periods = await owner.db.select().from(schema.payPeriod).where(eq(schema.payPeriod.period, MONTH));
    expect(periods).toHaveLength(1);
    expect(periods[0].status).toBe('open');
    // …and the monthly run then takes seq 2 under the SAME parent rather than colliding on seq 1
    // (`payroll_batch_period_run_uq` is on (pay_period_id, run_seq)).
    const monthly = await monthlyRun();
    const [m] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, monthly));
    expect(m.runSeq).toBe(2);
    expect(m.payPeriodId).toBe(periods[0].id);
    // A SECOND monthly run is still refused — relaxing the order did not relax "one regular run".
    await expect(createBatch(a, { companyId: base.companyId, payPeriod: MONTH })).rejects.toThrow(
      /A payroll process already exists for this period/,
    );
  });
});

describe('23e7dac3 · what this change must NOT have touched', () => {
  it('(e) an ordinary single MONTHLY run is unchanged, on real payslip figures', async () => {
    const batchId = await monthlyRun();
    const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(b.runSeq).toBe(1);
    // RM5,000 salary + RM500 overtime, May, no priors: EPF on RM5,000 (overtime is EPF-exempt),
    // SOCSO/EIS on RM5,500, MTD on the month.
    expect(await runFigures(batchId)).toEqual({
      epfEmployee: 550,
      epfEmployer: 650,
      socsoEmployee: 27.25,
      socsoEmployer: 95.35,
      socsoSkbbk: 0,
      eisEmployee: 10.9,
      eisEmployer: 10.9,
      pcb: 10,
    });
    // AND IT DID NOT GO THROUGH `deltaStat`. A lone regular run keeps its literal computeMonth call; if
    // it were routed through the delta path it would pick up the `pcbMeta.delta` stamp, which is the
    // one observable difference between "the same number" and "the same code". This arm fails the day
    // somebody simplifies the three-way branch into one.
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const meta = ((ps.statutory ?? {}) as Record<string, unknown>).pcbMeta as Record<string, unknown> | undefined;
    expect(meta).toBeTruthy();
    expect(meta!.delta).toBeUndefined();
  });

  it('(g) a company with NO non-regular cycle configured is untouched', async () => {
    // The entitlement is what opens the non-regular path at all. Without it — which is every company
    // that has not bought multi-cycle, and every company whose catalog has only a regular cycle — the
    // month behaves exactly as it always did: one run, opened by createBatch, at seq 1.
    await setModule(base.tenantId, 'multi_cycle_payroll', null);
    const plain = await entitledCtx(base);
    await expect(
      createAdditionalRun(plain, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' }),
    ).rejects.toThrow(/not enabled/i);
    const { batchId } = await createBatch(plain, { companyId: base.companyId, payPeriod: MONTH });
    await generatePayslips(plain, { batchId });
    const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(b.runSeq).toBe(1);
    expect(await monthTotal()).toEqual({
      epfEmployee: 550, epfEmployer: 650, socsoEmployee: 24.75, socsoEmployer: 86.65,
      socsoSkbbk: 0, eisEmployee: 9.9, eisEmployer: 9.9, pcb: 0,
    });
  });
});

describe('23e7dac3 · the ONE case the order still changes, stated rather than hidden', () => {
  /**
   * ADR-0085 §1.1: the EPF Third Schedule steps the EMPLOYER column DOWN from 13% to 12% at RM5,000, so
   * a month can get bigger and its employer contribution smaller. `deltaStat` floors every increment at
   * zero (ADR-0024 §6), so whichever run crosses the step contributes RM0 rather than giving the
   * difference back, and the month ends over the table figure. That is a known, bounded, accepted defect
   * — and lifting it is ADR-0085 step 3 (signed deltas), which this round deliberately does NOT do.
   *
   * Because the clamp fires on whichever run crosses the step, and the two orders cross it at different
   * points, this is the one shape where the order still changes a figure. The divergence is pinned here
   * with its DIRECTION and its BOUND so the worksheet's claim is checkable: the clamp can only ever
   * REMOVE a negative increment, so an out-of-order month is never under-remitted, only over — and the
   * excess is an employer cost that lands in the employee's own EPF account.
   */
  it('a bonus that carries the month across the RM5,000 EPF step still clamps, and only upwards', async () => {
    // RM4,990 basic, with RM40 of bonus-bucket money inside the salary run and a RM30 bonus run beside
    // it: the month is RM5,060, which is over the RM5,000 step, but the salary alone is under it.
    await setCompensation(a, { employmentId, basicSalary: 4990, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    await monthlyRun(0, 40);
    await bonusRun(30);
    const conventional = await monthTotal();

    await world();
    await setCompensation(a, { employmentId, basicSalary: 4990, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    await bonusRun(30);
    await monthlyRun(0, 40);
    const reversed = await monthTotal();

    // Conventional: the salary run already carries the month over the step, so no increment is negative
    // and the month equals the single Third Schedule lookup for RM5,060.
    expect(conventional.epfEmployer).toBe(612);
    // Reversed: the RM30 bonus run crosses the step FIRST, its negative increment is clamped away, and
    // the month ends ABOVE the table figure — never below it.
    expect(reversed.epfEmployer).toBe(650);
    expect(reversed.epfEmployer).toBeGreaterThan(conventional.epfEmployer);
    // The bound is the size of the step, not an open-ended drift.
    expect(round2(reversed.epfEmployer - conventional.epfEmployer)).toBe(38);
    // Every other leg is untouched by the step and agrees exactly.
    for (const k of ITEMS) {
      if (k === 'epfEmployer') continue;
      expect([k, reversed[k]]).toEqual([k, conventional[k]]);
    }
  });
});
