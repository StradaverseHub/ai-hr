/**
 * ADR-0077 slice 9 — REINSTATE a suspended tenant, and repair what the suspension cost its employees.
 *
 *   node --env-file=.env.production --import tsx scripts/reactivate-tenant.ts --tenant <uuid>
 *   node --env-file=.env.production --import tsx scripts/reactivate-tenant.ts --tenant <uuid> --apply
 *
 * REPORT-ONLY BY DEFAULT, like apply-dunning. Without --apply it prints the window it would close and
 * the replay it would schedule, and writes nothing.
 *
 * ── WHY THIS IS NOT `UPDATE tenant SET status='active'` ────────────────────────────────────────────
 * r105 refused to auto-reinstate for exactly this reason: flipping the status back is the easy half,
 * and on its own it is silently destructive. While the tenant was frozen the scheduled sweeps skipped
 * it (r108), and the two kinds of sweep behave differently when they finally run:
 *
 *   - accrue-earned SELF-HEALS. It computes from service dates up to `asOf`, so the first ordinary run
 *     after reinstatement grants the missed months by construction. Nothing to do.
 *   - expire-carry and expire-aged-leave DO NOT. They compare a STORED DATE to `today`. Run them the
 *     morning after reinstatement and they forfeit every balance whose expiry fell inside the window —
 *     leave the employee could not have used, taken away because their employer was late paying.
 *
 * So reinstatement closes the window FIRST, and the expiry sweeps read it: an expiry whose clock ran
 * through frozen time moves out by exactly that many days. Not skipped, not waived — moved, so the
 * employee gets back the usable time they lost and not one day more.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not run the sweeps. It closes the window, records the
 * event, and PRINTS the replay plan for the operator to run. A reinstatement that silently triggered
 * four sweeps against a customer's live payroll would be the same class of unattended action r105
 * refused for suspension.
 */
import { eq, isNull, and } from 'drizzle-orm';
import { createDb } from '../db/client';
import { appendEvent } from '../db/events';
import { tenant, tenantSuspensionWindow } from '../db/schema';
import { replayPlan, suspendedDaysWithin, type SkippedSweep } from '../core/tenant-lifecycle';

const argOf = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const todayIso = (): string => new Date().toISOString().slice(0, 10);

async function main() {
  const tenantId = argOf('--tenant');
  const apply = process.argv.includes('--apply');
  const today = argOf('--today') ?? todayIso();
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
    console.error('usage: reactivate-tenant.ts --tenant <uuid> [--apply] [--today YYYY-MM-DD]');
    process.exit(2);
  }

  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL (or DATABASE_URL) must be set — tenant is owner-writable only.');
    process.exit(2);
  }
  const owner = createDb(url);
  {
    const [t] = await owner.db
      .select({ id: tenant.id, name: tenant.name, status: tenant.status })
      .from(tenant)
      .where(eq(tenant.id, tenantId))
      .limit(1);
    if (!t) {
      console.error(`no such tenant: ${tenantId}`);
      process.exit(1);
    }

    // NEVER reinstate a CLOSED tenant. Closure is dual-controlled and starts a retention clock; undoing
    // it is not a reinstatement, it is a new decision that has to go back through the same two people.
    if (t.status === 'closed') {
      console.error(`tenant ${t.name} is CLOSED — reinstatement is not the reverse of closure. Refusing.`);
      process.exit(1);
    }
    if (t.status !== 'suspended') {
      console.log(`tenant ${t.name} is '${t.status}', not suspended — nothing to reinstate.`);
      return;
    }

    const [open] = await owner.db
      .select({ id: tenantSuspensionWindow.id, suspendedAt: tenantSuspensionWindow.suspendedAt })
      .from(tenantSuspensionWindow)
      .where(and(eq(tenantSuspensionWindow.tenantId, tenantId), isNull(tenantSuspensionWindow.resumedAt)))
      .limit(1);

    // A suspended tenant with NO open window predates 0350. Reinstating it is still right, but the
    // expiry repair cannot be computed — say so loudly rather than reporting a confident zero.
    if (!open) {
      console.warn(
        `tenant ${t.name} is suspended but has NO open suspension window (suspended before migration 0350?).\n` +
          `  The status can be restored, but the frozen period is unknown, so expiry dates CANNOT be repaired.\n` +
          `  Check the tenant.suspended timestamp and the tenant.suspended domain events before running the expiry sweeps.`,
      );
    }

    const frozenDays = open ? suspendedDaysWithin([{ suspendedAt: open.suspendedAt, resumedAt: null }], open.suspendedAt, today) : 0;

    // The sweeps that skipped this tenant, from r108's run-log `skipped` entries. Passed in rather than
    // queried here so the plan is computed from the same record the sweeps actually wrote.
    const skipped: SkippedSweep[] = ['accrue-earned', 'expire-carry', 'expire-aged-leave', 'review-sweep'].map((s) => ({
      sweep: s,
      skippedOn: open?.suspendedAt ?? today,
    }));
    const plan = replayPlan(skipped);

    console.log(`tenant:      ${t.name} (${t.id})`);
    console.log(`suspended:   ${open?.suspendedAt ?? 'unknown'}`);
    console.log(`frozen days: ${frozenDays}`);
    console.log('replay plan:');
    for (const step of plan) console.log(`  ${step.sweep.padEnd(20)} ${step.action.padEnd(28)} ${step.reason}`);

    if (!apply) {
      console.log('\n(report only — pass --apply to close the window and set the tenant active)');
      return;
    }

    await owner.db.transaction(async (tx) => {
      if (open) {
        await tx
          .update(tenantSuspensionWindow)
          .set({ resumedAt: today })
          .where(eq(tenantSuspensionWindow.id, open.id));
      }
      await tx.update(tenant).set({ status: 'active', suspendedAt: null }).where(eq(tenant.id, tenantId));
      await appendEvent(tx as never, {
        tenantId,
        aggregateType: 'tenant',
        aggregateId: tenantId,
        eventType: 'tenant.reinstated',
        actor: { type: 'system' },
        payload: { suspendedAt: open?.suspendedAt ?? null, resumedAt: today, frozenDays, replay: plan },
      });
    });
    console.log(`\nreinstated. Window closed at ${today}. Run the replay steps above.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
