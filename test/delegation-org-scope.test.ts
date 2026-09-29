/**
 * R51 (baf56348) — delegation ORG COVERAGE + same-level restriction (migration 0286). Real DB + RLS:
 *   • app.approver_level ladder (highest duty wins);
 *   • app.eligible_delegates under a NON-admin self-service session (the assertion that would false-pass on
 *     an admin connection — the whole point of the SECURITY DEFINER boundary), including the
 *     department-derived BU, terminated/self/lower-level exclusion, and the ownership guard;
 *   • the engine same-level guard (admin path + self-service path), with edit-path grandfathering;
 *   • org-scope enforcement end-to-end via requestLeave/decideLeave, the NULL-module 3-arg path, the
 *     company-only scope with NO assignment row, and the legacy NULL-scope back-compat;
 *   • head-step handover: a department_head step cleared by the head's delegate, refused out-of-scope;
 *   • the delegate-facing pending list is org-trimmed while ROW visibility stays (0230 precedent);
 *   • editDelegation round-trips the coverage.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import {
  DelegationError,
  approverLevelOf,
  editDelegation,
  endReportingLine,
  hireEmployee,
  setReportingLine,
} from '../core/org';
import { delegationsScoped, eligibleDelegates, listLeaveRequests } from '../core/read';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { requestLeave, decideLeave } from '../core/leave';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const A = (base: Base) => adminCtx(base);
const uniq = () => `${randomUUID().slice(0, 8)}@t.local`;
const TODAY = '2026-07-21';

async function hire(name: string, departmentId?: string) {
  return hireEmployee(A(b), {
    person: { fullName: name, primaryEmail: uniq() },
    companyId: b.companyId,
    departmentId: departmentId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}
async function adminLine(sub: string, mgr: string, validFrom = '2024-01-01') {
  return setReportingLine(A(b), { subordinateEmploymentId: sub, managerEmploymentId: mgr, lineType: 'administrative', validFrom });
}
async function userCtx(personId: string, role: 'employee' | 'manager'): Promise<SessionContext> {
  const uid = await createAppUser(b.tenantId, personId, role);
  return { tenantId: b.tenantId, userId: uid, roles: [role], personId };
}
async function mkBusinessUnit(code: string) {
  const [bu] = await owner.db
    .insert(schema.businessUnit)
    .values({ tenantId: b.tenantId, companyId: b.companyId, code, name: code })
    .returning({ id: schema.businessUnit.id });
  return bu.id;
}
async function mkDepartment(name: string, businessUnitId?: string) {
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: b.companyId, name, businessUnitId: businessUnitId ?? null })
    .returning({ id: schema.department.id });
  return d.id;
}
async function setDeptHead(departmentId: string, employmentId: string) {
  await owner.db.update(schema.department).set({ headEmploymentId: employmentId }).where(eq(schema.department.id, departmentId));
}
async function setBuHead(businessUnitId: string, employmentId: string) {
  await owner.db.update(schema.businessUnit).set({ headEmploymentId: employmentId }).where(eq(schema.businessUnit.id, businessUnitId));
}
/** The decide-authority probe assertCanDecide runs — NULL module/task = the scope-less legacy path. */
async function canDecide(ctx: SessionContext, subject: string, module: string | null, task: string | null) {
  return withTenant(ctx, async (tx) => {
    const res = await tx.execute(
      sql`SELECT app.can_decide_via_delegation(${subject}, ${module}, ${task}) AS ok`,
    );
    return (res as unknown as { ok: boolean }[])[0]?.ok ?? false;
  });
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

describe('app.approver_level — the ladder', () => {
  it('none → manager → department_head → business_unit_head; a multi-level person resolves to their HIGHEST', async () => {
    const leaf = await hire('Leaf');
    const mgr = await hire('Mgr');
    await adminLine(leaf.employmentId, mgr.employmentId);
    expect(await approverLevelOf(A(b), leaf.employmentId, TODAY)).toBe('none');
    expect(await approverLevelOf(A(b), mgr.employmentId, TODAY)).toBe('manager');

    // A department head who ALSO manages a team is still a department head (highest duty wins).
    const hod = await hire('Hod');
    const hodSub = await hire('HodSub');
    await adminLine(hodSub.employmentId, hod.employmentId);
    await setDeptHead(b.deptA, hod.employmentId);
    expect(await approverLevelOf(A(b), hod.employmentId, TODAY)).toBe('department_head');

    // …and a BU head who is also a department head + manager ranks business_unit_head.
    const buId = await mkBusinessUnit('BU-L');
    await setBuHead(buId, hod.employmentId);
    expect(await approverLevelOf(A(b), hod.employmentId, TODAY)).toBe('business_unit_head');
  });
});

describe('app.eligible_delegates — same-level candidates under a NON-admin session', () => {
  it('a self-service department head receives sibling heads across departments (definer boundary), with exclusions', async () => {
    const buY = await mkBusinessUnit('BU-Y');
    const deptY = await mkDepartment('Dept Y', buY);
    const h1 = await hire('HeadOne'); // head of deptA (no BU)
    const h2 = await hire('HeadTwo', deptY); // head of deptY — BU derives from department.business_unit_id
    const h3 = await hire('HeadGone'); // terminated head
    const deptZ = await mkDepartment('Dept Z');
    await setDeptHead(b.deptA, h1.employmentId);
    await setDeptHead(deptY, h2.employmentId);
    await setDeptHead(deptZ, h3.employmentId);
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-01-01' }).where(eq(schema.employment.id, h3.employmentId));
    // A LOWER-level candidate: a plain manager.
    const m = await hire('PlainMgr');
    const mSub = await hire('PlainMgrSub');
    await adminLine(mSub.employmentId, m.employmentId);

    // The load-bearing assertion: a NON-admin self-service head sees sibling heads a plain RLS query hides.
    const h1Ctx = await userCtx(h1.personId, 'manager');
    const rows = await eligibleDelegates(h1Ctx, h1.employmentId);
    const ids = rows.map((r) => r.employmentId);
    expect(ids).toContain(h2.employmentId); // same level, another department
    expect(ids).not.toContain(h1.employmentId); // never self
    expect(ids).not.toContain(h3.employmentId); // terminated
    expect(ids).not.toContain(m.employmentId); // lower level
    // BU derived from the department link (assignment.business_unit_id is NULL on these rows).
    const h2Row = rows.find((r) => r.employmentId === h2.employmentId);
    expect(h2Row?.businessUnitId).toBe(buY);
    expect(h2Row?.level).toBe('department_head');

    // Ownership guard: a stranger asking for H1's candidates gets EMPTY, an admin gets the list.
    const rogue = await hire('Rogue');
    const rogueCtx = await userCtx(rogue.personId, 'employee');
    expect(await eligibleDelegates(rogueCtx, h1.employmentId)).toEqual([]);
    const adminRows = await eligibleDelegates(A(b), h1.employmentId);
    expect(adminRows.map((r) => r.employmentId)).toContain(h2.employmentId);
  });
});

describe('engine same-level guard', () => {
  it('rejects a lower-level recipient (admin path AND self-service path); accepts an equal one', async () => {
    const h1 = await hire('GHod');
    await setDeptHead(b.deptA, h1.employmentId);
    const h2 = await hire('GHod2');
    const deptG = await mkDepartment('Dept G');
    await setDeptHead(deptG, h2.employmentId);
    const m = await hire('GMgr');
    const mSub = await hire('GMgrSub');
    await adminLine(mSub.employmentId, m.employmentId);

    // Admin path (the HR form / a crafted POST both land here).
    await expect(
      setReportingLine(A(b), {
        subordinateEmploymentId: h1.employmentId,
        managerEmploymentId: m.employmentId,
        lineType: 'delegate',
        validFrom: '2026-07-01',
        validTo: '2026-07-31',
      }),
    ).rejects.toBeInstanceOf(DelegationError);

    // Self-service path.
    const h1Ctx = await userCtx(h1.personId, 'manager');
    await expect(
      setReportingLine(h1Ctx, {
        subordinateEmploymentId: h1.employmentId,
        managerEmploymentId: m.employmentId,
        lineType: 'delegate',
        validFrom: '2026-07-01',
        validTo: '2026-07-31',
      }),
    ).rejects.toBeInstanceOf(DelegationError);

    // A same-level (department head) recipient is accepted, from across the org.
    await expect(
      setReportingLine(h1Ctx, {
        subordinateEmploymentId: h1.employmentId,
        managerEmploymentId: h2.employmentId,
        lineType: 'delegate',
        validFrom: '2026-07-01',
        validTo: '2026-07-31',
        reason: 'Annual leave',
      }),
    ).resolves.toBeTruthy();
  });

  it('edit grandfathering: a date-only edit of a legacy row whose recipient does not share the level goes through; SWAPPING to an ineligible recipient is rejected', async () => {
    const mgr = await hire('EMgr');
    const sub = await hire('ESub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const leafStand = await hire('ELeafStand'); // level none — could never be chosen today
    // A LEGACY row (pre-rule), inserted directly: manager-level delegator → level-none recipient.
    const [legacy] = await owner.db
      .insert(schema.reportingLine)
      .values({
        tenantId: b.tenantId,
        subordinateEmploymentId: mgr.employmentId,
        managerEmploymentId: leafStand.employmentId,
        lineType: 'delegate',
        validFrom: '2026-01-01',
        validTo: '2026-12-01',
      })
      .returning({ id: schema.reportingLine.id });

    // Date-only edit (recipient UNCHANGED) — must not fail the level guard.
    await expect(
      editDelegation(A(b), {
        reportingLineId: legacy.id,
        managerEmploymentId: leafStand.employmentId,
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        reason: 'Extended',
      }),
    ).resolves.toBeTruthy();

    // Swapping to ANOTHER ineligible (level-none) recipient re-runs the guard and is rejected.
    const rows = await owner.db
      .select({ id: schema.reportingLine.id })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.subordinateEmploymentId, mgr.employmentId));
    const activeId = rows[rows.length - 1].id;
    const otherLeaf = await hire('EOtherLeaf');
    await expect(
      editDelegation(A(b), {
        reportingLineId: activeId,
        managerEmploymentId: otherLeaf.employmentId,
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
      }),
    ).rejects.toBeInstanceOf(DelegationError);
  });
});

