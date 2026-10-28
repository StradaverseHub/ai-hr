/**
 * M10 (D6) — the push delivery sweep: new in-app notifications become ONE generic push per (notification,
 * registration), sent DIRECT to APNs/FCM. Modelled on core/notification-email-delivery.ts and driven by
 * scripts/mobile-push-sweep.ts; never called from a web request.
 *
 * WHAT IS SENT. genericPushMessage (lib/mobile-push-message.ts): a fixed title, a fixed body in the registration's
 * language and `{notificationId}`. The notification's stored title and body are never read by this module's query, so
 * nothing private can reach a provider; the app reads the text over the authenticated API after unlock.
 *
 * WHO. A notification's recipient employment → its person → that person's login in the tenant → that login's active
 * registrations. A candidate is a notification that is unread, created after the registration was, and recent
 * (PUSH_RECENCY_MINUTES): turning push on, or configuring keys later, never replays a backlog. Notifications of one
 * source event for two employments of the same login are coalesced into one push per registration.
 *
 * AT MOST ONCE. Each send is CLAIMED first — an INSERT of the (notification, registration) delivery row, unique, that
 * re-checks at that moment that the registration is not revoked, the notification still unread and the login neither
 * archived nor blocked — and committed before the provider is called. A concurrent sweep loses the claim; a crash after
 * the call leaves the row `pending`, which is never retried. A provider failure is recorded and not retried either.
 * `invalid_token` (APNs 410/BadDeviceToken, FCM UNREGISTERED/INVALID_ARGUMENT on the token) revokes the registration.
 *
 * KEYS ABSENT ⇒ NO-OP. A provider without a transport is skipped entirely and records nothing.
 *
 * THE CONNECTION. The registration tables are RLS-enabled, not forced (0671 says why): the sweep must run as their
 * owning migration role. On the application role it would see no registrations and silently send nothing, so it
 * refuses to run there instead.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import type { NotificationSweepConnection } from './notice-projection';
import { isModuleEnabled } from './entitlements';
import { genericPushMessage, safeProviderReason, type PushSendOutcome, type PushTransports } from '../lib/mobile-push-message';

/** Older notifications stay in the inbox but are not pushed. Engineering bound, not notification policy. */
export const PUSH_RECENCY_MINUTES = 120;
/** Candidates read per tenant per run, and the wall-clock budget for sending them (a minute cron). */
export const PUSH_SWEEP_LIMIT = 200;
export const PUSH_SWEEP_BUDGET_MS = 45_000;

type Provider = 'apns' | 'fcm';
type Candidate = {
  notification_id: string; source_event_id: string | null; company_id: string;
  registration_id: string; provider: Provider; token: string; locale: 'en' | 'ms';
};
export type PushSweepResult = {
  enabled: boolean; installed: boolean; providers: { apns: boolean; fcm: boolean };
  candidates: number; sent: number; invalidToken: number; failed: number; skipped: number; deferred: number;
};

/** The registration table exists here and this connection bypasses its row security as its owner (or superuser). */
async function pushSweepConnection(tx: Tx): Promise<'ready' | 'not_installed'> {
  const [row] = await tx.execute(sql`
    SELECT to_regclass('public.mobile_push_registration') IS NOT NULL AND to_regclass('public.mobile_push_delivery') IS NOT NULL AS installed,
     coalesce((SELECT current_user::text<>'ai_hr_app' AND bool_and(r.rolsuper OR r.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')))
      FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_roles r
      WHERE r.rolname=current_user AND c.oid IN (to_regclass('public.mobile_push_registration'),to_regclass('public.mobile_push_delivery'),to_regclass('public.notification'))),false) AS privileged
  `) as unknown as { installed: boolean; privileged: boolean }[];
  if (!row?.installed) return 'not_installed';
  if (!row.privileged) throw Error('Push sweep requires the owning database role.');
  return 'ready';
}

const providerList = (providers: Provider[]): SQL => sql.join(providers.map((p) => sql`${p}`), sql`, `);

