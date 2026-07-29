/**
 * ADR-0039 2B-2 — configurable approval policy. The approval chain is data: a per-company `levels` list
 * (optionally per leave-type) drives generateApprovalSteps. setLeaveApprovalPolicy edits the company
 * default; resolution prefers a leave-type-specific policy, then the company default, then the built-in
 * fallback. The chain shape (order + count) flows straight into the steps a request generates — the 2B-1
 * state machine is unchanged.
 *
 * r79 0322 — the on/off gate is GONE. `company.leave_multi_approval` used to decide whether ANY chain ran,
 * so a configured chain could sit there doing nothing. Now the chain's own LENGTH decides: two or more
 * levels generate steps, ONE level is a single-approver request that generates NO step rows at all — which
 * is the pre-existing whole-request decideLeave shape, not a one-element chain. That last point is the
 * behaviour this file pins hardest, because it is what every company currently running single-step
 * approval falls onto.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { decideLeave, requestLeave } from '../core/leave';
import { getLeaveApprovalPolicy, setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `pol_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
const kindsFor = async (leaveRequestId: string) =>
  (
    await owner.db
      .select({ kind: schema.leaveApprovalStep.approverKind })
      .from(schema.leaveApprovalStep)
      .where(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId))
      .orderBy(schema.leaveApprovalStep.stepIndex)
  ).map((r) => r.kind);
const request = () =>
  requestLeave(adminCtx(b), { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: '2026-07-01', endDate: '2026-07-01' });

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  subject = await hire('Subject');
  const manager = await hire('Manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  // r79 0322 — the one-step pin below actually APPROVES the request (proving it runs the whole-request
  // path, not just that no step rows exist), so the subject needs a balance for the debit to succeed.
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days: '20.00',
    effectiveOn: '2026-01-01',
  });
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0039 2B-2 — configurable approval policy', () => {
  it('a configured multi-step chain drives the generated steps', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['hr_admin', 'payroll'] });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual(['hr_admin', 'payroll']); // not the 2B-1 default
  });

  it('honors the configured order (HR before manager)', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['hr_admin', 'direct_manager'] });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual(['hr_admin', 'direct_manager']);
  });

  it('a leave-type-specific policy overrides the company default', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['hr_admin', 'payroll'] });
    // Type-specific override for annual leave (the editor will do this later; insert directly here).
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: b.annualLeaveTypeId,
      levels: ['direct_manager', 'hr_admin'],
    });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual(['direct_manager', 'hr_admin']);
  });

  /**
   * r79 0322 — THE pin. Before this round a company opted OUT with company.leave_multi_approval=false and
   * got no step rows; six of the eight production companies were in that state. The replacement for that
   * switch is a ONE-STEP chain, and it has to land on the SAME shape — no leave_approval_step rows at all,
   * so /approvals and decideLeave keep routing on `steps.length > 0` exactly as they do today. A
   * one-ELEMENT chain would satisfy "single approver" in words while changing the shape for everyone.
   *
   * Verified RED before green: with the gate written as `chain.length < 1` (only an empty chain
   * collapsing) this expects [] and receives ['hr_admin'], and the decide below then runs through the
   * step machinery rather than the whole-request path.
   */
  it('a ONE-step chain generates NO step rows — the existing single-step whole-request shape', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['hr_admin'] });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual([]);
    // ...and it is settled by ONE whole-request decision, not step-by-step.
    const decided = await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(decided).toEqual({ status: 'approved' });
  });

  it('a one-step chain is single-approver even when that single step is direct_manager', async () => {
    // The subject HAS an administrative manager here, so this is not the "step was dropped" path: the
    // chain is one level by CONFIGURATION, and that is what collapses it.
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual([]);
  });

  it('a two-step chain whose manager step is DROPPED still generates its one surviving step row', async () => {
    // Separates "one level by configuration" (collapses to whole-request) from "two levels, one dropped"
    // (stays a chain) — the distinction the gate makes by branching before the drop rules.
    const orphan = await hire('Orphan'); // deliberately no reporting line
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const { leaveRequestId } = await requestLeave(adminCtx(b), {
      employmentId: orphan.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    expect(await kindsFor(leaveRequestId)).toEqual(['hr_admin']);
  });

  it('rejects a chain with no levels, and getLeaveApprovalPolicy returns the saved chain', async () => {
    // Assert the SPECIFIC message: a bare rejects.toThrow() would also pass on an RLS or constraint error.
    await expect(
      setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: [] }),
    ).rejects.toThrow('An approval chain needs at least one level');
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    expect(await getLeaveApprovalPolicy(adminCtx(b), b.companyId)).toEqual({
      levels: ['direct_manager', 'hr_admin'],
    });
    // Sanity: only one company-default row exists (upsert, not duplicate insert).
    const defaults = await owner.db
      .select({ id: schema.leaveApprovalPolicy.id })
      .from(schema.leaveApprovalPolicy)
      .where(and(eq(schema.leaveApprovalPolicy.companyId, b.companyId), isNull(schema.leaveApprovalPolicy.leaveTypeId)));
    expect(defaults).toHaveLength(1);
  });
});
