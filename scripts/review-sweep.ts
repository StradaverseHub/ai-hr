// `review:sweep` (0110) — automated probation/contract/internship review opener, run out-of-band
// (CLI/cron) like accrue-earned.ts. Enumerates tenants with the owner role, then runs sweepDueReviews
// per tenant with a SYSTEM context (no userId → the domain event's actor is `system`; roles:['hr_admin']
// authorizes the writes and lets app.is_admin() see every tenant employment). Then dispatches
// notifications IN THE SAME SCRIPT — otherwise the "notify manager + HR ~1 month prior" headline is dead
// in a no-admin-traffic window (dispatchNotifications is otherwise only invoked opportunistically when an
// admin renders a page). Notifications are gated behind NOTIFICATIONS_ENABLED (off ⇒ dispatch no-ops).
// Idempotent: a re-run opens nothing already open. Schedule daily, e.g.
//   0 3 * * *  cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/review-sweep.ts
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { sweepDueReviews, sweepReviewReminders } from '../core/employment-review';
import { dispatchNotifications } from '../core/notifications';

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('review:sweep requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`review:sweep — ${tenants.length} tenant(s), today ${today}`);

  let totalOpened = 0;
  let totalReminders = 0;
  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context: no userId, so actorOf(ctx) records the event actor as `system`. The group-wide
      // hr_admin role authorizes the writes and lets the sweep see every tenant employment.
      const ctx = { tenantId: t.id, roles: ['hr_admin'] };
      const { opened } = await sweepDueReviews(ctx, { today });
      // 6522d26a Fn 2 — chase still-open reviews at the configured cadence (default 30/14/7 days before
      // the end date). Idempotent per (review, offset); runs AFTER the opener so a just-opened review is
      // eligible on the same day when already inside a window.
      const { reminders } = await sweepReviewReminders(ctx, { today });
      // Project the new started/reminder events into manager + HR notifications now (gated by NOTIFICATIONS_ENABLED).
      await dispatchNotifications(ctx);
      totalOpened += opened;
      totalReminders += reminders;
      console.log(`  ✓ ${t.name} (${t.id}): ${opened} review(s) opened, ${reminders} reminder(s)`);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `review:sweep done — ${totalOpened} review(s) opened, ${totalReminders} reminder(s) across ${tenants.length} tenant(s), ${failures} failure(s).`,
  );
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
