// `review:sweep` (0110) — automated probation/contract/internship review opener, run out-of-band
// (CLI/cron) like accrue-earned.ts. Enumerates tenants with the owner role, then runs sweepDueReviews
// per tenant with a SYSTEM context (no userId → the domain event's actor is `system`; roles:['hr_admin']
// authorizes the writes and lets app.is_admin() see every tenant employment). Then dispatches
// notifications IN THE SAME SCRIPT — otherwise the "notify manager + HR ~1 month prior" headline is dead
// in a no-admin-traffic window (dispatchNotifications is otherwise only invoked opportunistically when an
// admin renders a page). Notifications are gated behind NOTIFICATIONS_ENABLED (off ⇒ dispatch no-ops).
// R51 722904dc/71b9143a: the SAME nightly pass also drives LEAVE APPROVAL ESCALATION
// (sweepLeaveApprovalEscalations) — leave requests whose current approval step has sat pending past the
// company's configured working-day threshold get a bell notification for the next approver. One job, no
// second cron line to drift.
// Idempotent: a re-run opens nothing already open (and escalation fires once per (group, step) ever).
// Schedule daily, e.g.
//   0 3 * * *  cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/review-sweep.ts
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { sweepDueReviews, sweepReviewReminders } from '../core/employment-review';
import { sweepLeaveApprovalEscalations } from '../core/leave-escalation';
import { dispatchNotifications } from '../core/notifications';
import { todayInKualaLumpur } from '../core/leave';
import { recordJobRun } from '../core/job-run';

async function main() {
  const startedAt = Date.now();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('review:sweep requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  // MYT, not UTC — see accrue-earned.ts. Scheduled 03:00 local, which is the previous day in UTC, so a
  // review due today would be missed by a day.
  const today = todayInKualaLumpur();
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`review:sweep — ${tenants.length} tenant(s), today ${today}`);

  let totalOpened = 0;
  let totalReminders = 0;
  let totalEscalated = 0;
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
      // R51 722904dc/71b9143a — chase leave approval steps sitting past the company's escalation
      // threshold (once per (group, step) ever; the escalation-due events fan out below).
      const { escalated } = await sweepLeaveApprovalEscalations(ctx, { today });
      // Project the new started/reminder/escalation events into notifications now (gated by NOTIFICATIONS_ENABLED).
      await dispatchNotifications(ctx);
      totalOpened += opened;
      totalReminders += reminders;
      totalEscalated += escalated;
      console.log(`  ✓ ${t.name} (${t.id}): ${opened} review(s) opened, ${reminders} reminder(s), ${escalated} escalation(s)`);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `review:sweep done — ${totalOpened} review(s) opened, ${totalReminders} reminder(s), ${totalEscalated} escalation(s) across ${tenants.length} tenant(s), ${failures} failure(s).`,
  );
  // 0280 run log, in its OWN try/catch — see accrue-earned.ts. NOTE for anyone reading the screen: a
  // 'success' here does NOT prove mail was sent. dispatchNotifications is gated by NOTIFICATIONS_ENABLED
  // and no-ops when it is off, while the run still records success.
  try {
    await recordJobRun(owner.db, {
      jobKey: 'review.sweep',
      startedAt,
      tenantsProcessed: tenants.length,
      tenantsFailed: failures,
      result: { opened: totalOpened, reminders: totalReminders, escalated: totalEscalated },
    });
  } catch (e) {
    console.error(`review:sweep — could not write the run log: ${(e as Error).message}`);
  }
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
