/**
 * Payroll Reset / Zeroization — Processed-status control (feedback a03b2d9b).
 *
 * The feature: a PROCESSED payroll run is locked (draft-only guards everywhere; generatePayslips
 * refuses to re-run it). The controlled Reset returns it to Draft: payslips cleared, the loan-ledger
 * advance unwound, claims un-marked paid (still queued on the run), keyed draft inputs PRESERVED, and
 * ONE audited `payroll-batch.reset` event appended (who / when / period / company / optional reason).
 * Closed runs are NEVER resettable — the 0011 immutability trigger is the DB backstop.
 *
 * Tests:
 *   a. Full round-trip — process → reset → re-process is byte-identical (same payslip rows, same
 *      totals) with NO re-keying, because the reset restores the exact pre-generation state:
 *      payroll_input intact, the loan instalment back to 'reserved' on the batch, the claim back to
 *      'approved' and still stamped on the batch. Loan ledger restored (outstanding / instalments_paid /
 *      repayment row) and re-advanced identically. Event payload carries the reversal summary + actor.
 *   b. Guards — resetting a draft batch and a closed batch both throw BatchNotResettableError and
 *      mutate nothing; the closed-batch freeze holds even against a direct status UPDATE (0011 trigger).
 *   c. RBAC — a payroll_partner session is rejected (admin-only); the batch stays processed.
 *   d. Feature gate — the `payroll.reset_enabled` SETTING off ⇒ the service refuses before touching
 *      anything. (ADR-0077 slice 3: this was the PAYROLL_RESET_ENABLED env flag; it is now a
 *      per-tenant entitlement row.)
 *
 * ADR-0077 slice 3 note on CONTEXTS. `adminCtx` is `entitlementsExempt: 'harness'`, and an exempt
 * context reads every setting as its CATALOG DEFAULT — which for `payroll.reset_enabled` is `false`
 * (packs/catalog.ts). So the gate is unreachable through it in BOTH directions: it can never be
 * opened, and a test "proving" it closed would be proving only that the harness is exempt. Every
 * `resetProcessedBatch` call below therefore runs through `entitledCtx`, a REAL snapshot resolved
 * from this tenant's rows, taken AFTER the `setSetting` that decides the outcome. `adminCtx` is kept
 * for the setup/processing calls so the payroll behaviour under test is unchanged from before.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { randomUUID } from 'node:crypto';
import {
  BatchNotResettableError,
  closeBatch,
  createBatch,
  generatePayslips,
  resetProcessedBatch,
  setPayrollInput,
} from '../core/payroll';
import { createLoan, prefillLoansForBatch } from '../core/loans';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import {
  adminCtx,
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
const nextIc = () => `9004040${String(10000 + icSeq++).slice(-5)}`;

let base: Base;

async function hire(name: string, basic = 5000) {
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

const batchRow = async (batchId: string) => {
  const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  return b;
};

/** All payslip rows of the batch, stripped of the non-deterministic columns (id, createdAt) and
 *  sorted — the byte-identical comparison target. */
const slipSnapshot = async (batchId: string) => {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return rows
    .map(({ id: _id, createdAt: _c, ...rest }) => rest)
    .sort((x, y) => x.employmentId.localeCompare(y.employmentId));
};

