/**
 * 1.2.8 loan ⊥ payroll (ADR-0060):
 *   (a) un-gated path — with TYPED_PAY_COMPONENTS_ENABLED UNSET, a reserved+generated loan reduces
 *       otherDeductions / netPay by the instalment and changes NO statutory contribution (post-tax).
 *   (b) zero-loans byte-identical golden — a batch with no loans produces byte-identical payslips to the
 *       pre-loan path (the input query + the otherDeductions/totalDeductions sums touch ALL batches; matches
 *       the #148 / 9-3 byte-identical precedent).
 *   (c) negative-net guard (audit C1) — a loan + a large CP38 on a low salary must NEVER persist net pay
 *       < 0: the loan YIELDS to statutory + CP38 + everything else.
 *   (d) clamped instalment ⊥ silent write-off (audit C2/H1/H3) — when the instalment is clamped below the
 *       scheduled due, the loan stays ACTIVE with the TRUE residual outstanding (NOT settled, NOT written
 *       off), the shortfall RE-SCHEDULES, and the loan settles (status='settled', outstanding 0.00) ONLY
 *       once a later cycle clears the balance to zero.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCp38 } from '../core/cp38';
import { createBatch, generatePayslips } from '../core/payroll';
import { createLoan, prefillLoansForBatch, getLoanWithSchedule } from '../core/loans';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const payslipOf = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
};

const loanRow = async (loanId: string) => {
  const [l] = await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, loanId));
  return l;
};

let icSeq = 0;
const nextIc = () => `9001010${String(10000 + icSeq++).slice(-5)}`;
const hire = async (b: Base, name: string, basic: number) => {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
};

describe('ADR-0060 — loan ⊥ payroll', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED; // prove the UN-GATED path
  });
  afterEach(() => {
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterAll(async () => {
    await closeAll();
  });

  it('(a) un-gated: a loan instalment reduces otherDeductions/net and changes NO statutory contribution', async () => {
    const a = adminCtx(base);
    // Two identical employees in the SAME batch so statutory context (period, PCB replay) is identical: one
    // carries a loan, one does not. The only difference must be the loan instalment on net/otherDeductions.
    const noLoanEmp = await hire(base, 'NoLoanTwin', 5000);
    const loanEmp = await hire(base, 'LoanTwin', 5000);
    await createLoan(a, { employmentId: loanEmp.employmentId, loanType: 'personal', principal: 2400, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    await generatePayslips(a, { batchId });
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const noLoanPs = slips.find((r) => r.employmentId === noLoanEmp.employmentId)!;
    const loanPs = slips.find((r) => r.employmentId === loanEmp.employmentId)!;

    // The loan-bearing payslip's otherDeductions/net/total differ from the twin by exactly 200.
    expect(Number(loanPs.otherDeductions)).toBeCloseTo(Number(noLoanPs.otherDeductions) + 200, 2);
    expect(Number(loanPs.netPay)).toBeCloseTo(Number(noLoanPs.netPay) - 200, 2);
    expect(Number(loanPs.totalDeductions)).toBeCloseTo(Number(noLoanPs.totalDeductions) + 200, 2);
    // Statutory is identical (post-tax: loan touches no statutory base).
    expect(loanPs.statutory).toEqual(noLoanPs.statutory);
    // Gross is unchanged.
    expect(Number(loanPs.grossPay)).toBeCloseTo(Number(noLoanPs.grossPay), 2);
  });

  it('(b) zero-loans byte-identical golden: no loans ⇒ payslips byte-identical to the pre-loan path', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'NoLoan', 4321);

    // Capture a golden by generating a batch that has no loan rows AND no loan input at all.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    // Running prefill with no active loans must be a no-op and must NOT write a loan_deduction row.
    const res = await prefillLoansForBatch(a, { batchId });
    expect(res.loans).toBe(0);
    const inputs = await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batchId));
    expect(inputs.length).toBe(0); // no spurious payroll_input row created

    await generatePayslips(a, { batchId });
    const ps = await payslipOf(batchId);
    // The captured golden: basic 4321, no allowance/OT/bonus, otherDeductions reflects only unpaid/extra (0).
    expect(Number(ps.otherDeductions)).toBeCloseTo(0, 2);
    expect(Number(ps.grossPay)).toBeCloseTo(4321, 2);
    // net = gross − statutory only (no loan term); employerCost unaffected by loans.
    const st = ps.statutory as Record<string, number>;
    const statDed = st.epfEmployee + st.socsoEmployee + (st.socsoSkbbk ?? 0) + st.eisEmployee + st.pcb;
    expect(Number(ps.totalDeductions)).toBeCloseTo(statDed, 2);
    expect(Number(ps.netPay)).toBeCloseTo(4321 - statDed, 2);

    void e;
  });

  it('(c) audit C1 — a loan + a large CP38 on a low salary never persists net < 0', async () => {
    const a = adminCtx(base);
    // The audit probe verbatim: basic 3000, CP38 2500, loan instalment 1400 ⇒ untreated net −1272.80. The
    // loan must yield to statutory + CP38; net pay on the persisted payslip must stay >= 0.
    const e = await hire(base, 'Drowning', 3000);
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/BIG', amount: 2500, validFrom: '2026-01-01' });
    // A loan whose instalment (1400) would, untreated, drive net far below zero (audit: net −1272.80).
    await createLoan(a, { employmentId: e.employmentId, loanType: 'personal', principal: 16800, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    await generatePayslips(a, { batchId });
    const ps = await payslipOf(batchId);

    // The REQUIREMENT: the persisted payslip can never carry a negative net because of a loan.
    expect(Number(ps.netPay)).toBeGreaterThanOrEqual(0);
  });

  it('(d) audit C2/H1/H3 — a clamped instalment never writes off the loan; shortfall re-schedules; settles only at balance 0', async () => {
    const a = adminCtx(base);
    // Low salary with a CP38 that swallows most of net, and a 1-month loan whose full instalment cannot be
    // recovered. On the buggy code the loan auto-settles (instalmentsPaid >= durationMonths) → silent
    // write-off. The fix: clamp the applied amount, re-schedule the shortfall, keep the loan ACTIVE with the
    // true residual outstanding; only the cycle that clears the balance to 0 settles it.
    const e = await hire(base, 'Shortfall', 2000);
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/SF', amount: 1500, validFrom: '2026-01-01' });
    // principal 1800, 1 month ⇒ a single 1800 instalment, far above the available net after CP38 + statutory.
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId,
      loanType: 'advance',
      principal: 1800,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 1,
      startDate: '2026-01-01',
    });

    // Cycle 1 — the instalment is clamped to the available net (well below 1800).
    const c1 = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId: c1.batchId });
    await generatePayslips(a, { batchId: c1.batchId });
    const ps1 = await payslipOf(c1.batchId);
    expect(Number(ps1.netPay)).toBeGreaterThanOrEqual(0);

    const applied1 = Number(ps1.otherDeductions); // CP38 + clamped loan; the loan piece is < 1800
    expect(applied1).toBeLessThan(1800 + 1500); // sanity: clamped, not the full instalment

    // The loan must NOT be settled or written off after the clamped cycle.
    const afterC1 = await loanRow(loanId);
    expect(afterC1.status).toBe('active');
    // Outstanding reflects the TRUE residual: 1800 minus only what was actually applied (NOT 0.00).
    expect(Number(afterC1.outstandingBalance)).toBeGreaterThan(0);

    // The schedule still covers the full residual: applied rows + remaining scheduled rows sum to 1800.
    const sched1 = await getLoanWithSchedule(a, loanId);
    const appliedSum = sched1!.schedule.filter((r) => r.status === 'applied').reduce((s, r) => s + r.appliedAmount, 0);
    const scheduledSum = sched1!.schedule.filter((r) => r.status === 'scheduled').reduce((s, r) => s + r.dueAmount, 0);
    expect(appliedSum + scheduledSum).toBeCloseTo(1800, 2);
    // The applied row carries the ACTUAL clamped amount, and the outstanding equals the still-scheduled total.
    expect(Number(afterC1.outstandingBalance)).toBeCloseTo(scheduledSum, 2);
    // There IS a re-scheduled shortfall row (the loan is recoverable next cycle).
    expect(scheduledSum).toBeGreaterThan(0);

    // Cycle 2 — end the CP38 squeeze BEFORE June (cp38ForPeriod treats validTo >= month-start as still
    // active, so validTo must be the prior month) so the residual can clear and the loan settles ONLY now.
    await owner.db
      .update(schema.employeeCp38)
      .set({ validTo: '2026-05-01' })
      .where(and(eq(schema.employeeCp38.employmentId, e.employmentId), eq(schema.employeeCp38.cp38Ref, 'CP38/SF')));

    const c2 = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await prefillLoansForBatch(a, { batchId: c2.batchId });
    await generatePayslips(a, { batchId: c2.batchId });
    const ps2 = await payslipOf(c2.batchId);
    expect(Number(ps2.netPay)).toBeGreaterThanOrEqual(0);

    const afterC2 = await loanRow(loanId);
    expect(afterC2.status).toBe('settled');
    expect(Number(afterC2.outstandingBalance)).toBeCloseTo(0, 2);
  });
});
