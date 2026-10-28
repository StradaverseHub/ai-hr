/**
 * M10 (inbox part) and M14 (Home essentials) — the v2 notifications page, the read command and the Home summary,
 * through the REAL route handlers, core, the canonical notification service and RLS. Only bearer session resolution is
 * injected (as test/mobile-v2-leave.test.ts does).
 *
 * Pinned: keyset paging (D5) that neither repeats nor skips under EQUAL instants and under instants a microsecond
 * apart; recipient-only reads and writes (another person's id is neither marked nor answered); mark one and mark all
 * touch only the caller's own rows; the unread count and filter; the kind allowlist and its current-access gate, with
 * an unknown kind and a malicious stored link answering `destination: null` and no link text ever leaving the server;
 * the module gate; Home's two counts each read on its own; listNotifications' existing callers unchanged apart from
 * the deterministic tie-break.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave } from '../packs/leave/service';
import { listPendingTasks } from '../core/approvals-inbox';
import { isModuleEnabled } from '../core/entitlements';
import { listNotifications, listNotificationsPage, unreadNotificationCount } from '../core/notifications';
import { NOTIFICATION_DESTINATIONS, notificationDestination } from '../lib/mobile-api/notification-destination';
import { decodeCursor } from '../lib/mobile-api/v2/common';
import { NOTIFICATION_SCREENS, NOTIFICATIONS_CURSOR, NotificationsCursor } from '../lib/mobile-api/v2/notifications';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const pageRoute = await import('../app/api/mobile/v2/notifications/route');
const readRoute = await import('../app/api/mobile/v2/notifications/read/route');
const homeRoute = await import('../app/api/mobile/v2/home/summary/route');

type Role = 'employee' | 'manager' | 'hr_admin';
type Item = { id: string; title: string; readAt: string | null; createdAt: string; destination: { screen: string } | null };
let base: Base;
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// The nearest Monday at least 8 days out (the future-leave-year exposure test/mobile-v2-leave.test.ts names applies).
const MON = (() => { let d = addDays(TODAY, 8); while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1); return d; })();
const URL0 = 'https://hr.example.com/api/mobile/v2';
// Past instants, derived from the clock: a day ago, to the microsecond.
const DAY_AGO = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
const at = (micro: number) => `${DAY_AGO}.${String(micro).padStart(6, '0')}Z`;

async function hire(name: string, role: Role = 'employee') {
  const e = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: randomUUID() + '@m10.test' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(base.tenantId, e.personId, role);
  const ctx: SessionContext = { tenantId: base.tenantId, userId, personId: e.personId, roles: [role], grants: [{ role, companyId: base.companyId }], entitlements: harnessSnapshot(base.tenantId) };
  return { ...e, ctx };
}
type Person = Awaited<ReturnType<typeof hire>>;
/** Rows inserted as the owner, with exact instants, so ties and microsecond neighbours are deliberate. */
async function seed(who: Person, rows: { at: string; kind?: string; read?: boolean; linkPath?: string | null; title?: string }[]) {
  const values = rows.map((r) => ({
    id: randomUUID(), tenantId: base.tenantId, recipientEmploymentId: who.employmentId, kind: r.kind ?? 'leave.approved', title: r.title ?? 'Leave approved',
    body: 'Your leave request was approved.', linkPath: r.linkPath === undefined ? '/me' : r.linkPath, severity: 'info' as const,
    createdAt: sql`${r.at}::timestamptz`, readAt: r.read ? sql`now()` : null,
  }));
  await owner.db.insert(schema.notification).values(values);
  return values.map((v, i) => ({ id: v.id, at: rows[i].at }));
}
/** The kernel order, computed independently: instant desc, then id desc (uuid order = lowercase hex order). */
const expectedOrder = (rows: { id: string; at: string }[]) => [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map((r) => r.id);

const get = async (path: string, handler: (r: Request) => Promise<Response> = pageRoute.GET) => {
  const r = await handler(new Request(URL0 + path));
  const text = await r.text();
  return { status: r.status, text, body: text ? JSON.parse(text) : null };
};
const markRead = async (body: unknown) => {
  const r = await readRoute.POST(new Request(`${URL0}/notifications/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
async function walk(query = '', limit = 3): Promise<Item[]> {
  const seen: Item[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const page = await get(`/notifications?limit=${limit}${query}${cursor ? '&cursor=' + cursor : ''}`);
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBeLessThanOrEqual(limit);
    seen.push(...page.body.items);
    cursor = page.body.nextCursor; pages++;
  } while (cursor && pages < 50);
  expect(pages, 'the walk ended on a last page').toBeLessThan(50);
  return seen;
}
const readAtOf = async (id: string) => (await owner.db.select({ r: schema.notification.readAt }).from(schema.notification).where(eq(schema.notification.id, id)))[0]?.r ?? null;

let A: Person, B: Person;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); blocked = false;
  await setModule(base.tenantId, 'notifications', 'active');
  await setModule(base.tenantId, 'payroll', 'active');
  A = await hire('Aisyah Inbox'); B = await hire('Badrul Inbox');
  caller = A.ctx;
});

describe('paging (D5 keyset)', () => {
  it('pages equal instants and microsecond neighbours in one stable order, neither repeating nor skipping', async () => {
    const tied = await seed(A, Array.from({ length: 7 }, () => ({ at: at(500000) })));
    const close = await seed(A, [{ at: at(500001) }, { at: at(499999) }, { at: at(1) }]);
    await seed(B, [{ at: at(500000), title: 'For Badrul' }]);
    const all = [...tied, ...close];
    for (const limit of [1, 2, 3, 50]) {
      const seen = await walk('', limit);
      expect(seen.map((n) => n.id), `limit ${limit}`).toEqual(expectedOrder(all));
    }
    // The cursor is the list's own, carrying the instant to the microsecond.
    const first = await get('/notifications?limit=1');
    const decoded = decodeCursor(NOTIFICATIONS_CURSOR, first.body.nextCursor, NotificationsCursor);
    expect(decoded?.[0]).toBe(at(500001));
    expect(first.text).not.toContain('For Badrul');
  });

  it('refuses a malformed, foreign or oversized page request; 401 without a session', async () => {
    expect((await get('/notifications?cursor=garbage!')).status).toBe(400);
    expect((await get('/notifications?limit=51')).status).toBe(400);
    expect((await get('/notifications?unread=yes')).status).toBe(400);
    expect((await get('/notifications?unread=true&unread=true')).status).toBe(400);
    blocked = true;
    expect((await get('/notifications')).status).toBe(401);
  });

  it('the unread filter lists only unread rows; the count is the caller\'s own', async () => {
    const rows = await seed(A, [{ at: at(10) }, { at: at(20), read: true }, { at: at(30) }]);
    await seed(B, [{ at: at(40) }]);
    const unread = await walk('&unread=true', 1);
    expect(unread.map((n) => n.id)).toEqual(expectedOrder([rows[0], rows[2]]));
    expect(unread.every((n) => n.readAt === null)).toBe(true);
    const page = await get('/notifications');
    expect(page.body.unreadCount).toBe(2);
    expect(page.body.items.find((n: Item) => n.id === rows[1].id)?.readAt).toEqual(expect.any(String));
  });
});

describe('listNotifications for existing web callers', () => {
  it('returns the same rows as before, now in a deterministic tie order, and ignores no filter', async () => {
    const rows = await seed(A, [...Array.from({ length: 4 }, () => ({ at: at(7) })), { at: at(8), read: true }, { at: at(6) }]);
    const order = expectedOrder(rows);
    const web = await listNotifications(A.ctx, undefined, { limit: 12 });
    expect(web.map((n) => n.id)).toEqual(order);
    expect(Object.keys(web[0]).sort()).toEqual(['body', 'createdAt', 'id', 'kind', 'linkPath', 'readAt', 'severity', 'title']);
    expect((await listNotifications(A.ctx, undefined, { limit: 12, read: false })).map((n) => n.id)).toEqual(order.filter((id) => id !== rows[4].id));
    expect((await listNotifications(A.ctx, undefined, { limit: 12, read: true })).map((n) => n.id)).toEqual([rows[4].id]);
    expect((await listNotifications(A.ctx, A.employmentId)).map((n) => n.id)).toEqual(order);
    expect(await listNotifications(A.ctx, B.employmentId)).toEqual([]);
    expect(await listNotifications(A.ctx, undefined, { limit: 2 })).toHaveLength(2);
    // The optional keyset continues strictly past the cursor in the same order.
    const [head] = await listNotificationsPage(A.ctx, { limit: 1 });
    expect(head.id).toBe(order[0]);
    expect((await listNotifications(A.ctx, undefined, { limit: 12, after: { at: head.cursorAt, id: head.id } })).map((n) => n.id)).toEqual(order.slice(1));
  });
});

describe('mark read (recipient-only)', () => {
  it('marks only the caller\'s own ids, answers only those, and returns the fresh count', async () => {
    const mine = await seed(A, [{ at: at(1), kind: 'payslip.ready' }, { at: at(2) }]);
    const theirs = await seed(B, [{ at: at(3) }]);
    const r = await markRead({ ids: [mine[0].id, theirs[0].id, randomUUID()] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: 'read', unreadCount: 1, items: [{ id: mine[0].id, destination: { screen: 'pay' } }] });
    expect(await readAtOf(mine[0].id)).not.toBeNull();
    expect(await readAtOf(mine[1].id)).toBeNull();
    expect(await readAtOf(theirs[0].id), 'another person\'s row is untouched').toBeNull();
    // Idempotent: again changes nothing and answers the same.
    expect((await markRead({ ids: [mine[0].id] })).body).toEqual({ outcome: 'read', unreadCount: 1, items: [{ id: mine[0].id, destination: { screen: 'pay' } }] });
  });

  it('mark all touches only the caller\'s rows', async () => {
    const mine = await seed(A, [{ at: at(1) }, { at: at(2) }]);
    const theirs = await seed(B, [{ at: at(3) }]);
    expect((await markRead({ all: true })).body).toEqual({ outcome: 'read', unreadCount: 0, items: [] });
    for (const m of mine) expect(await readAtOf(m.id)).not.toBeNull();
    expect(await readAtOf(theirs[0].id)).toBeNull();
    expect(await unreadNotificationCount(B.ctx)).toBe(1);
  });

  it('refuses anything but {ids ≤ 50} or {all: true}', async () => {
    for (const bad of [{}, { ids: [] }, { ids: ['not-a-uuid'] }, { ids: Array.from({ length: 51 }, () => randomUUID()) }, { all: false }, { all: true, ids: [randomUUID()] }, { ids: [randomUUID()], employmentId: B.employmentId }]) {
      expect((await markRead(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
  });
});

describe('destinations (server allowlist)', () => {
  it('maps each listed kind to its screen, everything else to null, and never sends a stored link', async () => {
    expect(Object.values(NOTIFICATION_DESTINATIONS).every((s) => (NOTIFICATION_SCREENS as readonly string[]).includes(s))).toBe(true);
    expect(notificationDestination('leave.approved', { payroll: true })).toEqual({ screen: 'leaveHistory' });
    expect(notificationDestination('toil.accrued', { payroll: true })).toEqual({ screen: 'leave' });
    expect(notificationDestination('leave.escalation', { payroll: true })).toEqual({ screen: 'approvals' });
    expect(notificationDestination('payslip.ready', { payroll: false })).toBeNull();
    for (const kind of ['notice.published', 'claim.approved', 'letter.issued', 'constructor', '__proto__', 'toString', '']) expect(notificationDestination(kind, { payroll: true }), kind).toBeNull();

    const rows = await seed(A, [
      { at: at(1), kind: 'leave.rejected' },
      { at: at(2), kind: 'leave.escalation', linkPath: '/approvals' },
      { at: at(3), kind: 'payslip.ready' },
      { at: at(4), kind: 'unknown.kind', linkPath: 'https://evil.example/steal' },
      { at: at(5), kind: 'leave.approved', linkPath: '//evil.example/x' },
      { at: at(6), kind: 'notice.published', linkPath: 'javascript:alert(1)' },
    ]);
    const page = await get('/notifications?limit=50');
    const byId = new Map(page.body.items.map((n: Item) => [n.id, n.destination]));
    expect(byId.get(rows[0].id)).toEqual({ screen: 'leaveHistory' });
    expect(byId.get(rows[1].id)).toEqual({ screen: 'approvals' });
    expect(byId.get(rows[2].id)).toEqual({ screen: 'pay' });
    expect(byId.get(rows[3].id)).toBeNull();
    expect(byId.get(rows[4].id), 'a stale or malicious link does not change the kind\'s destination').toEqual({ screen: 'leaveHistory' });
    expect(byId.get(rows[5].id)).toBeNull();
    for (const leak of ['linkPath', 'link_path', 'evil.example', 'javascript:', '/approvals', '"kind"']) expect(page.text, leak).not.toContain(leak);

    // Current access: Payroll off now ⇒ the payslip notification opens nothing.
    await setModule(base.tenantId, 'payroll', 'disabled');
    caller = { ...A.ctx, entitlements: harnessSnapshot(base.tenantId) };
    expect((await get('/notifications?limit=50')).body.items.find((n: Item) => n.id === rows[2].id).destination).toBeNull();
    expect((await markRead({ ids: [rows[2].id] })).body.items).toEqual([{ id: rows[2].id, destination: null }]);
  });

  it('clips stored text to the contract bounds instead of failing the page', async () => {
    const [row] = await seed(A, [{ at: at(1), title: 'x'.repeat(2000) }]);
    const page = await get('/notifications');
    expect(page.status).toBe(200);
    const item = page.body.items.find((n: Item) => n.id === row.id);
    expect(item.title.length).toBe(500);
    expect(item.title.endsWith('…')).toBe(true);
  });
});

describe('module gate', () => {
  it('reads and writes nothing while Notifications is off', async () => {
    const [row] = await seed(A, [{ at: at(1), title: 'Hidden' }]);
    await setModule(base.tenantId, 'notifications', 'disabled');
    caller = { ...A.ctx, entitlements: harnessSnapshot(base.tenantId) };
    const page = await get('/notifications');
    expect(page.body).toEqual({ enabled: false, unreadCount: 0, items: [], nextCursor: null });
    expect((await markRead({ ids: [row.id] })).body).toEqual({ outcome: 'refused', code: 'notifications_off' });
    expect(await readAtOf(row.id)).toBeNull();
    expect((await get('/home/summary', homeRoute.GET)).body.inbox).toEqual({ status: 'ok', enabled: false, unreadCount: 0 });
  });
});

describe('Home summary (M14)', () => {
  it('counts the v2 task list and the unread inbox, each on its own', async () => {
    const manager = await hire('Marcus Manager', 'manager');
    await setReportingLine(adminCtx(base), { subordinateEmploymentId: A.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
    await owner.db.insert(schema.leaveLedger).values({ tenantId: base.tenantId, employmentId: A.employmentId, leaveTypeId: base.annualLeaveTypeId, entryType: 'accrual', days: '60.00', effectiveOn: TODAY });
    await requestLeave(A.ctx, { employmentId: A.employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: MON, endDate: addDays(MON, 1), today: TODAY });
    await seed(manager, [{ at: at(1) }, { at: at(2), read: true }]);

    caller = manager.ctx;
    const summary = await get('/home/summary', homeRoute.GET);
    expect(summary.status).toBe(200);
    const canonical = await listPendingTasks(manager.ctx, undefined, { attendance: isModuleEnabled(manager.ctx, 'attendance'), claims: isModuleEnabled(manager.ctx, 'claims') });
    expect(canonical.length).toBeGreaterThan(0);
    expect(summary.body).toEqual({ tasks: { status: 'ok', count: canonical.length }, inbox: { status: 'ok', enabled: true, unreadCount: 1 } });

    // The applicant: their own request is never their task, and nothing is unread.
    caller = A.ctx;
    expect((await get('/home/summary', homeRoute.GET)).body).toEqual({ tasks: { status: 'ok', count: 0 }, inbox: { status: 'ok', enabled: true, unreadCount: 0 } });
  });

  it('a part that cannot be read is `unavailable`, never zero, and does not take the other part down', async () => {
    // The snapshot could not be resolved: the inbox reads Notifications as off; the task list cannot decide its modules.
    caller = { ...A.ctx, entitlements: undefined, entitlementsError: 'test: no snapshot' };
    const summary = await get('/home/summary', homeRoute.GET);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({ tasks: { status: 'unavailable' }, inbox: { status: 'ok', enabled: false, unreadCount: 0 } });
    blocked = true;
    expect((await get('/home/summary', homeRoute.GET)).status).toBe(401);
  });
});
