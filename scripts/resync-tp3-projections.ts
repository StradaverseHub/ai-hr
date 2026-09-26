/**
 * Item 20837372 (r342) — RE-DERIVE EVERY STORED TP3 PROJECTION FROM THE FORM IT CAME FROM.
 *
 * ═══ WHY THIS SCRIPT IS OWED ═══
 *
 * `employee_statutory_my`'s five TP3 columns are a PROJECTION of the form, written only when the form is
 * saved. r342 changed the arithmetic that produces them — Section C is now counted to its statutory
 * limits, so C2's sub-lines contribute at most their own exemption and C3 contributes at most the EPF
 * relief cap. Every row stored before r342 therefore holds a figure derived by the old rule, and payroll
 * will keep seeding PCB with it until somebody re-saves that form by hand.
 *
 * Measured on production 2026-09-26: ONE form, C1 60,000 / C2 3,600 / C3 8,979, projecting
 * `tp3_net_remuneration` = 47,421. Under the corrected rule it is 52,400. The row is wrong by RM4,979
 * and that employee's PCB is light by the tax on it.
 *
 * ═══ WHAT IT DOES NOT DO ═══
 *
 * It does not write the five columns itself. It hands each freshly-derived seed to
 * `resyncTp3Projections` in core/tp3.ts, which reuses `projectSeedOntoStatutory` — the SAME function the
 * save path uses. A script that wrote those columns directly would be a second author of a statutory
 * projection, and the two would drift the first time one of them changed. The refusals come with it:
 * a row whose `tp3_year` is held by a LATER year is reported, not overwritten, and a person with no
 * statutory profile is reported, not given a bare one.
 *
 * It does not touch issued payslips. Correcting the seed changes what FUTURE runs compute; re-cutting a
 * payslip moves money already paid and reported, and that is the reporter's decision, not this script's.
 *
 * ═══ RUNNING IT ═══
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/resync-tp3-projections.ts --dry-run
 *
 * Read the dry run, then re-run without `--dry-run`. CLAUDE.md §6: deploy.sh runs migrations, not
 * scripts — this round is not done until this has run on the box and its rows are verified.
 */
import { createDb, type SessionContext } from '../db/client';
import { tenant } from '../db/schema';
import { resolveEntitlementsTx } from '../core/entitlements';
import { resyncTp3Projections } from '../core/tp3';

const money = (v: number | null) => (v == null ? '—' : v.toFixed(2));

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('resync-tp3-projections requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`resync-tp3-projections — ${tenants.length} tenant(s)${dryRun ? ', DRY RUN' : ''}\n`);

  let moved = 0;
  let same = 0;
  let refused = 0;

  for (const t of tenants) {
    // SYSTEM CONTEXT, as scripts/anomaly-sweep.ts documents: a bare { tenantId } is correctly hidden by
    // RLS and the run reports nothing for rows that plainly exist. No userId, so the domain event this
    // writes records its actor as `system`.
    const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, t.id));
    const ctx: SessionContext = { tenantId: t.id, roles: ['hr_admin'], entitlements };

    const rows = await resyncTp3Projections(ctx, { dryRun });
    if (rows.length === 0) continue;
    console.log(`${t.name} (${t.id.slice(0, 8)}) — ${rows.length} form(s)`);
    for (const r of rows) {
      const applied = (r.outcome as { applied?: boolean }).applied === true;
      const reason = (r.outcome as { reason?: string }).reason;
      const delta = r.before == null ? null : r.after - r.before;
      const changed = delta != null && Math.abs(delta) >= 0.005;
      if (!dryRun && !applied) refused += 1;
      else if (changed) moved += 1;
      else same += 1;
      const mark = changed ? '→' : ' ';
      console.log(
        `  ${mark} ${r.personId.slice(0, 8)} ${r.assessmentYear}  net ${money(r.before)} => ${money(r.after)}` +
          (changed ? `  (${delta! > 0 ? '+' : ''}${delta!.toFixed(2)})` : '') +
          (applied || dryRun ? '' : `  REFUSED: ${reason ?? 'unknown'}`),
      );
    }
    console.log();
  }

  console.log(`${dryRun ? 'would move' : 'moved'}: ${moved}   unchanged: ${same}   refused: ${refused}`);
  if (dryRun) console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
