/**
 * M07 — the v2 leave history, detail and the two employee commands, through the REAL route handlers, core and RLS.
 * Only bearer session resolution is injected (as test/mobile-native-journeys.test.ts does).
 *
 * Pinned: own-selected-employment scoping (a manager cannot read a subordinate's request through the OWN endpoint,
 * although RLS shows it to them); keyset paging that neither repeats nor skips under ties and inserts; the status
 * filter and counts; detail facts equal to the web's owners; withdraw/cancel replay and request_conflict; refusal
 * codes from the service (and nothing recorded for a refusal); the v1 hourly preview equal to what requestLeave
 * deducts, overnight included; the additive v1 entitlement notice text.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { decideLeave, requestLeave } from '../packs/leave/service';
import { mobileTranslator } from '../lib/mobile-api/server-text';
import { ENTITLEMENT_STATUS_LABEL_KEY } from '../lib/entitlement-status';
import msCatalogue from '../messages/ms.json';
import enCatalogue from '../messages/en.json';
import { employeeCancelOffers, listLeaveRequestsPage } from '../core/read';
import { ownLeaveApprovalTrails } from '../core/my-leave';
import { isPartiallyApproved } from '../lib/my-leave-history';
import { decodeCursor } from '../lib/mobile-api/v2/common';
import { LEAVE_REQUESTS_CURSOR, LeaveRequestsCursor } from '../lib/mobile-api/v2/leave';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const list = await import('../app/api/mobile/v2/leave/requests/route');
const one = await import('../app/api/mobile/v2/leave/requests/[id]/route');
const withdraw = await import('../app/api/mobile/v2/leave/requests/[id]/withdraw/route');
const cancellation = await import('../app/api/mobile/v2/leave/requests/[id]/cancellation/route');
const preview = await import('../app/api/mobile/v1/leave-preview/route');
const v1leave = await import('../app/api/mobile/v1/leave/route');

let base: Base;
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// The nearest Monday at least 8 days out, and nothing below runs past it by more than 18 days: the flat
// future-leave-year gate (core/leave.ts) refuses an employee's next-year dates, so a run in the last weeks of
// December would be refused for that reason — the same exposure every leave suite that books ahead carries.
const MON = (() => { let d = addDays(TODAY, 8); while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1); return d; })();
const week = (n: number) => ({ start: addDays(MON, 7 * n), end: addDays(MON, 7 * n + 4) });
const URL0 = 'https://hr.example.com/api/mobile/v2/leave/requests';

async function hire(name: string, role: 'employee' | 'manager' | 'hr_admin' = 'employee') {
  const e = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: randomUUID() + '@m07.test' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(base.tenantId, e.personId, role);
  const ctx: SessionContext = { tenantId: base.tenantId, userId, personId: e.personId, roles: [role], grants: [{ role, companyId: base.companyId }], entitlements: harnessSnapshot(base.tenantId) };
  return { ...e, ctx };
}
async function fund(employmentId: string) {
  await owner.db.insert(schema.leaveLedger).values({ tenantId: base.tenantId, employmentId, leaveTypeId: base.annualLeaveTypeId, entryType: 'accrual', days: '60.00', effectiveOn: TODAY });
}
const get = async (path: string) => { const r = await (path.startsWith('?') || path === '' ? list.GET : one.GET)(new Request(URL0 + path)); return { status: r.status, body: await r.json() }; };
const post = async (handler: (r: Request) => Promise<Response>, path: string, body: unknown) => {
  const r = await handler(new Request(URL0 + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const statusOf = async (id: string) => (await owner.db.select({ s: schema.leaveRequest.status }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id)))[0]?.s;
const receipts = () => owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'mobile.command.recorded'));

let employee: Awaited<ReturnType<typeof hire>>, manager: Awaited<ReturnType<typeof hire>>, hr: Awaited<ReturnType<typeof hire>>;
const apply = (n: number) =>
  requestLeave(employee.ctx, { employmentId: employee.employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: week(n).start, endDate: week(n).end, today: TODAY }).then((r) => r.leaveRequestId);
/** A one-day request on MON + n (paging needs many rows, and a short horizon). */
const applyDay = (n: number) =>
  requestLeave(employee.ctx, { employmentId: employee.employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: addDays(MON, n), endDate: addDays(MON, n), today: TODAY }).then((r) => r.leaveRequestId);
