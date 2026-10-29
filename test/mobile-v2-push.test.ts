/**
 * M10 (D6) — native push enrollment and the delivery sweep, on the reserved 0673 draft installed in this disposable
 * worker only (test/helpers/mobile-push-draft.ts). The routes run through the REAL handlers, core, the mobile command
 * receipt and RLS as the application role; only bearer session resolution is injected (as test/mobile-v2-leave.test.ts
 * does). The sweep runs on the owner connection with FAKE transports: no test contacts Apple or Google.
 *
 * Pinned: the binding is (tenant, session user, installation) and never a body field; receipt replay and conflict; an
 * unchanged token keeps one row, a new token revokes the old row ('replaced'); another login on the same installation
 * and a token moving to another tenant revoke the old binding ('rebound'); revoke and status are own-only; the module
 * gate and the permission refusal; the token never comes back in an answer. The sweep sends at most once per
 * (notification, registration) — twice in a row and two sweeps racing; only unread, recent notifications created after
 * the registration; never to a revoked registration or an archived or blocked login; coalesces one source event; an
 * invalid token revokes the registration; no keys ⇒ no-op; and NOTHING of the stored title or body reaches a transport.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { deliverMobilePush, PUSH_RECENCY_MINUTES } from '../core/mobile-push-delivery';
import { PUSH_BODY, PUSH_TITLE, type PushMessage, type PushSendOutcome, type PushTransport } from '../lib/mobile-push-message';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { installPushDraftForWorker } from './helpers/mobile-push-draft';
import { todayInKualaLumpur } from '../lib/hr-date';

let caller: SessionContext;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => caller }));
const enrollRoute = await import('../app/api/mobile/v2/push/enrollment/route');
const revokeRoute = await import('../app/api/mobile/v2/push/revoke/route');
const statusRoute = await import('../app/api/mobile/v2/push/status/route');

const URL0 = 'https://hr.example.com/api/mobile/v2';
const APNS = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const FCM = (n: number) => `fcm-token_${n}:${'A'.repeat(140)}`;
let base: Base, restore: (() => Promise<void>) | undefined;

async function hire(name: string, b: Base = base) {
  const e = await hireEmployee(adminCtx(b), { person: { fullName: name, primaryEmail: randomUUID() + '@m10push.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: b.companyId }], entitlements: harnessSnapshot(b.tenantId) };
  return { ...e, userId, ctx };
}
type Person = Awaited<ReturnType<typeof hire>>;
const post = async (handler: (r: Request) => Promise<Response>, path: string, body: unknown) => {
  const r = await handler(new Request(URL0 + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const text = await r.text();
  return { status: r.status, text, body: text ? JSON.parse(text) : null };
};
const enrollment = (over: Record<string, unknown> = {}) => ({
  requestId: randomUUID(), installationId: INSTALL, platform: 'ios', token: APNS(1), permission: 'granted', locale: 'en', appVersion: '1.0.3', ...over,
});
const enroll = (body: Record<string, unknown>) => post(enrollRoute.POST, '/push/enrollment', body);
const status = async (installationId = INSTALL) => {
  const r = await statusRoute.GET(new Request(`${URL0}/push/status?installationId=${installationId}`));
  return { status: r.status, body: await r.json() };
};
/** Registrations read as the owner, in a fixed order, so assertions are about the set rather than positions. */
const registrations = (installationId?: string) => owner.db.select().from(schema.mobilePushRegistration)
  .where(installationId ? eq(schema.mobilePushRegistration.installationId, installationId) : undefined)
  .orderBy(asc(schema.mobilePushRegistration.createdAt), asc(schema.mobilePushRegistration.id));
let INSTALL: string;

beforeAll(async () => { await migrateTestDb(); restore = await installPushDraftForWorker(); });
afterAll(async () => { try { await resetDb(); await restore?.(); } finally { await closeAll(); } });
let A: Person, B: Person;
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  await setModule(base.tenantId, 'notifications', 'active');
  A = await hire('Aisyah Push'); B = await hire('Badrul Push');
  caller = A.ctx; INSTALL = randomUUID();
});