/** Claim one (notification, registration) — re-checking eligibility now — or nothing. Returns the delivery id. */
async function claim(tx: Tx, tenantId: string, c: Candidate, skipped: boolean): Promise<string | null> {
  const rows = await tx.execute(sql`
    INSERT INTO mobile_push_delivery(tenant_id,notification_id,registration_id,outcome,provider_reason,completed_at)
    SELECT ${tenantId}::uuid,n.id,r.id,${skipped ? 'skipped' : 'pending'},${skipped ? 'coalesced' : null},${skipped ? sql`now()` : sql`NULL`}
    FROM notification n
    JOIN mobile_push_registration r ON r.id=${c.registration_id}::uuid AND r.tenant_id=n.tenant_id
    JOIN app_user u ON u.id=r.user_id AND u.tenant_id=r.tenant_id
    WHERE n.id=${c.notification_id}::uuid AND n.tenant_id=${tenantId}::uuid AND n.read_at IS NULL
     AND r.revoked_at IS NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    ON CONFLICT (notification_id,registration_id) DO NOTHING
    RETURNING id
  `) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

async function record(tx: Tx, deliveryId: string, registrationId: string, out: PushSendOutcome) {
  await tx.execute(sql`
    UPDATE mobile_push_delivery SET outcome=${out.outcome},provider_status=${out.status},provider_reason=${safeProviderReason(out.reason)},completed_at=now()
    WHERE id=${deliveryId}::uuid AND outcome='pending'
  `);
  if (out.outcome === 'invalid_token') await tx.execute(sql`
    UPDATE mobile_push_registration SET revoked_at=now(),revoke_reason='invalid_token',updated_at=now()
    WHERE id=${registrationId}::uuid AND revoked_at IS NULL
  `);
}

/**
 * One tenant's run. `ctx` is a maintenance context (no user) whose entitlements gate the Notifications module, whole
 * tenant or per company; `connection` is the owner connection; `transports` the configured providers (absent ⇒ off).
 */
export async function deliverMobilePush(
  ctx: SessionContext,
  connection: NotificationSweepConnection,
  transports: PushTransports,
  opts: { limit?: number; budgetMs?: number; now?: () => number } = {},
): Promise<PushSweepResult> {
  if (ctx.userId) throw Error('Push sweep requires a maintenance context.');
  const providers = { apns: !!transports.apns, fcm: !!transports.fcm };
  const result: PushSweepResult = { enabled: providers.apns || providers.fcm, installed: true, providers, candidates: 0, sent: 0, invalidToken: 0, failed: 0, skipped: 0, deferred: 0 };
  if (!result.enabled) return result;
  const wholeTenant = isModuleEnabled(ctx, 'notifications');
  if (!wholeTenant && !(ctx.entitlements?.scopedModules.notifications ?? []).some((companyId) => isModuleEnabled(ctx, 'notifications', companyId))) return result;
  const wanted = (['apns', 'fcm'] as const).filter((p) => providers[p]);
  const limit = Math.min(Math.max(opts.limit ?? PUSH_SWEEP_LIMIT, 1), 1000);
  const now = opts.now ?? Date.now, deadline = now() + (opts.budgetMs ?? PUSH_SWEEP_BUDGET_MS);

  const found = await connection.withTenant(ctx, async (tx) => {
    if (await pushSweepConnection(tx) === 'not_installed') return null;
    // No title, body or link column is selected: the push cannot carry what the query never read.
    return await tx.execute(sql`
      SELECT n.id AS notification_id,n.source_event_id,e.company_id,r.id AS registration_id,r.provider,r.token,r.locale
      FROM notification n
      JOIN employment e ON e.id=n.recipient_employment_id AND e.tenant_id=n.tenant_id
      JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
      JOIN mobile_push_registration r ON r.tenant_id=u.tenant_id AND r.user_id=u.id AND r.revoked_at IS NULL
      WHERE n.tenant_id=${ctx.tenantId}::uuid AND n.read_at IS NULL
       AND n.created_at>=r.created_at AND n.created_at>now()-make_interval(mins=>${PUSH_RECENCY_MINUTES})
       AND r.provider IN (${providerList([...wanted])})
       AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
       AND NOT EXISTS(SELECT 1 FROM mobile_push_delivery d WHERE d.notification_id=n.id AND d.registration_id=r.id)
      ORDER BY n.created_at,n.id,r.id
      LIMIT ${limit}
    `) as unknown as Candidate[];
  }, { readOnlySnapshot: true });
  if (found === null) return { ...result, installed: false };
  const candidates = wholeTenant ? found : found.filter((c) => isModuleEnabled(ctx, 'notifications', c.company_id));
  result.candidates = candidates.length;

  // One push per registration per source event (two employments of one login, one event).
  const sentFor = new Set<string>();
  for (const c of candidates) {
    if (now() > deadline) { result.deferred++; continue; }
    const transport = transports[c.provider];
    if (!transport) continue;
    const group = `${c.registration_id}:${c.source_event_id ?? c.notification_id}`;
    const duplicate = sentFor.has(group);
    const deliveryId = await connection.withTenant(ctx, (tx) => claim(tx, ctx.tenantId, c, duplicate));
    if (!deliveryId) continue; // claimed elsewhere, or no longer eligible
    if (duplicate) { result.skipped++; continue; }
    sentFor.add(group);
    let out: PushSendOutcome;
    try { out = await transport.send(genericPushMessage(c.locale, c.token, c.notification_id)); }
    catch { out = { outcome: 'failed', status: null, reason: 'transport_error' }; }
    await connection.withTenant(ctx, (tx) => record(tx, deliveryId, c.registration_id, out));
    if (out.outcome === 'sent') result.sent++;
    else if (out.outcome === 'invalid_token') result.invalidToken++;
    else result.failed++;
  }
  return result;
}
