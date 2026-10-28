/**
 * M08 — the v2 task list, task detail, decision and document routes, through the REAL route handlers, core, the
 * canonical deciders and RLS. Only bearer session resolution is injected (as test/mobile-v2-leave.test.ts does).
 *
 * Pinned: admission agrees with the canonical owner (isCurrentAssignedApproval) and refuses self-approval even for
 * super_admin (D4); a manager change, an expired delegation and a reassigned attendance stage each end admission;
 * another tenant's, another company's and a guessed id all read `not_assigned`; a decided item reads
 * `already_decided`; a missing rejection reason is `reason_required` and records nothing; a replay after commit
 * returns the first answer and a different decision under it is `request_conflict`; a moved leave step and a moved
 * attendance stage are `stale_step`; a per-date partial decision and a cancellation decision go through their
 * deciders; team cover is the caller's own team, never the subject, and carries no reason.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { endReportingLine, hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { decideLeave, requestLeave, requestLeaveCancellation } from '../packs/leave/service';
import {
  checkIn, checkOut, decideAttendanceCorrection, reassignAttendanceWorkflowStageToHr, requestAttendanceCorrection,
  saveAttendanceWorkflow, setAttendanceWorkflowEnabled,
} from '../packs/attendance/service';
import type { AttendanceWorkflowInput } from '../lib/attendance-workflow';
import { isCurrentAssignedApproval } from '../core/assigned-approval-focus';
import { listPendingTasks } from '../core/approvals-inbox';
import { isModuleEnabled } from '../core/entitlements';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const list = await import('../app/api/mobile/v2/tasks/route');
const one = await import('../app/api/mobile/v2/tasks/[kind]/[id]/route');
const decision = await import('../app/api/mobile/v2/tasks/[kind]/[id]/decision/route');
const document = await import('../app/api/mobile/v2/tasks/[kind]/[id]/document/route');

type Role = 'employee' | 'manager' | 'hr_admin' | 'super_admin';
type Kind = 'leave' | 'leaveCancellation' | 'attendance';
let base: Base;
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// The nearest Monday at least 8 days out (the future-leave-year exposure test/mobile-v2-leave.test.ts names applies).
const MON = (() => { let d = addDays(TODAY, 8); while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1); return d; })();
const week = (n: number) => ({ start: addDays(MON, 7 * n), end: addDays(MON, 7 * n + 4) });
// A recent Wednesday for attendance (derived from the clock, as test/attendance-workflow-hierarchy.test.ts does).
const PREVIOUS = addDays(TODAY, -7);
const WORKED = addDays(PREVIOUS, 3 - new Date(`${PREVIOUS}T00:00:00Z`).getUTCDay());
const URL0 = 'https://hr.example.com/api/mobile/v2/tasks';

async function hire(name: string, role: Role = 'employee', b: Base = base, departmentId = b.deptA, companyId = b.companyId) {
  const e = await hireEmployee(adminCtx(b), { person: { fullName: name, primaryEmail: randomUUID() + '@m08.test' }, companyId, departmentId, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(b.tenantId, e.personId, role);
  const ctx: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: [role], grants: [{ role, companyId }], entitlements: harnessSnapshot(b.tenantId) };
  return { ...e, ctx };
}
type Person = Awaited<ReturnType<typeof hire>>;
const fund = (employmentId: string, b: Base = base) =>
  owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '60.00', effectiveOn: TODAY });
const line = (sub: string, mgr: string, validFrom = '2024-01-01') =>
  setReportingLine(adminCtx(base), { subordinateEmploymentId: sub, managerEmploymentId: mgr, lineType: 'administrative', validFrom });
const modules = (ctx: SessionContext) => ({ attendance: isModuleEnabled(ctx, 'attendance'), claims: isModuleEnabled(ctx, 'claims'), performance: isModuleEnabled(ctx, 'performance'), rewards: isModuleEnabled(ctx, 'rewards') });
const assigned = (who: Person, kind: Kind, id: string) => isCurrentAssignedApproval(who.ctx, { kind, id }, modules(who.ctx));

const get = async (path: string) => {
  const r = await (path === '' || path.startsWith('?') ? list.GET : one.GET)(new Request(URL0 + path));
  return { status: r.status, body: await r.json() };
};
const detail = async (who: Person, kind: Kind, id: string) => { caller = who.ctx; return get(`/${kind}/${id}`); };
const post = async (who: Person, kind: Kind, id: string, body: Record<string, unknown>) => {
  caller = who.ctx;
  const r = await decision.POST(new Request(`${URL0}/${kind}/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
/** Decide as the detail last showed it: its `expected`, a fresh requestId unless one is given. */
const decide = async (who: Person, kind: Kind, id: string, extra: Record<string, unknown> = {}) => {
  const seen = await detail(who, kind, id);
  expect(seen.body.outcome, 'the caller is admitted before deciding').toBe('found');
  return post(who, kind, id, { requestId: randomUUID(), decision: 'approve', expected: seen.body.task.expected, ...extra });
};
const leaveStatus = async (id: string) => (await owner.db.select({ s: schema.leaveRequest.status }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id)))[0]?.s;
const receipts = () => owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'mobile.command.recorded'));