describe('Payroll Reset — resetProcessedBatch (DB)', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // The gate, on, for THIS tenant. seedBase seeds no `payroll.reset_enabled` row (the suite's env has
    // the legacy flag deleted, so legacyEnabledSettingsIn returns the empty set) and the catalog default
    // is false — so tests a–c must turn it on explicitly, exactly as an operator would. Test d overrides
    // it back to false. Written AFTER seedBase because it needs the tenant id; nothing leaks into other
    // test files any more, since the state is a row in this tenant that resetDb truncates.
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
  });
  afterAll(async () => {
    await closeAll();
  });

  it('a. full round-trip: process → reset → re-process is byte-identical; loan ledger + claim reversed exactly; audited', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Reset One', 5000);

    // A loan whose next instalment is reserved onto the run and ADVANCED at generation (ADR-0060).
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

    // An approved taxable claim STAMPED onto the run (as prefillClaimsForBatch does) — generation
    // marks it paid; the reset must revert it to 'approved' and keep it queued on the run.
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

    const [reservedRep] = await owner.db
      .select()
      .from(schema.loanRepayment)
      .where(eq(schema.loanRepayment.reservedBatchId, batchId));
    expect(reservedRep.status).toBe('reserved');

    // ── Process ──
    await generatePayslips(a, { batchId });
    const firstSlips = await slipSnapshot(batchId);
    expect(firstSlips.length).toBeGreaterThanOrEqual(1);
    const firstBatch = await batchRow(batchId);
    expect(firstBatch.status).toBe('processed');

    // Side-effects landed: ledger advanced, instalment applied, claim paid.
    const [loanAfterGen] = await owner.db.select().from(schema.employeeLoan);
    expect(loanAfterGen.outstandingBalance).toBe('2200.00');
    expect(loanAfterGen.instalmentsPaid).toBe(1);
    const [repAfterGen] = await owner.db
      .select()
      .from(schema.loanRepayment)
      .where(eq(schema.loanRepayment.id, reservedRep.id));
    expect(repAfterGen.status).toBe('applied');
    expect(repAfterGen.appliedBatchId).toBe(batchId);
    const [claimAfterGen] = await owner.db
      .select()
      .from(schema.claimRequest)
      .where(eq(schema.claimRequest.id, claim.id));
    expect(claimAfterGen.status).toBe('paid');
    expect(claimAfterGen.payoutRef).toBe('payroll:2026-05');

    // ── Reset ── (through a REAL snapshot: the gate is on for this tenant — see the header note)
    const gated = await entitledCtx(base);
    const res = await resetProcessedBatch(gated, { batchId, reason: 'wrong OT keyed' });
    expect(res).toEqual({ payslipsCleared: firstSlips.length, loanInstalmentsReversed: 1, claimsReverted: 1 });

    // Batch back to draft, results zeroized.
    const afterReset = await batchRow(batchId);
    expect(afterReset.status).toBe('draft');
    expect(afterReset.totals).toBeNull();
    expect(afterReset.employeeCount).toBe(0);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);

    // Keyed DRAFT inputs are PRESERVED (reset ≠ delete-draft): the OT row is still there.
    const inputs = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, e1.employmentId)));
    expect(inputs).toHaveLength(1);
    expect(Number(inputs[0].overtimeAmount)).toBe(123);

    // Loan ledger restored to the exact pre-generation state.
    const [loanAfterReset] = await owner.db.select().from(schema.employeeLoan);
    expect(loanAfterReset.outstandingBalance).toBe('2400.00');
    expect(loanAfterReset.instalmentsPaid).toBe(0);
    expect(loanAfterReset.status).toBe('active');
    const [repAfterReset] = await owner.db
      .select()
      .from(schema.loanRepayment)
      .where(eq(schema.loanRepayment.id, reservedRep.id));
    expect(repAfterReset.status).toBe('reserved');
    expect(repAfterReset.reservedBatchId).toBe(batchId);
    expect(repAfterReset.appliedBatchId).toBeNull();
    expect(Number(repAfterReset.appliedAmount)).toBe(0);
    expect(repAfterReset.appliedAt).toBeNull();
    expect(repAfterReset.dueAmount).toBe(reservedRep.dueAmount);

    // Claim re-queued: back to 'approved', payout provenance cleared, STILL stamped on the run.
    const [claimAfterReset] = await owner.db
      .select()
      .from(schema.claimRequest)
      .where(eq(schema.claimRequest.id, claim.id));
    expect(claimAfterReset.status).toBe('approved');
    expect(claimAfterReset.paidAt).toBeNull();
    expect(claimAfterReset.payoutRef).toBeNull();
    expect(claimAfterReset.payrollBatchId).toBe(batchId);

    // Audit trail: ONE batch-level reset event with the reversal summary + the REAL actor; the prior
    // .processed event is NOT deleted (append-only log reads processed → reset → processed).
    const batchEvents = await eventTypesFor(base.tenantId, batchId);
    expect(batchEvents).toContain('payroll-batch.processed');
    expect(batchEvents.filter((t) => t === 'payroll-batch.reset')).toHaveLength(1);
    const payload = (await latestEventPayload(base.tenantId, batchId, 'payroll-batch.reset')) as {
      fromStatus: string;
      toStatus: string;
      companyId: string;
      payPeriod: string;
      reason: string | null;
      payslipsCleared: number;
      loanInstalmentsReversed: number;
      loansReopened: number;
      claimsReverted: number;
      statutoryReportsForPeriod: number;
    };
    expect(payload.fromStatus).toBe('processed');
    expect(payload.toStatus).toBe('draft');
    expect(payload.companyId).toBe(base.companyId);
    expect(payload.payPeriod).toBe('2026-05');
    expect(payload.reason).toBe('wrong OT keyed');
    expect(payload.payslipsCleared).toBe(firstSlips.length);
    expect(payload.loanInstalmentsReversed).toBe(1);
    expect(payload.loansReopened).toBe(0);
    expect(payload.claimsReverted).toBe(1);
    expect(payload.statutoryReportsForPeriod).toBe(0);
    const [resetEvent] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, batchId), eq(schema.domainEvent.eventType, 'payroll-batch.reset')));
    expect(resetEvent.actorType).toBe('user');
    expect(resetEvent.actorId).toBe(base.adminUserId);
    // …and the cross-aggregate reversal events landed on their own aggregates.
    expect(await eventTypesFor(base.tenantId, reservedRep.id)).toContain('loan.instalment.reversed');
    expect(await eventTypesFor(base.tenantId, claim.id)).toContain('claim-request.payment-reversed');

    // ── Re-process (NO re-keying, NO re-prefill) → byte-identical ──
    await generatePayslips(a, { batchId });
    const secondSlips = await slipSnapshot(batchId);
    expect(secondSlips).toEqual(firstSlips);
    const secondBatch = await batchRow(batchId);
    expect(secondBatch.status).toBe('processed');
    expect(secondBatch.totals).toEqual(firstBatch.totals);
    expect(secondBatch.employeeCount).toBe(firstBatch.employeeCount);
    // The side-effects re-applied to the SAME end state.
    const [loanFinal] = await owner.db.select().from(schema.employeeLoan);
    expect(loanFinal.outstandingBalance).toBe('2200.00');
    expect(loanFinal.instalmentsPaid).toBe(1);
    const [claimFinal] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
    expect(claimFinal.status).toBe('paid');
    expect(claimFinal.payoutRef).toBe('payroll:2026-05');
  });

  it('b. guards: draft and closed batches throw BatchNotResettableError; the 0011 trigger backstops closed even against direct SQL', async () => {
    const a = adminCtx(base);
    // Real snapshot with the gate ON, so the STATUS guard is what these calls reach — an exempt or
    // gate-off context would refuse earlier and this test would pass for the wrong reason.
    const gated = await entitledCtx(base);
    await hire('Guard Reset');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });

    // Draft: nothing to reset. (Reason supplied so the status guard — not the mandatory-reason guard,
    // d1ed1e99 — is what fires here.)
    await expect(resetProcessedBatch(gated, { batchId, reason: 'x' })).rejects.toBeInstanceOf(BatchNotResettableError);
    expect((await batchRow(batchId)).status).toBe('draft');

    await generatePayslips(a, { batchId }); // → processed
    await closeBatch(a, { batchId }); // → closed

    // Closed: permanently immutable — the app guard refuses…
    await expect(resetProcessedBatch(gated, { batchId, reason: 'x' })).rejects.toBeInstanceOf(BatchNotResettableError);
    expect((await batchRow(batchId)).status).toBe('closed');
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slips.length).toBeGreaterThanOrEqual(1); // payslips untouched

    // …and even a direct status UPDATE (guard bypassed) is rejected by the 0011 trigger. Drizzle
    // wraps the Postgres error — read the cause chain (same extraction as slice0.test.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errText = (e: any): string => String(e?.cause?.message ?? e?.message ?? '');
    const triggerMsg = await owner.db
      .update(schema.payrollBatch)
      .set({ status: 'draft' })
      .where(eq(schema.payrollBatch.id, batchId))
      .then(() => '', errText);
    expect(triggerMsg).toMatch(/closed and immutable/);
    expect((await batchRow(batchId)).status).toBe('closed');
  });

  it('c. RBAC: a payroll_partner cannot reset (admin-only) — the batch stays processed', async () => {
    const a = adminCtx(base);
    await hire('Partner Blocked');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: u.id, companyId: base.companyId, role: 'payroll_partner' });
    // The partner session carries a REAL entitlement snapshot (gate ON) — otherwise the setting read at
    // the top of resetProcessedBatch throws EntitlementsUnresolvedError and this test would "pass" on an
    // unresolved-context error instead of on the RBAC denial it is about.
    const partner: SessionContext = {
      ...(await entitledCtx(base, ['payroll_partner'])),
      userId: u.id,
      grants: [{ role: 'payroll_partner', companyId: base.companyId }],
    };

    // 9bc442bc: denial now comes from the granular payroll-permission gate ("You do not have the
    // 'payroll.rollback' payroll permission.") — same admin-only semantics, new message.
    await expect(resetProcessedBatch(partner, { batchId, reason: 'x' })).rejects.toThrow(/'payroll\.rollback' payroll permission/);
    expect((await batchRow(batchId)).status).toBe('processed');
    expect(await eventTypesFor(base.tenantId, batchId)).not.toContain('payroll-batch.reset');
  });

  it('d. feature gate: payroll.reset_enabled off ⇒ the service refuses before touching anything', async () => {
    const a = adminCtx(base);
    await hire('Flag Off');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    // Turn the tenant's setting OFF (an explicit `false` row, not a missing one — so the refusal is the
    // gate answering, not the catalog default filling a hole), then resolve the snapshot AFTER it.
    await setSetting(base.tenantId, 'payroll.reset_enabled', false);
    const gated = await entitledCtx(base);
    await expect(resetProcessedBatch(gated, { batchId })).rejects.toThrow(/not enabled/);
    expect((await batchRow(batchId)).status).toBe('processed');
  });
});