describe('enrollment — the binding is (tenant, session user, installation)', () => {
  it('binds this installation to the caller, never answers the token, and replays a lost answer', async () => {
    const T = APNS(0xab); // hex with letters, sent upper-case: one spelling is stored
    const body = enrollment({ token: T.toUpperCase() });
    const first = await enroll(body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ outcome: 'registered', platform: 'ios', provider: 'apns', change: 'created', delivery: expect.stringMatching(/^(available|unavailable)$/) });
    expect(first.text.toLowerCase()).not.toContain(T);
    const rows = await registrations(INSTALL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: base.tenantId, userId: A.userId, installationId: INSTALL, platform: 'ios', provider: 'apns', token: T, locale: 'en', appVersion: '1.0.3', revokedAt: null });
    // The same requestId and body: the receipt replays the first answer and writes nothing.
    const again = await enroll(body);
    expect(again.body).toEqual(first.body);
    expect(await registrations(INSTALL)).toHaveLength(1);
    // The same requestId for a different command is a conflict, not a second binding.
    const conflict = await enroll({ ...body, token: APNS(2) });
    expect(conflict.body).toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect((await registrations(INSTALL)).map((r) => r.token)).toEqual([T]);
  });

  it('keeps one row for an unchanged token and revokes the old row when the token rotates', async () => {
    await enroll(enrollment());
    expect((await enroll(enrollment({ locale: 'ms' }))).body.change).toBe('unchanged');
    let rows = await registrations(INSTALL);
    expect(rows).toHaveLength(1);
    expect(rows[0].locale).toBe('ms');
    expect((await enroll(enrollment({ token: APNS(3) }))).body.change).toBe('rotated');
    rows = await registrations(INSTALL);
    expect(rows.map((r) => [r.token, r.revokeReason])).toEqual([[APNS(1), 'replaced'], [APNS(3), null]]);
    expect(rows.filter((r) => r.revokedAt == null)).toHaveLength(1);
  });

  it('a second login on the same installation revokes the first login’s binding; each sees only its own', async () => {
    await enroll(enrollment());
    caller = B.ctx;
    expect((await enroll(enrollment({ token: APNS(4) }))).body.outcome).toBe('registered');
    const rows = await registrations(INSTALL);
    expect(rows.map((r) => [r.userId, r.revokeReason])).toEqual([[A.userId, 'rebound'], [B.userId, null]]);
    expect((await status()).body).toMatchObject({ enabled: true, registered: true, platform: 'ios' });
    caller = A.ctx;
    expect((await status()).body).toMatchObject({ enabled: true, registered: false, platform: null });
    // RLS: as A, B's row is invisible; revoking as A touches nothing of B's.
    expect((await post(revokeRoute.POST, '/push/revoke', { requestId: randomUUID(), installationId: INSTALL, reason: 'logout' })).body).toEqual({ outcome: 'revoked', revoked: false });
    expect((await registrations(INSTALL)).find((r) => r.userId === B.userId)?.revokedAt).toBeNull();
  });

  it('a token that moves to another tenant revokes its old binding there', async () => {
    await enroll(enrollment({ platform: 'android', token: FCM(1) }));
    const other = await seedBase();
    await setModule(other.tenantId, 'notifications', 'active');
    const C = await hire('Chandra Elsewhere', other);
    caller = C.ctx;
    const moved = await enroll(enrollment({ platform: 'android', token: FCM(1), installationId: randomUUID() }));
    expect(moved.body).toMatchObject({ outcome: 'registered', provider: 'fcm', change: 'created' });
    const all = await owner.db.select().from(schema.mobilePushRegistration).where(eq(schema.mobilePushRegistration.token, FCM(1))).orderBy(asc(schema.mobilePushRegistration.createdAt));
    expect(all.map((r) => [r.tenantId, r.revokeReason])).toEqual([[base.tenantId, 'rebound'], [other.tenantId, null]]);
  });

  it('refuses with the module off or the permission not granted, and rejects a malformed command', async () => {
    expect((await enroll(enrollment({ permission: 'denied' }))).body).toEqual({ outcome: 'refused', code: 'permission_not_granted' });
    expect((await enroll(enrollment({ permission: 'undetermined' }))).body).toEqual({ outcome: 'refused', code: 'permission_not_granted' });
    expect((await enroll(enrollment({ token: 'not hex at all, with spaces' }))).status).toBe(400);
    expect((await enroll(enrollment({ platform: 'ios', token: FCM(9) }))).status).toBe(400); // an APNs token is hex
    // Identity never travels in the body: an extra field is refused, not obeyed.
    expect((await enroll({ ...enrollment(), userId: B.userId })).status).toBe(400);
    await setModule(base.tenantId, 'notifications', 'disabled');
    caller = { ...A.ctx, entitlements: harnessSnapshot(base.tenantId) };
    expect((await enroll(enrollment())).body).toEqual({ outcome: 'refused', code: 'notifications_off' });
    expect((await status()).body).toMatchObject({ enabled: false, registered: false });
    expect(await registrations(INSTALL)).toHaveLength(0);
  });

  it('revoke closes the caller’s binding with its reason and still works with the module off', async () => {
    await enroll(enrollment());
    await setModule(base.tenantId, 'notifications', 'disabled');
    caller = { ...A.ctx, entitlements: harnessSnapshot(base.tenantId) };
    const body = { requestId: randomUUID(), installationId: INSTALL, reason: 'turned_off' };
    expect((await post(revokeRoute.POST, '/push/revoke', body)).body).toEqual({ outcome: 'revoked', revoked: true });
    expect((await post(revokeRoute.POST, '/push/revoke', body)).body).toEqual({ outcome: 'revoked', revoked: true }); // replayed
    expect((await post(revokeRoute.POST, '/push/revoke', { ...body, requestId: randomUUID() })).body).toEqual({ outcome: 'revoked', revoked: false });
    const [row] = await registrations(INSTALL);
    expect(row.revokeReason).toBe('turned_off');
    expect(row.revokedAt).not.toBeNull();
    expect((await post(revokeRoute.POST, '/push/revoke', { ...body, requestId: randomUUID(), reason: 'because' })).status).toBe(400);
  });

  it('a binding is immutable and a revoked row is final, even for the owner', async () => {
    await enroll(enrollment());
    const [row] = await registrations(INSTALL);
    await expect(owner.db.update(schema.mobilePushRegistration).set({ userId: B.userId }).where(eq(schema.mobilePushRegistration.id, row.id))).rejects.toThrow();
    await owner.db.update(schema.mobilePushRegistration).set({ revokedAt: sql`now()`, revokeReason: 'logout' }).where(eq(schema.mobilePushRegistration.id, row.id));
    await expect(owner.db.update(schema.mobilePushRegistration).set({ revokedAt: null, revokeReason: null }).where(eq(schema.mobilePushRegistration.id, row.id))).rejects.toThrow();
  });
});