let employee: Person, colleague: Person, manager: Person, hr: Person;
const apply = (who: Person, n: number, reason?: string, leaveTypeId = base.annualLeaveTypeId) =>
  requestLeave(who.ctx, { employmentId: who.employmentId, leaveTypeId, startDate: week(n).start, endDate: week(n).end, today: TODAY, ...(reason ? { reason } : {}) }).then((r) => r.leaveRequestId);
async function approveThroughKernel(id: string) {
  while ((await leaveStatus(id)) === 'pending') {
    const [step] = await owner.db.select({ i: schema.leaveApprovalStep.stepIndex }).from(schema.leaveApprovalStep).where(and(eq(schema.leaveApprovalStep.leaveRequestId, id), eq(schema.leaveApprovalStep.status, 'pending'))).orderBy(schema.leaveApprovalStep.stepIndex).limit(1);
    await decideLeave(step?.i === 1 ? hr.ctx : manager.ctx, { leaveRequestId: id, decision: 'approved', deciderEmploymentId: step?.i === 1 ? hr.employmentId : manager.employmentId });
  }
}

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); blocked = false;
  await setLeaveApprovalPolicy(adminCtx(base), { companyId: base.companyId, levels: ['direct_manager', 'hr_admin'] as never });
  employee = await hire('Aisyah Employee'); colleague = await hire('Badrul Colleague');
  manager = await hire('Marcus Manager', 'manager'); hr = await hire('Hana HR', 'hr_admin');
  await line(employee.employmentId, manager.employmentId); await line(colleague.employmentId, manager.employmentId);
  for (const p of [employee, colleague, manager, hr]) await fund(p.employmentId);
});

describe('the task list', () => {
  it('pages the canonical inbox in its own order, neither repeating nor skipping, and marks native kinds', async () => {
    const ids = [await apply(employee, 0), await apply(employee, 1), await apply(colleague, 2)];
    caller = manager.ctx;
    const seen: { id: string; kind: string; nativeDecision: boolean; webPath: string | null }[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const page = await get('?limit=2' + (cursor ? '&cursor=' + cursor : ''));
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items);
      cursor = page.body.nextCursor; pages++;
    } while (cursor && pages < 10);
    const canonical = await listPendingTasks(manager.ctx, undefined, modules(manager.ctx));
    expect(seen.map((t) => `${t.kind}:${t.id}`)).toEqual(canonical.map((t) => `${t.kind}:${t.id}`));
    expect(seen.filter((t) => t.kind === 'leave').map((t) => t.id).sort()).toEqual([...ids].sort());
    expect(seen.filter((t) => t.kind === 'leave').every((t) => t.nativeDecision && t.webPath === null)).toBe(true);
    // D12 (M11) added claims to the natively decided kinds; every other kind still carries its web path.
    expect(seen.every((t) => t.nativeDecision === ['leave', 'leaveCancellation', 'attendance', 'claim'].includes(t.kind) && (t.nativeDecision === (t.webPath === null)))).toBe(true);
    expect((await get('?cursor=garbage!')).status).toBe(400);
    caller = employee.ctx;
    expect((await get('')).body.items.map((t: { id: string }) => t.id), 'an own request is never a task').not.toContain(ids[0]);
    blocked = true;
    expect((await get('')).status).toBe(401);
  });
});

