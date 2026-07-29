/**
 * 6fadb036 (R17 gap-close) — the reporter's full 7-role approver vocabulary (list C): Direct Manager,
 * Department Head, Business Unit Head, HR, HR Manager, Payroll, Custom Role. This proves the pieces the
 * verify pass flagged missing: HR can BUILD a chain with these kinds, head steps resolve to the org-chart
 * head (and are dropped when unset), and each step routes to the right decider authority — an HR admin can
 * always complete a chain, a plain manager cannot clear a non-manager step.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { decideLeave, requestLeave } from '../core/leave';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let manager: { personId: string; employmentId: string };
let mgrCtx: SessionContext;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `voc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

const setChain = (levels: string[]) =>
  owner.db.insert(schema.leaveApprovalPolicy).values({
    tenantId: b.tenantId,
    companyId: b.companyId,
    levels,
  });

const stepsFor = (leaveRequestId: string) =>
  owner.db
    .select({ kind: schema.leaveApprovalStep.approverKind, status: schema.leaveApprovalStep.status })
    .from(schema.leaveApprovalStep)
    .where(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId))
    .orderBy(schema.leaveApprovalStep.stepIndex);

const request = (start: string) =>
  requestLeave(adminCtx(b), {
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: start,
    endDate: start,
  });

beforeAll(async () => {
  await migrateTestDb();
});

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // r79 0322 — no per-company multi-step flag any more; each case below calls setChain() with the chain
  // it needs, and the chain's own length is what makes the request multi-step.
  subject = await hire('Subject');
  manager = await hire('Manager');
  await createAppUser(b.tenantId, manager.personId, 'manager');
  const uM = (
    await owner.db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(eq(schema.appUser.personId, manager.personId))
  )[0].id;
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  mgrCtx = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
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

describe('6fadb036 — full approver vocabulary', () => {
  it('drops a department_head step when the subject dept has no head, keeps it when a head is set', async () => {
    await setChain(['department_head', 'hr_admin']);

    // deptA has no head → the department_head step is dropped (no dead step), leaving only HR.
    const r1 = await request('2026-07-01');
    expect(await stepsFor(r1.leaveRequestId)).toEqual([{ kind: 'hr_admin', status: 'pending' }]);

    // Assign a head → the step is now generated ahead of HR.
    await owner.db
      .update(schema.department)
      .set({ headEmploymentId: manager.employmentId })
      .where(eq(schema.department.id, b.deptA));
    const r2 = await request('2026-07-02');
    expect(await stepsFor(r2.leaveRequestId)).toEqual([
      { kind: 'department_head', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);
  });

  it('an HR admin can clear a payroll step but a plain manager cannot', async () => {
    await setChain(['payroll', 'hr_admin']);
    const { leaveRequestId } = await request('2026-07-03');
    expect(await stepsFor(leaveRequestId)).toEqual([
      { kind: 'payroll', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);

    // A manager (no payroll/HR authority) is refused the payroll step.
    await expect(decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow(/Payroll|HR/);

    // An HR admin clears it (guaranteed visibility + authority) → advances to the HR step.
    const advanced = await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(advanced).toMatchObject({ status: 'pending', advancedTo: 'hr_admin' });
  });

  it('routes an HR Manager step to HR authority (manager rejected, HR clears → approved)', async () => {
    // r79 0322 — two levels, not one: a ONE-level chain no longer produces step rows at all (it is the
    // single-approver path), so an hr_manager STEP has to be part of a real chain to exist.
    await setChain(['hr_manager', 'hr_admin']);
    const { leaveRequestId } = await request('2026-07-04');
    expect(await stepsFor(leaveRequestId)).toEqual([
      { kind: 'hr_manager', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);

    await expect(decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow(/HR/);
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    const decided = await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(decided).toMatchObject({ status: 'approved' });
  });

  it("builds the reporter's Management Approval example: Direct Manager → HR Manager → HR", async () => {
    await setChain(['direct_manager', 'hr_manager', 'hr_admin']);
    const { leaveRequestId } = await request('2026-07-05');
    expect(await stepsFor(leaveRequestId)).toEqual([
      { kind: 'direct_manager', status: 'pending' },
      { kind: 'hr_manager', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);
    // Manager clears step 1, HR clears the remaining HR Manager + HR steps → approved.
    await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' });
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    const final = await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    expect(final).toMatchObject({ status: 'approved' });
  });
});
