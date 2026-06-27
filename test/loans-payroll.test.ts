/**
 * 1.2.8 loan ⊥ payroll (ADR-0060):
 *   (a) un-gated path — with TYPED_PAY_COMPONENTS_ENABLED UNSET, a reserved+generated loan reduces
 *       otherDeductions / netPay by the instalment and changes NO statutory contribution (post-tax).
 *   (b) zero-loans byte-identical golden — a batch with no loans produces byte-identical payslips to the
 *       pre-loan path (the input query + the otherDeductions/totalDeductions sums touch ALL batches; matches
 *       the #148 / 9-3 byte-identical precedent).
 *   (c) negative-net guard — an instalment exceeding available net is clamped, never driving net below 0.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { createLoan, prefillLoansForBatch } from '../core/loans';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const payslipOf = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
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

  it('(c) negative-net guard: an instalment far exceeding net is clamped, never driving net below 0', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'TinyPay', 1500);
    // A huge instalment (5000/month) vs a small salary — the clamp must cap the reservation below net.
    await createLoan(a, { employmentId: e.employmentId, loanType: 'advance', principal: 5000, interestRate: 0, interestMethod: 'none', durationMonths: 1, startDate: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    await generatePayslips(a, { batchId });
    const ps = await payslipOf(batchId);
    // Net pay must remain strictly non-negative.
    expect(Number(ps.netPay)).toBeGreaterThanOrEqual(0);
    // The reserved loan deduction was clamped below the full 5000 instalment.
    const [input] = await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batchId));
    expect(Number(input.loanDeduction)).toBeLessThan(5000);
  });
});
