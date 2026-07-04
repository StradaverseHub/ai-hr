/**
 * Employee loan instalments (1.2.8, ADR-0060) — HR-administered staff loans recovered by a fixed monthly
 * POST-TAX net-pay deduction. Two-phase reserve→apply, mirroring the claims payout:
 *   • prefillLoansForBatch  — RESERVE only (writes payroll_input.loan_deduction, stamps the next scheduled
 *                             repayment as 'reserved'); NO ledger mutation.
 *   • applyLoansForBatch    — internal, called ONLY from generatePayslips after the payslip loop; advances
 *                             outstanding_balance / instalments_paid, marks repayments 'applied', auto-stops.
 *
 * Every write appends a DomainEvent (module 'loans'); events reference the aggregate id only — NO cleartext
 * amounts in payloads (ADR-0030). All writes are admin-only (asserted in the service; RLS does not enforce
 * admin-only writes here, matching claims — so the ESS path must NEVER call a loan write service).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  employeeLoan,
  employment,
  loanRepayment,
  payrollBatch,
  payrollInput,
  person,
} from '../db/schema';

// RSC-safe pure calc engine + constants live in ./loans-compute (NO db import) so a client component
// (components/loan-new-form.tsx) can import computeLoan + the constants without pulling postgres into the
// browser bundle. Re-exported here so server callers + tests keep importing them from '@/core/loans'.
import {
  LoanError,
  LOAN_TYPES,
  LOAN_INTEREST_METHODS,
  computeLoan,
  toCents,
  fromCents,
  money,
  type LoanType,
  type LoanInterestMethod,
  type LoanComputation,
} from './loans-compute';
export { LoanError, LOAN_TYPES, LOAN_INTEREST_METHODS, computeLoan };
export type { LoanType, LoanInterestMethod, LoanComputation };

const isAdmin = (ctx: SessionContext): boolean =>
  (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
const assertAdmin = (ctx: SessionContext): void => {
  if (!isAdmin(ctx)) throw new LoanError('Only an administrator can manage loans');
};

/** Add `n` whole months to a YYYY-MM-DD date (UTC), keeping the day-of-month where valid. */
function addMonths(yyyyMmDd: string, n: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  const day = d.getUTCDate();
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));
  return base.toISOString().slice(0, 10);
}

// ─────────────────────────────── Service: lifecycle ───────────────────────────────

export type CreateLoanInput = {
  employmentId: string;
  loanType: LoanType;
  principal: number;
  interestRate: number;
  interestMethod: LoanInterestMethod;
  durationMonths: number;
  startDate: string;
  notes?: string | null;
};

/** Create a loan + materialize the full repayment schedule (all 'scheduled'). Admin-only. */
export async function createLoan(ctx: SessionContext, p: CreateLoanInput): Promise<{ id: string }> {
  assertAdmin(ctx);
  if (!(LOAN_TYPES as readonly string[]).includes(p.loanType)) throw new LoanError('Unknown loan type');
  if (!(LOAN_INTEREST_METHODS as readonly string[]).includes(p.interestMethod)) throw new LoanError('Unknown interest method');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startDate)) throw new LoanError('Start date must be YYYY-MM-DD');
  const comp = computeLoan({
    principal: p.principal,
    annualInterestPct: p.interestRate,
    durationMonths: p.durationMonths,
    method: p.interestMethod,
  });
  return withTenant(ctx, async (tx) => {
    const [loan] = await tx
      .insert(employeeLoan)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        loanType: p.loanType,
        principal: money(p.principal),
        interestRate: p.interestRate.toFixed(3),
        interestMethod: p.interestMethod,
        durationMonths: p.durationMonths,
        startDate: p.startDate,
        monthlyInstalment: money(fromCents(comp.monthlyInstalmentCents)),
        totalRepayable: money(fromCents(comp.totalRepayableCents)),
        outstandingBalance: money(fromCents(comp.totalRepayableCents)),
        instalmentsPaid: 0,
        status: 'active',
        notes: p.notes ?? null,
      })
      .returning({ id: employeeLoan.id });
    await tx.insert(loanRepayment).values(
      comp.schedule.map((dueCents, i) => ({
        tenantId: ctx.tenantId,
        loanId: loan.id,
        employmentId: p.employmentId,
        sequenceNo: i + 1,
        dueAmount: money(fromCents(dueCents)),
        status: 'scheduled',
      })),
    );
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-loan',
      aggregateId: loan.id,
      eventType: 'loan.created',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {}, // amounts live on the aggregate (ADR-0030)
    });
    return { id: loan.id };
  });
}

