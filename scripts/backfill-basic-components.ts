// One-off / maintenance CLI — seed the BASIC + ALLOWANCE employment_pay_component rows from every open
// compensation row, for every tenant. Feedback 64fb5e48: this backfill is now OPTIONAL housekeeping — the
// payroll engine always pays basic (and feeds percent-of-basic rules and statutory bases) from the
// Personnel compensation record itself, so BASIC component amounts no longer drive pay. A BASIC component
// that drifts from compensation.basic_salary only surfaces as the staleBasicComponent pre-check warning;
// re-running this CLI re-mirrors the amounts and clears the warning. Runs the SAME idempotent
// backfillEmploymentComponentsFromCompensation service (upserts, so a re-run is a no-op).
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
