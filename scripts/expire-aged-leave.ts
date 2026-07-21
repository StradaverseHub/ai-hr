// `leave:expire-aged` (fec49317 Leave Type Expiry Field) — forfeit earned leave portions whose configured
// age-from-earning expiry (leave_type.expiry_value / expiry_unit) has passed. Run out-of-band (CLI/cron)
// like expire-carry.ts: enumerates tenants with the owner role, then runs the SAME idempotent
// expireAgedLeave service per tenant with a SYSTEM context (no userId → the domain event's actor is
// `system`). Idempotent: a re-run forfeits nothing. Schedule daily (or monthly), e.g. just after midnight:
//   30 3 * * *  cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/expire-aged-leave.ts
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { expireAgedLeave, todayInKualaLumpur } from '../core/leave';
import { recordJobRun } from '../core/job-run';

async function main() {
  const startedAt = Date.now();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('leave:expire-aged requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  // MYT, not UTC — see accrue-earned.ts. Scheduled 03:30 local, which is the previous day in UTC.
  const today = todayInKualaLumpur();
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`leave:expire-aged — ${tenants.length} tenant(s), today ${today}`);

  let totalSwept = 0;
  let totalForfeited = 0;
  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context: no userId, so actorOf(ctx) records the event actor as `system`. expireAgedLeave
      // runs through the app-role connection (RLS enforced); the hr_admin role authorizes the writes.
      const { swept, forfeited } = await expireAgedLeave({ tenantId: t.id, roles: ['hr_admin'] }, { today });
      totalSwept += swept;
      totalForfeited = Math.round((totalForfeited + forfeited) * 100) / 100;
      console.log(`  ✓ ${t.name} (${t.id}): ${swept} sweep(s), ${forfeited} day(s) forfeited`);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `leave:expire-aged done — ${totalSwept} sweep(s), ${totalForfeited} day(s) forfeited across ${tenants.length} tenant(s), ${failures} failure(s).`,
  );
  // 0280 run log, in its OWN try/catch — see accrue-earned.ts. `forfeited` is a fractional DAY count.
  try {
    await recordJobRun(owner.db, {
      jobKey: 'leave.expire-aged',
      startedAt,
      tenantsProcessed: tenants.length,
      tenantsFailed: failures,
      result: { swept: totalSwept, forfeited: totalForfeited },
    });
  } catch (e) {
    console.error(`leave:expire-aged — could not write the run log: ${(e as Error).message}`);
  }
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
