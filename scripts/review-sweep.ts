// `review:sweep` (0110) — automated probation/contract/internship review opener, run out-of-band
// (CLI/cron) like accrue-earned.ts. Enumerates tenants with the owner role, then runs sweepDueReviews
// per tenant with a SYSTEM context (no userId → the domain event's actor is `system`; roles:['hr_admin']
// authorizes the writes and lets app.is_admin() see every tenant employment). Then dispatches
// notifications IN THE SAME SCRIPT — otherwise the "notify manager + HR ~1 month prior" headline is dead
// in a no-admin-traffic window (dispatchNotifications is otherwise only invoked opportunistically when an
// admin renders a page). Notifications are gated behind the per-tenant `notifications` MODULE (off ⇒
// dispatch no-ops). Conditional email is queued here and delivered by the separate minute email sweep.
// r83b 941c9dac: the same pass also APPLIES FUTURE-DATED MOVEMENTS (sweepDueMovements) — a promotion or
// transfer keyed with a future effective date is held Pending and takes effect on the morning of that
// date. Same job for the same reason: a second cron line is a second thing to forget to install.
// r237 (ADR-0084 §2.5): the SAME nightly pass also runs the READINESS NUDGE AGENT, and folding it in
// rather than adding a cron line is a deliberate reading of this file's own advice — "a second cron line
// is a second thing to forget to install". r230 is the proof: the anomaly sweep sat BUILT, DOCUMENTED and
// never installed in the crontab for six weeks. The nudge agent is additionally OFF per tenant by default
// (notifications.readiness_nudge_enabled), so an installed job with no opted-in tenant sends nothing.
// R51 722904dc/71b9143a: the SAME nightly pass also drives LEAVE APPROVAL ESCALATION
// (sweepLeaveApprovalEscalations) — leave requests whose current approval step has sat pending past the
// company's configured working-day threshold get a bell notification for the next approver. One job, no
// second cron line to drift.
// Idempotent: a re-run opens nothing already open (and escalation fires once per (group, step) ever).
// Schedule daily, e.g.
//   0 3 * * *  cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/review-sweep.ts
import { createDb, type SessionContext } from '../db/client';
import { describeSkips, loadSweepScope } from '../core/sweep-scope';
import { sweepDueReviews, sweepReviewReminders } from '../core/employment-review';
import { sweepLeaveApprovalEscalations } from '../core/leave-escalation';
import { sweepDueMovements } from '../core/movement-apply';
import { sweepReadinessNudges } from '../core/readiness-nudge';
import { triagePendingClaims } from '../core/input-triage';
import { dispatchNotifications } from '../core/notifications';
import { todayInKualaLumpur } from '../core/leave';
import { recordJobRun } from '../core/job-run';
import { resolveEntitlementsTx } from '../core/entitlements';

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
  // ADR-0077 slice 9 — standing is consulted BEFORE any transaction opens. A tenant that is not in
  // good standing is stepped over, not attempted: withTenant would refuse the writes anyway, and
  // discovering that as a read-only error would report a suspended customer as a nightly failure.
  const scope = await loadSweepScope(owner.db);
  const tenants = scope.run;
  console.log(`review:sweep — ${tenants.length} tenant(s) in scope, today ${today}` +
    (scope.skipped.length > 0 ? `, ${scope.skipped.length} skipped` : ''));
  for (const line of describeSkips(scope)) console.log(line);

  let totalOpened = 0;
  let totalReminders = 0;
  let totalEscalated = 0;
  let totalMovements = 0;
  let totalNudges = 0;
  let totalNudgesSettled = 0;
  let nudgeTenants = 0;
  let triageTenants = 0;
  let totalQueries = 0;
  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context: no userId, so actorOf(ctx) records the event actor as `system`. The group-wide
      // hr_admin role authorizes the writes and lets the sweep see every tenant employment.
      //
      // A REAL snapshot, not `entitlementsExempt: 'sweeps'`, because this sweep calls
      // `dispatchNotifications`, which is gated on the BILLABLE `notifications` module. The exempt
      // marker makes `isModuleEnabled` answer TRUE unconditionally, so an exempt context would have
      // dispatched notifications for every tenant on the box — including tenants that never bought the
      // module. That is the exact enforcement bypass ADR-0077 slice 3 exists to close, and it fails
      // silently in the direction nobody notices: the customer gets a feature, not an error.
      //
      // (No live regression today — NOTIFICATIONS_ENABLED is on in the demo deployment and the backfill
      // grants the module to every pre-existing tenant at env value — but the first tenant provisioned
      // WITHOUT notifications would have received them anyway, via this cron only.)
      //
      // Safe on the owner connection: RLS does not bind the owner role, so the snapshot query sees the
      // tenant's rows. The other three sweeps below it are core/ungated surfaces, but resolving once per
      // tenant is cheap and keeps every gated call this loop makes honest as more gates land.
      const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, t.id));
      const ctx: SessionContext = { tenantId: t.id, roles: ['hr_admin'], entitlements };
      const { opened } = await sweepDueReviews(ctx, { today });
      // 6522d26a Fn 2 — chase still-open reviews at the configured cadence (default 30/14/7 days before
      // the end date). Idempotent per (review, offset); runs AFTER the opener so a just-opened review is
      // eligible on the same day when already inside a window.
      const { reminders } = await sweepReviewReminders(ctx, { today });
      // R51 722904dc/71b9143a — chase leave approval steps sitting past the company's escalation
      // threshold (once per (group, step) ever; the escalation-due events fan out below).
      const { escalated } = await sweepLeaveApprovalEscalations(ctx, { today });
      // 941c9dac — put every future-dated movement whose effective date has arrived into effect. Safe to
      // run twice on the same day: due-ness is read from the ledger, and applying appends the record that
      // removes the movement from the due set (migration 0329 makes that unique).
      const { applied: movementsApplied, failed: movementsFailed } = await sweepDueMovements(ctx, { today });
      // ADR-0084 §2.5 — chase incomplete records. Runs BEFORE dispatch so the nudge events it appends
      // become notifications in this same pass rather than waiting a day for the next admin page load.
      // Returns `disabled` for a tenant that has not switched it on, which is the default and is not a
      // failure; those tenants are simply not counted below.
      const nudge = await sweepReadinessNudges(ctx);
      if (!nudge.disabled) nudgeTenants += 1;

      // ADR-0084 §2.7 — read the claims filed since the last pass and ask the CLAIMANT about anything
      // that does not fit. Also before dispatch, for the same reason as the nudge above.
      //
      // ⚠️ ITS OWN try/catch. A provider outage or a rate limit must not cost this tenant the review
      // openings, the reminders, the escalations and the movements this pass has already computed — those
      // are the part somebody depends on tonight, and triage is the part nobody has ever had.
      let triage = { disabled: true, queried: 0, asked: 0, cleared: 0, rejected: 0, candidates: 0, cappedOut: false, notConfigured: false };
      try {
        triage = await triagePendingClaims(ctx);
        if (!triage.disabled) triageTenants += 1;
        totalQueries += triage.queried;
      } catch (e) {
        console.error(`  ✗ triage ${t.name}: ${(e as Error).message}`);
      }

      // Project the new started/reminder/escalation/nudge events into notifications now — gated on the
      // tenant's `notifications` entitlement, which the snapshot above makes this context answer truthfully.
      await dispatchNotifications(ctx);
      totalOpened += opened;
      totalReminders += reminders;
      totalEscalated += escalated;
      totalMovements += movementsApplied;
      totalNudges += nudge.sent;
      totalNudgesSettled += nudge.settled;
      console.log(
        `  ✓ ${t.name} (${t.id}): ${opened} review(s) opened, ${reminders} reminder(s), ${escalated} escalation(s), ${movementsApplied} movement(s) applied` +
          (movementsFailed > 0 ? ` — ${movementsFailed} movement(s) COULD NOT be applied` : '') +
          // Every nudge counter is printed, not just the flattering one: `orphaned` means a real gap with
          // nobody to tell, and `cappedOut` means work was left undone. A sweep that reports only what it
          // did reads as complete when it was truncated (AGENTS: no silent caps).
          (nudge.disabled
            ? ', nudges off'
            : `, ${nudge.sent} nudge(s)` +
              (nudge.cooled > 0 ? `, ${nudge.cooled} in cooldown` : '') +
              (nudge.settled > 0 ? `, ${nudge.settled} outcome(s) judged` : '') +
              (nudge.orphaned > 0 ? ` — ⚠ ${nudge.orphaned} gap(s) with NO ONE to notify` : '') +
              (nudge.cappedOut ? ' — ⚠ CAPPED, more remain' : '')) +
          // Same rule as the nudge counters: every one is printed, including the unflattering ones. A
          // discarded proposal is the adjudicator refusing a question we would otherwise have put in
          // front of an employee, and it is the number this feature is measured on.
          (triage.disabled
            ? ', triage off'
            : `, triage ${triage.candidates} claim(s)` +
              (triage.queried > 0 ? ` — ${triage.queried} question(s) raised` : ' — none to ask about') +
              (triage.cleared > 0 ? `, ${triage.cleared} read and clear` : '') +
              (triage.rejected > 0 ? `, ⚠ ${triage.rejected} discarded` : '') +
              (triage.notConfigured ? ' [no AI provider]' : '') +
              (triage.cappedOut ? ' — ⚠ CAPPED, more remain' : '')),
      );
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `review:sweep done — ${totalOpened} review(s) opened, ${totalReminders} reminder(s), ${totalEscalated} escalation(s), ${totalMovements} movement(s) applied, ${totalNudges} nudge(s) across ${nudgeTenants} opted-in tenant(s), ${totalNudgesSettled} nudge outcome(s) judged, ${totalQueries} claim question(s) across ${triageTenants} opted-in tenant(s), across ${tenants.length} tenant(s), ${failures} failure(s).` +
      (scope.skipped.length > 0 ? ` ${scope.skipped.length} tenant(s) skipped for standing.` : ''),
  );
  // 0280 run log, in its OWN try/catch — see accrue-earned.ts. NOTE for anyone reading the screen: a
  // 'success' here does not prove delivery. In-app rows and conditional email jobs are projections;
  // the separate email sweep records relay acceptance, rejection or uncertainty, never human receipt.
  // `dispatchNotifications` is gated on the per-tenant `notifications` MODULE (not, as this note used to
  // say, on NOTIFICATIONS_ENABLED, which no application code reads) and no-ops for a tenant without it,
  // while the run still records success.
  try {
    await recordJobRun(owner.db, {
      jobKey: 'review.sweep',
      startedAt,
      tenantsProcessed: tenants.length,
      tenantsFailed: failures,
      tenantsSkipped: scope.skipped.length,
      result: {
        opened: totalOpened,
        reminders: totalReminders,
        escalated: totalEscalated,
        movementsApplied: totalMovements,
        nudgesSent: totalNudges,
        nudgeOutcomesJudged: totalNudgesSettled,
        nudgeTenants,
      },
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
