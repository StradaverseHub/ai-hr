/**
 * Hierarchy Management (ADR-0052). Visibility now follows the recursive administrative graph
 * (direct + indirect reports) and the department tree (HOD), clamped to the manager's company subtree;
 * decision authority stays on the direct manager (+ HR + an active delegate). Delegation reuses
 * reporting_line as a `delegate` edge (approver-routing only — no visibility inheritance).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  DelegationError,
  ReportingCycleError,
  hireEmployee,
  setReportingLine,
  terminateEmployment,
} from '../core/org';
import { currentCompensation, setCompensation } from '../core/comp';
import { requestLeave, decideLeave } from '../core/leave';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { employeeDetail, orgChartData } from '../core/read';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const A = (b: Base) => adminCtx(b);

/** Hire into a given company + department, returning ids. */
async function hire(name: string, companyId: string, departmentId: string) {
  return hireEmployee(A(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 6)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

async function adminLine(subordinate: string, manager: string, validFrom = '2024-01-01') {
  return setReportingLine(A(b), { subordinateEmploymentId: subordinate, managerEmploymentId: manager, lineType: 'administrative', validFrom });
}

/** A non-admin session that resolves through app.current_user_id() for RLS. */
async function userCtx(personId: string, role: 'employee' | 'manager'): Promise<SessionContext> {
  const uid = await createAppUser(b.tenantId, personId, role);
  return { tenantId: b.tenantId, userId: uid, roles: [role], personId };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0052 — recursive + HOD visibility', () => {
  it('1. a 3-level admin chain: top sees the indirect report; a sibling manager does not', async () => {
    // A (top) → B (mid) → C (leaf). deptA for everyone here.
    const topA = await hire('TopA', b.companyId, b.deptA);
    const midB = await hire('MidB', b.companyId, b.deptA);
    const leafC = await hire('LeafC', b.companyId, b.deptA);
    await adminLine(midB.employmentId, topA.employmentId);
    await adminLine(leafC.employmentId, midB.employmentId);
    const sibling = await hire('Sibling', b.companyId, b.deptA); // manages nobody

    const topCtx = await userCtx(topA.personId, 'manager');
    // top can see the indirect (2-hop) report C
    expect((await employeeDetail(topCtx, leafC.employmentId))?.name).toBe('LeafC');
    // and the direct report B
    expect((await employeeDetail(topCtx, midB.employmentId))?.name).toBe('MidB');

    const sibCtx = await userCtx(sibling.personId, 'manager');
    expect(await employeeDetail(sibCtx, leafC.employmentId)).toBeFalsy();
  });

  it('2. self / HR regression: an employee sees only self; HR/admin sees all', async () => {
    const emp = await hire('Solo', b.companyId, b.deptA);
    const other = await hire('Other', b.companyId, b.deptA);
    const eCtx = await userCtx(emp.personId, 'employee');
    expect((await employeeDetail(eCtx, emp.employmentId))?.name).toBe('Solo');
    expect(await employeeDetail(eCtx, other.employmentId)).toBeFalsy();
    // admin sees both
    expect((await employeeDetail(A(b), emp.employmentId))?.name).toBe('Solo');
    expect((await employeeDetail(A(b), other.employmentId))?.name).toBe('Other');
  });

  it('3. HOD sees the whole department subtree, not a sibling department', async () => {
    // Department tree: deptA has a child sub-department; deptB is a sibling.
    const [sub] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Finance-Sub', parentDepartmentId: b.deptA })
      .returning({ id: schema.department.id });

    const head = await hire('Head', b.companyId, b.deptA); // HOD: current assignment dept = deptA
    const inSub = await hire('InSub', b.companyId, sub.id); // in a sub-department of deptA
    const inSibling = await hire('InSibling', b.companyId, b.deptB); // sibling department

    // The head must manage at least one report (heads_department_of requires an admin line as manager).
    const someReport = await hire('SomeReport', b.companyId, b.deptA);
    await adminLine(someReport.employmentId, head.employmentId);

    const hodCtx = await userCtx(head.personId, 'manager');
    expect((await employeeDetail(hodCtx, inSub.employmentId))?.name).toBe('InSub'); // sub-department visible
    expect(await employeeDetail(hodCtx, inSibling.employmentId)).toBeFalsy(); // sibling dept NOT visible
  });

  it('4. the cycle guard still rejects A reporting to C (downstream of A)', async () => {
    const topA = await hire('CycTop', b.companyId, b.deptA);
    const midB = await hire('CycMid', b.companyId, b.deptA);
    const leafC = await hire('CycLeaf', b.companyId, b.deptA);
    await adminLine(midB.employmentId, topA.employmentId);
    await adminLine(leafC.employmentId, midB.employmentId);
    await expect(adminLine(topA.employmentId, leafC.employmentId)).rejects.toBeInstanceOf(ReportingCycleError);
  });

  it('5. multi-employment seed: a manager holding two employments sees indirect reports under EITHER', async () => {
    // One person, two manager employments. Each heads a separate chain.
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'DualMgr', primaryEmail: `dual_${randomUUID().slice(0, 6)}@t.local` })
      .returning({ id: schema.person.id });
    // Build the two employments for the same person via the admin hire path (person.id reused).
    const m1 = await hireEmployee(A(b), {
      person: { id: p.id },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    const m2 = await hireEmployee(A(b), {
      person: { id: p.id },
      companyId: b.companyId,
      departmentId: b.deptB,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    const r1mid = await hire('R1Mid', b.companyId, b.deptA);
    const r1leaf = await hire('R1Leaf', b.companyId, b.deptA);
    await adminLine(r1mid.employmentId, m1.employmentId);
    await adminLine(r1leaf.employmentId, r1mid.employmentId); // indirect under employment #1
    const r2 = await hire('R2', b.companyId, b.deptB);
    await adminLine(r2.employmentId, m2.employmentId); // direct under employment #2

    const ctx = await userCtx(p.id, 'manager');
    expect((await employeeDetail(ctx, r1leaf.employmentId))?.name).toBe('R1Leaf'); // indirect via emp #1
    expect((await employeeDetail(ctx, r2.employmentId))?.name).toBe('R2'); // via emp #2
  });

  it('6. company clamp: an indirect report in a sibling company is NOT visible to the manager', async () => {
    // A sibling company under the same tenant (not a descendant of companyId).
    const [coB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Sibling Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [deptCoB] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: coB.id, name: 'CoB-Dept' })
      .returning({ id: schema.department.id });

    const mgr = await hire('ClampMgr', b.companyId, b.deptA);
    const mid = await hire('ClampMid', b.companyId, b.deptA);
    await adminLine(mid.employmentId, mgr.employmentId);
    // The indirect report sits in the sibling company.
    const sibReport = await hire('ClampSib', coB.id, deptCoB.id);
    await adminLine(sibReport.employmentId, mid.employmentId);

    const ctx = await userCtx(mgr.personId, 'manager');
    // direct report (same company) is visible
    expect((await employeeDetail(ctx, mid.employmentId))?.name).toBe('ClampMid');
    // indirect report in the sibling company is clamped out
    expect(await employeeDetail(ctx, sibReport.employmentId)).toBeFalsy();
  });

  it('7. termination: a terminated mid-level manager breaks the chain — their subtree is not reachable', async () => {
    const topA = await hire('TTop', b.companyId, b.deptA);
    const midB = await hire('TMid', b.companyId, b.deptA);
    const leafC = await hire('TLeaf', b.companyId, b.deptA);
    await adminLine(midB.employmentId, topA.employmentId);
    await adminLine(leafC.employmentId, midB.employmentId);

    const ctx = await userCtx(topA.personId, 'manager');
    expect((await employeeDetail(ctx, leafC.employmentId))?.name).toBe('TLeaf'); // reachable before

    await terminateEmployment(A(b), { employmentId: midB.employmentId, terminationDate: '2025-01-01' });
    // mid's admin edges were ended on termination → top can no longer reach the leaf through mid.
    expect(await employeeDetail(ctx, leafC.employmentId)).toBeFalsy();
  });
});

describe('ADR-0052 — delegation (approver-routing only)', () => {
  async function leaveSetup() {
    const mgr = await hire('LMgr', b.companyId, b.deptA);
    const sub = await hire('LSub', b.companyId, b.deptA);
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('Stand', b.companyId, b.deptA); // the delegate
    // Multi-step chain (direct_manager → hr_admin) so the delegate clears the direct_manager step and the
    // request ADVANCES (no finalize / ledger debit) — this isolates "delegate can clear a direct_manager
    // step" per the plan, independent of the subject's leave balance.
    await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, enabled: true, levels: ['direct_manager', 'hr_admin'] });
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    return { mgr, sub, stand, leaveRequestId };
  }

  it('8a. within the window the delegate can clear the direct_manager step', async () => {
    const { mgr, stand, leaveRequestId } = await leaveSetup();
    // Delegation from the manager (delegator) to the stand-in, covering today's date.
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
    });
    const standCtx = await userCtx(stand.personId, 'manager');
    const res = await decideLeave(standCtx, { leaveRequestId, decision: 'approved' });
    // The direct_manager step cleared; the request advanced to the hr_admin step (not finalized).
    expect(res.status).toBe('pending');
    expect((res as { advancedTo?: string }).advancedTo).toBe('hr_admin');
  });

  it('8b. a delegate outside the window cannot decide', async () => {
    const { mgr, stand, leaveRequestId } = await leaveSetup();
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2020-01-01',
      validTo: '2020-02-01', // window already closed
    });
    const standCtx = await userCtx(stand.personId, 'manager');
    await expect(decideLeave(standCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow();
  });

  it('8c. the delegate gains NO visibility of the delegator’s reports (no inheritance)', async () => {
    const { mgr, sub, stand } = await leaveSetup();
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
    });
    void mgr;
    const standCtx = await userCtx(stand.personId, 'manager');
    // Holding the delegation does NOT let the delegate read the delegator's report.
    expect(await employeeDetail(standCtx, sub.employmentId)).toBeFalsy();
  });

  it('8d. a delegate who is the subject is still blocked by the self-approval ban', async () => {
    // The delegate IS the subject of the request — even with a delegation, the self-ban holds.
    const mgr = await hire('SelfMgr', b.companyId, b.deptA);
    const subject = await hire('SelfSubj', b.companyId, b.deptA);
    await adminLine(subject.employmentId, mgr.employmentId);
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    // Delegate the manager's authority to the SUBJECT themselves.
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: subject.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
    });
    const subjCtx = await userCtx(subject.personId, 'employee');
    await expect(decideLeave(subjCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow(/your own/);
  });

  it('overlapping active delegations of the same delegator are rejected', async () => {
    const mgr = await hire('OvMgr', b.companyId, b.deptA);
    const d1 = await hire('OvD1', b.companyId, b.deptA);
    const d2 = await hire('OvD2', b.companyId, b.deptA);
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: d1.employmentId,
      lineType: 'delegate',
      validFrom: '2026-01-01',
      validTo: '2026-03-01',
    });
    await expect(
      setReportingLine(A(b), {
        subordinateEmploymentId: mgr.employmentId,
        managerEmploymentId: d2.employmentId,
        lineType: 'delegate',
        validFrom: '2026-02-01', // overlaps the first window
        validTo: '2026-04-01',
      }),
    ).rejects.toBeInstanceOf(DelegationError);
    // A non-overlapping window is accepted.
    await expect(
      setReportingLine(A(b), {
        subordinateEmploymentId: mgr.employmentId,
        managerEmploymentId: d2.employmentId,
        lineType: 'delegate',
        validFrom: '2026-03-02',
        validTo: '2026-04-01',
      }),
    ).resolves.toBeTruthy();
  });

  it('valid_from <= valid_to is enforced', async () => {
    const mgr = await hire('WinMgr', b.companyId, b.deptA);
    const d = await hire('WinD', b.companyId, b.deptA);
    await expect(
      setReportingLine(A(b), {
        subordinateEmploymentId: mgr.employmentId,
        managerEmploymentId: d.employmentId,
        lineType: 'delegate',
        validFrom: '2026-05-01',
        validTo: '2026-04-01',
      }),
    ).rejects.toBeInstanceOf(DelegationError);
  });
});