// ── The sweep ──────────────────────────────────────────────────────────────────────────────────────────────────

const PRIVATE_TITLE = 'Salary RM 7,345.67 for Aisyah Push — medical: dengue';
const PRIVATE_BODY = 'Aisyah Push, your MC for dengue fever was approved; basic 7345.67.';
function fake(outcome: PushSendOutcome = { outcome: 'sent', status: 200, reason: null }) {
  const sent: PushMessage[] = [];
  const transport: PushTransport = { send: vi.fn(async (m: PushMessage) => { sent.push(m); return outcome; }), close: vi.fn() };
  return { transport, sent };
}
const sweepCtx = (b: Base = base): SessionContext => ({ tenantId: b.tenantId, roles: ['hr_admin'], entitlements: harnessSnapshot(b.tenantId) });
/** A registration inserted as the owner, `ageMinutes` old, so recency and ordering are deliberate. */
async function register(who: Person, over: Partial<typeof schema.mobilePushRegistration.$inferInsert> = {}, ageMinutes = 1) {
  const [row] = await owner.db.insert(schema.mobilePushRegistration).values({
    tenantId: who.ctx.tenantId, userId: who.userId, installationId: randomUUID(), platform: 'ios', provider: 'apns', token: APNS(++tokenSeq), locale: 'en',
    createdAt: sql`now() - make_interval(mins => ${ageMinutes})`, updatedAt: sql`now() - make_interval(mins => ${ageMinutes})`, ...over,
  }).returning();
  return row;
}
async function notify(who: Person, over: Partial<typeof schema.notification.$inferInsert> = {}, ageMinutes = 0) {
  const [row] = await owner.db.insert(schema.notification).values({
    tenantId: who.ctx.tenantId, recipientEmploymentId: who.employmentId, kind: 'leave.approved', title: PRIVATE_TITLE, body: PRIVATE_BODY,
    linkPath: '/me/leave', severity: 'info', createdAt: sql`now() - make_interval(mins => ${ageMinutes})`, ...over,
  }).returning({ id: schema.notification.id });
  return row.id;
}
let tokenSeq = 300;
const deliveries = () => owner.db.select().from(schema.mobilePushDelivery).orderBy(asc(schema.mobilePushDelivery.claimedAt), asc(schema.mobilePushDelivery.id));

