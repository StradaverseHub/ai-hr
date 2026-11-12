// Morning summaries (owner decision, 11 Nov 2026): prepares every `daily_digest` mandate due today in every tenant in
// scope, as each tenant's named agent principal (core/digest/run.ts runDueDailyDigests). Started by the nightly
// review sweep (scripts/review-sweep.ts) as a child process, so there is no second cron line to forget; it can also be
// run on its own:
//   cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/daily-digest-sweep.ts
//
// The digest reads the approvals queue, whose module graph includes server-only packs. Like the minute notification
// sweep, this worker therefore runs under the installed marker package's server export (`--conditions=react-server`),
// respawning itself when started without it, and loads the HR graph only in that child. The review sweep keeps its
// ordinary plain-Node runtime (test/review-sweep-startup.test.ts).
//
// Its last stdout line is `daily-digest:sweep result {json}` with the counts, which the review sweep records.
import {spawn} from 'node:child_process';

async function main() {
  const [{createDb}, {describeSkips, loadSweepScope}, {ensureAgentPrincipal}, {resolveEntitlementsTx}, {runDueDailyDigests}] = await Promise.all([
    import('../db/client'), import('../core/sweep-scope'), import('../core/agent-principal'), import('../core/entitlements'), import('../core/digest/run'),
  ]);
  // Checked after the graph loads, so a startup check proves the graph loads under this runtime.
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('daily-digest:sweep requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const scope = await loadSweepScope(owner.db);
  for (const line of describeSkips(scope)) console.log(line);
  const totals = {tenants: scope.run.length, due: 0, prepared: 0, stopped: 0, failed: 0, cappedTenants: 0, failedTenants: 0};
  for (const t of scope.run) {
    try {
      const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, t.id));
      const principalId = await ensureAgentPrincipal(owner.db, t.id);
      const run = await runDueDailyDigests({tenantId: t.id, principalId, entitlements});
      totals.due += run.due; totals.prepared += run.prepared; totals.stopped += run.stopped; totals.failed += run.failed;
      if (run.capped) { totals.cappedTenants++; console.error(`  ⚠ ${t.name} (${t.id}): morning summaries reached the per-run cap; the rest wait for the next run.`); }
      if (run.failed > 0) console.error(`  ${t.name} (${t.id}): ${run.failed} morning summar${run.failed === 1 ? 'y' : 'ies'} could not be prepared.`);
      if (run.due > 0) console.log(`  ✓ ${t.name} (${t.id}): ${run.prepared} morning summar${run.prepared === 1 ? 'y' : 'ies'} prepared, ${run.stopped} stopped by their checks (recorded).`);
    } catch {
      totals.failedTenants++;
      console.error(`  ✗ ${t.name} (${t.id}): morning summaries failed before any was prepared.`);
    }
  }
  await owner.client.end();
  console.log(`daily-digest:sweep result ${JSON.stringify(totals)}`);
  process.exit(totals.failed > 0 || totals.failedTenants > 0 ? 1 : 0);
}

if (!process.execArgv.includes('--conditions=react-server')) {
  const worker = spawn(process.execPath, ['--conditions=react-server', ...process.execArgv, ...process.argv.slice(1)], {stdio: 'inherit', env: process.env});
  worker.once('error', () => { console.error('daily-digest:sweep server runtime unavailable.'); process.exitCode = 1; });
  worker.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => worker.kill(signal));
} else main().catch(() => { console.error('daily-digest:sweep failed.'); process.exit(1); });