async function approve(id: string) {
  while ((await statusOf(id)) === 'pending') {
    const [step] = await owner.db.select({ i: schema.leaveApprovalStep.stepIndex }).from(schema.leaveApprovalStep).where(and(eq(schema.leaveApprovalStep.leaveRequestId, id), eq(schema.leaveApprovalStep.status, 'pending'))).orderBy(schema.leaveApprovalStep.stepIndex).limit(1);
    await decideLeave(step?.i === 1 ? hr.ctx : manager.ctx, { leaveRequestId: id, decision: 'approved', deciderEmploymentId: step?.i === 1 ? hr.employmentId : manager.employmentId });
  }
}

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); blocked = false;
  await setLeaveApprovalPolicy(adminCtx(base), { companyId: base.companyId, levels: ['direct_manager', 'hr_admin'] as never });
  employee = await hire('Aisyah Employee'); manager = await hire('Marcus Manager', 'manager'); hr = await hire('Hana HR', 'hr_admin');
  await setReportingLine(adminCtx(base), { subordinateEmploymentId: employee.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
  await fund(employee.employmentId); await fund(manager.employmentId);
});

describe('own selected employment only', () => {
  it('a manager cannot read or act on a subordinate’s request through the own endpoints, although RLS shows it to them', async () => {
    const theirs = await apply(0);
    // Non-vacuity: RLS admits the manager to the subordinate's row through the canonical read.
    const visible = await listLeaveRequestsPage(manager.ctx, { limit: 50, offset: 0 });
    expect(visible.rows.map((r) => r.id)).toContain(theirs);
    caller = manager.ctx;
    const listed = await get('');
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ employmentId: manager.employmentId, items: [], nextCursor: null, counts: { pending: 0, approved: 0, rejected: 0, cancelled: 0 } });
    caller = employee.ctx;
    expect((await get('')).body.items.map((i: { id: string }) => i.id), 'the owner does see it').toEqual([theirs]);
    caller = manager.ctx;
    expect(await get('/' + theirs)).toEqual({ status: 200, body: { outcome: 'refused', code: 'not_found' } });
    expect((await post(withdraw.POST, `/${theirs}/withdraw`, { requestId: randomUUID() })).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await post(cancellation.POST, `/${theirs}/cancellation`, { requestId: randomUUID(), cancelDates: [week(0).end] })).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect(await statusOf(theirs)).toBe('pending');
    expect(await receipts()).toEqual([]);
    // Naming the subordinate's employment is a 400, never a read under it.
    expect((await get('?employmentId=' + employee.employmentId)).status).toBe(400);
    expect((await get(`/${theirs}?employmentId=${employee.employmentId}`)).status).toBe(400);
    expect((await get('/not-a-uuid')).status).toBe(400);
    blocked = true;
    expect((await get('')).status).toBe(401);
  });
});