describe('org-scope enforcement', () => {
  async function scopedWorld() {
    const mgr = await hire('SMgr');
    const subA = await hire('SSubA', b.deptA);
    const subB = await hire('SSubB', b.deptB);
    await adminLine(subA.employmentId, mgr.employmentId);
    await adminLine(subB.employmentId, mgr.employmentId);
    // The stand-in + their report live in a THIRD department: same level as mgr (R51 rule) without any
    // derived department-head visibility of deptA/deptB — so every row they can act on flows through the
    // delegation route, which is exactly what the org-scope trim + backstop must gate.
    const deptS = await mkDepartment('Dept S');
    const stand = await hire('SStand', deptS);
    const standSub = await hire('SStandSub', deptS);
    await adminLine(standSub.employmentId, stand.employmentId); // same level (manager)
    return { mgr, subA, subB, stand };
  }

  it('a department-scoped delegation authorises IN-scope subjects and refuses OUT-of-scope ones, end-to-end via decideLeave', async () => {
    const { mgr, subA, subB, stand } = await scopedWorld();
    // Multi-step chain: the delegate clears the direct_manager step (advances, no ledger read/debit — a
    // delegate deliberately cannot read the subject's ledger, 0109), same shape as the Phase-1/2 suites.
    await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
      reason: 'Covering Finance only',
      orgScope: { companyId: b.companyId, businessUnitId: null, departmentId: b.deptA },
    });
    const standCtx = await userCtx(stand.personId, 'manager');

    // The NULL-module 3-arg path (what every scope-less decide caller — profile/review/offboarding — runs;
    // travel was one until b833a077 (r362) removed My Travel and its decide service).
    expect(await canDecide(standCtx, subA.employmentId, null, null)).toBe(true);
    expect(await canDecide(standCtx, subB.employmentId, null, null)).toBe(false);

    const { leaveRequestId: reqA } = await requestLeave(A(b), {
      employmentId: subA.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-03',
      endDate: '2026-08-03',
    });
    const { leaveRequestId: reqB } = await requestLeave(A(b), {
      employmentId: subB.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-04',
      endDate: '2026-08-04',
    });

    // Pending list: the delegate's to-do NEVER contains an out-of-coverage item (the org trim in
    // listLeaveRequests is the guard that keeps this true even if employment visibility is ever widened
    // for delegates — today the employment join already hides delegation-only subjects from the list).
    // ROW visibility of the request itself is unchanged (0230 authority-narrower-than-visibility): the
    // out-of-scope row stays READABLE, pinned below, while every decide refuses.
    const pending = await listLeaveRequests(standCtx);
    const pendingIds = pending.map((r) => r.id);
    expect(pendingIds).not.toContain(reqB);
    const rawVisible = await withTenant(standCtx, (tx) =>
      tx.select({ id: schema.leaveRequest.id }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, reqB)),
    );
    expect(rawVisible).toHaveLength(1);

    // …and the decide-time backstop agrees: in-scope clears the step, out-of-scope refuses.
    const res = await decideLeave(standCtx, { leaveRequestId: reqA, decision: 'approved' });
    expect(res.status).toBe('pending');
    expect((res as { advancedTo?: string }).advancedTo).toBe('hr_admin');
    await expect(decideLeave(standCtx, { leaveRequestId: reqB, decision: 'approved' })).rejects.toThrow();
  });

  it('a legacy NULL-scope row still authorises everything; a company-only scope covers a subject with NO assignment row; a BU scope does not', async () => {
    const mgr = await hire('NMgr');
    const stand = await hire('NStand');
    const standSub = await hire('NStandSub');
    await adminLine(standSub.employmentId, stand.employmentId);
    // A subject employment with NO assignment row at all (owner-inserted, no hire flow).
    const [pers] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'NoAssign', primaryEmail: uniq() })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({
        tenantId: b.tenantId,
        personId: pers.id,
        companyId: b.companyId,
        hiredOn: '2024-01-01',
      })
      .returning({ id: schema.employment.id });
    await adminLine(emp.id, mgr.employmentId);
    const standCtx = await userCtx(stand.personId, 'manager');

    // Legacy whole-scope row (all three org columns NULL) → authorises everything, assignment or not.
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: '2026-01-01', // will be inactive today — used only to prove creation-order overlap hygiene
    });
    // (that first window is already closed; create the live company-only one)
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2026-01-02',
      validTo: '2026-12-01',
      orgScope: { companyId: b.companyId, businessUnitId: null, departmentId: null },
    });
    expect(await canDecide(standCtx, emp.id, 'leave', 'leave.application')).toBe(true);

    // Swap to a BU-restricted scope: a subject with no current assignment can never match.
    const buId = await mkBusinessUnit('BU-N');
    const rows = await owner.db
      .select({ id: schema.reportingLine.id, validFrom: schema.reportingLine.validFrom })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.subordinateEmploymentId, mgr.employmentId));
    const live = rows.find((r) => r.validFrom === '2026-01-02')!;
    await endReportingLine(A(b), { reportingLineId: live.id, endDate: '2026-07-01' });
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2026-07-02',
      validTo: '2026-12-01',
      orgScope: { companyId: b.companyId, businessUnitId: buId, departmentId: null },
    });
    expect(await canDecide(standCtx, emp.id, 'leave', 'leave.application')).toBe(false);

    // And a plain legacy NULL-scope active row (no org columns) authorises again.
    const rows2 = await owner.db
      .select({ id: schema.reportingLine.id, validFrom: schema.reportingLine.validFrom })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.subordinateEmploymentId, mgr.employmentId));
    const live2 = rows2.find((r) => r.validFrom === '2026-07-02')!;
    await endReportingLine(A(b), { reportingLineId: live2.id, endDate: '2026-07-10' });
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2026-07-11',
      validTo: null,
    });
    expect(await canDecide(standCtx, emp.id, 'attendance', 'attendance.correction')).toBe(true);
  });

  it('a subject whose BU comes only from department.business_unit_id matches a BU scope (COALESCE derivation)', async () => {
    const buId = await mkBusinessUnit('BU-C');
    const deptC = await mkDepartment('Dept C', buId);
    const mgr = await hire('CMgr');
    const sub = await hire('CSub', deptC); // assignment.business_unit_id NULL; department carries the BU
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('CStand');
    const standSub = await hire('CStandSub');
    await adminLine(standSub.employmentId, stand.employmentId);
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
      orgScope: { companyId: b.companyId, businessUnitId: buId, departmentId: null },
    });
    const standCtx = await userCtx(stand.personId, 'manager');
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.application')).toBe(true);
  });
});

