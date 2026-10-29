/**
 * M10 (D6) — push enrollment for one installation of the app: enroll, revoke and status, COMPOSITION over the 0673
 * draft tables (db/migrations/0673_mobile_push_tokens.sql) and the mobile command receipt.
 *
 * THE BINDING IS (tenant, user, installation). Tenant and user are the bearer session's, never a body field; the
 * receipt's subject is the caller's own selected employment (core/mobile-command-receipt.ts), which the binding does
 * not depend on. Under the caller's session:
 *   1. advisory locks on the token and on the installation serialise a racing enrollment of either;
 *   2. app.mobile_push_release revokes ('rebound') every OTHER active binding of this installation in the tenant
 *      (another login on this phone) and of this token anywhere (the token moved to another user or tenant);
 *   3. the caller's own active row for the installation is kept (same token: `unchanged`), or revoked ('replaced')
 *      and a new row written (`rotated`), or a first row written (`created`). A binding is never rewritten.
 * Revoke closes the caller's own active row for the installation; nothing active is `revoked: false`, not a refusal.
 *
 * Gated like the inbox: the Notifications module off ⇒ nothing is enrolled (revoke still works). The token is never
 * answered back, so the receipt (which stores the answer) never holds it. Kept free of 'server-only'.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { mobilePushRegistration } from '../db/schema';
import { isModuleEnabled } from './entitlements';
import { withMobileCommandReceipt } from './mobile-command-receipt';
import { pushDeliveryAvailability } from '../lib/mobile-push-config';
import {
  PROVIDER_OF, PushEnrollmentResult, PushRevokeResult,
  type PushEnrollmentCommand, type PushRevokeCommand, type PushStatusV2,
} from '../lib/mobile-api/v2/push';

const enabled = (ctx: SessionContext) => isModuleEnabled(ctx, 'notifications');
const R = mobilePushRegistration;

/** Enroll (or keep) this installation's token for the caller. Replays its first answer under the same requestId. */
export async function enrollPushV2(ctx: SessionContext, employmentId: string, command: PushEnrollmentCommand): Promise<PushEnrollmentResult> {
  if (!enabled(ctx)) return { outcome: 'refused', code: 'notifications_off' };
  if (command.permission !== 'granted' && command.permission !== 'provisional') return { outcome: 'refused', code: 'permission_not_granted' };
  const userId = ctx.userId!, installationId = command.installationId.toLowerCase(), platform = command.platform, provider = PROVIDER_OF[platform];
  // An APNs token is hex in either case; one spelling, so one token cannot hold two bindings.
  const token = platform === 'ios' ? command.token.toLowerCase() : command.token;
  const locale = command.locale, appVersion = command.appVersion ?? null, appBuild = command.appBuild ?? null;
  const delivery = pushDeliveryAvailability()[platform];
  return withMobileCommandReceipt(ctx, {
    kind: 'push.enrollment', requestId: command.requestId, actorEmploymentId: employmentId, response: PushEnrollmentResult,
    intent: { installationId, platform, token, permission: command.permission, locale, appVersion, appBuild },
  }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'mobile-push-token:' + provider + ':' + token},0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'mobile-push-installation:' + ctx.tenantId + ':' + installationId},0))`);
    await tx.execute(sql`select app.mobile_push_release(${installationId}::uuid,${provider},${token})`);
    const [current] = await tx.select({ id: R.id, token: R.token, platform: R.platform }).from(R).where(and(
      eq(R.tenantId, ctx.tenantId), eq(R.userId, userId), eq(R.installationId, installationId), isNull(R.revokedAt))).limit(1);
    if (current && current.token === token && current.platform === platform) {
      await tx.update(R).set({ locale, appVersion, appBuild, updatedAt: sql`now()` }).where(eq(R.id, current.id));
      return { outcome: 'registered' as const, platform, provider, change: 'unchanged' as const, delivery };
    }
    if (current) await tx.update(R).set({ revokedAt: sql`now()`, revokeReason: 'replaced', updatedAt: sql`now()` }).where(eq(R.id, current.id));
    await tx.insert(R).values({ tenantId: ctx.tenantId, userId, installationId, platform, provider, token, locale, appVersion, appBuild });
    return { outcome: 'registered' as const, platform, provider, change: current ? 'rotated' as const : 'created' as const, delivery };
  });
}

/** Stop push on this installation for the caller (logout, turned off, company switch, permission denied). */
export async function revokePushV2(ctx: SessionContext, employmentId: string, command: PushRevokeCommand): Promise<PushRevokeResult> {
  const userId = ctx.userId!, installationId = command.installationId.toLowerCase();
  return withMobileCommandReceipt(ctx, {
    kind: 'push.revoke', requestId: command.requestId, actorEmploymentId: employmentId, response: PushRevokeResult,
    intent: { installationId, reason: command.reason },
  }, async (tx) => {
    const closed = await tx.update(R).set({ revokedAt: sql`now()`, revokeReason: command.reason, updatedAt: sql`now()` })
      .where(and(eq(R.tenantId, ctx.tenantId), eq(R.userId, userId), eq(R.installationId, installationId), isNull(R.revokedAt)))
      .returning({ id: R.id });
    return { outcome: 'revoked' as const, revoked: closed.length > 0 };
  });
}

/** The caller's own active binding for one installation, and whether this server can deliver to each platform. */
export async function pushStatusV2(ctx: SessionContext, installationId: string): Promise<PushStatusV2> {
  const delivery = pushDeliveryAvailability();
  if (!enabled(ctx)) return { enabled: false, registered: false, platform: null, updatedAt: null, delivery };
  const userId = ctx.userId;
  if (!userId) return { enabled: true, registered: false, platform: null, updatedAt: null, delivery };
  const [row] = await withTenant(ctx, (tx) => tx.select({ platform: R.platform, updatedAt: R.updatedAt }).from(R).where(and(
    eq(R.tenantId, ctx.tenantId), eq(R.userId, userId), eq(R.installationId, installationId.toLowerCase()), isNull(R.revokedAt))).limit(1));
  return { enabled: true, registered: !!row, platform: row?.platform ?? null, updatedAt: row ? new Date(row.updatedAt).toISOString() : null, delivery };
}