describe('history paging', () => {
  it('start date descending, keyset pages that neither repeat nor skip, across ties and an insert mid-walk', async () => {
    const ids = [await applyDay(0), await applyDay(1), await applyDay(2), await applyDay(3), await applyDay(4)];
    // Ties: two rows share day 2, and the pair also shares created_at, so only the id breaks the tie.
    await owner.db.update(schema.leaveRequest).set({ startDate: addDays(MON, 2), endDate: addDays(MON, 2) }).where(eq(schema.leaveRequest.id, ids[1]));
    await owner.db.execute(sql`update leave_request set created_at = (select created_at from leave_request where id = ${ids[2]}) where id = ${ids[1]}`);
    caller = employee.ctx;
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0, inserted: string | null = null;
    do {
      const page = await get('?limit=2' + (cursor ? '&cursor=' + cursor : ''));
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
      if (cursor) expect(decodeCursor(LEAVE_REQUESTS_CURSOR, cursor, LeaveRequestsCursor)).toEqual([page.body.items.at(-1).startDate, page.body.items.at(-1).id]);
      if (pages === 0) inserted = await applyDay(7); // a newer request appears after page 1: not on a later page
      pages++;
    } while (cursor && pages < 10);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(seen).not.toContain(inserted);
    const walk = await listLeaveRequestsPage(employee.ctx, { employmentIds: [employee.employmentId], ids, sort: 'start', dir: 'desc', limit: 10, offset: 0 });
    expect(seen).toEqual(walk.rows.map((r) => r.id));
    expect((await get('?cursor=' + 'x'.repeat(20))).status).toBe(400);
    expect((await get('?limit=0')).status).toBe(400);
    expect((await get('?status=archived')).status).toBe(400);
    expect((await get('?from=2026-02-30')).status).toBe(400);
  });

  it('filters by stored status and counts every status under the same window', async () => {
    const pending = await apply(0), approved = await apply(1), withdrawn = await apply(2);
    await approve(approved);
    caller = employee.ctx;
    expect((await post(withdraw.POST, `/${withdrawn}/withdraw`, { requestId: randomUUID() })).body).toEqual({ outcome: 'withdrawn', id: withdrawn });
    const all = await get('');
    expect(all.body.counts).toEqual({ pending: 1, approved: 1, rejected: 0, cancelled: 1 });
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([withdrawn, approved, pending]);
    const only = await get('?status=approved');
    expect(only.body.items).toEqual([expect.objectContaining({ id: approved, status: 'approved', displayStatus: 'approved', days: 5, durationType: 'full_day' })]);
    expect(only.body.counts, 'counts ignore the status filter').toEqual(all.body.counts);
    const windowed = await get(`?from=${week(1).start}&to=${week(1).end}`);
    expect(windowed.body.items.map((i: { id: string }) => i.id)).toEqual([approved]);
    expect(windowed.body.counts).toEqual({ pending: 0, approved: 1, rejected: 0, cancelled: 0 });
  });
});

describe('detail', () => {
  it('names each level and its decider, offers the web’s cancellable dates, and Withdraw only on a pending row', async () => {
    const approved = await apply(0), pending = await apply(1);
    await approve(approved);
    caller = employee.ctx;
    const a = await get('/' + approved);
    expect(a.body.outcome).toBe('found');
    expect(a.body.request).toMatchObject({ id: approved, status: 'approved', displayStatus: 'approved', startDate: week(0).start, endDate: week(0).end, days: 5, appliedOn: TODAY });
    expect(a.body.request.approvals).toEqual([
      { level: 1, kindLabel: expect.any(String), status: 'approved', names: ['Marcus Manager'], decidedAt: expect.any(String) },
      { level: 2, kindLabel: expect.any(String), status: 'approved', names: ['Hana HR'], decidedAt: expect.any(String) },
    ]);
    const [row] = (await listLeaveRequestsPage(employee.ctx, { employmentIds: [employee.employmentId], ids: [approved], limit: 1, offset: 0 })).rows;
    const offer = (await employeeCancelOffers(employee.ctx, [row], TODAY)).get(approved);
    expect(offer, 'the whole future approved week').toHaveLength(5);
    expect(a.body.request.actions).toEqual({ withdraw: false, cancelDates: offer });
    const p = await get('/' + pending);
    expect(p.body.request.actions).toEqual({ withdraw: true, cancelDates: null });
    expect(p.body.request.approvals).toEqual([
      { level: 1, kindLabel: expect.any(String), status: 'waiting', names: ['Marcus Manager'], decidedAt: null },
      { level: 2, kindLabel: expect.any(String), status: 'not_reached', names: [], decidedAt: null },
    ]);
    // The display status is the web's rule, pinned against its owner.
    const trails = await ownLeaveApprovalTrails(employee.ctx, [approved]);
    expect(isPartiallyApproved(row, trails.get(approved))).toBe(false);
  });

  it('a pending give-back reads Cancellation pending with its copied levels', async () => {
    const id = await apply(0);
    await approve(id);
    caller = employee.ctx;
    const out = await post(cancellation.POST, `/${id}/cancellation`, { requestId: randomUUID(), cancelDates: [week(0).end] });
    expect(out.body).toMatchObject({ outcome: 'accepted', id, status: 'pending', requestedDays: 1 });
    const d = await get('/' + id);
    expect(d.body.request.displayStatus).toBe('cancellation_pending');
    expect(d.body.request.pendingCancellation).toEqual({ requestedAt: expect.any(String), cancelDates: [week(0).end], levels: [{ level: 1, status: 'waiting' }, { level: 2, status: 'not_reached' }] });
    expect(d.body.request.actions.cancelDates, 'no second give-back while one waits (the web predicate)').toBeNull();
  });
});

