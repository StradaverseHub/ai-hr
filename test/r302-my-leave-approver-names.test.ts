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
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { adminCancelLeave, cancelOwnLeave, decideLeave, decideLeaveCancellation, requestLeave, requestLeaveCancellation } from '../core/leave';
import { listLeaveRequestsPage } from '../core/read';
import { ownLeaveApprovalTrails, ownLeaveCancellations, ownLeaveRejectionReasons } from '../core/my-leave';
import { pendingApprovalLine } from '../lib/my-leave-history';
import { and, eq, sql } from 'drizzle-orm';
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
const WED = addDays(MON, 2);
const FRI = addDays(MON, 4);

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

// ── The read this item adds: migration 0472's two SECURITY DEFINER functions ─────────────────────────────────

type World = Awaited<ReturnType<typeof world>>;
/** An employee with a manager, a manager's manager, a department head, a same-company colleague and HR. */
async function world(levels: string[]) {
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels });
  const emp = await person('Nadia Employee', 'employee');
  const mgr = await person('Marcus Manager', 'manager');
  const boss = await person('Bella Boss', 'manager');
  const head = await person('Dora Head', 'manager');
  const colleague = await person('Colin Colleague', 'employee');
  const hr = await person('Hana HR', 'hr_admin');
  const line = (sub: string, man: string) =>
    setReportingLine(adminCtx(b), { subordinateEmploymentId: sub, managerEmploymentId: man, lineType: 'administrative', validFrom: '2024-01-01' });
  await line(emp.employmentId, mgr.employmentId);
  await line(colleague.employmentId, mgr.employmentId);
  await line(mgr.employmentId, boss.employmentId);
  await owner.db.update(schema.department).set({ headEmploymentId: head.employmentId }).where(eq(schema.department.id, b.deptA));
  for (const who of [emp, colleague]) {
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: who.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '30.00',
      effectiveOn: TODAY,
    });
  }
  const apply = (who: { ctx: SessionContext; employmentId: string }, start = MON, end = MON) =>
    requestLeave(who.ctx, { employmentId: who.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: start, endDate: end, today: TODAY }).then(
      (r) => r.leaveRequestId,
    );
  return { emp, mgr, boss, head, colleague, hr, apply };
}

