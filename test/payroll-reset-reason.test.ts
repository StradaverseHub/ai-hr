/**
 * Payroll Reset — MANDATORY reason (feedback d1ed1e99).
 *
 * The Reset feature (resetProcessedBatch, a03b2d9b) already reverts a PROCESSED run to Draft:
 * payslips deleted + totals/employeeCount cleared, the loan-ledger advance unwound + auto-settled loans
 * reopened, batch-paid claims reverted to 'approved', audited in payroll_status_history (action
 * 'rollback') + a payroll-batch.reset event; keyed draft inputs preserved. This item makes the REASON
 * mandatory so the audit log always explains WHY a processed run was reset — the guard is a typed
 * ResetReasonRequiredError thrown BEFORE any deletion / status change (mirrors UnlockReasonRequiredError).
 *
 * Tests:
 *   a. A blank / whitespace-only (and an undefined) reason is rejected with ResetReasonRequiredError
 *      before anything mutates — the batch stays processed, payslips + totals are intact, no 'rollback'
 *      history row and no payroll-batch.reset event are written, and the loan/claim side-effects still
 *      reflect the processed run (nothing was reversed).
 *   b. A non-blank reason succeeds: Processed → Draft, payslips deleted + totals cleared, the loan
 *      instalment reversed + claim reverted to 'approved', a payroll_status_history 'rollback' row is
 *      written (from/to/actor/trimmed-reason), and the payroll-batch.reset event carries the reason.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {
  ResetReasonRequiredError,
  createBatch,
  generatePayslips,
  resetProcessedBatch,
  resetProcessedBatchTx,
  previewReviewedPayrollResetTx,
  setPayrollInput,
} from '../core/payroll';
import { createLoan, prefillLoansForBatch } from '../core/loans';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import {
  closeAll,
  entitledCtx,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setSetting,
  type Base,
} from './harness';

let icSeq = 0;
const nextIc = () => `9204040${String(10000 + icSeq++).slice(-5)}`;

let base: Base;
/**
 * ADR-0077 slice 3 — the reset gate is a per-tenant SETTING row (`payroll.reset_enabled`), not
 * PAYROLL_RESET_ENABLED. It therefore cannot be driven through `adminCtx`: that context carries a
 * SYNTHETIC snapshot whose `settings` map is `legacyEnabledSettingsIn(process.env)`, which test/env.ts
 * makes EMPTY — so every setting reads its catalog default (`false` here) and a `setSetting` fixture is
 * only visible to a context built after it. Every call in this file goes through a REAL snapshot
 * (`entitledCtx`), resolved in beforeEach AFTER the grant is written, which reads the tenant's ROWS and
 * needs no mirror. It also keeps the rest of the run on the same code path as before: seedBase seeds no
 * `multi_cycle_payroll` / `typed_pay_components` row under the suite env, exactly as test/env.ts
 * deleted those flags. (Until slice 3 `adminCtx` was `entitlementsExempt: 'harness'` and would have
 * answered TRUE for both modules — the hazard this file was converted against.)
 */
let ctx: SessionContext;

async function hire(name: string, basic = 5000) {
  const a = ctx;
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

const batchRow = async (batchId: string) => {
  const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  return b;
};

const rollbackHistoryRows = async (batchId: string) =>
  owner.db
    .select()
    .from(schema.payrollStatusHistory)
    .where(and(eq(schema.payrollStatusHistory.batchId, batchId), eq(schema.payrollStatusHistory.action, 'rollback')));

/**
 * Drive a batch to PROCESSED with a loan instalment advanced + an approved claim stamped-and-paid, so a
 * reset has real side-effects to reverse. Returns the ids the assertions probe.
 */
async function processedBatchWithSideEffects(period: string) {
  const a = ctx;
  const e1 = await hire(`Reset Reason ${period}`, 5000);

  await createLoan(a, {
    employmentId: e1.employmentId,
    loanType: 'personal',
    principal: 2400,
    interestRate: 0,
    interestMethod: 'none',
    durationMonths: 12,
    startDate: '2026-01-01',
  });

  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await prefillLoansForBatch(a, { batchId });
  await setPayrollInput(a, { batchId, employmentId: e1.employmentId, overtimeAmount: 123 });

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
      incurredOn: `${period}-03`,
      taxable: true,
      status: 'approved',
      payrollBatchId: batchId,
    })
    .returning({ id: schema.claimRequest.id });

  const [reservedRep] = await owner.db
    .select()
    .from(schema.loanRepayment)
    .where(eq(schema.loanRepayment.reservedBatchId, batchId));

  await generatePayslips(a, { batchId }); // → processed
  expect((await batchRow(batchId)).status).toBe('processed');

  return { batchId, claimId: claim.id, repId: reservedRep.id };
}

