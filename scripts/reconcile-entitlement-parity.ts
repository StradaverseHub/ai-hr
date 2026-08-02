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
// deploy, BEFORE restarting the app — `deploy/deploy.sh --migrate-only` stops exactly there:
//
//   node --env-file=.env.production --import tsx scripts/reconcile-entitlement-parity.ts \
//     --created-before=2026-07-27                                                             # plan
//   node --env-file=.env.production --import tsx scripts/reconcile-entitlement-parity.ts \
//     --created-before=2026-07-27 --apply                                                     # write
//
// `--created-before=<YYYY-MM-DD>` IS THE FLIP BOUNDARY, AND `--apply` REFUSES WITHOUT IT (review r3).
// Parity is a statement about tenants that were running on `.env.production` BEFORE the flip. A tenant
// provisioned after it is a different case entirely: `db/provision.ts` already gave it the correct
// install defaults, and re-granting the env parity set on top would write `payroll.reset_enabled=true`
// and `payroll.unlock_enabled=true` for a brand-new customer — `scope='platform'` rows `ai_hr_app` can
// never close again, which is exactly the over-grant `provisionTenant` refuses to make. Without the
// boundary this script had no way to tell the two apart, so BOTH branches of the operator's only
// decision were wrong: grant nothing and post-flip tenants keep behaving differently, or grant
// everything and new tenants get two unclosable hatches. The date is the operator's to state — it is
// the same sign-off the plan already asks for, made machine-readable — and it is compared against
// `tenant.created_at`, which the plan has always printed for exactly this purpose.
//
// It also makes `--preflight` answerable. Without a boundary, "outstanding" grew by three settings for
// every customer created after the flip, forever, so the check could never reach zero on this
// deployment and the exit code meant nothing.
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
// `disabled` tenant_module row for it before applying. The SETTING axis has no such row — `tenant_setting`
// carries key/value/source and no status — so its equivalent is an explicit `false` row written on the
// owner connection. Both statements are in the preflight's own output and in deploy/DEPLOY.md; saying
// "write a disabled row" for a setting, as this used to, names something that does not exist.
//
// AFTER slice 7 gives operators a real plan-management plane, DELETE THIS FILE. Parity is a migration
// artefact, not a policy: re-running it a year from now would re-grant modules a customer's plan change
// legitimately removed.
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { SYSTEM_TENANT_ID } from '../core/sweep-scope';
import {
  LEGACY_MODULE_ENV_GATES,
  legacyEnabledModulesIn,
  legacyEnabledSettingsIn,
  missingModuleDependencies,
} from '../packs/catalog';

/** The reserved system tenant (0151 §4) — not a customer, and 0313 excludes it for the same reason. */
// The reserved audit anchor from 0151 — defined once in core/sweep-scope.ts, imported here so the
// two places that must agree about it cannot drift.

/**
 * `host/database` for the plan header, credentials stripped.
 *
 * The sign-off this script asks for ("read the list against your customer records") is only meaningful
 * against a NAMED database. Printing the plan without saying which database it was computed from is how
 * an operator signs off on a dev box and applies to production, or the reverse.
 */
