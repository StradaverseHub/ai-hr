/**
 * Payroll Process listing — DRAFT delete + resume-on-Step-1 (feedback 4f00d8f0).
 *
 * The feature: a Draft payroll process can be permanently deleted from the listing (confirmation-gated in
 * the UI, draft-only in the service), and resuming a draft re-enters the wizard on Step 1 (Payroll Period &
 * Company Selection, shown read-only for review) instead of jumping to Employee Selection.
 *
 * Tests (harness conventions of test/payroll-draft-resume.test.ts):
 *   a. (pure) wizardInitialStep — BOTH fresh and resume flows open on Step 1 (index 0); pins the
 *      resume-lands-on-Step-1 rule against a regression back to `isResume ? 1 : 0`.
 *   b. Happy-path cascade — deleteDraftBatch removes the batch + its payroll_input /
 *      payroll_individual_txn rows, RELEASES the reserved loan instalment back to 'scheduled'
 *      (reservedBatchId cleared), DETACHES the queued claim (payroll_batch_id → null, claim survives),
 *      deletes the now-orphaned OPEN pay_period, and appends the full event trail
 *      (payroll-batch.deleted with teardown payload, pay-period.deleted,
 *      loan.instalment.reservation-released, claim-request.unqueued-from-payroll). The same
 *      (company, period) can then be re-created — the reporter's delete-and-recreate objective.
 *   c. Draft-only guard — a processed and a closed batch both throw BatchNotDraftError and mutate
 *      nothing (batch + payslips intact). Unwinding a processed run is the sibling Reset feature
 *      (a03b2d9b), never delete.
 *   d. Orphan-period guard — deleting one of two sibling runs leaves the shared pay_period (and the
 *      other run) intact.
 *   e. RLS/company scope — an admin granted only company A cannot delete company B's draft (resolves to
 *      "batch not found"; row untouched).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { randomUUID } from 'node:crypto';
import {
  BatchNotDraftError,
  closeBatch,
  createAdditionalRun,
  createBatch,
  deleteDraftBatch,
  generatePayslips,
  resetProcessedBatch,
  setPayrollInput,
} from '../core/payroll';
import { createLoan, prefillLoansForBatch } from '../core/loans';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import { wizardInitialStep } from '../app/payroll/process/selection-logic';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let icSeq = 0;
const nextIc = () => `9003030${String(10000 + icSeq++).slice(-5)}`;

let base: Base;

async function hire(name: string, basic = 4000) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

const batchRows = (batchId: string) =>
  owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));

const periodRows = (companyId: string, period: string) =>
  owner.db
    .select()
    .from(schema.payPeriod)
    .where(and(eq(schema.payPeriod.companyId, companyId), eq(schema.payPeriod.period, period)));

describe('Payroll draft delete — pure wizard-entry rule', () => {
  it('a. wizardInitialStep: fresh AND resume flows both open on Step 1 (index 0)', () => {
    expect(wizardInitialStep(false)).toBe(0);
    // The reporter-expected behaviour: resuming a draft returns the user to Step 1 for review, NOT
    // straight to Employee Selection (the pre-feature `isResume ? 1 : 0`).
    expect(wizardInitialStep(true)).toBe(0);
  });
});

describe('Payroll draft delete — deleteDraftBatch (DB)', () => {
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

  it('b. cascades draft child data, releases the loan reservation, detaches the claim, removes the orphan period, and appends the event trail', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Delete One', 5000);

    // A loan whose next instalment will be RESERVED onto the draft.
    await createLoan(a, {
      employmentId: e1.employmentId,
      loanType: 'personal',
      principal: 2400,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: '2026-01-01',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });
    await setPayrollInput(a, { batchId, employmentId: e1.employmentId, overtimeAmount: 123 });

    // A dated individual transaction on the draft — since f1564110 Phase 2 it must SURVIVE the delete
    // DETACHED (batch_id → null, keeping its (company, pay month) home), not be deleted with the batch.
    const [indivTxn] = await owner.db
      .insert(schema.payrollIndividualTxn)
      .values({
        tenantId: base.tenantId,
        batchId,
        employmentId: e1.employmentId,
        kind: 'earning',
        txnDate: '2026-05-10',
        amount: '150.00',
      })
      .returning({ id: schema.payrollIndividualTxn.id });

    // An approved taxable claim STAMPED onto the draft (as prefillClaimsForBatch does) — must survive
    // the delete DETACHED, not be deleted with the batch.
    const [ct] = await owner.db
      .insert(schema.claimType)
      .values({ tenantId: base.tenantId, code: `MEDICAL_${randomUUID().slice(0, 8)}`, name: 'Medical' })
      .returning({ id: schema.claimType.id });
    const [claim] = await owner.db
      .insert(schema.claimRequest)
      .values({
        tenantId: base.tenantId,
        employmentId: e1.employmentId,
        claimTypeId: ct.id,
        amount: '80.00',
        incurredOn: '2026-05-03',
        taxable: true,
        status: 'approved',
        payrollBatchId: batchId,
      })
      .returning({ id: schema.claimRequest.id });

    // Sanity: the reservation exists before the delete.
    const [reservedBefore] = await owner.db
      .select()
      .from(schema.loanRepayment)
      .where(eq(schema.loanRepayment.reservedBatchId, batchId));
    expect(reservedBefore.status).toBe('reserved');

    const res = await deleteDraftBatch(a, { batchId });
    expect(res.id).toBe(batchId);

    // Batch + draft child rows are gone.
    expect(await batchRows(batchId)).toHaveLength(0);
    expect(
      await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batchId)),
    ).toHaveLength(0);
    // The individual transaction SURVIVES the delete, detached back to its (company, pay month) home
    // (f1564110 Phase 2 — draft teardown detaches instead of deleting; ADR-0056 amendment).
    const [indivAfter] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, indivTxn.id));
    expect(indivAfter).toBeTruthy();
    expect(indivAfter.batchId).toBeNull();
    expect(indivAfter.companyId).toBe(base.companyId);
    expect(indivAfter.payPeriod).toBe('2026-05');

    // The loan reservation is RELEASED, not stranded: back to 'scheduled', reservedBatchId cleared.
    const [repaymentAfter] = await owner.db
      .select()
      .from(schema.loanRepayment)
      .where(eq(schema.loanRepayment.id, reservedBefore.id));
    expect(repaymentAfter.status).toBe('scheduled');
    expect(repaymentAfter.reservedBatchId).toBeNull();

    // The claim SURVIVES, detached and re-queueable (still approved, no batch link).
    const [claimAfter] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
    expect(claimAfter.status).toBe('approved');
    expect(claimAfter.payrollBatchId).toBeNull();

    // The sole-run OPEN pay_period is tidied away.
    expect(await periodRows(base.companyId, '2026-05')).toHaveLength(0);

    // Event trail: the batch-level delete event carries the teardown audit payload…
    const batchEvents = await eventTypesFor(base.tenantId, batchId);
    expect(batchEvents).toContain('payroll-batch.deleted');
    const payload = (await latestEventPayload(base.tenantId, batchId, 'payroll-batch.deleted')) as {
      payPeriodId: string;
      payPeriodDeleted: boolean;
      deletedChildCounts: { inputs: number; components: number; payslips: number };
      releasedLoanRepaymentIds: string[];
      detachedClaimIds: string[];
      detachedIndividualTxnIds: string[];
    };
    expect(payload.payPeriodDeleted).toBe(true);
    expect(payload.deletedChildCounts.inputs).toBeGreaterThanOrEqual(1);
    expect(payload.deletedChildCounts.payslips).toBe(0); // a draft has no payslips — defensive delete found none
    expect(payload.releasedLoanRepaymentIds).toEqual([reservedBefore.id]);
    expect(payload.detachedClaimIds).toEqual([claim.id]);
    expect(payload.detachedIndividualTxnIds).toEqual([indivTxn.id]); // detached, not deleted (f1564110 Phase 2)
    // …and the per-row cross-aggregate events landed on their own aggregates.
    expect(await eventTypesFor(base.tenantId, reservedBefore.id)).toContain('loan.instalment.reservation-released');
    expect(await eventTypesFor(base.tenantId, claim.id)).toContain('claim-request.unqueued-from-payroll');
    expect(await eventTypesFor(base.tenantId, indivTxn.id)).toContain('payroll.individual-txn.detached');
    expect(await eventTypesFor(base.tenantId, payload.payPeriodId)).toContain('pay-period.deleted');

    // Reporter's objective: the mistaken draft can be re-created cleanly for the SAME company+period.
    const recreated = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    expect(recreated.batchId).toBeTruthy();
  });

  it('f. a batch reverted Processed→Draft (with rollback status-history + unlock/reprocess children) still deletes cleanly (feedback ec3873a6)', async () => {
    // The reported bug: a draft created by reverting a PROCESSED run carries payroll_status_history
    // ('rollback') rows that FK-reference the batch with NO onDelete cascade, so the final
    // tx.delete(payroll_batch) threw a foreign-key violation and leaked the raw SQL. teardownDraftChildren
    // must now clear EVERY batch-keyed audit/control child so the hard delete completes.
    process.env.PAYROLL_RESET_ENABLED = 'true';
    try {
      const a = adminCtx(base);
      const e1 = await hire('Revert Delete', 4200);
      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
      await generatePayslips(a, { batchId }); // → 'processed'

      // Revert to draft — this writes the 'rollback' payroll_status_history row that caused the FK leak.
      await resetProcessedBatch(a, { batchId, reason: 'correcting a keyed figure' });
      expect((await batchRows(batchId))[0].status).toBe('draft');

      const statusHistBefore = await owner.db
        .select()
        .from(schema.payrollStatusHistory)
        .where(eq(schema.payrollStatusHistory.batchId, batchId));
      expect(statusHistBefore.length).toBeGreaterThanOrEqual(1); // the rollback snapshot — reproduces the bug

      // Also plant the OTHER batch-keyed children an unlock-then-reprocess path can leave, so the teardown
      // is proven to clear all four FK tables (result-history, reprocess-job, step-up challenge), not just
      // status-history. Owner client bypasses RLS for the fixture insert.
      await owner.db.insert(schema.payrollEmployeeResultHistory).values({
        tenantId: base.tenantId,
        batchId,
        employmentId: e1.employmentId,
        action: 'reprocess',
        actorType: 'user',
        actorId: null,
      });
      await owner.db.insert(schema.payrollReprocessJob).values({
        tenantId: base.tenantId,
        batchId,
        idempotencyKey: `idem_${randomUUID()}`,
        status: 'completed',
        employmentIds: [e1.employmentId],
      });
      await owner.db.insert(schema.payrollStepUpChallenge).values({
        tenantId: base.tenantId,
        userId: randomUUID(),
        batchId,
        purpose: 'unlock',
        codeHash: 'x'.repeat(16),
        expiresAt: new Date(Date.now() + 60_000),
      });

      // The delete now succeeds where it previously threw the FK "Failed query" error.
      const res = await deleteDraftBatch(a, { batchId });
      expect(res.id).toBe(batchId);

      // Batch gone, and EVERY batch-keyed child cleared (no orphan pointing at the deleted batch).
      expect(await batchRows(batchId)).toHaveLength(0);
      expect(
        await owner.db.select().from(schema.payrollStatusHistory).where(eq(schema.payrollStatusHistory.batchId, batchId)),
      ).toHaveLength(0);
      expect(
        await owner.db
          .select()
          .from(schema.payrollEmployeeResultHistory)
          .where(eq(schema.payrollEmployeeResultHistory.batchId, batchId)),
      ).toHaveLength(0);
      expect(
        await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.batchId, batchId)),
      ).toHaveLength(0);
      expect(
        await owner.db.select().from(schema.payrollStepUpChallenge).where(eq(schema.payrollStepUpChallenge.batchId, batchId)),
      ).toHaveLength(0);

      // The deletion is audited (durable trail survives the hard delete) with the child counts.
      const payload = (await latestEventPayload(base.tenantId, batchId, 'payroll-batch.deleted')) as {
        deletedChildCounts: {
          statusHistory: number;
          resultHistory: number;
          reprocessJobs: number;
          stepUpChallenges: number;
        };
      };
      expect(payload.deletedChildCounts.statusHistory).toBeGreaterThanOrEqual(1);
      expect(payload.deletedChildCounts.resultHistory).toBe(1);
      expect(payload.deletedChildCounts.reprocessJobs).toBe(1);
      expect(payload.deletedChildCounts.stepUpChallenges).toBe(1);
    } finally {
      delete process.env.PAYROLL_RESET_ENABLED; // don't leak the gate into the shared worker
    }
  });

  it('c. draft-only guard: processed and closed batches throw BatchNotDraftError and mutate nothing', async () => {
    const a = adminCtx(base);
    await hire('Guard One');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId }); // → 'processed'

    await expect(deleteDraftBatch(a, { batchId })).rejects.toBeInstanceOf(BatchNotDraftError);
    expect(await batchRows(batchId)).toHaveLength(1);
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slips.length).toBeGreaterThanOrEqual(1); // payslips untouched — Reset (a03b2d9b) owns that path

    await closeBatch(a, { batchId }); // → 'closed'
    await expect(deleteDraftBatch(a, { batchId })).rejects.toBeInstanceOf(BatchNotDraftError);
    expect(await batchRows(batchId)).toHaveLength(1);
  });

  it('d. deleting one of two sibling runs leaves the shared pay_period and the other run intact', async () => {
    process.env.MULTI_CYCLE_PAYROLL_ENABLED = 'true';
    const a = adminCtx(base);
    await hire('Sibling One');
    const { batchId: regularId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const { batchId: offCycleId } = await createAdditionalRun(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'off_cycle',
      remarks: 'Advance Salary',
      paymentDate: '2026-05-10',
    });

    await deleteDraftBatch(a, { batchId: offCycleId });

    expect(await batchRows(offCycleId)).toHaveLength(0);
    expect(await batchRows(regularId)).toHaveLength(1); // sibling untouched
    expect(await periodRows(base.companyId, '2026-05')).toHaveLength(1); // shared parent stays
    const payload = (await latestEventPayload(base.tenantId, offCycleId, 'payroll-batch.deleted')) as {
      payPeriodDeleted: boolean;
    };
    expect(payload.payPeriodDeleted).toBe(false);
  });

  it('e. company scope (RLS): an admin granted only company A cannot delete company B\'s draft', async () => {
    const a = adminCtx(base);
    // Company B in the same tenant, with a draft created by the group-wide admin.
    const [coB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    const { batchId } = await createBatch(a, { companyId: coB.id, payPeriod: '2026-05' });

    // An hr_admin GRANTED ONLY company A (the base company) — RLS hides company B's batch entirely.
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: u.id, companyId: base.companyId, role: 'hr_admin' });
    const scoped: SessionContext = {
      tenantId: base.tenantId,
      userId: u.id,
      grants: [{ role: 'hr_admin', companyId: base.companyId }],
    };

    await expect(deleteDraftBatch(scoped, { batchId })).rejects.toThrow('batch not found');
    expect(await batchRows(batchId)).toHaveLength(1); // untouched
  });
});
