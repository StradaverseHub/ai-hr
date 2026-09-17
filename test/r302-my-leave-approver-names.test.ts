/**
 * r302 (board 6c9802c9) · MY LEAVE — WHO A REQUEST IS WAITING FOR, AND WHY IT NEEDED A NEW READ.
 *
 * STEP 1 OF THE BUILD WAS A VERIFICATION, AND THIS FILE IS ITS EVIDENCE. The research note assumed that an
 * employee cannot read their own manager's name (person RLS, 0001 / 0029 / 0099: `app.can_see_person` admits
 * self, admins, and people whose employment the caller may see — a manager's employment is not one of those
 * for the manager's report). The first describe block seeds exactly that and reads as the APP ROLE with an
 * EMPLOYEE session, so the premise is a pinned fact rather than a repeated assumption.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { decideLeave, requestLeave } from '../core/leave';
import { listLeaveRequestsPage } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MON = (() => {
  let d = addDays(TODAY, 14);
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
})();

async function person(name: string, role: 'employee' | 'manager' | 'hr_admin') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `r302n_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const ctx: SessionContext = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, e.personId, role),
    personId: e.personId,
    roles: [role],
  };
  return { ...e, ctx };
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('STEP 1a · TODAY an employee cannot read their approver’s name (the premise, verified)', () => {
  it('the shared history projection names the manager to the manager and to HR, and to the employee NOT AT ALL', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const emp = await person('Nadia Employee', 'employee');
    const mgr = await person('Marcus Manager', 'manager');
    const hr = await person('Hana HR', 'hr_admin');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: emp.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '20.00',
      effectiveOn: TODAY,
    });
    const { leaveRequestId } = await requestLeave(emp.ctx, {
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: MON,
      endDate: MON,
      today: TODAY,
    });

    const read = async (ctx: SessionContext) =>
      (await listLeaveRequestsPage(ctx, { employmentIds: [emp.employmentId], limit: 10, offset: 0 })).rows.find(
        (r) => r.id === leaveRequestId,
      );

    // The employee sees their own row, the pending step and its kind — but the NAME resolves to null.
    const own = await read(emp.ctx);
    expect(own, 'the employee sees their own request').toBeDefined();
    expect(own!.currentStepKind).toBe('direct_manager');
    expect(own!.stepCount).toBe(2);
    expect(own!.currentApproverName, 'person RLS hides the manager’s name from the employee').toBeNull();
    // The manager and HR read the same projection and DO get the name — so the null above is RLS, not data.
    expect((await read(mgr.ctx))!.currentApproverName).toBe('Marcus Manager');
    expect((await read(hr.ctx))!.currentApproverName).toBe('Marcus Manager');

    // Once decided, the decider's name is hidden from the employee the same way.
    await decideLeave(mgr.ctx, { leaveRequestId, decision: 'approved', deciderEmploymentId: mgr.employmentId });
    await decideLeave(hr.ctx, { leaveRequestId, decision: 'approved', deciderEmploymentId: hr.employmentId });
    const decidedOwn = await read(emp.ctx);
    expect(decidedOwn!.status).toBe('approved');
    expect(decidedOwn!.decidedByName, 'person RLS hides the decider’s name from the employee').toBeNull();
    expect((await read(hr.ctx))!.decidedByName).toBe('Hana HR');
  });
});
