// ONE-SHOT maintenance CLI (ADR-0077 slice 3) — close the parity gap migration 0313 structurally
// cannot reach, for tenants created AFTER it ran.
//
// THE GAP. 0313's backfill grants the parity `tenant_module` / `tenant_setting` rows to every tenant
// that existed at migrate time. It runs once. The only production writer that creates a tenant
// afterwards is `db/provision.ts`, which until this slice inserted exactly the modules the operator
// ticked (the form pre-ticked only the four modules NO env var gates) and no settings at all. So every
// tenant provisioned between slice 1's deploy and slice 3's has been RUNNING
//   • `notifications`, `multi_cycle_payroll`, `typed_pay_components` — on via .env.production, and
//   • `payroll.reset_enabled`, `payroll.unlock_enabled`, `payroll.individual_txn_pay_enabled`
// while carrying no row for any of them, because nothing read a row yet. The moment slice 3's resolver
// starts reading rows, all six switch OFF for that tenant, silently. `typed_pay_components` is the one
// that hurts: core/payroll.ts switches the earnings source on it, so the next payslip run changes
// numbers with no error anywhere.
//
// WHY A SCRIPT AND NOT A SECOND MIGRATION. The correct grant is what THIS DEPLOYMENT's env actually
// has on, and SQL cannot read an env var — that limitation is written into 0313's own header, which
// notes it grants "the set the REPOSITORY says this deployment runs". A migration would therefore
// either re-grant a module this box does not run, or undo the documented DELETE remedy an operator ran
// on a deployment that legitimately has a flag off. Reading `legacyEnabledModulesIn(process.env)` /
// `legacyEnabledSettingsIn(process.env)` is the only way to say "grant what the env is giving them
// today", which is the definition of parity.
//
// SAFE TO RE-RUN AND SAFE TO RUN EARLY. Every insert is `ON CONFLICT DO NOTHING`, and a tenant that
// already has the row is untouched — including one 0313 backfilled. It never REVOKES: a module absent
// from this deployment's env is left absent, because a missing row already means disabled (C7), which
// is exactly what an unset env var means today. Run it in the same maintenance window as the slice-3
// deploy, BEFORE restarting the app:
//
//   node --env-file=.env.production --import tsx scripts/reconcile-entitlement-parity.ts            # plan
//   node --env-file=.env.production --import tsx scripts/reconcile-entitlement-parity.ts --apply    # write
//
// DRY RUN IS THE DEFAULT, and the inversion is deliberate (review r2). This script's failure direction
// is a SILENT GRANT — the one outcome nothing downstream notices, and the same shape as the
// review-sweep defect slice 3 exists to fix — so the bare invocation must be the one that cannot cause
// it. `--apply` writes; anything else plans.
//
// WHAT IT CANNOT KNOW, STATED PLAINLY RATHER THAN GLOSSED. `provisionTenant` honours the operator's
// pick set verbatim ("unticking is still the operator's decision"), so a customer deliberately sold
// WITHOUT Notifications and a customer that simply predates the row are INDISTINGUISHABLE here: both
// have no row. The tie is broken toward granting, and the justification is narrow — before slice 3
// nothing read the row, so `NOTIFICATIONS_ENABLED=true` gave that tenant notifications regardless of
// what the operator ticked. The untick was inert; granting preserves today's ACTUAL behaviour, which
// is the whole promise of the flip. Revoking would be the behaviour change.
//
// That argument justifies the default, not silence about it. So: the plan prints every tenant with its
// creation date for sign-off, a code is SKIPPED when the tenant already holds a row at ANY grain (see
// the per-code check below), and an operator who wants a tenant to stay without a module writes a
// `disabled` row for it before applying.
//
// AFTER slice 7 gives operators a real plan-management plane, DELETE THIS FILE. Parity is a migration
// artefact, not a policy: re-running it a year from now would re-grant modules a customer's plan change
// legitimately removed.
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { legacyEnabledModulesIn, legacyEnabledSettingsIn } from '../packs/catalog';