describe('0472 · the OWNER reads the names of the people who decide their request', () => {
  it('each level names who it is routed to while pending, and who decided it once decided', async () => {
    const w: World = await world(['direct_manager', 'manager_manager', 'department_head', 'hr_admin']);
    const id = await w.apply(w.emp);
    let trail = (await ownLeaveApprovalTrails(w.emp.ctx, [id])).get(id)!;
    expect(trail.status).toBe('pending');
    expect(trail.steps.map((s) => [s.stepIndex, s.kind, s.approverName, s.status])).toEqual([
      [0, 'direct_manager', 'Marcus Manager', 'pending'],
      [1, 'manager_manager', 'Bella Boss', 'pending'],
      [2, 'department_head', 'Dora Head', 'pending'],
      // A role resolves to a SET of people and is never named — the screen prints the kind's label.
      [3, 'hr_admin', null, 'pending'],
    ]);
    expect(pendingApprovalLine(trail)).toEqual({ level: 1, of: 4, kind: 'direct_manager', names: ['Marcus Manager'] });

    await decideLeave(w.mgr.ctx, { leaveRequestId: id, decision: 'approved', deciderEmploymentId: w.mgr.employmentId });
    trail = (await ownLeaveApprovalTrails(w.emp.ctx, [id])).get(id)!;
    const [l1, l2] = trail.steps;
    expect(l1.status).toBe('approved');
    expect(l1.decidedByName).toBe('Marcus Manager');
    expect(l1.decidedAt).toBeInstanceOf(Date);
    // A decided level no longer carries a routed-to name — only who decided it.
    expect(l1.approverName).toBeNull();
    expect(l2.approverName).toBe('Bella Boss');
    expect(pendingApprovalLine(trail)).toEqual({ level: 2, of: 4, kind: 'manager_manager', names: ['Bella Boss'] });
  });

  it('a named approver and any-one alternates are named; a single-level request names the direct manager', async () => {
    const w = await world(['direct_manager', 'hr_admin']);
    const id = await w.apply(w.emp);
    await owner.db
      .update(schema.leaveApprovalStep)
      .set({
        approverKind: 'specific_employee',
        approverEmploymentId: w.head.employmentId,
        approverAlternates: [{ kind: 'specific_employee', employmentId: w.boss.employmentId }, 'hr_admin'],
      })
      .where(and(eq(schema.leaveApprovalStep.leaveRequestId, id), eq(schema.leaveApprovalStep.stepIndex, 0)));
    const step0 = (await ownLeaveApprovalTrails(w.emp.ctx, [id])).get(id)!.steps[0];
    expect(step0).toMatchObject({ kind: 'specific_employee', approverName: 'Dora Head', alternateNames: ['Bella Boss'] });

    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
    const single = await w.apply(w.emp, addDays(MON, 7), addDays(MON, 7));
    const t = (await ownLeaveApprovalTrails(w.emp.ctx, [single])).get(single)!;
    expect(t.steps).toEqual([]);
    expect(t.singleLevelApproverName).toBe('Marcus Manager');
    expect(pendingApprovalLine(t)).toEqual({ level: 1, of: 1, kind: 'direct_manager', names: ['Marcus Manager'] });
  });

  it('REFUSES — returns nothing for — a colleague’s request, the manager, HR, and an id from another tenant', async () => {
    const w = await world(['direct_manager', 'hr_admin']);
    const mine = await w.apply(w.emp);
    const theirs = await w.apply(w.colleague);
    // The owner gets their own and NOT the same-company colleague's, even asked for both at once.
    const own = await ownLeaveApprovalTrails(w.emp.ctx, [mine, theirs]);
    expect([...own.keys()]).toEqual([mine]);
    // The colleague cannot read mine.
    expect((await ownLeaveApprovalTrails(w.colleague.ctx, [mine])).size).toBe(0);
    // Not an approver path: the manager and HR get nothing from this function (no admin branch)…
    expect((await ownLeaveApprovalTrails(w.mgr.ctx, [mine])).size).toBe(0);
    expect((await ownLeaveApprovalTrails(w.hr.ctx, [mine])).size).toBe(0);
    // …and the manager's EXISTING view is unchanged: the shared projection still names the approver to them.
    const mgrRow = (await listLeaveRequestsPage(w.mgr.ctx, { employmentIds: [w.emp.employmentId], limit: 10, offset: 0 })).rows.find((r) => r.id === mine);
    expect(mgrRow!.currentApproverName).toBe('Marcus Manager');
    // …while the employee's shared projection is ALSO unchanged (still null): person RLS was not widened.
    const empRow = (await listLeaveRequestsPage(w.emp.ctx, { employmentIds: [w.emp.employmentId], limit: 10, offset: 0 })).rows.find((r) => r.id === mine);
    expect(empRow!.currentApproverName).toBeNull();

    // Another tenant: its own employee, request and manager. Its id asked from THIS tenant's owner session → nothing.
    const bA = b;
    b = await seedBase();
    const other = await world(['direct_manager', 'hr_admin']);
    const foreign = await other.apply(other.emp);
    expect((await ownLeaveApprovalTrails(other.emp.ctx, [foreign])).size, 'sanity: its owner reads it').toBe(1);
    b = bA;
    expect((await ownLeaveApprovalTrails(w.emp.ctx, [foreign])).size).toBe(0);
    expect((await ownLeaveCancellations(w.emp.ctx, [foreign])).size).toBe(0);
    // A session whose tenant GUC does not match the user (a forged context) reads nothing either.
    expect((await ownLeaveApprovalTrails({ ...w.emp.ctx, tenantId: other.emp.ctx.tenantId }, [foreign])).size).toBe(0);
  });

  it('carries NO other person column — the result set is exactly names, kinds, statuses and times', async () => {
    const cols = async (fn: string) =>
      (
        await owner.db.execute(sql`
          SELECT unnest(p.proargnames) AS name, unnest(p.proargmodes) AS mode
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = ${fn}`)
      )
        .filter((r) => (r as { mode: string }).mode === 't')
        .map((r) => (r as { name: string }).name);
    expect(await cols('own_leave_request_approvals')).toEqual([
      'leave_request_id',
      'step_index',
      'approver_kind',
      'approver_name',
      'alternate_names',
      'status',
      'decided_by_name',
      'decided_at',
    ]);
    expect(await cols('own_leave_request_cancellations')).toEqual([
      'leave_request_id',
      'cancelled_at',
      'cancelled_by_name',
      'cancelled_automatically',
      'requested_at',
      'reason',
    ]);
    // SECURITY DEFINER with a pinned search_path, and not executable by PUBLIC.
    const meta = await owner.db.execute(sql`
      SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('ai_hr_app', p.oid, 'EXECUTE') AS app_exec,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname IN ('own_leave_request_approvals', 'own_leave_request_cancellations')
      ORDER BY p.proname`);
    expect(meta.map((m) => ({ ...(m as Record<string, unknown>) }))).toEqual([
      { proname: 'own_leave_request_approvals', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], app_exec: true, public_exec: false },
      { proname: 'own_leave_request_cancellations', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], app_exec: true, public_exec: false },
    ]);
  });
});

