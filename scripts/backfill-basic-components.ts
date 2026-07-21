// One-off / maintenance CLI — seed the BASIC + ALLOWANCE employment_pay_component rows from every open
// compensation row, for every tenant. ADR-0078 note: the BASIC component deliberately mirrors the
// MONTHLY-EQUIVALENT compensation.basic_salary for every pay mode (daily/hourly included) — it feeds
// percent-of-basic rules and statutory bases, never the daily/hourly basic pay, which the engine computes
// from compensation.rate_amount at run time. Fixes the data gap behind feedback 62e370b0 ("Basic salary not
// reflected during payroll processing"): with TYPED_PAY_COMPONENTS_ENABLED on, the typed earnings path reads
// basic from a BASIC component; employees whose components were never backfilled paid zero. Runs the SAME
// idempotent backfillEmploymentComponentsFromCompensation service (upserts, so a re-run is a no-op).
//   node --env-file=.env.production --import tsx scripts/backfill-basic-components.ts
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { backfillEmploymentComponentsFromCompensation } from '../core/pay-components';

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('backfill:basic-components requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`backfill:basic-components — ${tenants.length} tenant(s)`);
  let total = 0;
  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context (hr_admin authorizes the component writes; no userId → event actor is `system`).
      const { employments } = await backfillEmploymentComponentsFromCompensation({ tenantId: t.id, roles: ['hr_admin'] });
      total += employments;
      console.log(`  ✓ ${t.name} (${t.id}): seeded BASIC+ALLOWANCE for ${employments} employment(s)`);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(`backfill:basic-components done — ${total} employment(s) across ${tenants.length} tenant(s), ${failures} failure(s).`);
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
