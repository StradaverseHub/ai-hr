// `leave:accrue` (ADR-0040 2D-2) — monthly earned-leave accrual, run out-of-band (CLI/cron) like
// statutory-sync.ts. Enumerates tenants with the owner role, then tops every earned policy up to the
// amount earned by today via the SAME idempotent accrueEarnedLeave service the admin "Run earned
// accrual" button calls. Runs with a SYSTEM context (no userId → the domain event's actor is `system`).
// Idempotent: a re-run grants nothing. Schedule monthly on the deploy host, e.g.
//   0 2 1 * *  cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/accrue-earned.ts
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { accrueEarnedLeave, todayInKualaLumpur } from '../core/leave';

async function main() {
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
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`leave:accrue — ${tenants.length} tenant(s), asOf ${asOf}`);

  let totalGranted = 0;
  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context: no userId, so actorOf(ctx) records the event actor as `system`. accrueEarnedLeave
      // runs through the app-role connection (RLS enforced); the hr_admin role authorizes the writes.
      const { granted } = await accrueEarnedLeave({ tenantId: t.id, roles: ['hr_admin'] }, { asOf });
      totalGranted += granted;
      console.log(`  ✓ ${t.name} (${t.id}): ${granted} grant(s)`);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `leave:accrue done — ${totalGranted} ledger grant(s) across ${tenants.length} tenant(s), ${failures} failure(s).`,
  );
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
