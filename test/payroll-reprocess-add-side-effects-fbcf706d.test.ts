/**
 * fbcf706d — ADDING SOMEONE TO A PROCESSED RUN: the side effects, and the money they protect.
 *
 * The compute half is pinned by payroll-reprocess-add-fbcf706d.test.ts: the selective path already
 * writes a correct payslip for an employment that has no payslip on the run. What it did NOT do is any
 * of the things a FIRST processing does, because the whole subset branch was written for corrections to
 * people already paid, where every ledger had already moved. For an ADDITION that assumption is exactly
 * inverted, and every consequence of it is a real number going wrong:
 *
 *   • the run's headcount stayed at its pre-addition figure for ever (one writer, the full generation);
 *   • a loan instalment came off the pay and never off the loan balance;
 *   • a claim the payslip had just paid stayed payable, so the next run would pay it again;
 *   • on a run set up for a chosen list of people, the addition computed NOTHING AT ALL — the scope
 *     filter and the subset filter were AND-ed, so the person was silently absent from their own add;
 *   • the audit said "reprocess" and rendered a rise from 0.00, which is not what happened.
 *
 * WHAT IS ASSERTED HERE IS THE ENGINE, NOT THE SCREEN. Every fixture below reaches its starting state
 * through the product's own services wherever one exists (prefill, scope narrow, generate); the two
 * places where no service can produce the state — a claim HELD on a processed run for someone with no
 * payslip on it — are written directly and said so at the point of writing.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createClaimType, decideClaim, prefillClaimsForBatch, submitClaim } from '../core/claims';
import { createLoan, prefillLoansForBatch } from '../core/loans';
import {
  createBatch,
  generatePayslips,
  listPayslipLessEligible,
  reprocessSelectedEmployees,
  updateBatchScope,
} from '../core/payroll';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const recent = (daysBack = 5): string =>
  new Date(new Date(`${todayInKualaLumpur()}T00:00:00Z`).getTime() - daysBack * 86400000).toISOString().slice(0, 10);

describe('fbcf706d — the side effects of adding an employee to a processed payroll run', () => {
  let base: Base;
  let a: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    a = await entitledCtx(base);
  });
  afterAll(async () => {
    await closeAll();
  });

  let icSeq = 0;
  async function hire(name: string, hiredOn = '2026-01-01') {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\W/g, '')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    icSeq += 1;
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `90010101${String(1000 + icSeq)}` });
    return e;
  }

  async function paid(name: string, salary: number, hiredOn = '2026-01-01') {
    const e = await hire(name, hiredOn);
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: salary, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    return e;
  }

  const batchRow = async (batchId: string) => {
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    return row;
  };
  const slipOf = async (batchId: string, employmentId: string) => {
    const [row] = await owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    return row ?? null;
  };
  const eventsOfType = async (eventType: string) =>
    owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, eventType));
  const historyOf = async (batchId: string) =>
    owner.db
      .select()
      .from(schema.payrollEmployeeResultHistory)
      .where(eq(schema.payrollEmployeeResultHistory.batchId, batchId));

  // ────────────────────────────────────────────────────────────────────────────────────────────────

  it('recounts the run headcount, records the add as an ADD, and reports added vs recalculated', async () => {
    const onRun = await paid('OnRun', 3000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    expect((await batchRow(batchId)).employeeCount).toBe(1);

    const late = await paid('LateRecord', 4000, '2026-02-01');

    const r = (await reprocessSelectedEmployees(a, {
      batchId,
      employmentIds: [onRun.employmentId, late.employmentId],
      reason: 'added after processing',
    })) as { status: string; reprocessed?: number; added?: number; recalculated?: number; headcount?: number };
    expect(r.status).toBe('completed');

    // The headcount is RECOUNTED off the payslips, not left at the pre-addition figure and not
    // incremented by a running total.
    expect((await batchRow(batchId)).employeeCount).toBe(2);
    expect(r.headcount).toBe(2);
    expect(r.reprocessed).toBe(2);
    expect(r.added).toBe(1);
    expect(r.recalculated).toBe(1);

    // The event the Payroll Process list and the result panel read carries the same split.
    const events = await eventsOfType('payroll-batch.selective-reprocessed');
    expect(events).toHaveLength(2);
    const payloads = events.map(e=>e.payload as {headcount:number;addedCount:number;recalculatedCount:number;addedEmploymentIds:string[]});
    expect(Math.max(...payloads.map(p=>p.headcount))).toBe(2);
    expect(payloads.reduce((n,p)=>n+p.addedCount,0)).toBe(1);
    expect(payloads.reduce((n,p)=>n+p.recalculatedCount,0)).toBe(1);
    expect(payloads.flatMap(p=>p.addedEmploymentIds)).toEqual([late.employmentId]);

    // The audit distinguishes the two. An add has no version and no figures BEFORE it, which is what
    // stops the disclosure rendering a rise from 0.00 as if the person's pay had gone up.
    const rows = await historyOf(batchId);
    const addRow = rows.find((h) => h.employmentId === late.employmentId)!;
    const recalcRow = rows.find((h) => h.employmentId === onRun.employmentId)!;
    expect(addRow.action).toBe('add');
    expect(addRow.versionBefore).toBeNull();
    expect(addRow.before).toBeNull();
    expect(addRow.versionAfter).toBe(1);
    expect(recalcRow.action).toBe('reprocess');
    expect(recalcRow.versionBefore).toBe(1);
    expect(recalcRow.versionAfter).toBe(2);
  });

  it('refuses a posted employment that is neither on the run nor eligible for the period, by name', async () => {
    const onRun = await paid('OnRunTwo', 3000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    // Hired AFTER the period ended: a company-mate, but nothing to do with this run. Before fbcf706d the
    // only membership test was "belongs to this company", so this id was accepted, silently removed by
    // the period filter, and reported back as reprocessed.
    const future = await paid('FutureHire', 5000, '2026-09-01');

    await expect(
      reprocessSelectedEmployees(a, { batchId, employmentIds: [onRun.employmentId, future.employmentId] }),
    ).rejects.toMatchObject({name:'PayrollReprocessStoppedError',cause:expect.objectContaining({message:expect.stringMatching(/FutureHire[^]*not on this payroll run/)})});

    // Fails closed: the whole job is refused, so the person who WAS on the run is not half-processed.
    expect(await slipOf(batchId, future.employmentId)).toBeNull();
    // A global error stops the job; earlier employee transactions may already be committed.
    const [stoppedJob] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.batchId,batchId));
    const priorOutcomes = (stoppedJob.result as {outcomes?:{employmentId:string}[]} | null)?.outcomes ?? [];
    expect(stoppedJob.status).toBe('failed');
    expect((await slipOf(batchId, onRun.employmentId))!.version).toBe(priorOutcomes.some(r=>r.employmentId===onRun.employmentId) ? 2 : 1);
    expect((await batchRow(batchId)).employeeCount).toBe(1);
  });

  it('widens a chosen-list run when someone is added to it, and records the widening', async () => {
    const chosen = await paid('Chosen', 3000);
    const notChosen = await paid('NotChosen', 4000);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [chosen.employmentId] },
    });
    await generatePayslips(a, { batchId });
    expect(await slipOf(batchId, notChosen.employmentId)).toBeNull();

    // BEFORE fbcf706d this computed nothing at all: the scope filter and the subset filter were AND-ed,
    // so the intersection was empty and the run refused with "None of the selected employees are active
    // in this period." — about somebody who is unambiguously active in it.
    const r = (await reprocessSelectedEmployees(a, {
      batchId,
      employmentIds: [notChosen.employmentId],
      reason: 'add to the chosen list',
    })) as { status: string; added?: number };
    expect(r.status).toBe('completed');
    expect(r.added).toBe(1);

    const slip = await slipOf(batchId, notChosen.employmentId);
    expect(slip, 'the addition computed nothing on a scoped run').not.toBeNull();
    expect(Number(slip!.grossPay)).toBeCloseTo(4000, 2);

    // The run's chosen list now contains them — otherwise the next prefill or regeneration would drop
    // the person straight back out of the run that has just paid them.
    const scope = (await batchRow(batchId)).scope as { employmentIds?: string[] };
    expect(scope.employmentIds).toContain(chosen.employmentId);
    expect(scope.employmentIds).toContain(notChosen.employmentId);

    const widened = await eventsOfType('payroll-batch.scope-widened');
    expect(widened).toHaveLength(1);
    expect((widened[0].payload as { addedEmploymentIds: string[] }).addedEmploymentIds).toEqual([
      notChosen.employmentId,
    ]);
  });

  it('leaves a whole-company run unscoped — there is no chosen list to widen', async () => {
    await paid('Whole', 3000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const late = await paid('WholeLate', 4000, '2026-02-01');

    await reprocessSelectedEmployees(a, { batchId, employmentIds: [late.employmentId] });

    expect((await batchRow(batchId)).scope).toBeNull();
    expect(await eventsOfType('payroll-batch.scope-widened')).toHaveLength(0);
  });

  // ─────────────────────────── the money: claims ───────────────────────────

  it('marks an added employee’s held claim paid exactly once, and never requeues anybody else’s', async () => {
    const onRun = await paid('ClaimOnRun', 3000);
    const late = await paid('ClaimLate', 4000);

    const { id: typeId } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: true, requiresReceipt: false });
    const { id: onRunClaim } = await submitClaim(a, { employmentId: onRun.employmentId, claimTypeId: typeId, amount: 150, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: onRunClaim, decision: 'approve' });
    const { id: lateClaim } = await submitClaim(a, { employmentId: late.employmentId, claimTypeId: typeId, amount: 250, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: lateClaim, decision: 'approve' });

    // Whole-company draft: both claims are reserved and both employees get a prefilled claim allowance.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillClaimsForBatch(a, { batchId });
    // Then the run is narrowed to one person. Narrowing FROM whole-company enumerates no removed set, so
    // the prefilled input rows stay exactly where they are — this is the product's own behaviour, not a
    // contrivance, and it is what leaves the second employee with a claim allowance and no payslip.
    await updateBatchScope(a, { batchId, scope: { employmentIds: [onRun.employmentId] } });
    await generatePayslips(a, { batchId });

    // The full generation requeued the unpaid claim, exactly as it should. To exercise the ADD path we
    // put it back on hold against this run — the one state no service can produce, because prefill is
    // draft-only. Everything after this line is the engine's own behaviour.
    await owner.db
      .update(schema.claimRequest)
      .set({ payrollBatchId: batchId })
      .where(eq(schema.claimRequest.id, lateClaim));

    await reprocessSelectedEmployees(a, { batchId, employmentIds: [late.employmentId], reason: 'add' });

    // The added employee's payslip disbursed the claim allowance, and the claim is now settled — once.
    const slip = await slipOf(batchId, late.employmentId);
    expect(Number(slip!.grossPay)).toBeCloseTo(4250, 2);
    const [after] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, lateClaim));
    expect(after.status).toBe('paid');
    expect(after.payrollBatchId).toBe(batchId);
    const paidEvents = await eventsOfType('claim-request.paid');
    expect(paidEvents.filter((e) => e.aggregateId === lateClaim)).toHaveLength(1);

    // …and the person already on the run kept the settlement they already had. Nothing was unlinked:
    // the requeue arm is the one that could strip a claim off somebody outside the subset, and it does
    // not run here at all.
    const [other] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, onRunClaim));
    expect(other.status).toBe('paid');
    expect(other.payrollBatchId).toBe(batchId);

    // Reprocessing the same person again cannot settle it a second time.
    await reprocessSelectedEmployees(a, { batchId, employmentIds: [late.employmentId], reason: 'again' });
    const [twice] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, lateClaim));
    expect(twice.status).toBe('paid');
    expect((await eventsOfType('claim-request.paid')).filter((e) => e.aggregateId === lateClaim)).toHaveLength(1);
  });

  it('refuses an add whose payslip would pay a claim allowance no held claim accounts for', async () => {
    const onRun = await paid('UnrecOnRun', 3000);
    const late = await paid('UnrecLate', 4000);

    const { id: typeId } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: true, requiresReceipt: false });
    const { id: lateClaim } = await submitClaim(a, { employmentId: late.employmentId, claimTypeId: typeId, amount: 250, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: lateClaim, decision: 'approve' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillClaimsForBatch(a, { batchId });
    await updateBatchScope(a, { batchId, scope: { employmentIds: [onRun.employmentId] } });
    await generatePayslips(a, { batchId });

    // The claim is back in the queue for a later run, and the prefilled allowance is still sitting on
    // THIS run. Adding the employee now would pay the 250 out of this payslip AND leave the claim
    // payable on the next one — the same money twice. It is refused instead.
    const [requeued] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, lateClaim));
    expect(requeued.payrollBatchId).toBeNull();
    expect(requeued.status).toBe('approved');

    await expect(
      reprocessSelectedEmployees(a, { batchId, employmentIds: [late.employmentId] }),
    ).rejects.toMatchObject({name:'PayrollReprocessStoppedError',cause:expect.objectContaining({message:expect.stringMatching(/claim allowance of 250\.00 against 0\.00/)})});

    // Fails closed, in one transaction: no payslip, no headcount move, claim untouched.
    expect(await slipOf(batchId, late.employmentId)).toBeNull();
    expect((await batchRow(batchId)).employeeCount).toBe(1);
    const [stillQueued] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, lateClaim));
    expect(stillQueued.status).toBe('approved');
    expect(stillQueued.payrollBatchId).toBeNull();
  });

  // ─────────────────────────── the money: loans ───────────────────────────

  it('advances an added employee’s loan ledger exactly once, and never touches anybody else’s', async () => {
    const onRun = await paid('LoanOnRun', 3000);
    const late = await paid('LoanLate', 4000);
    await createLoan(a, {
      employmentId: onRun.employmentId,
      loanType: 'personal',
      principal: 1200,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: '2026-01-01',
    });
    const { id: lateLoanId } = await createLoan(a, {
      employmentId: late.employmentId,
      loanType: 'personal',
      principal: 2400,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: '2026-01-01',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    // Narrow to one person AFTER the reservations exist. Narrowing from whole-company releases nothing,
    // so the second employee keeps both the reservation and the prefilled deduction.
    await updateBatchScope(a, { batchId, scope: { employmentIds: [onRun.employmentId] } });

    // Re-reserve the instalment the full generation is about to spend on nobody. `applyLoansForBatch`
    // consumes every reservation on the batch regardless of who got a payslip, so without this the ADD
    // path would have nothing to settle — which is a defect in its own right and is pinned by the test
    // below. Here we are pinning the settled case.
    await generatePayslips(a, { batchId });
    await owner.db
      .update(schema.loanRepayment)
      .set({ status: 'reserved', reservedBatchId: batchId })
      .where(and(eq(schema.loanRepayment.loanId, lateLoanId), eq(schema.loanRepayment.sequenceNo, 1)));

    const [before] = await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, lateLoanId));
    expect(before.instalmentsPaid).toBe(0);

    await reprocessSelectedEmployees(a, { batchId, employmentIds: [late.employmentId], reason: 'add' });

    const [afterOnce] = await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, lateLoanId));
    expect(afterOnce.instalmentsPaid).toBe(1);
    expect(Number(afterOnce.outstandingBalance)).toBeCloseTo(2400 - 200, 2);
    const [rep] = await owner.db
      .select()
      .from(schema.loanRepayment)
      .where(and(eq(schema.loanRepayment.loanId, lateLoanId), eq(schema.loanRepayment.sequenceNo, 1)));
    expect(rep.status).toBe('applied');
    expect(rep.appliedBatchId).toBe(batchId);

    // Reprocess the SAME person again: their instalment must not advance a second time.
    await reprocessSelectedEmployees(a, { batchId, employmentIds: [late.employmentId], reason: 'again' });
    const [afterTwice] = await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, lateLoanId));
    expect(afterTwice.instalmentsPaid).toBe(1);
    expect(Number(afterTwice.outstandingBalance)).toBeCloseTo(2200, 2);
    // Exactly ONE application actually moved money for this instalment. (The full generation above also
    // "applied" it, for 0.00, against a person who had no payslip — that is the very hole this fixture
    // reconstructs, so the events are filtered to the ones that recovered anything.)
    expect(
      (await eventsOfType('loan.instalment.applied')).filter(
        (e) =>
          (e.payload as { batchId?: string; appliedAmount?: string }).batchId === batchId &&
          e.aggregateId === rep.id &&
          Number((e.payload as { appliedAmount?: string }).appliedAmount ?? 0) > 0,
      ),
    ).toHaveLength(1);
  });

  it('refuses an add whose payslip would deduct a loan instalment with nothing left to settle it', async () => {
    const onRun = await paid('StaleOnRun', 3000);
    const late = await paid('StaleLate', 4000);
    await createLoan(a, {
      employmentId: late.employmentId,
      loanType: 'personal',
      principal: 2400,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: '2026-01-01',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    await updateBatchScope(a, { batchId, scope: { employmentIds: [onRun.employmentId] } });
    // The full generation spends the reservation on a person who got no payslip (nothing recovered, the
    // shortfall reschedules) but leaves the prefilled deduction on the run. Adding the employee now would
    // take 200 off their pay with no reservation left to take it off the loan balance.
    await generatePayslips(a, { batchId });

    await expect(
      reprocessSelectedEmployees(a, { batchId, employmentIds: [late.employmentId] }),
    ).rejects.toMatchObject({name:'PayrollReprocessStoppedError',cause:expect.objectContaining({message:expect.stringMatching(/loan instalment of 200\.00 with no instalment held on this run/)})});

    expect(await slipOf(batchId, late.employmentId)).toBeNull();
    expect((await batchRow(batchId)).employeeCount).toBe(1);
  });

  // ─────────────────────────── the read the screen is built on ───────────────────────────

  it('lists exactly the people eligible for the month with no payslip on the run', async () => {
    const onRun = await paid('ReadOnRun', 3000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    // Three shapes that must be told apart: eligible and waiting, eligible but not payable yet, and
    // not part of this month at all.
    const waiting = await paid('ReadWaiting', 4000, '2026-02-01');
    const notReady = await hire('ReadNotReady', '2026-02-01'); // hired, but no salary on record
    await paid('ReadFuture', 5000, '2026-09-01'); // hired after the period ended

    const rows = await listPayslipLessEligible(a, { batchId });
    const ids = rows.map((r) => r.employmentId);
    expect(ids).toContain(waiting.employmentId);
    expect(ids).toContain(notReady.employmentId);
    expect(ids, 'somebody already paid is not "missing" from the run').not.toContain(onRun.employmentId);
    expect(rows).toHaveLength(2);

    const waitingRow = rows.find((r) => r.employmentId === waiting.employmentId)!;
    expect(waitingRow.blockers).toEqual([]);
    expect(waitingRow.outsideScope).toBe(false);
    expect(waitingRow.hiredOn).toBe('2026-02-01');

    // The readiness columns are preProcessChecksTx's own verdict, scoped to these people — so what the
    // screen says will happen is what the engine will actually do.
    const notReadyRow = rows.find((r) => r.employmentId === notReady.employmentId)!;
    expect(notReadyRow.blockers).toContain('missingCompensation');
    expect(await reprocessSelectedEmployees(a, {batchId,employmentIds:[notReady.employmentId]})).toMatchObject({
      status:'completed',validationFailed:1,outcomes:[{employmentId:notReady.employmentId,status:'validation_failed',
        validationDetails:[{gap:'no current salary record'}]}],
    });
  });

  it('reports the run’s chosen list rather than filtering by it', async () => {
    const chosen = await paid('ReadChosen', 3000);
    const outside = await paid('ReadOutside', 4000);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [chosen.employmentId] },
    });
    await generatePayslips(a, { batchId });

    // Filtering them out would hide the person the operator came looking for; including them silently
    // would widen a deliberately narrow run by accident. So they are listed, and flagged.
    const rows = await listPayslipLessEligible(a, { batchId });
    expect(rows.map((r) => r.employmentId)).toEqual([outside.employmentId]);
    expect(rows[0]!.outsideScope).toBe(true);
  });

  it('says nothing about a draft run — a run with no payslips is not a run missing anybody', async () => {
    await paid('ReadDraft', 3000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    expect(await listPayslipLessEligible(a, { batchId })).toEqual([]);
  });

  // ─────────────────────────── one-off transactions ───────────────────────────

  it('collects an added employee’s waiting one-off transaction, and only theirs', async () => {
    const onRun = await paid('TxnOnRun', 3000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const late = await paid('TxnLate', 4000, '2026-02-01');

    // Two one-off rows keyed against the pay month and attached to no run: one for the person being
    // added, one for the person already paid. Written directly because the Individual Transactions
    // screen is not what this test is about.
    const mk = async (employmentId: string) => {
      const [row] = await owner.db
        .insert(schema.payrollIndividualTxn)
        .values({
          tenantId: base.tenantId,
          companyId: base.companyId,
          employmentId,
          payPeriod: '2026-05',
          txnDate: '2026-05-15',
          kind: 'earning',
          amount: '100.00',
        })
        .returning({ id: schema.payrollIndividualTxn.id });
      return row.id;
    };
    const lateTxn = await mk(late.employmentId);
    const onRunTxn = await mk(onRun.employmentId);

    await reprocessSelectedEmployees(a, { batchId, employmentIds: [late.employmentId, onRun.employmentId] });

    const [lateRow] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, lateTxn));
    expect(lateRow.batchId, 'the added employee’s waiting one-off was not collected').toBe(batchId);

    // The person already on the run collects nothing: their ledger was attached when they were first
    // paid, and re-attaching here would drag a later keying into a run that has already paid them.
    const [onRunRow] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, onRunTxn));
    expect(onRunRow.batchId).toBeNull();
  });
});
