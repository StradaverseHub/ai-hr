/**
 * Board 4197534a — THE ONE-TIME TIDY-UP of duplicate, never-used Overtime Pattern drafts. NOT RUN BY DEPLOY.
 *
 *   node --conditions=react-server --import tsx scripts/data/overtime-pattern-consolidate.ts --tenant=<tenant id> --actor=<app user id>           # dry run (default): counts only
 *   node --conditions=react-server --import tsx scripts/data/overtime-pattern-consolidate.ts --tenant=<tenant id> --actor=<app user id> --apply   # merge
 *
 * ON THE SERVER, SOURCE THE ENV (see scripts/backfill-assignment-company.ts for why `--env-file` is not used):
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && node --conditions=react-server --import tsx scripts/data/overtime-pattern-consolidate.ts --tenant=… --actor=…
 *
 * WHAT IT DOES (packs/attendance/overtime-patterns.ts consolidateOvertimePatterns): the retired per-company starting
 * drafts (STD_OT15_<company>, …) become one STD_OT15 / STD_OT20 / STD_OT30 / STD_OT00 draft each, covering every company
 * they were made for; other drafts with exactly the same settings are combined under the earliest one's code. Only
 * never-activated, unreferenced single-version drafts are touched, and they are archived ("Merged into <code>"), never
 * deleted. A pattern that was switched on, is used by employees, a Schedule Group or a past result, differs, mixes
 * currencies or includes a company the actor does not look after is left exactly as it is. Each group is one short
 * transaction. SAFE TO RE-RUN: a second run finds nothing to merge and writes nothing.
 *
 * WHO. It runs as the named tenant administrator (--actor, an app user holding a group-wide hr_admin or super_admin
 * role in that tenant) through the application role and row security, so every write passes the same overtime
 * configuration guards as the screen, and the Audit Trail records that person. MIGRATION_DATABASE_URL (owner role)
 * only resolves the tenant's entitlements and checks the actor; DATABASE_URL carries the writes.
 *
 * EVIDENCE. Run the dry run first and keep its printed counts for review; run --apply only after the owner accepts
 * them, then keep the printed counts and run the dry run again (it must report groups 0, toArchive 0). Run it
 * separately on each installation (staging, then production with its own permission). Deployment does not imply it ran.
 */
import type { SessionContext } from '../../db/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const apply = process.argv.includes('--apply');
  const tenantId = arg('tenant'), actor = arg('actor');
  if (!tenantId || !UUID.test(tenantId) || !actor || !UUID.test(actor)) {
    console.error('overtime-pattern-consolidate needs --tenant=<tenant id> and --actor=<app user id>.');
    process.exit(1);
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url || !process.env.DATABASE_URL) { console.error('overtime-pattern-consolidate requires MIGRATION_DATABASE_URL and DATABASE_URL.'); process.exit(1); }
  const [{ createDb }, { resolveEntitlementsTx, isModuleEnabled }, { consolidateOvertimePatterns }, { sql }] = await Promise.all([
    import('../../db/client'), import('../../core/entitlements'), import('../../packs/attendance/service'), import('drizzle-orm'),
  ]);
  const owner = createDb(url);
  try {
    const grants = await owner.db.execute(sql`select ra.role::text as role from role_assignment ra join app_user u on u.id=ra.app_user_id
      where ra.tenant_id=${tenantId}::uuid and ra.app_user_id=${actor}::uuid and ra.company_id is null and ra.role::text in ('hr_admin','super_admin')`) as unknown as { role: string }[];
    if (!grants.length) { console.error('The actor is not a group-wide administrator of this tenant.'); process.exitCode = 1; return; }
    const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, tenantId));
    const role = grants.some((grant) => grant.role === 'super_admin') ? 'super_admin' : 'hr_admin';
    const ctx: SessionContext = { tenantId, userId: actor, roles: [role], grants: [{ role, companyId: null }], entitlements };
    if (!isModuleEnabled(ctx, 'attendance')) { console.log(JSON.stringify({ tenantId, skipped: 'attendanceDisabled' })); return; }
    const report = await consolidateOvertimePatterns(ctx, { apply });
    console.log(JSON.stringify(report));
  } finally { await owner.client.end(); }
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(error instanceof Error ? error.message : 'Consolidation failed.'); process.exit(1); });
