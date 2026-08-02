/**
 * ADR-0077 slice 9 — apply the dunning policy: the ONLY thing that suspends a tenant.
 *
 * r104 made a non-good-standing tenant read-only inside `withTenant`, and nothing could reach that state:
 * no code path set `tenant.status` to 'suspended'. This sweep is the trigger, and it is deliberately the
 * only one — "one authority: subscription.status is the billing fact; tenant.status derives from it".
 *
 * ENV CONTRACT: MIGRATION_DATABASE_URL ONLY, like the other out-of-band runners. `tenant` is not writable
 * by the app role, and the owner credential is kept out of the web application on purpose.
 *
 *   node --env-file=.env.production --import tsx scripts/apply-dunning.ts            # report only
 *   node --env-file=.env.production --import tsx scripts/apply-dunning.ts --apply    # suspend
 *
 * REPORT-ONLY BY DEFAULT, and that is not timidity. Suspending a customer makes their whole tenant
 * read-only; a sweep that does it unattended on its first run, from a policy nobody has seen output from,
 * is the wrong default. Run it, read what it would do, then pass --apply. Wire it into a schedule only
 * once its output has been boring for a while.
 *
 * IT NEVER REINSTATES. The plan makes reactivation explicit — it records the suspended window and replays
 * the sweeps that were skipped, with that window excluded from expiry clocks. A sweep that silently
 * flipped a tenant back to active would skip all of that and leave expiry having run across a period
 * nobody accounted for. Lifting a suspension is an operator action, not a side effect of paying an invoice.
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { appendEvent } from '../db/events';
import { subscription, tenant } from '../db/schema';
import { dunningDecision, DEFAULT_GRACE_DAYS } from '../core/dunning';
import { todayInKualaLumpur } from '../lib/hr-date';

function loadEnv() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // env supplied directly
    }
  }
}

export type DunningOutcome = {
  tenantId: string;
  tenantName: string;
  action: 'suspend' | 'none';
  reason: string;
};

export async function runDunning(
  url: string,
  opts: { apply: boolean; today?: string; graceDays?: number },
): Promise<DunningOutcome[]> {
  const owner = createDb(url);
  const today = opts.today ?? todayInKualaLumpur();

  // Every tenant WITH a subscription. A tenant with none is not delinquent — it has no billing fact to
  // derive a state from, and inventing one would suspend a customer for a data gap.
  const rows = await owner.db
    .select({
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantStatus: tenant.status,
      subscriptionStatus: subscription.status,
      periodEnd: subscription.periodEnd,
    })
    .from(subscription)
    .innerJoin(tenant, eq(tenant.id, subscription.tenantId));

  const out: DunningOutcome[] = [];
  for (const r of rows) {
    const decision = dunningDecision({
      subscriptionStatus: r.subscriptionStatus,
      periodEnd: r.periodEnd,
      tenantStatus: r.tenantStatus,
      today,
      graceDays: opts.graceDays,
    });
    out.push({ tenantId: r.tenantId, tenantName: r.tenantName, action: decision.action, reason: decision.reason });

    if (decision.action !== 'suspend' || !opts.apply) continue;

    await owner.db.transaction(async (tx) => {
      await owner.db.update(tenant).set({ status: 'suspended' }).where(eq(tenant.id, r.tenantId));
      // The event is the record of WHY a customer lost write access. Without it, the only evidence is a
      // status column and an operator's memory.
      await appendEvent(tx as never, {
        tenantId: r.tenantId,
        aggregateType: 'tenant',
        aggregateId: r.tenantId,
        eventType: 'tenant.suspended',
        actor: { type: 'system' },
        payload: {
          reason: decision.reason,
          subscriptionStatus: r.subscriptionStatus,
          periodEnd: r.periodEnd,
          graceDays: opts.graceDays ?? DEFAULT_GRACE_DAYS,
          appliedOn: today,
        },
      });
    });
  }
  return out;
}

if (process.argv[1]?.endsWith('apply-dunning.ts')) {
  loadEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('apply-dunning requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  runDunning(url, { apply })
    .then((rows) => {
      const suspend = rows.filter((r) => r.action === 'suspend');
      console.log(`dunning — ${rows.length} tenant(s) with a subscription, mode=${apply ? 'APPLY' : 'report only'}`);
      for (const r of rows) console.log(`  ${r.action === 'suspend' ? 'SUSPEND' : 'ok     '} ${r.tenantName}: ${r.reason}`);
      if (suspend.length > 0 && !apply) {
        console.log(`\n  ${suspend.length} tenant(s) WOULD be suspended. Re-run with --apply to do it.`);
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
