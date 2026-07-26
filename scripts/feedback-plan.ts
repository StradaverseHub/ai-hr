// `feedback:plan` (ADR-0043 FB-3) — the feedback planning agent, run out-of-band (cron) like
// scripts/accrue-earned.ts. Every few hours, enumerate tenants and for each `open`/`contested` feedback
// item, ask the AI gateway for an implementation plan and store it (status → `planned`) for the reporter
// to review. Runs with a SYSTEM context (no userId → the plan's domain event actor is `agent` via
// setFeedbackPlan). A tenant with no AI config is skipped (logged). Schedule on the deploy host, e.g.
//   0 */3 * * *  cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/feedback-plan.ts
import { createDb, type SessionContext } from '../db/client';
import { tenant } from '../db/schema';
import { generateFeedbackPlan, listPlannableFeedback } from '../core/feedback';

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('feedback:plan requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`feedback:plan — ${tenants.length} tenant(s)`);

  let planned = 0;
  let failures = 0;
  for (const t of tenants) {
    const ctx: SessionContext = { tenantId: t.id, roles: ['hr_admin'], entitlementsExempt: 'sweeps' };
    let ids: string[] = [];
    try {
      ids = await listPlannableFeedback(ctx);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
      continue;
    }
    for (const id of ids) {
      try {
        await generateFeedbackPlan(ctx, { feedbackId: id });
        planned += 1;
        console.log(`  ✓ ${t.name}: planned ${id}`);
      } catch (e) {
        failures += 1;
        console.error(`  ✗ ${t.name} ${id}: ${(e as Error).message}`);
      }
    }
  }
  console.log(`feedback:plan done — ${planned} planned, ${failures} failure(s).`);
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