describe('admission', () => {
  it('refuses self-approval for an employee and for a super_admin, whom the kernel would let decide', async () => {
    const own = await apply(employee, 0);
    expect(await detail(employee, 'leave', own)).toEqual({ status: 200, body: { outcome: 'refused', code: 'self_approval' } });
    expect((await post(employee, 'leave', own, { requestId: randomUUID(), decision: 'approve', expected: { stepIndex: 0 } })).body).toEqual({ outcome: 'refused', code: 'self_approval' });
    const boss = await hire('Sofia Super', 'super_admin'); await fund(boss.employmentId);
    const theirs = await apply(boss, 1);
    expect(await assigned(boss, 'leave', theirs), 'the owner does not list it').toBe(false);
    expect((await detail(boss, 'leave', theirs)).body).toEqual({ outcome: 'refused', code: 'self_approval' });
    expect((await post(boss, 'leave', theirs, { requestId: randomUUID(), decision: 'approve', expected: { stepIndex: 0 } })).body).toEqual({ outcome: 'refused', code: 'self_approval' });
    expect(await leaveStatus(own)).toBe('pending'); expect(await leaveStatus(theirs)).toBe('pending');
    expect(await receipts()).toEqual([]);
  });

  it('another tenant’s, another company’s and a guessed id all read not_assigned; a malformed reference is a 400', async () => {
    const other = await seedBase();
    const foreigner = await hire('Farah Foreign', 'employee', other); await fund(foreigner.employmentId, other);
    const foreign = await apply(foreigner, 0, undefined, other.annualLeaveTypeId);
    expect(await leaveStatus(foreign)).toBe('pending');
    for (const who of [manager, hr]) {
      expect((await detail(who, 'leave', foreign)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
      expect((await post(who, 'leave', foreign, { requestId: randomUUID(), decision: 'approve', expected: { stepIndex: 0 } })).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    }
    const [company] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Second Sdn Bhd' }).returning({ id: schema.company.id });
    const [dept] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: company.id, name: 'Logistics' }).returning({ id: schema.department.id });
    const outsider = await hire('Omar Outside', 'employee', base, dept.id, company.id); await fund(outsider.employmentId);
    const elsewhere = await apply(outsider, 0);
    expect(await leaveStatus(elsewhere)).toBe('pending');
    expect((await detail(manager, 'leave', elsewhere)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    const guessed = randomUUID();
    for (const kind of ['leave', 'leaveCancellation', 'attendance'] as const) expect((await detail(manager, kind, guessed)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect((await post(manager, 'leave', guessed, { requestId: randomUUID(), decision: 'approve', expected: { stepIndex: 0 } })).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    caller = manager.ctx;
    // D12: a claim is a native kind now, so a guessed claim id is `not_assigned`; a kind the app never decides is a 400.
    expect((await get(`/claim/${guessed}`)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect((await get(`/profile/${guessed}`)).status).toBe(400);
    expect((await get('/leave/not-a-uuid')).status).toBe(400);
    const mine = await apply(employee, 1);
    expect((await post(manager, 'leave', mine, { requestId: randomUUID(), decision: 'approve', expected: { stageIndex: 0, participantSlot: null } })).status, 'expected state of another kind').toBe(400);
    expect((await post(manager, 'leave', mine, { requestId: randomUUID(), decision: 'reject', reason: 'x', dates: [week(1).start], expected: { stepIndex: 0 } })).status, 'dates on a rejection').toBe(400);
    expect(await receipts()).toEqual([]);
  });

  it('a manager change ends the old manager’s admission and opens the new one’s', async () => {
    const id = await apply(employee, 0);
    expect((await detail(manager, 'leave', id)).body.outcome).toBe('found');
    const successor = await hire('Siti Successor', 'manager');
    await line(employee.employmentId, successor.employmentId, addDays(TODAY, -1));
    await expect(decideLeave(manager.ctx, { leaveRequestId: id, decision: 'approved' }), 'the kernel refuses the old manager too').rejects.toThrow();
    expect((await detail(manager, 'leave', id)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect((await post(manager, 'leave', id, { requestId: randomUUID(), decision: 'approve', expected: { stepIndex: 0 } })).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect((await detail(successor, 'leave', id)).body.outcome).toBe(await assigned(successor, 'leave', id) ? 'found' : 'refused');
    expect(await leaveStatus(id)).toBe('pending');
  });

  it('an expired delegation ends the stand-in’s admission (decided at request time, as the kernel does)', async () => {
    const stand = await hire('Tan Stand-in', 'manager'), standReport = await hire('Uma Report');
    await line(standReport.employmentId, stand.employmentId); // R51: the stand-in holds the delegator's level
    const { reportingLineId } = await setReportingLine(adminCtx(base), { subordinateEmploymentId: manager.employmentId, managerEmploymentId: stand.employmentId, lineType: 'delegate', validFrom: '2024-01-01', validTo: null });
    const id = await apply(employee, 0);
    // While active, mobile admission says exactly what the canonical owner says.
    expect((await detail(stand, 'leave', id)).body.outcome).toBe(await assigned(stand, 'leave', id) ? 'found' : 'refused');
    await endReportingLine(adminCtx(base), { reportingLineId, endDate: addDays(TODAY, -2) });
    expect(await assigned(stand, 'leave', id)).toBe(false);
    await expect(decideLeave(stand.ctx, { leaveRequestId: id, decision: 'approved' })).rejects.toThrow();
    expect((await detail(stand, 'leave', id)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect((await post(stand, 'leave', id, { requestId: randomUUID(), decision: 'approve', expected: { stepIndex: 0 } })).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect(await leaveStatus(id)).toBe('pending');
    expect(await receipts()).toEqual([]);
  });
});

describe('leave decisions', () => {
  it('detail facts, replay after commit, request_conflict, then already_decided once the chain completes', async () => {
    const id = await apply(employee, 0, 'Family trip');
    const seen = await detail(manager, 'leave', id);
    expect(seen.body).toMatchObject({ outcome: 'found', task: {
      kind: 'leave', id, subject: { name: 'Aisyah Employee' }, leaveType: 'Annual Leave', startDate: week(0).start, endDate: week(0).end,
      durationType: 'full_day', employeeReason: 'Family trip', hasDocument: false, reasonRequiredToReject: true, expected: { stepIndex: 0 },
    } });
    const requestId = randomUUID(), body = { requestId, decision: 'approve', expected: seen.body.task.expected };
    const first = await post(manager, 'leave', id, body);
    expect(first).toEqual({ status: 200, body: { outcome: 'accepted', status: 'pending_next_step' } });
    // The answer was lost; the same requestId replays it although the item has left the manager's list.
    expect(await assigned(manager, 'leave', id)).toBe(false);
    expect((await post(manager, 'leave', id, body)).body).toEqual(first.body);
    expect((await post(manager, 'leave', id, { ...body, decision: 'reject', reason: 'Changed my mind' })).body).toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect(await receipts()).toHaveLength(1);
    expect((await detail(manager, 'leave', id)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect((await decide(hr, 'leave', id)).body).toEqual({ outcome: 'accepted', status: 'approved' });
    expect(await leaveStatus(id)).toBe('approved');
    expect((await detail(hr, 'leave', id)).body).toEqual({ outcome: 'refused', code: 'already_decided' });
    expect((await post(hr, 'leave', id, { requestId: randomUUID(), decision: 'approve', expected: { stepIndex: 1 } })).body).toEqual({ outcome: 'refused', code: 'already_decided' });
    // Every receipt's subject is the deciding actor's own employment, never the employee's.
    const subjects = await owner.db.select({ s: schema.domainEvent.subjectEmploymentId }).from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'mobile.command.recorded')).orderBy(asc(schema.domainEvent.sequence));
    expect(subjects.map((r) => r.s)).toEqual([manager.employmentId, hr.employmentId]);
  });

  it('a rejection without a reason is reason_required and records nothing; with one, it rejects', async () => {
    const id = await apply(employee, 0);
    const seen = await detail(manager, 'leave', id);
    for (const reason of [undefined, '   ']) {
      expect((await post(manager, 'leave', id, { requestId: randomUUID(), decision: 'reject', ...(reason === undefined ? {} : { reason }), expected: seen.body.task.expected })).body)
        .toEqual({ outcome: 'refused', code: 'reason_required' });
    }
    expect(await leaveStatus(id)).toBe('pending');
    expect(await receipts()).toEqual([]);
    expect((await post(manager, 'leave', id, { requestId: randomUUID(), decision: 'reject', reason: 'Short staffed', expected: seen.body.task.expected })).body).toEqual({ outcome: 'accepted', status: 'rejected' });
    expect(await leaveStatus(id)).toBe('rejected');
  });

  it('a multi-step chain that moved on is stale_step, records nothing, and the refetched step decides', async () => {
    const id = await apply(employee, 0);
    expect(await assigned(hr, 'leave', id), 'HR may clear any step, so it is admitted at step 0').toBe(true);
    const opened = await detail(hr, 'leave', id);
    expect(opened.body.task.expected).toEqual({ stepIndex: 0 });
    await decideLeave(manager.ctx, { leaveRequestId: id, decision: 'approved', deciderEmploymentId: manager.employmentId });
    expect((await post(hr, 'leave', id, { requestId: randomUUID(), decision: 'approve', expected: opened.body.task.expected })).body).toEqual({ outcome: 'refused', code: 'stale_step' });
    expect(await leaveStatus(id)).toBe('pending');
    expect(await receipts()).toEqual([]);
    const fresh = await detail(hr, 'leave', id);
    expect(fresh.body.task.expected).toEqual({ stepIndex: 1 });
    expect((await post(hr, 'leave', id, { requestId: randomUUID(), decision: 'approve', expected: fresh.body.task.expected })).body).toEqual({ outcome: 'accepted', status: 'approved' });
  });

  it('per-date: the approved dates are approved, the rest rejected with the reason, in one decision', async () => {
    await setLeaveApprovalPolicy(adminCtx(base), { companyId: base.companyId, levels: ['direct_manager'] as never });
    await owner.db.update(schema.leaveType).set({ counting: 'working_days', perDateApproval: true }).where(eq(schema.leaveType.id, base.annualLeaveTypeId));
    const days = [MON, addDays(MON, 1), addDays(MON, 2)];
    const { leaveRequestId: id } = await requestLeave(employee.ctx, { employmentId: employee.employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: days[0], endDate: days[2], today: TODAY });
    const seen = await detail(manager, 'leave', id);
    expect(seen.body.task.dates.map((d: { date: string; status: string }) => [d.date, d.status])).toEqual(days.map((d) => [d, 'pending']));
    expect(seen.body.task.expected).toEqual({ stepIndex: null });
    expect((await post(manager, 'leave', id, { requestId: randomUUID(), decision: 'approve', dates: [days[0], days[2]], expected: seen.body.task.expected })).body,
      'a rejected date needs the reason').toEqual({ outcome: 'refused', code: 'reason_required' });
    expect((await post(manager, 'leave', id, { requestId: randomUUID(), decision: 'approve', dates: [addDays(MON, 5)], expected: seen.body.task.expected })).body,
      'a date the request does not have pending').toEqual({ outcome: 'refused', code: 'stale_step' });
    expect(await receipts()).toEqual([]);
    expect((await post(manager, 'leave', id, { requestId: randomUUID(), decision: 'approve', dates: [days[2], days[0]], reason: 'Stock take', expected: seen.body.task.expected })).body)
      .toEqual({ outcome: 'accepted', status: 'approved' });
    const rows = await owner.db.select({ d: schema.leaveRequestDate.leaveDate, s: schema.leaveRequestDate.status, r: schema.leaveRequestDate.rejectReason }).from(schema.leaveRequestDate)
      .where(eq(schema.leaveRequestDate.leaveRequestId, id)).orderBy(asc(schema.leaveRequestDate.leaveDate));
    expect(rows).toEqual([{ d: days[0], s: 'approved', r: null }, { d: days[1], s: 'rejected', r: 'Stock take' }, { d: days[2], s: 'approved', r: null }]);
  });

  it('a cancellation is decided level by level through decideLeaveCancellation, without a reason field', async () => {
    const id = await apply(employee, 0);
    await approveThroughKernel(id);
    const { cancellationRequestId } = await requestLeaveCancellation(employee.ctx, { leaveRequestId: id, cancelDates: [week(0).end], today: TODAY });
    const seen = await detail(manager, 'leaveCancellation', cancellationRequestId);
    expect(seen.body).toMatchObject({ outcome: 'found', task: { kind: 'leaveCancellation', cancelDates: [week(0).end], reasonRequiredToReject: false, expected: { stepIndex: 0 } } });
    expect((await post(manager, 'leaveCancellation', cancellationRequestId, { requestId: randomUUID(), decision: 'approve', expected: seen.body.task.expected })).body)
      .toEqual({ outcome: 'accepted', status: 'pending_next_step' });
    expect((await decide(hr, 'leaveCancellation', cancellationRequestId)).body).toEqual({ outcome: 'accepted', status: 'approved' });
    const [cr] = await owner.db.select({ s: schema.leaveCancellationRequest.status }).from(schema.leaveCancellationRequest).where(eq(schema.leaveCancellationRequest.id, cancellationRequestId));
    expect(cr.s).toBe('approved');
    expect((await detail(hr, 'leaveCancellation', cancellationRequestId)).body).toEqual({ outcome: 'refused', code: 'already_decided' });
  });

  it('team cover lists the caller’s own team on those dates — never the subject, never another team, never a reason', async () => {
    const id = await apply(employee, 0);
    const covering = await apply(colleague, 0, 'Secret medical reason');
    await approveThroughKernel(covering);
    const otherManager = await hire('Victor Other', 'manager'), stranger = await hire('Wani Stranger');
    await line(stranger.employmentId, otherManager.employmentId); await fund(stranger.employmentId);
    await apply(stranger, 0);
    const seen = await detail(manager, 'leave', id);
    const cover = seen.body.task.teamCover as { name: string; dates: { date: string; status: string }[] }[];
    expect(cover.map((m) => m.name)).toEqual(['Badrul Colleague']);
    expect(cover[0].dates.length).toBeGreaterThan(0);
    expect(cover[0].dates.every((d) => d.date >= week(0).start && d.date <= week(0).end && d.status === 'approved')).toBe(true);
    expect(JSON.stringify(seen.body)).not.toContain('Secret medical reason');
    expect(Object.keys(cover[0]).sort()).toEqual(['dates', 'name']);
  });

  it('the supporting document: an admitted approver gets the stored image; a mislabelled file is unsupported', async () => {
    const id = await apply(employee, 0);
    caller = manager.ctx;
    const fetchDoc = async (ref: string) => document.GET(new Request(`${URL0}/leave/${ref}/document`));
    expect(await (await fetchDoc(id)).json()).toEqual({ outcome: 'refused', code: 'no_document' });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await owner.db.insert(schema.leaveRequestAttachment).values({ tenantId: base.tenantId, leaveRequestId: id, employmentId: employee.employmentId, content: png, fileName: 'mc.png', mimeType: 'image/png', sizeBytes: png.byteLength });
    expect((await detail(manager, 'leave', id)).body.task.hasDocument).toBe(true);
    caller = manager.ctx;
    const file = await fetchDoc(id);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="mc.png"');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await file.arrayBuffer()).equals(png)).toBe(true);
    await owner.db.delete(schema.leaveRequestAttachment).where(eq(schema.leaveRequestAttachment.leaveRequestId, id));
    await owner.db.insert(schema.leaveRequestAttachment).values({ tenantId: base.tenantId, leaveRequestId: id, employmentId: employee.employmentId, content: png, fileName: 'mc.pdf', mimeType: 'application/pdf', sizeBytes: png.byteLength });
    expect(await (await fetchDoc(id)).json()).toEqual({ outcome: 'refused', code: 'unsupported_document' });
    caller = colleague.ctx;
    expect(await (await fetchDoc(id)).json()).toEqual({ outcome: 'refused', code: 'not_assigned' });
    caller = manager.ctx;
    expect((await document.GET(new Request(`${URL0}/attendance/${id}/document`))).status).toBe(400);
  });
});

describe('attendance decisions (clock corrections and overtime share one decider)', () => {
  // Activation resolves the stages for EVERY targeted employee (core/attendance-workflow.ts validateActivation). The
  // whole fixture sits in deptA, where the manager and HR have no superior and HR would be its own only HR approver,
  // so the workflow targets the subject alone — as test/attendance-workflow-hierarchy.test.ts does by keeping its
  // approvers out of the criteria department.
  function workflow(stages: ('direct_manager' | 'hr_admin')[], over: Partial<AttendanceWorkflowInput> = {}): AttendanceWorkflowInput {
    return { companyId: base.companyId, code: 'M08', name: 'Mobile review', description: 'M08', applicationType: 'irregularity', priority: 100,
      criteria: { departmentIds: [base.deptA], employeeIds: [employee.employmentId] },
      stages: stages.map((kind, i) => ({ name: `Review ${i + 1}`, level: { kind, employmentId: null, alternates: [] } })), active: true, ...over };
  }
  async function correction(stages: ('direct_manager' | 'hr_admin')[], over: Partial<AttendanceWorkflowInput> = {}) {
    const a = adminCtx(base), value = workflow(stages, over);
    await saveAttendanceWorkflow(a, value);
    await setAttendanceWorkflowEnabled(a, base.companyId, value.applicationType, true);
    await checkIn(a, { employmentId: employee.employmentId, date: WORKED, time: '08:00', manual: true });
    await checkOut(a, { employmentId: employee.employmentId, date: WORKED, time: '17:00', manual: true });
    return (await requestAttendanceCorrection(employee.ctx, { employmentId: employee.employmentId, date: WORKED, checkIn: '09:00', checkOut: '18:00', reason: 'Forgot to clock' })).correctionId;
  }

  it('a stage that moved on is stale_step; a missing reason is reason_required; the refetched stage decides', async () => {
    const id = await correction(['direct_manager', 'hr_admin']);
    expect(await assigned(hr, 'attendance', id), 'HR is admitted at stage 0').toBe(true);
    const opened = await detail(hr, 'attendance', id);
    expect(opened.body).toMatchObject({ outcome: 'found', task: { kind: 'attendance', application: 'correction', date: WORKED, proposedCheckIn: '09:00', proposedCheckOut: '18:00', employeeReason: 'Forgot to clock', expected: { stageIndex: 0 } } });
    await decideAttendanceCorrection(manager.ctx, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
    expect((await post(hr, 'attendance', id, { requestId: randomUUID(), decision: 'approve', expected: opened.body.task.expected })).body).toEqual({ outcome: 'refused', code: 'stale_step' });
    const fresh = await detail(hr, 'attendance', id);
    expect(fresh.body.task.expected.stageIndex).toBe(1);
    expect((await post(hr, 'attendance', id, { requestId: randomUUID(), decision: 'reject', expected: fresh.body.task.expected })).body).toEqual({ outcome: 'refused', code: 'reason_required' });
    expect(await receipts()).toEqual([]);
    expect((await post(hr, 'attendance', id, { requestId: randomUUID(), decision: 'approve', expected: fresh.body.task.expected })).body).toEqual({ outcome: 'accepted', status: 'approved' });
    const [row] = await owner.db.select({ s: schema.attendanceCorrection.status }).from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, id));
    expect(row.s).toBe('approved');
  });

  it('a stage reassigned to HR ends the manager’s admission', async () => {
    const id = await correction(['direct_manager'], { routingVersion: 2 });
    const opened = await detail(manager, 'attendance', id);
    expect(opened.body).toMatchObject({ outcome: 'found', task: { expected: { stageIndex: 0 } } });
    await reassignAttendanceWorkflowStageToHr(adminCtx(base), { correctionId: id, expectedStageIndex: 0, reason: 'Manager on long leave' });
    expect(await assigned(manager, 'attendance', id)).toBe(false);
    expect((await detail(manager, 'attendance', id)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect((await post(manager, 'attendance', id, { requestId: randomUUID(), decision: 'approve', expected: opened.body.task.expected })).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    const [row] = await owner.db.select({ s: schema.attendanceCorrection.status }).from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, id));
    expect(row.s).toBe('pending');
    expect(await receipts()).toEqual([]);
  });

  it('a self-overtime application is decided natively as an attendance task, labelled overtime', async () => {
    const a = adminCtx(base), value = workflow(['direct_manager'], { applicationType: 'self_overtime', code: 'M08OT' });
    await saveAttendanceWorkflow(a, value);
    await setAttendanceWorkflowEnabled(a, base.companyId, 'self_overtime', true);
    await checkIn(a, { employmentId: employee.employmentId, date: WORKED, time: '08:00', manual: true });
    await checkOut(a, { employmentId: employee.employmentId, date: WORKED, time: '20:00', manual: true });
    const { correctionId: id } = await requestAttendanceCorrection(employee.ctx, { employmentId: employee.employmentId, date: WORKED, requestedOtMinutes: 60, requestKind: 'self_overtime', reason: 'Month end' });
    caller = manager.ctx;
    expect((await get('')).body.items).toContainEqual(expect.objectContaining({ id, kind: 'attendance', nativeDecision: true }));
    const seen = await detail(manager, 'attendance', id);
    expect(seen.body).toMatchObject({ outcome: 'found', task: { application: 'overtime', requestedOtMinutes: 60 } });
    expect(['workday', 'rest_day', 'holiday']).toContain(seen.body.task.dayType);
    expect((await post(manager, 'attendance', id, { requestId: randomUUID(), decision: 'reject', reason: 'Not planned', expected: seen.body.task.expected })).body).toEqual({ outcome: 'accepted', status: 'rejected' });
  });
});
