// `leave:expire-carry` (ADR-0038 carry-forward expiry) — forfeit carried-forward ANNUAL days whose
// configured expiry/auto-forfeit date has passed. Run out-of-band (CLI/cron) like accrue-earned.ts:
// enumerates tenants with the owner role, then runs the SAME idempotent expireCarriedLeave service per
// tenant with a SYSTEM context (no userId → the domain event's actor is `system`). Idempotent: a re-run
// forfeits nothing. Schedule once per year after the configured expiry date(s), e.g. just after 31 Mar:
//   0 3 1 4 *  cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/expire-carry.ts
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { expireCarriedLeave, todayInKualaLumpur } from '../core/leave';
import { recordJobRun } from '../core/job-run';

async function main() {
  const startedAt = Date.now();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('leave:expire-carry requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  // MYT, not UTC — see accrue-earned.ts. Scheduled 03:00 local on 1 Apr; toISOString() would resolve to
  // 31 Mar, i.e. ON the expiry date rather than after it, and forfeit nothing.
  const today = todayInKualaLumpur();
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`leave:expire-carry — ${tenants.length} tenant(s), today ${today}`);

  let totalSwept = 0;
  let totalForfeited = 0;
  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context: no userId, so actorOf(ctx) records the event actor as `system`. expireCarriedLeave
      // runs through the app-role connection (RLS enforced); the hr_admin role authorizes the writes.
      const { swept, forfeited } = await expireCarriedLeave({ tenantId: t.id, roles: ['hr_admin'] }, { today });
      totalSwept += swept;
      totalForfeited = Math.round((totalForfeited + forfeited) * 100) / 100;
      console.log(`  ✓ ${t.name} (${t.id}): ${swept} sweep(s), ${forfeited} day(s) forfeited`);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `leave:expire-carry done — ${totalSwept} sweep(s), ${totalForfeited} day(s) forfeited across ${tenants.length} tenant(s), ${failures} failure(s).`,
  );
  // 0280 run log, in its OWN try/catch — see accrue-earned.ts. `forfeited` is a DAY count and may be
  // fractional (e.g. 12.5); it goes into jsonb as a float and must never be rounded to an integer.
  try {
    await recordJobRun(owner.db, {
      jobKey: 'leave.expire-carry',
      startedAt,
      tenantsProcessed: tenants.length,
      tenantsFailed: failures,
      result: { swept: totalSwept, forfeited: totalForfeited },
    });
  } catch (e) {
    console.error(`leave:expire-carry — could not write the run log: ${(e as Error).message}`);
  }
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