describe('head-step handover', () => {
  it('a department_head step is cleared by the head\'s delegate when in scope, refused out-of-scope and for a non-delegate', async () => {
    const deptH = await mkDepartment('Dept H');
    const deptY = await mkDepartment('Dept Y2');
    const h1 = await hire('HHod', deptH);
    const h2 = await hire('HHod2', deptY);
    const h3 = await hire('HHod3', deptY);
    await setDeptHead(deptH, h1.employmentId);
    await setDeptHead(deptY, h2.employmentId);
    const deptZ = await mkDepartment('Dept Z2');
    await setDeptHead(deptZ, h3.employmentId);
    const sub = await hire('HSub', deptH);
    await adminLine(sub.employmentId, h1.employmentId); // the head is also the admin manager (visibility route)

    await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, levels: ['department_head', 'hr_admin'] });

    // OUT-of-scope first: the delegation covers dept B, the subject sits in dept H → refused.
    const { reportingLineId: outScoped } = await setReportingLine(A(b), {
      subordinateEmploymentId: h1.employmentId,
      managerEmploymentId: h2.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: '2026-08-01',
      orgScope: { companyId: b.companyId, businessUnitId: null, departmentId: b.deptB },
    });
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-05',
      endDate: '2026-08-05',
    });
    const h2Ctx = await userCtx(h2.personId, 'manager');
    await expect(decideLeave(h2Ctx, { leaveRequestId, decision: 'approved' })).rejects.toThrow();

    // In scope (the head's own department): the delegate CLEARS the head step — real transferred authority.
    await endReportingLine(A(b), { reportingLineId: outScoped, endDate: '2026-01-01' });
    await setReportingLine(A(b), {
      subordinateEmploymentId: h1.employmentId,
      managerEmploymentId: h2.employmentId,
      lineType: 'delegate',
      validFrom: '2026-01-02',
      validTo: null,
      orgScope: { companyId: b.companyId, businessUnitId: null, departmentId: deptH },
    });
    const res = await decideLeave(h2Ctx, { leaveRequestId, decision: 'approved' });
    expect(res.status).toBe('pending');
    expect((res as { advancedTo?: string }).advancedTo).toBe('hr_admin');

    // A same-level NON-delegate head cannot clear it.
    const { leaveRequestId: lr2 } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-06',
      endDate: '2026-08-06',
    });
    const h3Ctx = await userCtx(h3.personId, 'manager');
    await expect(decideLeave(h3Ctx, { leaveRequestId: lr2, decision: 'approved' })).rejects.toThrow();
  });
});