async function loadLoan(tx: Tx, loanId: string) {
  const [loan] = await tx.select().from(employeeLoan).where(eq(employeeLoan.id, loanId)).limit(1);
  return loan ?? null;
}

/**
 * Amend a loan's terms (admin-only; only while active/suspended). Recompute on the REMAINING tail using the
 * current outstanding_balance (NOT original principal) over (durationMonths − instalmentsPaid) remaining
 * months. Already-applied rows are immutable; only the 'scheduled' rows are rewritten so they sum to the
 * current outstanding_balance. totalRepayable stays the historical original-terms figure.
 */
export async function amendLoan(
  ctx: SessionContext,
  p: { loanId: string; durationMonths?: number; interestRate?: number; interestMethod?: LoanInterestMethod; notes?: string | null },
): Promise<void> {
  assertAdmin(ctx);
  await withTenant(ctx, async (tx) => {
    const loan = await loadLoan(tx, p.loanId);
    if (!loan) throw new LoanError('Loan not found');
    if (loan.status !== 'active' && loan.status !== 'suspended') {
      throw new LoanError('Only an active or suspended loan can be amended');
    }
    const newDuration = p.durationMonths ?? loan.durationMonths;
    if (!(newDuration >= 1) || !Number.isInteger(newDuration)) throw new LoanError('Duration (months) must be a whole number ≥ 1');
    const remainingMonths = newDuration - loan.instalmentsPaid;
    if (remainingMonths < 1) throw new LoanError('Remaining duration must leave at least one instalment');

    const outstandingCents = toCents(Number(loan.outstandingBalance));
    // Recompute the remaining tail from outstanding (NOT principal): equal instalments + last reconciles.
    const instalment = Math.round(outstandingCents / remainingMonths);
    const tail: number[] = [];
    for (let i = 0; i < remainingMonths - 1; i++) tail.push(instalment);
    tail.push(outstandingCents - instalment * (remainingMonths - 1));

    // Rewrite the 'scheduled' rows (lowest sequenceNo first) with the new due amounts. Already-applied rows
    // are immutable. Map the recomputed tail onto the scheduled rows by position; any SURPLUS scheduled rows
    // (when the new duration is shorter) are marked 'skipped' so the schedule sums to outstanding exactly.
    const scheduled = await tx
      .select({ id: loanRepayment.id })
      .from(loanRepayment)
      .where(and(eq(loanRepayment.loanId, loan.id), eq(loanRepayment.status, 'scheduled')))
      .orderBy(asc(loanRepayment.sequenceNo));
    for (let i = 0; i < scheduled.length; i++) {
      if (i < tail.length) {
        await tx.update(loanRepayment).set({ dueAmount: money(fromCents(tail[i])), status: 'scheduled' }).where(eq(loanRepayment.id, scheduled[i].id));
      } else {
        // Beyond the new remaining term — no longer needed.
        await tx.update(loanRepayment).set({ status: 'skipped' }).where(eq(loanRepayment.id, scheduled[i].id));
      }
    }

    await tx
      .update(employeeLoan)
      .set({
        durationMonths: newDuration,
        interestRate: p.interestRate != null ? p.interestRate.toFixed(3) : loan.interestRate,
        interestMethod: p.interestMethod ?? loan.interestMethod,
        monthlyInstalment: money(fromCents(instalment)),
        notes: p.notes !== undefined ? p.notes : loan.notes,
        updatedAt: sql`now()`,
      })
      .where(eq(employeeLoan.id, loan.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-loan',
      aggregateId: loan.id,
      eventType: 'loan.amended',
      actor: actorOf(ctx),
      subjectEmploymentId: loan.employmentId,
      payload: {},
    });
  });
}

/** Suspend an active loan (admin-only) — only pauses prefill eligibility; never rewinds the schedule. */
export async function suspendLoan(ctx: SessionContext, loanId: string): Promise<void> {
  assertAdmin(ctx);
  await withTenant(ctx, async (tx) => {
    const loan = await loadLoan(tx, loanId);
    if (!loan) throw new LoanError('Loan not found');
    if (loan.status !== 'active') throw new LoanError('Only an active loan can be suspended');
    await tx.update(employeeLoan).set({ status: 'suspended', updatedAt: sql`now()` }).where(eq(employeeLoan.id, loanId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-loan',
      aggregateId: loanId,
      eventType: 'loan.suspended',
      actor: actorOf(ctx),
      subjectEmploymentId: loan.employmentId,
    });
  });
}