describe('delivery sweep (fake transports)', () => {
  it('sends ONE generic push per (notification, registration): no stored title, body, name or figure leaves', async () => {
    const reg = await register(A);
    const id = await notify(A);
    const apns = fake();
    const result = await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport });
    expect(result).toMatchObject({ enabled: true, installed: true, sent: 1, failed: 0, invalidToken: 0 });
    expect(apns.sent).toEqual([{ token: reg.token, title: PUSH_TITLE, body: PUSH_BODY.en, notificationId: id }]);
    const wire = JSON.stringify(apns.sent);
    for (const secret of ['7345', 'Aisyah', 'dengue', 'MC', '/me/leave', 'leave.approved']) expect(wire).not.toContain(secret);
    // The delivery record holds outcome and provider code only.
    const rows = await deliveries();
    expect(rows.map((r) => [r.notificationId, r.registrationId, r.outcome])).toEqual([[id, reg.id, 'sent']]);
    expect(Object.keys(rows[0]).sort()).toEqual(['claimedAt', 'completedAt', 'id', 'notificationId', 'outcome', 'providerReason', 'providerStatus', 'registrationId', 'tenantId']);
    // A second sweep sends nothing more.
    expect((await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport })).sent).toBe(0);
    expect(apns.sent).toHaveLength(1);
  });

  it('the registration’s language picks the generic body; Android goes to FCM only', async () => {
    const reg = await register(A, { platform: 'android', provider: 'fcm', token: FCM(2), locale: 'ms' });
    await notify(A);
    const apns = fake(), fcm = fake();
    await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport });
    expect(apns.sent).toHaveLength(0); // no transport for the registration's provider ⇒ nothing recorded
    expect(await deliveries()).toHaveLength(0);
    await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport, fcm: fcm.transport });
    expect(fcm.sent).toEqual([expect.objectContaining({ token: reg.token, title: PUSH_TITLE, body: PUSH_BODY.ms })]);
  });

  it('two sweeps racing still send once', async () => {
    await register(A);
    await notify(A); await notify(A, { sourceEventId: randomUUID() });
    const apns = fake();
    const [x, y] = await Promise.all([deliverMobilePush(sweepCtx(), owner, { apns: apns.transport }), deliverMobilePush(sweepCtx(), owner, { apns: apns.transport })]);
    expect(x.sent + y.sent).toBe(2);
    expect(apns.sent).toHaveLength(2);
    expect(new Set(apns.sent.map((m) => m.notificationId)).size).toBe(2);
  });

  it('only unread, recent notifications created after the registration', async () => {
    await register(A, {}, 5 * 60);
    const fresh = await notify(A, {}, 30);
    await notify(A, { readAt: new Date() });
    await notify(A, {}, PUSH_RECENCY_MINUTES + 30);
    await notify(A, {}, 6 * 60); // before the registration existed
    const apns = fake();
    await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport });
    expect(apns.sent.map((m) => m.notificationId)).toEqual([fresh]);
  });

  it('never to a revoked registration, an archived login or a blocked login', async () => {
    await register(A, { revokedAt: new Date(), revokeReason: 'logout' });
    await notify(A);
    await register(B);
    await notify(B);
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, B.userId));
    const C = await hire('Chen Blocked');
    await register(C);
    await notify(C);
    await owner.db.update(schema.employment).set({ blacklistedAt: todayInKualaLumpur() }).where(eq(schema.employment.id, C.employmentId));
    const apns = fake();
    const result = await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport });
    expect(apns.sent).toHaveLength(0);
    expect(result.sent).toBe(0);
    expect(await deliveries()).toHaveLength(0);
  });

  it('coalesces one source event into one push per registration', async () => {
    await register(A);
    const event = randomUUID();
    await notify(A, { sourceEventId: event }); await notify(A, { sourceEventId: event });
    const apns = fake();
    const result = await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport });
    expect(apns.sent).toHaveLength(1);
    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect((await deliveries()).map((d) => [d.outcome, d.providerReason]).sort()).toEqual([['sent', null], ['skipped', 'coalesced']]);
  });

  it('an invalid token revokes the registration and is never retried; a failure is recorded, not retried', async () => {
    const dead = await register(A);
    await notify(A);
    const gone = fake({ outcome: 'invalid_token', status: 410, reason: 'Unregistered' });
    expect((await deliverMobilePush(sweepCtx(), owner, { apns: gone.transport })).invalidToken).toBe(1);
    const [row] = await owner.db.select().from(schema.mobilePushRegistration).where(eq(schema.mobilePushRegistration.id, dead.id));
    expect(row.revokeReason).toBe('invalid_token');
    expect((await deliveries()).map((d) => [d.outcome, d.providerStatus, d.providerReason])).toEqual([['invalid_token', 410, 'Unregistered']]);
    const live = await register(B);
    await notify(B);
    const broken = fake({ outcome: 'failed', status: 500, reason: 'InternalServerError' });
    await deliverMobilePush(sweepCtx(), owner, { apns: broken.transport });
    await deliverMobilePush(sweepCtx(), owner, { apns: broken.transport });
    expect(broken.sent).toHaveLength(1);
    const [again] = await owner.db.select().from(schema.mobilePushRegistration).where(and(eq(schema.mobilePushRegistration.id, live.id), isNull(schema.mobilePushRegistration.revokedAt)));
    expect(again).toBeDefined(); // a provider failure revokes nothing
  });

  it('keys absent ⇒ a no-op that records nothing; the module off ⇒ nothing sent; only its own tenant', async () => {
    await register(A);
    await notify(A);
    expect(await deliverMobilePush(sweepCtx(), owner, {})).toMatchObject({ enabled: false, sent: 0 });
    expect(await deliveries()).toHaveLength(0);
    const other = await seedBase();
    await setModule(other.tenantId, 'notifications', 'active');
    const apns = fake();
    expect((await deliverMobilePush(sweepCtx(other), owner, { apns: apns.transport })).sent).toBe(0);
    await setModule(base.tenantId, 'notifications', 'disabled');
    expect((await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport })).sent).toBe(0);
    expect(apns.sent).toHaveLength(0);
  });

  it('refuses an application-role connection or a user context instead of silently sending nothing', async () => {
    const { withTenant } = await import('../db/client');
    await expect(deliverMobilePush(sweepCtx(), { withTenant }, { apns: fake().transport })).rejects.toThrow(/owning database role/);
    await expect(deliverMobilePush(A.ctx, owner, { apns: fake().transport })).rejects.toThrow(/maintenance context/);
  });

  it('an enrollment through the route is what the sweep delivers to', async () => {
    await enroll(enrollment({ token: APNS(7) }));
    const id = await notify(A);
    const apns = fake();
    await deliverMobilePush(sweepCtx(), owner, { apns: apns.transport });
    expect(apns.sent).toEqual([{ token: APNS(7), title: PUSH_TITLE, body: PUSH_BODY.en, notificationId: id }]);
  });
});
