/**
 * 1.2.8 loan lifecycle (ADR-0060) — the two-phase reserve→apply ledger and the full state machine.
 *   create → prefill (reserve, ledger UNCHANGED) → generatePayslips (apply: outstanding decremented +
 *   repayment 'applied') → repeat to auto-'settled'. Plus: re-prefill on the same draft does NOT reserve a
 *   second instalment; abandoning a draft after prefill leaves the ledger UNCHANGED; suspend excludes /
 *   resume re-includes; settle zeroes + skips remaining; cancel blocked after an instalment applied; amend
 *   recomputes only scheduled rows from outstanding; a non-regular batch is rejected; a terminated employee
 *   is not reserved. Events asserted via eventTypesFor.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import {
  amendLoan,
  cancelLoan,
  createLoan,
  getLoanWithSchedule,
  prefillLoansForBatch,
  resumeLoan,
  settleLoan,
  suspendLoan,
} from '../core/loans';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let icSeq = 0;
const nextIc = () => `9001010${String(10000 + icSeq++).slice(-5)}`;
const hire = async (b: Base, name: string) => {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
};

const loanRow = async (loanId: string) => {
  const [l] = await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, loanId));
  return l;
};
const reservedFor = async (loanId: string) =>
  owner.db
    .select()
    .from(schema.loanRepayment)
    .where(and(eq(schema.loanRepayment.loanId, loanId), eq(schema.loanRepayment.status, 'reserved')));
const loanInput = async (batchId: string, employmentId: string) => {
  const [r] = await owner.db
    .select({ loan: schema.payrollInput.loanDeduction })
    .from(schema.payrollInput)
    .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
  return r ? Number(r.loan) : null;
};

describe('ADR-0060 — loan lifecycle', () => {
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

  it('create materializes the schedule; prefill RESERVES without touching the ledger; generate APPLIES it', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Borrower');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId,
      loanType: 'personal',
      principal: 1200,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: '2026-01-01',
    });
    const created = await loanRow(loanId);
    expect(Number(created.monthlyInstalment)).toBeCloseTo(100, 2);
    expect(Number(created.outstandingBalance)).toBeCloseTo(1200, 2);
    const withSchedule = await getLoanWithSchedule(a, loanId);
    expect(withSchedule!.schedule).toHaveLength(12);

    // ── Prefill = RESERVE only ──
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const res = await prefillLoansForBatch(a, { batchId });
    expect(res.loans).toBe(1);
    expect(res.total).toBeCloseTo(100, 2);
    expect(await loanInput(batchId, e.employmentId)).toBeCloseTo(100, 2);
    const afterPrefill = await loanRow(loanId);
    expect(Number(afterPrefill.outstandingBalance)).toBeCloseTo(1200, 2); // UNCHANGED
    expect(afterPrefill.instalmentsPaid).toBe(0); // UNCHANGED
    expect((await reservedFor(loanId)).length).toBe(1);

    // ── Generate = APPLY ──
    await generatePayslips(a, { batchId });
    const afterApply = await loanRow(loanId);
    expect(Number(afterApply.outstandingBalance)).toBeCloseTo(1100, 2);
    expect(afterApply.instalmentsPaid).toBe(1);
    const sched = await getLoanWithSchedule(a, loanId);
    expect(sched!.schedule.filter((r) => r.status === 'applied')).toHaveLength(1);

    const events = await eventTypesFor(base.tenantId, loanId);
    expect(events).toContain('loan.created');
  });

  it('re-prefill on the same draft does NOT reserve a second instalment', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Once');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId, loanType: 'advance', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    await prefillLoansForBatch(a, { batchId }); // re-run
    expect((await reservedFor(loanId)).length).toBe(1); // still exactly one
    expect(await loanInput(batchId, e.employmentId)).toBeCloseTo(100, 2); // converges, not doubled
  });

  it('abandoning a draft after prefill leaves outstanding/instalmentsPaid UNCHANGED (reserve ≠ apply)', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Abandon');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    // Abandon: delete the draft batch's inputs + the batch (no generate). The loan ledger must be intact.
    await owner.db.delete(schema.payrollInput).where(eq(schema.payrollInput.batchId, batchId));
    const l = await loanRow(loanId);
    expect(Number(l.outstandingBalance)).toBeCloseTo(1200, 2);
    expect(l.instalmentsPaid).toBe(0);
  });

  it('repeated cycles drive the loan to auto-settled (auto-stop)', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Repay');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId, loanType: 'advance', principal: 300, interestRate: 0, interestMethod: 'none', durationMonths: 3, startDate: '2026-01-01',
    });
    for (const period of ['2026-04', '2026-05', '2026-06']) {
      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
      await prefillLoansForBatch(a, { batchId });
      await generatePayslips(a, { batchId });
    }
    const l = await loanRow(loanId);
    expect(l.status).toBe('settled');
    expect(Number(l.outstandingBalance)).toBeCloseTo(0, 2);
    expect(l.instalmentsPaid).toBe(3);
    const events = await eventTypesFor(base.tenantId, loanId);
    expect(events).toContain('loan.settled');
  });

  it('suspend excludes from prefill; resume re-includes', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Pause');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    await suspendLoan(a, loanId);
    const { batchId: b1 } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const r1 = await prefillLoansForBatch(a, { batchId: b1 });
    expect(r1.loans).toBe(0);
    expect((await reservedFor(loanId)).length).toBe(0);

    await resumeLoan(a, loanId);
    const { batchId: b2 } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    const r2 = await prefillLoansForBatch(a, { batchId: b2 });
    expect(r2.loans).toBe(1);
    const events = await eventTypesFor(base.tenantId, loanId);
    expect(events).toEqual(expect.arrayContaining(['loan.suspended', 'loan.resumed']));
  });

  it('settle zeroes the balance + skips remaining repayments', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Settle');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    await settleLoan(a, loanId);
    const l = await loanRow(loanId);
    expect(l.status).toBe('settled');
    expect(Number(l.outstandingBalance)).toBeCloseTo(0, 2);
    const sched = await getLoanWithSchedule(a, loanId);
    expect(sched!.schedule.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('cancel is blocked once an instalment has been applied', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'NoCancel');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId, loanType: 'advance', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    // Before any instalment: cancel works on a fresh loan…
    const e2 = await hire(base, 'CanCancel');
    const { id: loan2 } = await createLoan(a, {
      employmentId: e2.employmentId, loanType: 'advance', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    await cancelLoan(a, loan2);
    expect((await loanRow(loan2)).status).toBe('cancelled');

    // …but once applied, cancel is rejected.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    await generatePayslips(a, { batchId });
    await expect(cancelLoan(a, loanId)).rejects.toThrow();
  });

  it('amend recomputes only the scheduled rows from outstanding; they sum to it', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Amend');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    // Apply one instalment so instalmentsPaid = 1, outstanding = 1100.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    await generatePayslips(a, { batchId });

    // Amend: shorten to 6 months total → remaining = 6 - 1 = 5 months over outstanding 1100.
    await amendLoan(a, { loanId, durationMonths: 6 });
    const l = await loanRow(loanId);
    expect(l.durationMonths).toBe(6);
    expect(Number(l.monthlyInstalment)).toBeCloseTo(220, 2); // 1100 / 5

    const sched = await getLoanWithSchedule(a, loanId);
    const scheduledSum = sched!.schedule.filter((r) => r.status === 'scheduled').reduce((s, r) => s + Math.round(r.dueAmount * 100), 0);
    expect(scheduledSum).toBe(Math.round(Number(l.outstandingBalance) * 100)); // scheduled rows sum to outstanding
    // The already-applied row is immutable.
    expect(sched!.schedule.filter((r) => r.status === 'applied')).toHaveLength(1);
  });

  it('prefill rejects a non-regular (additional) batch', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'OffCycle');
    await createLoan(a, {
      employmentId: e.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    // The regular run must exist first; then an additional run is non-regular (multi-cycle gated on).
    //
    // ADR-0077 slice 3: multi-cycle payroll is a per-tenant entitlement ROW, not MULTI_CYCLE_PAYROLL_ENABLED.
    // The row alone is not enough here — `adminCtx` builds its snapshot from `legacyEnabledModulesIn(process.env)`
    // at construction time, and test/env.ts deletes that flag, so `a` would refuse `createAdditionalRun`
    // no matter what the database says. `entitledCtx` resolves a REAL snapshot from this tenant's rows,
    // and snapshots point-in-time, so the grant must be written BEFORE the context is built.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const mc = await entitledCtx(base);
    await createBatch(mc, { companyId: base.companyId, payPeriod: '2026-05' });
    const { batchId: bonusBatch } = await createAdditionalRun(mc, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' });
    // Pinned to the runType refusal: multi-cycle is deliberately ON for this tenant, so a rejection here
    // can only be the non-regular guard in prefillLoansForBatch — not a ModuleNotEnabledError from a gate
    // that failed to open, which is exactly how this test could otherwise pass for the wrong reason.
    await expect(prefillLoansForBatch(mc, { batchId: bonusBatch })).rejects.toThrow(
      /only be prefilled onto a regular run/,
    );
  });

  it('a terminated employee is not reserved (active-employee filter)', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Leaver');
    const { id: loanId } = await createLoan(a, {
      employmentId: e.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    // Terminate before the pay period — they get no payslip, so no reservation.
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-04-30' }).where(eq(schema.employment.id, e.employmentId));
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    const res = await prefillLoansForBatch(a, { batchId });
    expect(res.loans).toBe(0);
    expect((await reservedFor(loanId)).length).toBe(0);
    expect((await loanRow(loanId)).status).toBe('active'); // stays active with outstanding balance
  });
});
