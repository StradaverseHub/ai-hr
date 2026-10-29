/**
 * Minute push delivery (M10, D6): unread in-app notifications become one generic push per registration, direct to
 * APNs/FCM (core/mobile-push-delivery.ts). Run under flock from cron, never from a web request. NOT installed in any
 * crontab: activation is an operator step (deploy/DEPLOY.md, "Mobile push sweep").
 *
 * With no provider keys configured this is a logged no-op and exits 0. It reads notifications projected by
 * scripts/notification-email-sweep.ts; it does not project any itself.
 */
import { createDb, type SessionContext } from '../db/client';
import { loadSweepScope, describeSkips } from '../core/sweep-scope';
import { resolveEntitlementsTx } from '../core/entitlements';
import { deliverMobilePush } from '../core/mobile-push-delivery';
import { createConfiguredPushTransports } from '../lib/mobile-push-config';

async function main() {
  const transports = createConfiguredPushTransports();
  // Outcome counts only: never a token, a key, a notification's text or a provider's response body.
  if (!transports.apns && !transports.fcm) { console.log(JSON.stringify({ push: 'disabled', reason: 'no_provider_configured' })); process.exit(0); }
  const url = process.env.MIGRATION_DATABASE_URL; if (!url) throw new Error('Migration database required');
  const owner = createDb(url); let failed = 0;
  try {
    const scope = await loadSweepScope(owner.db); for (const line of describeSkips(scope)) console.log(line);
    for (const tenant of scope.run) {
      try {
        const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, tenant.id));
        const ctx: SessionContext = { tenantId: tenant.id, roles: ['hr_admin'], entitlements };
        console.log(JSON.stringify({ tenantId: tenant.id, ...(await deliverMobilePush(ctx, owner, transports)) }));
      } catch { failed++; console.error('Push sweep failed for tenant ' + tenant.id); }
    }
  } finally { transports.apns?.close(); transports.fcm?.close(); await owner.client.end(); }
  process.exit(failed ? 1 : 0);
}
main().catch(() => { console.error('Push sweep failed.'); process.exit(1); });