/** Resume a suspended loan (admin-only). */
export async function resumeLoan(ctx: SessionContext, loanId: string): Promise<void> {
  assertAdmin(ctx);
  await withTenant(ctx, async (tx) => {
    const loan = await loadLoan(tx, loanId);
    if (!loan) throw new LoanError('Loan not found');
    if (loan.status !== 'suspended') throw new LoanError('Only a suspended loan can be resumed');
    await tx.update(employeeLoan).set({ status: 'active', updatedAt: sql`now()` }).where(eq(employeeLoan.id, loanId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-loan',
      aggregateId: loanId,
      eventType: 'loan.resumed',
      actor: actorOf(ctx),
      subjectEmploymentId: loan.employmentId,
    });
  });
}

/** Manual early payoff (admin-only): zero the balance, settle, skip remaining scheduled/reserved repayments. */
export async function settleLoan(ctx: SessionContext, loanId: string): Promise<void> {
  assertAdmin(ctx);
  await withTenant(ctx, async (tx) => {
    const loan = await loadLoan(tx, loanId);
    if (!loan) throw new LoanError('Loan not found');
    if (loan.status === 'settled' || loan.status === 'cancelled') throw new LoanError('Loan is already closed');
    await tx
      .update(loanRepayment)
      .set({ status: 'skipped' })
      .where(and(eq(loanRepayment.loanId, loanId), inArray(loanRepayment.status, ['scheduled', 'reserved'])));
    await tx
      .update(employeeLoan)
      .set({ status: 'settled', outstandingBalance: '0.00', updatedAt: sql`now()` })
      .where(eq(employeeLoan.id, loanId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-loan',
      aggregateId: loanId,
      eventType: 'loan.settled',
      actor: actorOf(ctx),
      subjectEmploymentId: loan.employmentId,
    });
  });
}

/** Cancel a loan (admin-only) — only if no instalment has ever been applied. Marks all repayments skipped. */
export async function cancelLoan(ctx: SessionContext, loanId: string): Promise<void> {
  assertAdmin(ctx);
  await withTenant(ctx, async (tx) => {
    const loan = await loadLoan(tx, loanId);
    if (!loan) throw new LoanError('Loan not found');
    if (loan.status === 'settled' || loan.status === 'cancelled') throw new LoanError('Loan is already closed');
    if (loan.instalmentsPaid > 0) throw new LoanError('A loan with applied instalments cannot be cancelled — settle it instead');
    const [appliedRow] = await tx
      .select({ id: loanRepayment.id })
      .from(loanRepayment)
      .where(and(eq(loanRepayment.loanId, loanId), eq(loanRepayment.status, 'applied')))
      .limit(1);
    if (appliedRow) throw new LoanError('A loan with applied instalments cannot be cancelled — settle it instead');
    await tx.update(loanRepayment).set({ status: 'skipped' }).where(eq(loanRepayment.loanId, loanId));
    await tx
      .update(employeeLoan)
      .set({ status: 'cancelled', updatedAt: sql`now()` })
      .where(eq(employeeLoan.id, loanId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-loan',
      aggregateId: loanId,
      eventType: 'loan.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: loan.employmentId,
    });
  });
}

// ─────────────────────────────── Prefill (RESERVE only) ───────────────────────────────

/**
 * Reserve the next instalment of every active loan of this batch's company's active-in-period employees onto
 * a REGULAR DRAFT batch, and (re)compute payroll_input.loan_deduction from the set of currently-reserved
 * repayments. NO ledger mutation. Idempotent: a re-run is a no-op for an already-reserved loan (the partial
 * unique index forbids a second 'reserved' row), and loan_deduction is SET (recomputed), not blind-added.
 */
