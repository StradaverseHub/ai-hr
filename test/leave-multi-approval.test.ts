/**
 * ADR-0038 2B-1 (#18) — multi-level leave approval. A leave request whose resolved chain has two or more
 * levels generates an ordered chain of approval steps (direct manager → HR). decideLeave advances the
 * current step; the request is only approved (and the ledger debited) when the final step clears, and a
 * rejection at any step is terminal. A non-HR approver cannot clear the HR step.
 *
 * r79 0322 — the opt-in is no longer company.leave_multi_approval; it is the resolved chain's own length.
 * These cases run on the built-in direct_manager → hr_admin fallback (no rule configured), which is what
 * the seeded company resolves to.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { decideLeave, requestLeave } from '../core/leave';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let mgrCtx: SessionContext;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `mla_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
const stepsFor = (leaveRequestId: string) =>
  owner.db
    .select({ kind: schema.leaveApprovalStep.approverKind, status: schema.leaveApprovalStep.status })
    .from(schema.leaveApprovalStep)
    .where(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId))
    .orderBy(schema.leaveApprovalStep.stepIndex);
const statusOf = async (leaveRequestId: string) => {
  const [r] = await owner.db
    .select({ status: schema.leaveRequest.status })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, leaveRequestId));
  return r?.status;
};
const request = (start: string) =>
  requestLeave(adminCtx(b), { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: start, endDate: start });

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  subject = await hire('Subject');
  const manager = await hire('Manager');
  const uM = await createAppUser(b.tenantId, manager.personId, 'manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  mgrCtx = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
  // Give the subject leave balance so a final approval can debit it.
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

describe('ADR-0038 2B-1 — multi-level leave approval', () => {
  it('generates a manager → HR chain and only finalizes when the last step clears', async () => {
    const { leaveRequestId } = await request('2026-07-01');
    expect(await stepsFor(leaveRequestId)).toEqual([
      { kind: 'direct_manager', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);

    // Manager clears step 1 → advances, NOT final (no debit, still pending).
    const afterMgr = await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' });
    expect(afterMgr).toMatchObject({ status: 'pending', advancedTo: 'hr_admin' });
    expect(await statusOf(leaveRequestId)).toBe('pending');

    // HR clears the final step → approved + debited.
    const afterHr = await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(afterHr).toMatchObject({ status: 'approved' });
    expect(await statusOf(leaveRequestId)).toBe('approved');
    const debit = await owner.db
      .select({ days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.sourceRequestId, leaveRequestId));
    expect(debit).toHaveLength(1);
    expect(Number(debit[0].days)).toBe(-1);
  });

  it('a manager cannot clear the HR step', async () => {
    const { leaveRequestId } = await request('2026-07-02');
    await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' }); // clears manager step
    await expect(decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow(/HR/);
    expect(await statusOf(leaveRequestId)).toBe('pending');
  });

  it('a rejection at any step is terminal', async () => {
    const { leaveRequestId } = await request('2026-07-03');
    // Partial Leave Approval (0131): a reject now requires a reason; rejection at any step is still terminal.
    await decideLeave(mgrCtx, { leaveRequestId, decision: 'rejected', rejectReason: 'not this week' });
    expect(await statusOf(leaveRequestId)).toBe('rejected');
    const debit = await owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.sourceRequestId, leaveRequestId));
    expect(debit).toHaveLength(0);
  });

  /**
   * r79 0322 — this used to be "a company that has not opted in", flipping
   * company.leave_multi_approval to false. That switch is gone; a company says "one approver" by being
   * assigned a ONE-STEP chain, and it must land on the same shape the opt-out landed on: no step rows,
   * one whole-request decision. Flipping the old column here would now be a no-op that quietly proves
   * nothing, which is why the test writes a real one-step policy instead.
   */
  it('a company on a ONE-step chain keeps single-step approval', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['hr_admin'] });
    const { leaveRequestId } = await request('2026-07-06');
    expect(await stepsFor(leaveRequestId)).toHaveLength(0);
    const decided = await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(decided).toMatchObject({ status: 'approved' });
    expect(await statusOf(leaveRequestId)).toBe('approved');
  });
});
