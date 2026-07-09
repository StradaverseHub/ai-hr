/**
 * Payroll Process wizard plan — the one intended engine behaviour change: claims scope safety.
 * Before this fix, prefillClaimsForBatch queued the whole company's approved-taxable claims regardless
 * of a batch's scope, and generatePayslips marked EVERY reserved claim paid — including claims belonging
 * to people outside a filtered run, who received no payslip. This suite proves both halves of the fix:
 *   (a) prefill only reserves claims for employments in the batch's scope.
 *   (b) generation marks paid only claims whose employment actually got a payslip in THIS batch; any
 *       linked claim without a payslip here (out-of-scope) reverts to unlinked/approved so it re-queues
 *       on the next batch instead of being stranded.
 * f1564110 Phase 1 note: the comp-less variant of (b) can no longer reach generation — an in-scope
 * employee with no compensation row now HARD-BLOCKS generatePayslips (PreProcessBlockedError; see
 * payroll-preprocess-advisory.test.ts), so (b) is exercised via a post-prefill scope narrow instead.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { createClaimType, decideClaim, prefillClaimsForBatch, submitClaim } from '../core/claims';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips, updateBatchScope } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string, departmentId: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const recent = (daysBack = 5): string =>
  new Date(new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10);

describe('Payroll Process wizard — claims scope safety', () => {
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

  it('prefill reserves ONLY claims for employees in the batch scope', async () => {
    const a = adminCtx(base);
    const inScope = await hire(a, base, 'InScope', base.deptA);
    const outOfScope = await hire(a, base, 'OutOfScope', base.deptA);
    await setCompensation(a, { employmentId: inScope.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: outOfScope.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    const { id: typeId } = await createClaimType(a, { code: 'PHONE', name: 'Phone', defaultTaxable: true, requiresReceipt: false });
    const { id: inScopeClaim } = await submitClaim(a, { employmentId: inScope.employmentId, claimTypeId: typeId, amount: 100, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: inScopeClaim, decision: 'approve' });
    const { id: outOfScopeClaim } = await submitClaim(a, { employmentId: outOfScope.employmentId, claimTypeId: typeId, amount: 200, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: outOfScopeClaim, decision: 'approve' });

    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [inScope.employmentId] },
    });
    const { applied, claims, total } = await prefillClaimsForBatch(a, { batchId });
    expect(applied).toBe(1);
    expect(claims).toBe(1);
    expect(total).toBeCloseTo(100, 2);

    const [inClaim] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, inScopeClaim));
    expect(inClaim.payrollBatchId).toBe(batchId);
    const [outClaim] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, outOfScopeClaim));
    expect(outClaim.payrollBatchId).toBeNull();
    expect(outClaim.status).toBe('approved');
  });

  it('generation marks paid only claims with a payslip in this batch; linked claims without a payslip re-queue', async () => {
    const a = adminCtx(base);
    const withPayslip = await hire(a, base, 'WithPayslip', base.deptA);
    const excluded = await hire(a, base, 'Excluded', base.deptA);
    await setCompensation(a, { employmentId: withPayslip.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: excluded.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    const { id: typeId } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: true, requiresReceipt: false });
    const { id: claimA } = await submitClaim(a, { employmentId: withPayslip.employmentId, claimTypeId: typeId, amount: 150, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: claimA, decision: 'approve' });
    const { id: claimB } = await submitClaim(a, { employmentId: excluded.employmentId, claimTypeId: typeId, amount: 250, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: claimB, decision: 'approve' });

    // Whole-company batch (no scope) so both claims are reserved via the normal unscoped path.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillClaimsForBatch(a, { batchId });

    const [beforeA] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimA));
    const [beforeB] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimB));
    expect(beforeA.payrollBatchId).toBe(batchId);
    expect(beforeB.payrollBatchId).toBe(batchId);

    // Narrow the scope AFTER prefill — the excluded employee keeps a linked claim but gets no payslip.
    // (f1564110 Phase 1: the previous comp-less route to a payslip-less linked claim now hard-blocks
    // generation instead of silently dropping the employee.)
    await updateBatchScope(a, { batchId, scope: { employmentIds: [withPayslip.employmentId] } });

    await generatePayslips(a, { batchId });

    const [afterA] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimA));
    expect(afterA.status).toBe('paid');
    expect(afterA.payrollBatchId).toBe(batchId);

    // The scoped-out employee got no payslip → the linked claim reverts to unlinked/approved so it
    // re-queues on the next batch instead of being stranded forever.
    const [afterB] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimB));
    expect(afterB.status).toBe('approved');
    expect(afterB.payrollBatchId).toBeNull();
  });
});