describe('Payroll Reset — mandatory reason (resetProcessedBatch)', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // The gate this file needs ON, as a row on THIS tenant. No cleanup hook any more: the grant dies
    // with the tenant at the next resetDb, so unlike the env var it cannot leak into another file.
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    ctx = await entitledCtx(base); // resolved AFTER the grant — the snapshot is point-in-time.
  });
  afterAll(async () => {
    await closeAll();
  });

  it('a. a blank / undefined reason is rejected before the flip; batch stays processed, nothing zeroized, nothing audited, side-effects intact', async () => {
    const a = ctx;
    const { batchId, claimId, repId } = await processedBatchWithSideEffects('2026-05');

    // Whitespace-only reason → typed error, thrown BEFORE any deletion / status change.
    await expect(resetProcessedBatch(a, { batchId, reason: '   ' })).rejects.toBeInstanceOf(ResetReasonRequiredError);
    // An undefined reason is likewise rejected.
    await expect(resetProcessedBatch(a, { batchId })).rejects.toBeInstanceOf(ResetReasonRequiredError);

    // Nothing changed: still processed, payslips + totals intact…
    const b = await batchRow(batchId);
    expect(b.status).toBe('processed');
    expect(b.totals).not.toBeNull();
    expect(b.employeeCount).toBeGreaterThanOrEqual(1);
    expect(
      await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId)),
    ).not.toHaveLength(0);

    // …no rollback history, no reset event…
    expect(await rollbackHistoryRows(batchId)).toHaveLength(0);
    expect(await eventTypesFor(base.tenantId, batchId)).not.toContain('payroll-batch.reset');

    // …and the processed-run side-effects are untouched (loan applied, claim still paid).
    const [rep] = await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id, repId));
    expect(rep.status).toBe('applied');
    const [claim] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimId));
    expect(claim.status).toBe('paid');
  });

  it('b. a non-blank reason succeeds: Processed → Draft, zeroized, loan/claim reversed, history row + event carry the trimmed reason', async () => {
    const a = ctx;
    const { batchId, claimId, repId } = await processedBatchWithSideEffects('2026-06');

    const res = await resetProcessedBatch(a, { batchId, reason: '  fix keyed OT  ' });
    expect(res).toEqual({ payslipsCleared: expect.any(Number), loanInstalmentsReversed: 1, claimsReverted: 1 });

    // Status flipped + results zeroized.
    const b = await batchRow(batchId);
    expect(b.status).toBe('draft');
    expect(b.totals).toBeNull();
    expect(b.employeeCount).toBe(0);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);

    // Side-effects reversed: loan instalment back to 'reserved', claim back to 'approved' (still queued).
    const [rep] = await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id, repId));
    expect(rep.status).toBe('reserved');
    const [claim] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimId));
    expect(claim.status).toBe('approved');
    expect(claim.payrollBatchId).toBe(batchId);

    // Exactly one audited 'rollback' history row with the trimmed reason + the real actor.
    const rows = await rollbackHistoryRows(batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromStatus).toBe('processed');
    expect(rows[0].toStatus).toBe('draft');
    expect(rows[0].reason).toBe('fix keyed OT');
    expect(rows[0].actorType).toBe('user');
    expect(rows[0].actorId).toBe(base.adminUserId);

    // The domain event carries the trimmed reason too.
    expect(await eventTypesFor(base.tenantId, batchId)).toContain('payroll-batch.reset');
    const payload = (await latestEventPayload(base.tenantId, batchId, 'payroll-batch.reset')) as { reason: string };
    expect(payload.reason).toBe('fix keyed OT');
  });
  it('c. caller-owned reset returns exact audit references and rolls all native effects back with its caller', async () => {
    const {batchId,claimId,repId}=await processedBatchWithSideEffects('2026-07');
    const beforeBatch=await batchRow(batchId);
    const beforeSlips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
    const [beforeRep]=await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id,repId));
    const [beforeLoan]=await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id,beforeRep.loanId));
    await expect(withTenant(ctx,async tx=>{
      const result=await resetProcessedBatchTx(tx,ctx,{batchId,reason:'Caller rollback witness'});
      expect(result).toMatchObject({statusHistoryId:expect.any(String),resetEventId:expect.any(String),payslipsCleared:beforeSlips.length,loanInstalmentsReversed:1,claimsReverted:1});
      const [history]=await tx.select().from(schema.payrollStatusHistory).where(eq(schema.payrollStatusHistory.id,result.statusHistoryId));
      expect(history).toMatchObject({batchId,action:'rollback',fromStatus:'processed',toStatus:'draft',reason:'Caller rollback witness',actorId:ctx.userId});
      const [event]=await tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,result.resetEventId));
      expect(event).toMatchObject({aggregateId:batchId,eventType:'payroll-batch.reset',actorId:ctx.userId});
      expect(event.payload).toMatchObject({statusHistoryId:result.statusHistoryId,payslipsCleared:beforeSlips.length,loanInstalmentsReversed:1,claimsReverted:1});
      const [rep]=await tx.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id,repId));
      const [claim]=await tx.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId));
      expect(rep.status).toBe('reserved');expect(claim.status).toBe('approved');
      throw new Error('Fictional outer transaction refusal');
    })).rejects.toThrow('Fictional outer transaction refusal');
    expect(await batchRow(batchId)).toEqual(beforeBatch);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toEqual(beforeSlips);
    expect((await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id,repId)))[0]).toEqual(beforeRep);
    expect((await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id,beforeRep.loanId)))[0]).toEqual(beforeLoan);
    expect((await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId)))[0].status).toBe('paid');
    expect(await rollbackHistoryRows(batchId)).toHaveLength(0);
    expect(await eventTypesFor(base.tenantId,batchId)).not.toContain('payroll-batch.reset');
  });

  it('d. native SAVEPOINT preview leaves loan, claim, payslip and audit state unchanged and discards preview references', async () => {
    const {batchId,claimId,repId}=await processedBatchWithSideEffects('2026-08');
    const beforeBatch=await batchRow(batchId),beforeHistory=await rollbackHistoryRows(batchId);
    const beforeEvents=await eventTypesFor(base.tenantId,batchId);
    const beforeSlips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
    const [beforeRep]=await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id,repId));
    const [beforeLoan]=await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id,beforeRep.loanId));
    const [beforeClaim]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId));
    await withTenant(ctx,async tx=>{
      const first=await previewReviewedPayrollResetTx(tx,ctx,{batchId,reason:'Preview native effect'});
      expect(first.counts).toEqual({payslipsCleared:beforeSlips.length,loanInstalmentsReversed:1,loansReopened:0,claimsReverted:1});
      expect(first.sourceCounts).toMatchObject({payslipsToDelete:beforeSlips.length,appliedRepaymentRows:1,affectedLoans:1,paidClaimsToRevert:1});
      expect(Object.keys(first).sort()).toEqual(['counts','effectDigest','sourceCounts','sourceDigest']);
      const second=await previewReviewedPayrollResetTx(tx,ctx,{batchId,reason:'Preview native effect'});
      expect(second).toEqual(first);
      const [batch]=await tx.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));
      expect(batch).toEqual(beforeBatch);
    });
    expect(await batchRow(batchId)).toEqual(beforeBatch);
    expect(await rollbackHistoryRows(batchId)).toEqual(beforeHistory);
    expect(await eventTypesFor(base.tenantId,batchId)).toEqual(beforeEvents);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toEqual(beforeSlips);
    expect((await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id,repId)))[0]).toEqual(beforeRep);
    expect((await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id,beforeRep.loanId)))[0]).toEqual(beforeLoan);
    expect((await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId)))[0]).toEqual(beforeClaim);
  });

  it('e. a native failure inside preview rolls back every earlier effect and releases the savepoint', async () => {
    const {batchId,claimId,repId}=await processedBatchWithSideEffects('2026-09');
    const beforeBatch=await batchRow(batchId);
    const beforeSlips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
    const [beforeRep]=await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id,repId));
    const [beforeLoan]=await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id,beforeRep.loanId));
    const [beforeClaim]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId));
    await owner.db.execute(sql`create function app.fictional_reset_preview_failure() returns trigger language plpgsql as $$begin if NEW.action='rollback' then raise exception 'Fictional reset preview refusal';end if;return NEW;end$$`);
    await owner.db.execute(sql`create trigger fictional_reset_preview_failure before insert on public.payroll_status_history for each row execute function app.fictional_reset_preview_failure()`);
    try {
      await withTenant(ctx,async tx=>{
        await expect(previewReviewedPayrollResetTx(tx,ctx,{batchId,reason:'Preview failure cleanup'})).rejects.toThrow();
        const [batch]=await tx.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));
        expect(batch).toEqual(beforeBatch);
        // A subsequent real SAVEPOINT must work; the failed preview did not leave an aborted scope.
        await tx.execute(sql`SAVEPOINT fictional_after_preview`);
        await tx.execute(sql`RELEASE SAVEPOINT fictional_after_preview`);
      });
    } finally {
      await owner.db.execute(sql`drop trigger fictional_reset_preview_failure on public.payroll_status_history`);
      await owner.db.execute(sql`drop function app.fictional_reset_preview_failure()`);
    }
    expect(await batchRow(batchId)).toEqual(beforeBatch);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toEqual(beforeSlips);
    expect((await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id,repId)))[0]).toEqual(beforeRep);
    expect((await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id,beforeRep.loanId)))[0]).toEqual(beforeLoan);
    expect((await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId)))[0]).toEqual(beforeClaim);
    expect(await rollbackHistoryRows(batchId)).toHaveLength(0);
    expect(await eventTypesFor(base.tenantId,batchId)).not.toContain('payroll-batch.reset');
  });

});