describe('editDelegation round-trips the org scope', () => {
  it('create → edit persists the new coverage columns and delegationsScoped returns them', async () => {
    const mgr = await hire('RMgr');
    const mgrSub = await hire('RMgrSub');
    await adminLine(mgrSub.employmentId, mgr.employmentId);
    const stand = await hire('RStand');
    const standSub = await hire('RStandSub');
    await adminLine(standSub.employmentId, stand.employmentId);
    const { reportingLineId } = await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2026-07-01',
      validTo: '2026-07-31',
      reason: 'Initial',
      orgScope: { companyId: b.companyId, businessUnitId: null, departmentId: b.deptA },
    });
    const [created] = await owner.db
      .select({
        companyId: schema.reportingLine.scopeCompanyId,
        buId: schema.reportingLine.scopeBusinessUnitId,
        deptId: schema.reportingLine.scopeDepartmentId,
      })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.id, reportingLineId));
    expect(created).toEqual({ companyId: b.companyId, buId: null, deptId: b.deptA });

    const { reportingLineId: newId } = await editDelegation(A(b), {
      reportingLineId,
      managerEmploymentId: stand.employmentId,
      validFrom: '2026-07-01',
      validTo: '2026-08-31',
      reason: 'Extended',
      orgScope: { companyId: b.companyId, businessUnitId: null, departmentId: b.deptB },
    });
    const [edited] = await owner.db
      .select({
        companyId: schema.reportingLine.scopeCompanyId,
        buId: schema.reportingLine.scopeBusinessUnitId,
        deptId: schema.reportingLine.scopeDepartmentId,
      })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.id, newId));
    expect(edited).toEqual({ companyId: b.companyId, buId: null, deptId: b.deptB });

    // The read used by the HR edit-form defaults carries ids + names.
    const rows = await delegationsScoped(A(b), { isAdmin: true, history: false, asOf: TODAY });
    const row = rows.find((r) => r.id === newId)!;
    expect(row.orgScope.companyId).toBe(b.companyId);
    expect(row.orgScope.departmentId).toBe(b.deptB);
    expect(row.orgScope.departmentName).toBe('Operations');

    // Parent-chain validation: a department under a mismatching BU is rejected.
    const buX = await mkBusinessUnit('BU-X');
    await expect(
      editDelegation(A(b), {
        reportingLineId: newId,
        managerEmploymentId: stand.employmentId,
        validFrom: '2026-07-01',
        validTo: '2026-08-31',
        orgScope: { companyId: b.companyId, businessUnitId: buX, departmentId: b.deptB },
      }),
    ).resolves.toBeTruthy(); // deptB has NO BU link — usable under every BU (hire-form precedent)
  });
});
