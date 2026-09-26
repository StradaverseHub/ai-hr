/**
 * Item a5f21891 (r344) — DERIVE THE CHILD-RELIEF GRID FOR EVERY EMPLOYEE ALREADY ON 'auto'.
 *
 * ═══ WHY THIS IS OWED ═══
 *
 * r344 made `syncChildReliefFromFamily` derive `employee_statutory_my.child_relief_table` from the
 * Family register, and made the payslip price that grid for an 'auto' employee. But the sync only fires
 * on a family edit — an add, an edit, an archive. An employee already on 'auto' whose family nobody
 * touches therefore keeps a NULL grid and goes on being relieved `num_children × perChild`, which is
 * exactly the under-relief this item exists to end. They would pick it up whenever somebody next edited
 * their record, which is to say: unpredictably, and possibly never.
 *
 * Production 2026-09-26: 3 employees on 'auto'. Between them 2 eligible children counted where the s.48
 * rules count 5 units — RM6,000 of relief not being given.
 *
 * ═══ WHAT IT DOES NOT DO ═══
 *
 * It does not write the grid itself. It calls `syncChildReliefFromFamily` — the SAME function a family
 * edit calls — so a resynced row is byte-identical to what the next edit would have produced, including
 * every rail:
 *   · rail (a) skips anyone not on 'auto', so a typed 'manual' figure is never touched;
 *   · rail (b) reports 'unchanged' where neither the head count nor the grid moves;
 *   · rail (d) raises `payrollAlert` when the move lands while a payroll batch for the current period is
 *     still open — the run is NOT blocked, but the alert is printed, because a tax figure moving under an
 *     open batch is something a human should see.
 * A script that wrote the column directly would be a second author of the same projection, and the two
 * would drift the first time one of them changed.
 *
 * It does not recompute issued payslips. Correcting the grid changes what FUTURE runs compute.
 *
 * ═══ RUNNING IT ═══
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/resync-child-relief-grid.ts --dry-run
 *
 * Read the dry run, then re-run without `--dry-run`. CLAUDE.md §6: deploy.sh runs migrations, not
 * scripts — this round is not done until this has run on the box and its rows are verified.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import { employeeStatutoryMy, tenant } from '../db/schema';
import { resolveEntitlementsTx } from '../core/entitlements';
import { syncChildReliefFromFamily } from '../core/dependents';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('resync-child-relief-grid requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`resync-child-relief-grid — ${tenants.length} tenant(s)${dryRun ? ', DRY RUN' : ''}\n`);

  let moved = 0;
  let same = 0;
  let skippedTenants = 0;
  let alerts = 0;

  for (const t of tenants) {
    // Only 'auto' rows: rail (a) would refuse the rest anyway, and asking it about 71 'manual' employees
    // would print 71 lines saying nothing happened.
    const people = await owner.db
      .select({ personId: employeeStatutoryMy.personId, grid: employeeStatutoryMy.childReliefTable })
      .from(employeeStatutoryMy)
      .where(and(eq(employeeStatutoryMy.tenantId, t.id), eq(employeeStatutoryMy.childReliefMode, 'auto'), isNotNull(employeeStatutoryMy.personId)));
    if (people.length === 0) continue;

    // SYSTEM CONTEXT, as scripts/anomaly-sweep.ts documents: a bare { tenantId } is correctly hidden by
    // RLS and the run reports nothing for rows that plainly exist.
    let ctx: SessionContext;
    try {
      const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, t.id));
      ctx = { tenantId: t.id, roles: ['hr_admin'], entitlements };
    } catch (e) {
      console.log(`${t.name} (${t.id.slice(0, 8)}) — SKIPPED: ${e instanceof Error ? e.message : String(e)}`);
      skippedTenants += 1;
      continue;
    }

    console.log(`${t.name} (${t.id.slice(0, 8)}) — ${people.length} employee(s) on 'auto'`);
    for (const p of people) {
      const had = p.grid == null ? 'no grid' : 'a grid';
      if (dryRun) {
        console.log(`    ${p.personId.slice(0, 8)}  ${had} today — would re-derive from the Family register`);
        same += 1;
        continue;
      }
      // ⚠️ A TENANT WITHOUT THE PAYROLL MODULE MUST SKIP, NOT ABORT THE RUN. r342 shipped that bug in
      // scripts/resync-tp3-projections.ts: one tenant threw and the whole multi-tenant fixup stopped,
      // which on a different sort order would have resynced nothing at all.
      let res;
      try {
        res = await syncChildReliefFromFamily(ctx, p.personId);
      } catch (e) {
        console.log(`    ${p.personId.slice(0, 8)}  ERROR: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (res.changed) {
        moved += 1;
        console.log(`  → ${p.personId.slice(0, 8)}  ${had} => re-derived  (head count ${res.before} => ${res.after})`);
      } else {
        same += 1;
        console.log(`    ${p.personId.slice(0, 8)}  unchanged (${res.skipped ?? 'no move'})`);
      }
      if (res.payrollAlert) {
        alerts += 1;
        console.log(
          `    ⚠️  ${p.personId.slice(0, 8)} moved while ${res.payrollAlert.batches} batch(es) for ${res.payrollAlert.period} are still open — check that run`,
        );
      }
    }
    console.log();
  }

  console.log(
    `${dryRun ? 'would examine' : 'moved'}: ${moved}   unchanged: ${same}   tenants skipped: ${skippedTenants}   payroll alerts: ${alerts}`,
  );
  if (dryRun) console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
