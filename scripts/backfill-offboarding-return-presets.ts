/**
 * d1e26f81 — THE ONE-OFF BACK-FILL that gives open offboarding cases' Return and revoke items their team, round-robin
 * owner and Day -1/0 date from Onboarding & Offboarding settings.
 *
 *   node --conditions=react-server --import tsx scripts/backfill-offboarding-return-presets.ts            # report only (default)
 *   node --conditions=react-server --import tsx scripts/backfill-offboarding-return-presets.ts --apply    # write
 *
 * ON THE SERVER, SOURCE THE ENV (see scripts/backfill-assignment-company.ts for why `--env-file` is not used):
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && node --conditions=react-server --import tsx scripts/backfill-offboarding-return-presets.ts
 *
 * THIS IS NOT PART OF DEPLOY. Run it after the release (with migration 5480 applied, so open offboarding items count
 * toward open-task limits) and record the printed per-tenant counts as its evidence. Production needs separate
 * permission, as every production step does.
 *
 * WHAT IT CHANGES. Only items on submitted offboarding cases that are To do / In progress, still Unassigned and were
 * never preset. Items whose date is the untouched revoke-date default get the Day -1/0 date from the effective last
 * working day; any other date is kept as a fixed date. Owners HR has chosen and items already done are never
 * touched. Each case is one short transaction with a case revision, a 'returns.presetsApplied' history line and
 * an audit event. SAFE TO RE-RUN: preset items carry their method, so a second run finds nothing.
 */
import type { SessionContext } from '../db/client';

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) { console.error('backfill-offboarding-return-presets requires MIGRATION_DATABASE_URL (owner role).'); process.exit(1); }
  const [{ createDb }, { loadSweepScope }, { resolveEntitlementsTx, isModuleEnabled }, { v9BackfillReturnPresets }] = await Promise.all([
    import('../db/client'), import('../core/sweep-scope'), import('../core/entitlements'), import('../packs/lifecycle/service'),
  ]);
  const owner = createDb(url);
  let failed = 0;
  try {
    const scope = await loadSweepScope(owner.db);
    for (const tenant of scope.run) {
      const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, tenant.id));
      const ctx: SessionContext = { tenantId: tenant.id, roles: ['hr_admin'], entitlements };
      if (!isModuleEnabled(ctx, 'lifecycle')) continue;
      const result = await v9BackfillReturnPresets(ctx, owner, { apply });
      failed += result.failed;
      console.log(JSON.stringify({ tenantId: tenant.id, apply, ...result }));
    }
  } finally { await owner.client.end(); }
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Back-fill failed.'); process.exitCode = 1; });