describe('commands: replay, conflict and refusal', () => {
  it('withdraw replays its first answer, conflicts on a different command under the same reference, and records once', async () => {
    const a = await apply(0), b = await apply(1);
    caller = employee.ctx;
    const requestId = randomUUID();
    const [first, second] = await Promise.all([post(withdraw.POST, `/${a}/withdraw`, { requestId }), post(withdraw.POST, `/${a}/withdraw`, { requestId })]);
    expect(first.body).toEqual({ outcome: 'withdrawn', id: a });
    expect(second.body).toEqual(first.body);
    expect(await statusOf(a)).toBe('cancelled');
    expect(await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, a), eq(schema.domainEvent.eventType, 'leave-request.self-cancelled')))).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    expect((await post(withdraw.POST, `/${b}/withdraw`, { requestId })).body).toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect(await statusOf(b)).toBe('pending');
    // A NEW reference on the already-withdrawn request is the service's own refusal, and records nothing.
    expect((await post(withdraw.POST, `/${a}/withdraw`, { requestId: randomUUID() })).body).toMatchObject({ outcome: 'refused', code: 'already_final' });
    expect(await receipts()).toHaveLength(1);
    expect((await post(withdraw.POST, `/${a}/withdraw`, { requestId: 'nope' })).status).toBe(400);
    expect((await post(withdraw.POST, `/${a}/withdraw`, { requestId: randomUUID(), employmentId: manager.employmentId })).status, 'identity never travels in the body').toBe(400);
  });

  it('withdraw of an approved request is already_approved; nothing is written or recorded', async () => {
    const id = await apply(0);
    await approve(id);
    caller = employee.ctx;
    expect((await post(withdraw.POST, `/${id}/withdraw`, { requestId: randomUUID() })).body).toMatchObject({ outcome: 'refused', code: 'already_approved', message: expect.any(String) });
    expect(await statusOf(id)).toBe('approved');
    expect(await receipts()).toEqual([]);
  });

  it('cancel dates replays, conflicts on different dates under one reference, and refuses with the service’s codes', async () => {
    const id = await apply(0);
    await approve(id);
    caller = employee.ctx;
    const requestId = randomUUID();
    const first = await post(cancellation.POST, `/${id}/cancellation`, { requestId, cancelDates: [week(0).end, addDays(week(0).end, -1), week(0).end], reason: ' Plans changed ' });
    expect(first.body).toMatchObject({ outcome: 'accepted', id, status: 'pending', requestedDays: 2 });
    const again = await post(cancellation.POST, `/${id}/cancellation`, { requestId, cancelDates: [addDays(week(0).end, -1), week(0).end], reason: 'Plans changed' });
    expect(again.body, 'same intent (normalised) replays').toEqual(first.body);
    const rows = await owner.db.select().from(schema.leaveCancellationRequest).where(eq(schema.leaveCancellationRequest.leaveRequestId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('Plans changed');
    expect((await post(cancellation.POST, `/${id}/cancellation`, { requestId, cancelDates: [week(0).start] })).body).toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect((await post(cancellation.POST, `/${id}/cancellation`, { requestId: randomUUID(), cancelDates: [week(0).start] })).body).toMatchObject({ outcome: 'refused', code: 'already_pending' });
    expect(await receipts()).toHaveLength(1);
    expect((await post(cancellation.POST, `/${id}/cancellation`, { requestId: randomUUID(), cancelDates: [] })).status).toBe(400);
  });

  it('date_invalid, type_off and not_approved come from the service; none records a receipt', async () => {
    const id = await apply(0), pending = await apply(1);
    await approve(id);
    caller = employee.ctx;
    expect((await post(cancellation.POST, `/${id}/cancellation`, { requestId: randomUUID(), cancelDates: [addDays(week(0).end, 30)] })).body).toMatchObject({ outcome: 'refused', code: 'date_invalid' });
    expect((await post(cancellation.POST, `/${pending}/cancellation`, { requestId: randomUUID(), cancelDates: [week(1).start] })).body).toMatchObject({ outcome: 'refused', code: 'not_approved' });
    await owner.db.update(schema.leaveType).set({ employeeCancelApproved: false }).where(eq(schema.leaveType.id, base.annualLeaveTypeId));
    expect((await post(cancellation.POST, `/${id}/cancellation`, { requestId: randomUUID(), cancelDates: [week(0).end] })).body).toMatchObject({ outcome: 'refused', code: 'type_off' });
    expect((await get('/' + id)).body.request.actions.cancelDates, 'the offer follows the same switch').toBeNull();
    expect(await receipts()).toEqual([]);
    expect(await owner.db.select().from(schema.leaveCancellationRequest)).toEqual([]);
  });
});

