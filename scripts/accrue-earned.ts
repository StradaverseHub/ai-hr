// `leave:accrue` (ADR-0040 2D-2) — monthly earned-leave accrual, run out-of-band (CLI/cron) like
// statutory-sync.ts. Enumerates tenants with the owner role, then tops every earned policy up to the
// amount earned by today via the SAME idempotent accrueEarnedLeave service the admin "Run earned
// accrual" button calls. Runs with a SYSTEM context (no userId → the domain event's actor is `system`).
// Idempotent: a re-run grants nothing. Schedule monthly on the deploy host, e.g.
//   0 2 1 * *  cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/accrue-earned.ts
import { createDb } from '../db/client';
import { describeSkips, loadSweepScope } from '../core/sweep-scope';
import { accrueEarnedLeave, todayInKualaLumpur } from '../core/leave';
import { recordJobRun } from '../core/job-run';

async function main() {
  const startedAt = Date.now();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('leave:accrue requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  // MYT, not UTC. This is scheduled for 02:00 local on the 1st; toISOString() resolves to the previous
  // UTC day there — the last day of the PREVIOUS month — which would accrue against the wrong period.
  // The admin "Run earned accrual" button already uses this helper (app/admin/actions.ts).
  const asOf = todayInKualaLumpur();
  const owner = createDb(ownerUrl);
  // ADR-0077 slice 9 — standing is consulted BEFORE any transaction opens. A tenant that is not in
  // good standing is stepped over, not attempted: withTenant would refuse the writes anyway, and
  // discovering that as a read-only error would report a suspended customer as a nightly failure.
  const scope = await loadSweepScope(owner.db);
  const tenants = scope.run;
  console.log(`leave:accrue — ${tenants.length} tenant(s) in scope, asOf ${asOf}` +
    (scope.skipped.length > 0 ? `, ${scope.skipped.length} skipped` : ''));
  for (const line of describeSkips(scope)) console.log(line);

  let totalGranted = 0;
  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context: no userId, so actorOf(ctx) records the event actor as `system`. accrueEarnedLeave
      // runs through the app-role connection (RLS enforced); the hr_admin role authorizes the writes.
      const { granted } = await accrueEarnedLeave({ tenantId: t.id, roles: ['hr_admin'], entitlementsExempt: 'sweeps' }, { asOf });
      totalGranted += granted;
      console.log(`  ✓ ${t.name} (${t.id}): ${granted} grant(s)`);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `leave:accrue done — ${totalGranted} ledger grant(s) across ${tenants.length} tenant(s), ${failures} failure(s).` +
      (scope.skipped.length > 0 ? ` ${scope.skipped.length} tenant(s) skipped for standing.` : ''),
  );
  // 0280 run log. In its OWN try/catch: this is an audit record, and failing to write it must never
  // turn a run that did its real work into a non-zero exit. The exit code below is unchanged.
  try {
    await recordJobRun(owner.db, {
      jobKey: 'leave.accrue',
      startedAt,
      tenantsProcessed: tenants.length,
      tenantsFailed: failures,
      tenantsSkipped: scope.skipped.length,
      result: { granted: totalGranted },
    });
  } catch (e) {
    console.error(`leave:accrue — could not write the run log: ${(e as Error).message}`);
  }
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