export async function prefillLoansForBatch(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<{ loans: number; total: number }> {
  assertAdmin(ctx);
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        status: payrollBatch.status,
        runType: payrollBatch.runType,
        payPeriod: payrollBatch.payPeriod,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new LoanError('Payroll batch not found');
    if (batch.runType !== 'regular') throw new LoanError('Loan deductions can only be prefilled onto a regular run');
    if (batch.status !== 'draft') throw new LoanError('Loan deductions can only be prefilled onto a draft batch');

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(new Date(pYear, pMonth, 0).getDate()).padStart(2, '0')}`;

    // Active loans of active-in-period employees of this company. Same active-employee predicate as
    // generatePayslips, so we never reserve for an employee who will get no payslip.
    const activeLoans = await tx
      .select({
        loanId: employeeLoan.id,
        employmentId: employeeLoan.employmentId,
        outstanding: employeeLoan.outstandingBalance,
      })
      .from(employeeLoan)
      .innerJoin(employment, eq(employment.id, employeeLoan.employmentId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          eq(employeeLoan.status, 'active'),
          sql`${employment.hiredOn} <= ${periodEnd}`,
          sql`(${employment.terminatedOn} is null or ${employment.terminatedOn} >= ${periodStart})`,
        ),
      );

    // C1 fix: NO blind pre-clamp here. The authoritative net≥0 clamp lives in generatePayslips, where the
    // full statutory + CP38 + unpaid + manual-deduction picture is known. Prefill reserves the FULL scheduled
    // instalment, capped only at the loan's outstanding balance (a legitimate final-instalment cap).
    for (const loan of activeLoans) {
      // The single next scheduled repayment (lowest sequenceNo). If the loan already has a reserved row,
      // the partial-unique index makes a second reservation impossible — skip it (no-op convergence).
      const [reservedAlready] = await tx
        .select({ id: loanRepayment.id })
        .from(loanRepayment)
        .where(and(eq(loanRepayment.loanId, loan.loanId), eq(loanRepayment.status, 'reserved')))
        .limit(1);
      if (reservedAlready) continue;

      const [next] = await tx
        .select({ id: loanRepayment.id, dueAmount: loanRepayment.dueAmount })
        .from(loanRepayment)
        .where(and(eq(loanRepayment.loanId, loan.loanId), eq(loanRepayment.status, 'scheduled')))
        .orderBy(asc(loanRepayment.sequenceNo))
        .limit(1);
      if (!next) continue; // nothing left to reserve

      // Reserve the full scheduled instalment, capped only at the outstanding balance (final-instalment cap,
      // NOT a net-clamp). The net≥0 clamp is applied authoritatively in generatePayslips / applyLoansForBatch.
      const takeCents = Math.min(toCents(Number(next.dueAmount)), toCents(Number(loan.outstanding)));
      if (takeCents <= 0) continue; // nothing recoverable (outstanding already 0)

      await tx
        .update(loanRepayment)
        .set({ status: 'reserved', reservedBatchId: p.batchId, dueAmount: money(fromCents(takeCents)) })
        .where(eq(loanRepayment.id, next.id));

      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'loan-repayment',
        aggregateId: next.id,
        eventType: 'loan.instalment.reserved',
        actor: actorOf(ctx),
        subjectEmploymentId: loan.employmentId,
        payload: { batchId: p.batchId },
      });
    }

    // Recompute loan_deduction from ALL currently-reserved repayments for this batch (set, not blind-add) —
    // so a re-run CONVERGES rather than double-adds.
    const reserved = await tx
      .select({ employmentId: loanRepayment.employmentId, dueAmount: loanRepayment.dueAmount })
      .from(loanRepayment)
      .where(eq(loanRepayment.reservedBatchId, p.batchId));
    const sumByEmp = new Map<string, number>();
    for (const r of reserved) sumByEmp.set(r.employmentId, (sumByEmp.get(r.employmentId) ?? 0) + toCents(Number(r.dueAmount)));

    // Write loan_deduction for every active-in-period employee of this company (so a removed reservation
    // resets the column to 0, not stale). Upsert the payroll_input row.
    const empIds = [...new Set(activeLoans.map((l) => l.employmentId))];
    let totalCents = 0;
    for (const employmentId of empIds) {
      const cents = sumByEmp.get(employmentId) ?? 0;
      totalCents += cents;
      const [existing] = await tx
        .select({ id: payrollInput.id })
        .from(payrollInput)
        .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, employmentId)))
        .limit(1);
      if (existing) {
        await tx.update(payrollInput).set({ loanDeduction: money(fromCents(cents)), updatedAt: sql`now()` }).where(eq(payrollInput.id, existing.id));
      } else if (cents > 0) {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          loanDeduction: money(fromCents(cents)),
        });
      }
    }
    return { loans: sumByEmp.size, total: fromCents(totalCents) };
  });
}

// ─────────────────────────────── Apply (inside generatePayslips ONLY) ───────────────────────────────

/**
 * Advance the loan ledger for every repayment reserved to this batch — called ONLY from generatePayslips,
 * inside its transaction, after the payslip loop. Sets each repayment 'applied' with the ACTUAL applied
 * amount (the per-employee net≥0 clamp computed in generatePayslips, NOT the reserved due), decrements
 * outstanding by the actual, re-schedules any shortfall so the schedule still covers the residual, and
 * settles ONLY when the outstanding balance reaches zero. NO admin assert (the caller is the payroll kernel,
 * already admin-gated at createBatch/generatePayslips).
 *
 * `appliedLoanCentsByEmp` — per-employment ACTUAL loan cents recovered this cycle (Σ clamped slipLoan). The
 * reserved repayments of an employment are applied in order against this budget; the unfunded remainder of
 * any reservation re-schedules and the loan stays active (C2/H1/H3 fix — never a silent write-off).
 */
export async function applyLoansForBatch(
  tx: Tx,
  ctx: SessionContext,
  batchId: string,
  appliedLoanCentsByEmp: Map<string, number>,
): Promise<void> {
  const reserved = await tx
    .select()
    .from(loanRepayment)
    .where(and(eq(loanRepayment.reservedBatchId, batchId), eq(loanRepayment.status, 'reserved')));
  // A mutable per-employment running budget (copy of the actual-applied cents) consumed in reservation order.
  const remaining = new Map<string, number>(appliedLoanCentsByEmp);
  for (const rep of reserved) {
    const loan = await loadLoan(tx, rep.loanId);
    if (!loan) continue;
    const dueCents = toCents(Number(rep.dueAmount));
    const budget = remaining.get(rep.employmentId) ?? 0;
    const applyCents = Math.max(0, Math.min(dueCents, budget));
    remaining.set(rep.employmentId, budget - applyCents);

    // Mark the reservation applied with the ACTUAL recovered amount (not the reserved due).
    await tx
      .update(loanRepayment)
      .set({ status: 'applied', appliedBatchId: batchId, appliedAmount: money(fromCents(applyCents)), appliedAt: new Date() })
      .where(eq(loanRepayment.id, rep.id));

    // Re-schedule any shortfall so the schedule still covers the outstanding and is re-reservable next cycle.
    if (applyCents < dueCents) {
      const [{ maxSeq } = { maxSeq: loan.durationMonths }] = await tx
        .select({ maxSeq: sql<number>`coalesce(max(${loanRepayment.sequenceNo}), 0)` })
        .from(loanRepayment)
        .where(eq(loanRepayment.loanId, loan.id));
      await tx.insert(loanRepayment).values({
        tenantId: loan.tenantId,
        loanId: loan.id,
        employmentId: loan.employmentId,
        sequenceNo: Number(maxSeq) + 1,
        dueAmount: money(fromCents(dueCents - applyCents)),
        status: 'scheduled',
      });
    }

    const newOutstandingCents = Math.max(0, toCents(Number(loan.outstandingBalance)) - applyCents);
    const newInstalmentsPaid = loan.instalmentsPaid + (applyCents > 0 ? 1 : 0);
    // C2/H1 fix: settle ONLY when the real balance reaches zero — never on the instalment count alone.
    const fullyRepaid = newOutstandingCents <= 0;
    await tx
      .update(employeeLoan)
      .set({
        outstandingBalance: fullyRepaid ? '0.00' : money(fromCents(newOutstandingCents)),
        instalmentsPaid: newInstalmentsPaid,
        ...(fullyRepaid ? { status: 'settled' as const } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(employeeLoan.id, loan.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'loan-repayment',
      aggregateId: rep.id,
      eventType: 'loan.instalment.applied',
      actor: actorOf(ctx),
      subjectEmploymentId: loan.employmentId,
      payload: { batchId, appliedAmount: money(fromCents(applyCents)) },
    });
    if (fullyRepaid) {
      // Balance cleared — mark any leftover scheduled rows skipped (auto-stop) and emit settled.
      await tx
        .update(loanRepayment)
        .set({ status: 'skipped' })
        .where(and(eq(loanRepayment.loanId, loan.id), eq(loanRepayment.status, 'scheduled')));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employee-loan',
        aggregateId: loan.id,
        eventType: 'loan.settled',
        actor: actorOf(ctx),
        subjectEmploymentId: loan.employmentId,
      });
    }
  }
}

// ─────────────────────────────── Reads (ESS-safe, no writes) ───────────────────────────────

export type LoanRow = {
  id: string;
  employmentId: string;
  employeeName?: string;
  employeeCode?: string | null;
  loanType: string;
  principal: number;
  interestRate: number;
  interestMethod: string;
  durationMonths: number;
  startDate: string;
  monthlyInstalment: number;
  totalRepayable: number;
  outstandingBalance: number;
  instalmentsPaid: number;
  status: string;
  notes: string | null;
  createdAt: string;
};

export type RepaymentRow = {
  id: string;
  sequenceNo: number;
  dueAmount: number;
  appliedAmount: number;
  status: string;
  appliedAt: string | null;
};

const toLoanRow = (l: typeof employeeLoan.$inferSelect & { employeeName?: string; employeeCode?: string | null }): LoanRow => ({
  id: l.id,
  employmentId: l.employmentId,
  employeeName: l.employeeName,
  employeeCode: l.employeeCode,
  loanType: l.loanType,
  principal: Number(l.principal),
  interestRate: Number(l.interestRate),
  interestMethod: l.interestMethod,
  durationMonths: l.durationMonths,
  startDate: l.startDate,
  monthlyInstalment: Number(l.monthlyInstalment),
  totalRepayable: Number(l.totalRepayable),
  outstandingBalance: Number(l.outstandingBalance),
  instalmentsPaid: l.instalmentsPaid,
  status: l.status,
  notes: l.notes,
  createdAt: l.createdAt.toISOString(),
});

/** A single employment's loans (newest first) — "my loans" / per-employee. RLS scopes visibility. */
export async function listLoansForEmployment(ctx: SessionContext, employmentId: string): Promise<LoanRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(employeeLoan)
      .where(eq(employeeLoan.employmentId, employmentId))
      .orderBy(sql`${employeeLoan.createdAt} desc`);
    return rows.map((r) => toLoanRow(r));
  });
}

/** A loan + its full repayment schedule (RLS-scoped). null if not visible. */
export async function getLoanWithSchedule(
  ctx: SessionContext,
  loanId: string,
): Promise<{ loan: LoanRow; schedule: RepaymentRow[] } | null> {
  return withTenant(ctx, async (tx) => {
    const loan = await loadLoan(tx, loanId);
    if (!loan) return null;
    const reps = await tx
      .select()
      .from(loanRepayment)
      .where(eq(loanRepayment.loanId, loanId))
      .orderBy(asc(loanRepayment.sequenceNo));
    return {
      loan: toLoanRow(loan),
      schedule: reps.map((r) => ({
        id: r.id,
        sequenceNo: r.sequenceNo,
        dueAmount: Number(r.dueAmount),
        appliedAmount: Number(r.appliedAmount),
        status: r.status,
        appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
      })),
    };
  });
}

/** All loans for a company (admin list) with employee names. RLS scopes to the caller's visibility. */
export async function listActiveLoans(ctx: SessionContext, companyId: string): Promise<LoanRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ loan: employeeLoan, employeeName: person.fullName, employeeCode: employment.employeeCode })
      .from(employeeLoan)
      .innerJoin(employment, eq(employment.id, employeeLoan.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.companyId, companyId))
      .orderBy(sql`${employeeLoan.createdAt} desc`);
    return rows.map((r) => toLoanRow({ ...r.loan, employeeName: r.employeeName, employeeCode: r.employeeCode }));
  });
}

/** Summary of loan deductions reserved on a batch (count + total) — the payroll-UI line. */
export async function loanSummaryForBatch(ctx: SessionContext, batchId: string): Promise<{ loans: number; total: number }> {
  return withTenant(ctx, async (tx) => {
    const reserved = await tx
      .select({ loanId: loanRepayment.loanId, dueAmount: loanRepayment.dueAmount })
      .from(loanRepayment)
      .where(and(eq(loanRepayment.reservedBatchId, batchId), eq(loanRepayment.status, 'reserved')));
    const total = reserved.reduce((s, r) => s + toCents(Number(r.dueAmount)), 0);
    return { loans: new Set(reserved.map((r) => r.loanId)).size, total: fromCents(total) };
  });
}

export { addMonths };