describe('v1 additive: hourly preview and the entitlement notice text', () => {
  const previewOf = async (command: Record<string, unknown>) => (await preview.POST(new Request('https://hr.example.com/api/mobile/v1/leave-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }))).json();
  it('passes the hourly window through to the rule requestLeave deducts by; an incomplete or overnight window keeps days null', async () => {
    await owner.db.update(schema.leaveType).set({ durations: ['half_day_am', 'half_day_pm', 'hourly'] }).where(eq(schema.leaveType.id, base.annualLeaveTypeId));
    caller = employee.ctx;
    for (const [i, [fromTime, toTime]] of ([['09:00', '11:00'], ['09:00', '18:00'], ['13:20', '14:05']] as const).entries()) {
      const day = addDays(MON, i);
      const command = { requestId: randomUUID(), leaveTypeId: base.annualLeaveTypeId, startDate: day, endDate: day, durationType: 'hourly', fromTime, toTime };
      const shown = await previewOf(command);
      const submitted = await requestLeave(employee.ctx, { employmentId: employee.employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: day, endDate: day, durationType: 'hourly', fromTime, toTime, today: TODAY });
      expect(shown.days, `${fromTime}–${toTime}`).toBe(submitted.days);
    }
    const day = addDays(MON, 7);
    const base1 = { requestId: randomUUID(), leaveTypeId: base.annualLeaveTypeId, startDate: day, endDate: day, durationType: 'hourly' };
    expect((await previewOf({ ...base1, fromTime: '22:00', toTime: '02:00' })).days).toBeNull();
    expect((await previewOf({ ...base1, fromTime: '09:00' })).days).toBeNull();
    expect((await previewOf(base1)).days).toBeNull();
  });

  it('server text comes from the web catalogue in the caller’s language, English when a key is missing, null when absent', async () => {
    const key = ENTITLEMENT_STATUS_LABEL_KEY.not_generated;
    const ms = await mobileTranslator('ms', 'me.leaveBalanceTable');
    const msText = (msCatalogue as unknown as { me: { leaveBalanceTable: Record<string, string> } }).me.leaveBalanceTable[key];
    const enText = (enCatalogue as unknown as { me: { leaveBalanceTable: Record<string, string> } }).me.leaveBalanceTable[key];
    expect(enText).toMatch(/\S/);
    expect(ms(key)).toBe(msText || enText);
    expect(ms('no.such.key')).toBeNull();
    expect((await mobileTranslator('en', 'leaveApproval'))('manager')).toBe((enCatalogue as { leaveApproval: Record<string, string> }).leaveApproval.manager);
  });

  it('a card whose entitlement needs a notice carries it as text in the caller’s language; v1’s key field is unchanged', async () => {
    await seedEntitlement(adminCtx(base), { leaveTypeId: base.annualLeaveTypeId, annualDays: 30, validFrom: TODAY.slice(0, 4) + '-01-01' });
    caller = employee.ctx;
    const r = await v1leave.GET(new Request('https://hr.example.com/api/mobile/v1/leave?locale=ms'));
    const body = await r.json() as { cards: { entitlementNotice: string | null; entitlementNoticeText?: { label: string; detail: string | null } | null }[] };
    expect(r.status).toBe(200);
    expect(body.cards.length).toBeGreaterThan(0);
    for (const c of body.cards) {
      if (c.entitlementNotice == null) expect(c.entitlementNoticeText).toBeNull();
      else expect(c.entitlementNoticeText).toEqual({ label: expect.stringMatching(/\S/), detail: expect.anything() });
    }
  });
});
