// `payroll-loop-tick` (AI v2 P2-2a, owner decision 4) — the Pre-salary loop's frequent tick. Run every 15 minutes by
// deploy/systemd/aihr-payroll-loop-tick.timer (a disabled source template: an operator enables it at release, see
// deploy/systemd/README.md). Each tick runs ONLY the Pre-salary loop (core/loops/tick.ts runPreSalaryTick), for each
// tenant in scope, as the tenant's named agent principal, exactly as the nightly sweep runs it: a switched-off,
// stopped or paused loop does nothing, and only the companies whose own interval (hourly, twice daily or daily) has
// come round are checked. A tick that finds the previous one still running for a tenant skips that tenant.
// Deterministic, no model and no spend. It records no job_run row (every 15 minutes would bury the Scheduled actions
// history): each loop run is its own outcome record (teras_loop_run), read on AI Centre › Operations › Loops.
import { createDb } from '../db/client';
import { describeSkips, loadSweepScope } from '../core/sweep-scope';
import { resolveEntitlementsTx } from '../core/entitlements';
import { ensureAgentPrincipal } from '../core/agent-principal';
import { runPreSalaryTick } from '../core/loops/tick';
import { todayInKualaLumpur } from '../lib/hr-date';

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('payroll-loop-tick requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  const today = todayInKualaLumpur();
  const owner = createDb(ownerUrl);
  const scope = await loadSweepScope(owner.db);
  for (const line of describeSkips(scope)) console.log(line);
  let ran = 0, busy = 0, notRun = 0, failed = 0, companies = 0, opened = 0, closed = 0;
  for (const t of scope.run) {
    try {
      const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, t.id));
      const principalId = await ensureAgentPrincipal(owner.db, t.id);
      const result = await runPreSalaryTick(owner.client, { tenantId: t.id, principalId, entitlements, today });
      if (result.status === 'busy') busy++;
      else if (result.status === 'ran') { ran++; companies += result.companies; opened += result.totals.opened + result.totals.reopened; closed += result.totals.closed; }
      else if (result.status === 'not_run') notRun++;
      else { failed++; console.error(`  ⚠ the Pre-salary loop ${result.status === 'sponsor_lost' ? 'stopped: its sponsor no longer holds administrator access' : 'did not finish'} (tenant ${t.id}).`); }
    } catch (e) {
      failed++;
      console.error(`  ⚠ tenant ${t.id}: ${(e as Error).message}`);
    }
  }
  console.log(`payroll-loop-tick — ${scope.run.length} tenant(s), today ${today}: ${ran} ran (${companies} company check(s), ${opened} card(s) opened, ` +
    `${closed} closed), ${notRun} off, ${busy} still running from the previous tick, ${failed} failed`);
  await owner.client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