function describeDb(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname} as ${u.username || '(default user)'}`;
  } catch {
    return '(unparseable connection string)';
  }
}

async function main() {
  // Opt IN to writing. See the header: the failure direction here is a silent grant, so the bare
  // invocation must be the harmless one.
  const apply = process.argv.includes('--apply');
  // PREFLIGHT MODE — a scripted "did I finish?" for the operator, NOT a deploy gate. Plans exactly as a
  // dry run does and then exits NON-ZERO if anything is still outstanding, so the reconciliation step can
  // be confirmed rather than remembered.
  //
  // DELIBERATELY NOT WIRED INTO deploy/deploy.sh (review r2), where it briefly was. `db/provision.ts`
  // writes no PLATFORM-scoped tenant_setting row for a new tenant — `settingsOnInstallFor` emits one
  // only when `defaultOnInstall` differs from `defaultValue`, and the two payroll risk switches
  // deliberately do not — while this box has PAYROLL_RESET_ENABLED / PAYROLL_UNLOCK_ENABLED true. So a
  // tenant created after the flip is two setting rows "short" by design, and as a `set -e` gate the
  // first such customer would have blocked every later deploy. `--created-before` is what makes the
  // verdict answerable at all (see the header); even so this stays a runbook step rather than a gate,
  // because the script cannot tell "predates the row" from "deliberately unticked" and says so — a
  // check only a human can resolve correctly belongs in deploy/DEPLOY.md, which is where it is.
  const preflight = process.argv.includes('--preflight');

  // THE FLIP BOUNDARY. Parity is about tenants that were already running on this deployment's env; a
  // tenant provisioned after the flip got its install defaults from `db/provision.ts` and must not be
  // re-granted the env set on top. See the header for why `--apply` refuses without it.
  const createdBeforeArg = process.argv.find((a) => a.startsWith('--created-before='));
  const createdBefore = createdBeforeArg ? createdBeforeArg.slice('--created-before='.length) : null;
  if (createdBefore !== null && !/^\d{4}-\d{2}-\d{2}$/.test(createdBefore)) {
    console.error(`--created-before must be YYYY-MM-DD, got '${createdBefore}'.`);
    process.exit(1);
  }
  // Parsed once, as UTC midnight, so the comparison below is against a real instant rather than a
  // string compare against whatever `created_at` renders as in this locale.
  const createdBeforeAt = createdBefore ? new Date(`${createdBefore}T00:00:00Z`) : null;
  if (createdBeforeAt && Number.isNaN(createdBeforeAt.getTime())) {
    console.error(`--created-before=${createdBefore} is not a real date.`);
    process.exit(1);
  }
  if (apply && !createdBeforeAt) {
    console.error('');
    console.error('✗ --apply requires --created-before=<YYYY-MM-DD>, the date of the slice-3 flip.');
    console.error('  Without it this grants the env parity set to tenants provisioned AFTER the flip,');
    console.error('  which db/provision.ts already gave correct install defaults — writing');
    console.error('  payroll.reset_enabled=true and payroll.unlock_enabled=true for a brand-new');
    console.error('  customer. Both are scope=platform, so ai_hr_app can never close them again.');
    console.error('  Running in the deploy window? Use today\'s date. Reconciling later? Use the date');
    console.error('  the slice-3 deploy went out, from deploy/DEPLOY.md.');
    process.exit(1);
  }

  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('reconcile:entitlement-parity requires MIGRATION_DATABASE_URL (the owner role).');
    console.error('tenant_module is SELECT-only to ai_hr_app and the platform-scoped settings are');
    console.error('unwritable by it at all, so this cannot run on the app connection.');
    process.exit(1);
  }

  const modules = legacyEnabledModulesIn(process.env);
  const settings = legacyEnabledSettingsIn(process.env);
  console.log(`reconcile:entitlement-parity ${apply ? '(APPLY)' : preflight ? '(preflight)' : '(dry run)'}`);
  console.log(`  database: ${describeDb(ownerUrl)}`);
  console.log(`  modules this env has on : ${modules.join(', ') || '(none)'}`);
  console.log(`  settings this env has on: ${settings.map((s) => s.key).join(', ') || '(none)'}`);
  // WAS THE ENV FILE ACTUALLY LOADED? Tested against a SENTINEL, because the obvious test does not work
  // and shipped here not working (review r2).
  //
  // This used to be `if (modules.length === 0 && settings.length === 0)`. It can never fire.
  // `legacyEnabledModulesIn` returns a code whose gate is `null` UNCONDITIONALLY, and payroll, attendance,
  // claims and performance are all `null` in LEGACY_MODULE_ENV_GATES — so the module list is four entries
  // long whatever the environment, including a completely empty one. An operator who runs the wrong
  // command shape (the header warns about a bare `tsx`) but happens to have MIGRATION_DATABASE_URL and
  // NODE_ENV exported — after `set -a; . ./.env.production` in a deploy shell, say — sailed through both
  // this abort and the dev-shaped-env refusal below, and `--apply` then granted payroll / attendance /
  // claims / performance tenant-wide to every tenant, including one an operator deliberately unticked.
  // That is the silent grant this script's header names as its own failure direction.
  //
  // So test the thing the message claims to test. These two keys are in BOTH env templates
  // (`.env.example` and `deploy/.env.production.example`) and deploy.sh already refuses to run without
  // DEV_TENANT_ID, so their presence means a real env file is loaded — while nobody types them into an
  // ad-hoc `VAR=… tsx …` invocation, which is the case that was getting through.
  //
  // Read by LITERAL name, not `process.env[k]` over a list: test/module-catalog-drift.test.ts bans a
  // computed env key outside a named owners list, because a computed lookup is invisible to every
  // gate-name check in that file. This is a sentinel, not a gate, but the ban is the right shape and
  // spelling the two names out costs nothing.
  const absentSentinels = [
    process.env.DATABASE_URL ? null : 'DATABASE_URL',
    process.env.DEV_TENANT_ID ? null : 'DEV_TENANT_ID',
  ].filter((k): k is string => k !== null);
  if (absentSentinels.length > 0) {
    console.error(`${absentSentinels.join(' and ')} ${absentSentinels.length === 1 ? 'is' : 'are'} unset.`);
    console.error('That almost certainly means the env file was not loaded — use');
    console.error('`node --env-file=.env.production --import tsx …`, not a bare `tsx`.');
    console.error('Every grant below is read from process.env, so a partially-populated environment');
    console.error('grants a DIFFERENT set from the one this deployment actually runs.');
    process.exit(1);
  }
  // A separate, non-fatal signal: not one env-GATED code is on. That is legitimate (a deployment may
  // genuinely run none of them) and the four ungated modules still need parity rows, so it must not
  // abort — but it is worth saying out loud, because it is also what a half-loaded env looks like.
  if (modules.every((c) => LEGACY_MODULE_ENV_GATES[c] === null) && settings.length === 0) {
    console.warn('  ⚠ no env-GATED module or setting is on in this environment; only the ungated');
    console.warn('    modules below would be granted. Check that this is the env file you meant.');
  }

  // REFUSE A DEV-SHAPED ENV WHEN WRITING. The grants below are read from `process.env`, and `.env.example`
  // — the developer template — ships MULTI_CYCLE_PAYROLL_ENABLED, TYPED_PAY_COMPONENTS_ENABLED,
  // PAYROLL_RESET_ENABLED and PAYROLL_UNLOCK_ENABLED all active and true. Running --apply with that env
  // loaded hands every customer two payroll risk switches which are `scope='platform'`, i.e. ones
  // 0313's write policy makes `ai_hr_app` unable to close afterwards. The abort above catches an env
  // file that was never loaded; this catches the wrong one being loaded, which looks identical in the
  // output and is worse. Dry runs and preflights are unaffected — they write nothing, and being able to
  // preview the plan against a dev database is useful.
  if (apply) {
    const devish = /ai_hr_dev|ai_hr_test/.test(ownerUrl) || process.env.NODE_ENV !== 'production';
    if (devish) {
      console.error('');
      console.error('✗ REFUSING TO --apply against a development-shaped environment.');
      console.error(`  database: ${describeDb(ownerUrl)}   NODE_ENV: ${process.env.NODE_ENV ?? '(unset)'}`);
      console.error('  A grant is permanent, and the two payroll risk switches are platform-scoped, so');
      console.error('  ai_hr_app can never close one this script opens. Run it with .env.production, whose');
      console.error('  template is deploy/.env.production.example — NOT .env.example, which is the developer');
      console.error('  template and ships four of these flags set to true.');
      process.exit(1);
    }
  }

  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name, createdAt: tenant.createdAt }).from(tenant);
  console.log(`  ${tenants.length} tenant(s)`);
  console.log(`  flip boundary            : ${createdBefore ?? '(none — planning over EVERY tenant)'}`);

  let moduleGrants = 0;
  let settingGrants = 0;
  let outOfScope = 0;
  let skipped = 0;
  let failures = 0;
  let inertTenants = 0;
  for (const t of tenants) {
    if (t.id === SYSTEM_TENANT_ID) continue;
    // OUT OF SCOPE: provisioned at or after the flip. `db/provision.ts` already wrote this tenant's
    // install defaults; the env parity set is a statement about tenants that predate the flip, and
    // applying it here would open two platform-scoped payroll switches for a brand-new customer. A
    // tenant with no creation date at all is treated as in scope — the column is NOT NULL, so that
    // cannot happen, and guessing "new" for an impossible row would silently skip a real gap.
    if (createdBeforeAt && t.createdAt && new Date(t.createdAt) >= createdBeforeAt) {
      outOfScope += 1;
      continue;
    }
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
      // PLAN FIRST, WRITE AFTER. The dependency check below needs the whole proposed set, and an
      // operator watching a streaming log needs the warning to appear before the grant it is about.
      const missingModules: string[] = [];
      const heldModules: string[] = [];
      for (const moduleCode of modules) {
        const existing = await owner.db.execute(sql`
          SELECT 1 FROM tenant_module WHERE tenant_id = ${t.id}::uuid AND module_code = ${moduleCode}`);
        if (existing.length > 0) heldModules.push(moduleCode);
        else missingModules.push(moduleCode);
      }
      skipped += heldModules.length;

      // THE dependsOn CLOSURE, checked over what this tenant will actually END UP WITH (review r3).
      // `db/provision.ts` refuses an incoherent pick set at the same seam and for the same reason: slice
      // 2's resolver ANDs the closure, so an ACTIVE row whose dependency is missing resolves DISABLED —
      // "a paid entitlement that is silently inert". This script had no such check, and its own
      // documented opt-out produced exactly that shape: the header (and DEPLOY.md) tell an operator who
      // wants a tenant to stay WITHOUT a module to write a `disabled` row for it first, and a disabled
      // `payroll` row is invisible to `enabledModules` — after which this run happily grants
      // `typed_pay_components` and `multi_cycle_payroll` as ACTIVE rows that resolve OFF, and reports
      // them as granted. `typed_pay_components` is the code the header calls "the one that hurts".
      //
      // FLAGGED, NOT REFUSED. The reconciliation is per tenant and per code; aborting the whole run over
      // one tenant's shape would leave the rest half-reconciled, which is worse. The line is loud, it
      // names the inert codes, and `inert` feeds the exit status below so a preflight cannot pass over it.
      const enabledRows = await owner.db.execute(sql`
        SELECT module_code FROM tenant_module
         WHERE tenant_id = ${t.id}::uuid AND status IN ('active','trial')
           AND (expires_at IS NULL OR expires_at > now())`);
      const willHold = [
        ...new Set([...enabledRows.map((r) => String((r as { module_code: string }).module_code)), ...missingModules]),
      ];
      const unsatisfied = missingModuleDependencies(willHold);
      if (unsatisfied.length > 0 && missingModules.length > 0) {
        inertTenants += 1;
        console.warn(
          `  ⚠ ${t.name} (${t.id}): ${apply ? 'granted' : 'would grant'} ${missingModules.join(', ')}, but ` +
            `${unsatisfied.join(', ')} ${unsatisfied.length === 1 ? 'is' : 'are'} not enabled for this tenant ⇒ ` +
            'the grant RESOLVES DISABLED (slice 2 ANDs the dependsOn closure). Sell the dependency or ' +
            'write a `disabled` row for the dependent code.',
        );
      }
      if (apply) {
        for (const moduleCode of missingModules) {
          // `ON CONFLICT DO NOTHING` stays as the RACE guard; the existence test above is the policy.
          await owner.db.execute(sql`
            INSERT INTO tenant_module (tenant_id, module_code, status)
            VALUES (${t.id}::uuid, ${moduleCode}, 'active')
            ON CONFLICT DO NOTHING`);
        }
      }

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
      `${outOfScope} tenant(s) skipped as provisioned on/after ${createdBefore ?? '(no boundary)'}; ` +
      `${skipped} module(s) left alone because a row already exists; ${inertTenants} tenant(s) with an ` +
      `unsatisfied dependency; ${failures} failure(s).`,
  );
  if (!apply && moduleGrants + settingGrants > 0) {
    console.log('');
    console.log('Nothing was written. Check the list above against your customer records — a grant is');
    console.log('permanent, and this script cannot tell "predates the row" from "deliberately unticked".');
    console.log('Re-run with --apply to write it.');
  }
  await owner.client.end();
  if (failures > 0) process.exit(1);
  // PREFLIGHT VERDICT. Something is still outstanding, so the exit code says so and the operator decides.
  //
  // REACHABLE ONLY WITH `--created-before` (review r3), and the preflight says so rather than exiting
  // red forever. Without a boundary every tenant provisioned after the flip counts as two setting rows
  // short — by design, since `db/provision.ts` gives them install defaults instead — so the verdict
  // could never be green on this deployment and the exit code carried no information. With a boundary,
  // "outstanding" means what it says: a tenant that predates the flip and is missing a row.
  //
  // What it can still legitimately mean, and cannot distinguish: a module an operator deliberately
  // unticked also has no `tenant_module` row. That is why this is advice to a human and not a `set -e`
  // gate, and why the remedy is to record the decision rather than to grant.
  if (preflight && !createdBeforeAt) {
    console.error('');
    console.error('⚠ --preflight without --created-before=<YYYY-MM-DD> cannot reach a clean verdict:');
    console.error('  every tenant provisioned after the flip is counted as missing the two platform');
    console.error('  payroll switches, which db/provision.ts deliberately does not write. Pass the');
    console.error('  flip date so the check answers the question you meant to ask.');
  }
  if (preflight && moduleGrants + settingGrants + inertTenants > 0) {
    console.error('');
    console.error('✗ NOT RECONCILED — some tenant is still missing a row this environment has on.');
    console.error('  If those tenants predate the flip, reconcile them in this window');
    console.error('  (deploy/DEPLOY.md, "ONE-SHOT: entitlement parity"):');
    console.error('    • reconcile:  node --env-file=.env.production --import tsx \\');
    console.error(`                    scripts/reconcile-entitlement-parity.ts --created-before=${createdBefore ?? '<YYYY-MM-DD>'} --apply`);
    console.error('  If instead the module was deliberately left unticked, this is the expected shape');
    console.error('  and there is nothing to grant — record the decision instead:');
    console.error('    • a MODULE: insert a `disabled` tenant_module row for that tenant and code.');
    console.error('    • a SETTING: tenant_setting has no status column, so the equivalent is an');
    console.error('      explicit OFF row on the OWNER connection (ai_hr_app cannot write a');
    console.error('      platform-scoped key at all — 0313 tenant_setting_write requires scope=tenant):');
    console.error("        INSERT INTO tenant_setting (tenant_id, key, value, source)");
    console.error("        VALUES ('<tenant-uuid>', '<key>', 'false'::jsonb, 'platform')");
    console.error('        ON CONFLICT DO NOTHING;');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