describe('the View panel’s rejection reason and cancellation detail', () => {
  it('a rejection shows its reason — to the owner, and to nobody else', async () => {
    const w = await world(['direct_manager', 'hr_admin']);
    const id = await w.apply(w.emp);
    await decideLeave(w.mgr.ctx, { leaveRequestId: id, decision: 'rejected', deciderEmploymentId: w.mgr.employmentId, rejectReason: 'Year-end close' });
    expect((await ownLeaveRejectionReasons(w.emp.ctx, [id])).get(id)).toBe('Year-end close');
    expect((await ownLeaveRejectionReasons(w.colleague.ctx, [id])).size).toBe(0);
    const trail = (await ownLeaveApprovalTrails(w.emp.ctx, [id])).get(id)!;
    expect(trail).toMatchObject({ status: 'rejected', decidedByName: 'Marcus Manager' });
    expect(trail.steps[0]).toMatchObject({ status: 'rejected', decidedByName: 'Marcus Manager' });
    expect(pendingApprovalLine(trail)).toBeNull();
  });

  it('withdrawn by the employee: their own name and when', async () => {
    const w = await world(['direct_manager', 'hr_admin']);
    const id = await w.apply(w.emp);
    await cancelOwnLeave(w.emp.ctx, { leaveRequestId: id });
    const c = (await ownLeaveCancellations(w.emp.ctx, [id])).get(id)!;
    expect(c).toMatchObject({ cancelledByName: 'Nadia Employee', automatic: false, reason: null });
    expect(c.cancelledAt).toBeInstanceOf(Date);
  });

  it('cancelled by HR on the employee’s behalf: HR’s name, and NEVER HR’s free-text reason (an internal note)', async () => {
    const w = await world(['direct_manager']);
    const id = await w.apply(w.emp);
    await adminCancelLeave(w.hr.ctx, { leaveRequestId: id, reason: 'Duplicate application', cancelledByEmploymentId: w.hr.employmentId });
    expect((await ownLeaveCancellations(w.emp.ctx, [id])).get(id)).toMatchObject({ cancelledByName: 'Hana HR', reason: null });
    expect((await ownLeaveCancellations(w.colleague.ctx, [id])).size).toBe(0);
    expect((await ownLeaveCancellations(w.mgr.ctx, [id])).size).toBe(0);
  });

  it('approved leave cancelled through Cancel Approved Leave: the approver who approved it, when asked, and why', async () => {
    const w = await world(['direct_manager', 'hr_admin']);
    const id = await w.apply(w.emp, MON, FRI);
    await decideLeave(w.mgr.ctx, { leaveRequestId: id, decision: 'approved', deciderEmploymentId: w.mgr.employmentId });
    await decideLeave(w.hr.ctx, { leaveRequestId: id, decision: 'approved', deciderEmploymentId: w.hr.employmentId });
    const { cancellationRequestId } = await requestLeaveCancellation(w.emp.ctx, { leaveRequestId: id, cancelDates: [WED], reason: 'Trip moved', today: TODAY });
    await decideLeaveCancellation(w.mgr.ctx, { cancellationRequestId, decision: 'approved', deciderEmploymentId: w.mgr.employmentId });
    await decideLeaveCancellation(w.hr.ctx, { cancellationRequestId, decision: 'approved', deciderEmploymentId: w.hr.employmentId });
    const [cancelledRow] = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(and(eq(schema.leaveRequest.employmentId, w.emp.employmentId), eq(schema.leaveRequest.status, 'cancelled')));
    const c = (await ownLeaveCancellations(w.emp.ctx, [cancelledRow.id])).get(cancelledRow.id)!;
    expect(c).toMatchObject({ cancelledByName: 'Hana HR', automatic: false, reason: 'Trip moved' });
    expect(c.requestedAt).toBeInstanceOf(Date);
    expect(c.cancelledAt).toBeInstanceOf(Date);
    // A request that is not cancelled has no cancellation row at all.
    expect((await ownLeaveCancellations(w.emp.ctx, [id])).has(id)).toBe(id === cancelledRow.id);
  });
});

describe('SECURITY DEFINER search_path — a caller cannot shadow a table the ownership check reads', () => {
  it('a TEMP app_user table naming a colleague’s person does not reveal that colleague’s approver', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const attacker = await person('Adam Attacker', 'employee');
    const victim = await person('Vera Victim', 'employee');
    const mgr = await person('Secret Manager Name', 'manager');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: victim.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
    await owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: victim.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '30.00', effectiveOn: TODAY });
    const { leaveRequestId: victimReq } = await requestLeave(victim.ctx, { employmentId: victim.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: MON, today: TODAY });
    // Non-vacuous: the owner is told the name.
    const own = await withTenant(victim.ctx, (tx) => tx.execute(sql`SELECT approver_name FROM app.own_leave_request_approvals(${`{${victimReq}}`}::uuid[])`));
    expect((own as unknown as { approver_name: string | null }[]).map((r) => r.approver_name)).toContain('Secret Manager Name');
    const shadowed = await withTenant(attacker.ctx, async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE app_user (id uuid, tenant_id uuid, person_id uuid) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO pg_temp.app_user VALUES (${attacker.ctx.userId}::uuid, ${b.tenantId}::uuid, ${victim.personId}::uuid)`);
      return tx.execute(sql`SELECT approver_name FROM app.own_leave_request_approvals(${`{${victimReq}}`}::uuid[])`);
    });
    expect(shadowed as unknown as unknown[]).toEqual([]);
  });
});