describe('ADR-0052 — see ≠ decide, comp non-regression, org chart, hire-with-manager', () => {
  it('9. an indirect manager can SEE a report but cannot DECIDE their leave', async () => {
    const topA = await hire('SDTop', b.companyId, b.deptA);
    const midB = await hire('SDMid', b.companyId, b.deptA);
    const leafC = await hire('SDLeaf', b.companyId, b.deptA);
    await adminLine(midB.employmentId, topA.employmentId);
    await adminLine(leafC.employmentId, midB.employmentId);
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: leafC.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    const topCtx = await userCtx(topA.personId, 'manager');
    expect((await employeeDetail(topCtx, leafC.employmentId))?.name).toBe('SDLeaf'); // can see
    await expect(decideLeave(topCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow(); // cannot decide
  });

  it('10. an indirect manager who can now see the employment CANNOT read its compensation (admin-or-self)', async () => {
    const topA = await hire('CTop', b.companyId, b.deptA);
    const midB = await hire('CMid', b.companyId, b.deptA);
    const leafC = await hire('CLeaf', b.companyId, b.deptA);
    await adminLine(midB.employmentId, topA.employmentId);
    await adminLine(leafC.employmentId, midB.employmentId);
    await setCompensation(A(b), { employmentId: leafC.employmentId, basicSalary: 9000, effectiveFrom: '2024-01-01' });

    const topCtx = await userCtx(topA.personId, 'manager');
    expect((await employeeDetail(topCtx, leafC.employmentId))?.name).toBe('CLeaf'); // visibility gained
    expect(await currentCompensation(topCtx, leafC.employmentId)).toBeFalsy(); // but NOT comp (0060)
  });

  it('org chart edge query drops edges through a terminated manager and is subtree-scoped', async () => {
    const topA = await hire('OCTop', b.companyId, b.deptA);
    const midB = await hire('OCMid', b.companyId, b.deptA);
    const leafC = await hire('OCLeaf', b.companyId, b.deptA);
    await adminLine(midB.employmentId, topA.employmentId);
    await adminLine(leafC.employmentId, midB.employmentId);

    // Admin sees the full graph (2 edges).
    const adminChart = await orgChartData(A(b));
    expect(adminChart.edges.length).toBe(2);

    await terminateEmployment(A(b), { employmentId: midB.employmentId, terminationDate: '2025-01-01' });
    const afterChart = await orgChartData(A(b));
    // Both edges touched the terminated mid → both dropped (and the edges were ended on termination).
    expect(afterChart.edges.length).toBe(0);
  });

  it('11. hire-with-manager creates the admin line at hiredOn and emits reporting-line.set', async () => {
    const mgr = await hire('HWMgr', b.companyId, b.deptA);
    const newHire = await hireEmployee(A(b), {
      person: { fullName: 'NewHire', primaryEmail: `nh_${randomUUID().slice(0, 6)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-06-01',
      reportingManagerEmploymentId: mgr.employmentId,
    });
    const lines = await owner.db
      .select({ validFrom: schema.reportingLine.validFrom, lineType: schema.reportingLine.lineType })
      .from(schema.reportingLine)
      .where(sql`${schema.reportingLine.subordinateEmploymentId} = ${newHire.employmentId}`);
    expect(lines.length).toBe(1);
    expect(lines[0].lineType).toBe('administrative');
    expect(lines[0].validFrom).toBe('2025-06-01'); // valid_from = hiredOn

    const evts = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(sql`${schema.domainEvent.subjectEmploymentId} = ${newHire.employmentId}`);
    expect(evts.map((e) => e.t)).toContain('reporting-line.set');
  });
});