/** The reserved system tenant (0151 §4) — not a customer, and 0313 excludes it for the same reason. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

async function main() {
  // Opt IN to writing. See the header: the failure direction here is a silent grant, so the bare
  // invocation must be the harmless one.
  const apply = process.argv.includes('--apply');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('reconcile:entitlement-parity requires MIGRATION_DATABASE_URL (the owner role).');
    console.error('tenant_module is SELECT-only to ai_hr_app and the platform-scoped settings are');
    console.error('unwritable by it at all, so this cannot run on the app connection.');
    process.exit(1);
  }

  const modules = legacyEnabledModulesIn(process.env);
  const settings = legacyEnabledSettingsIn(process.env);
  console.log(`reconcile:entitlement-parity ${apply ? '(APPLY)' : '(dry run)'}`);
  console.log(`  modules this env has on : ${modules.join(', ') || '(none)'}`);
  console.log(`  settings this env has on: ${settings.map((s) => s.key).join(', ') || '(none)'}`);
  if (modules.length === 0 && settings.length === 0) {
    console.error('Nothing to grant. That almost certainly means the env file was not loaded —');
    console.error('use `node --env-file=.env.production --import tsx …`, not a bare `tsx`.');
    process.exit(1);
  }

  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name, createdAt: tenant.createdAt }).from(tenant);
  console.log(`  ${tenants.length} tenant(s)`);

  let moduleGrants = 0;
  let settingGrants = 0;
  let skipped = 0;
  let failures = 0;
  for (const t of tenants) {
    if (t.id === SYSTEM_TENANT_ID) continue;
    try {
      // Per tenant, per code, so the summary can report WHO was short a row rather than a total —
      // "three tenants were missing typed_pay_components" is the fact an operator needs to sanity-check
      // this against the customer list before applying.
      //
      // ANY EXISTING ROW, AT ANY GRAIN, MEANS HANDS OFF. `ON CONFLICT DO NOTHING` alone is not that
      // check, and the difference is a real escalation (review r2). 0313's grain index is
      // `UNIQUE (tenant_id, module_code, COALESCE(company_id, '0…0'))`, so a tenant holding only a
      // COMPANY-SCOPED grant does not conflict with a tenant-wide insert — the script would have added
      // one beside it and promoted a single subsidiary's purchase to the whole group, which is exactly
      // the fail-open branch `core/entitlements.ts`'s scoped check refuses. A company-scoped row is a
      // deliberate scope decision, and a `disabled` row is a deliberate revocation; neither is a gap.
      // So the existence test runs FIRST and identically in both modes, and the insert only ever
      // touches a code with no row of any kind. (`ON CONFLICT DO NOTHING` stays as the race guard.)
      const missingModules: string[] = [];
      const heldModules: string[] = [];
      for (const moduleCode of modules) {
        const existing = await owner.db.execute(sql`
          SELECT 1 FROM tenant_module WHERE tenant_id = ${t.id}::uuid AND module_code = ${moduleCode}`);
        if (existing.length > 0) {
          heldModules.push(moduleCode);
          continue;
        }
        if (apply) {
          await owner.db.execute(sql`
            INSERT INTO tenant_module (tenant_id, module_code, status)
            VALUES (${t.id}::uuid, ${moduleCode}, 'active')
            ON CONFLICT DO NOTHING`);
        }
        missingModules.push(moduleCode);
      }
      skipped += heldModules.length;
      const missingSettings: string[] = [];
      for (const { key, value } of settings) {
        const existing = await owner.db.execute(sql`
          SELECT 1 FROM tenant_setting WHERE tenant_id = ${t.id}::uuid AND key = ${key}`);
        if (existing.length > 0) continue;
        if (apply) {
          await owner.db.execute(sql`
            INSERT INTO tenant_setting (tenant_id, key, value, source)
            VALUES (${t.id}::uuid, ${key}, ${JSON.stringify(value)}::jsonb, 'platform')
            ON CONFLICT DO NOTHING`);
        }
        missingSettings.push(key);
      }
      moduleGrants += missingModules.length;
      settingGrants += missingSettings.length;
      // The creation date is printed for SIGN-OFF, not used as a rule: a tenant created before 0313 ran
      // was covered by its backfill and should show nothing here, so a pre-0313 date next to a proposed
      // grant is the signal that something else is going on and the operator should stop and look.
      const created = t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 10) : '????-??-??';
      if (missingModules.length === 0 && missingSettings.length === 0) {
        console.log(`  = ${t.name} (${t.id}, created ${created}): already at parity`);
      } else {
        console.log(
          `  ${apply ? '+' : '!'} ${t.name} (${t.id}, created ${created}): ${apply ? 'granted' : 'WOULD grant'} ` +
            `modules ${missingModules.join(', ') || '—'} | settings ${missingSettings.join(', ') || '—'}` +
            (heldModules.length ? ` | left alone (row already exists) ${heldModules.join(', ')}` : ''),
        );
      }
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `reconcile:entitlement-parity done — ${moduleGrants} module row(s), ${settingGrants} setting row(s) ` +
      `${apply ? 'granted' : 'WOULD be granted'} across ${tenants.length} tenant(s); ` +
      `${skipped} module(s) left alone because a row already exists; ${failures} failure(s).`,
  );
  if (!apply && moduleGrants + settingGrants > 0) {
    console.log('');
    console.log('Nothing was written. Check the list above against your customer records — a grant is');
    console.log('permanent, and this script cannot tell "predates the row" from "deliberately unticked".');
    console.log('Re-run with --apply to write it.');
  }
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
