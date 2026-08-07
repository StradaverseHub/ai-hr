// One-off / maintenance CLI (2da9937a) — create Overtime 2.0 and Overtime 3.0 alongside a tenant's
// existing Overtime 1.5, each with its per-hour rate already configured.
//
// WHY A SCRIPT AND NOT A MIGRATION. These are TENANT catalog rows with a tenant-specific rate, and the
// approved plan is explicit that they must be written "through the same writer the admin screen uses, not
// a raw insert, so they exercise the same validation and audit event". A SQL migration can only do the
// raw insert: no rule validation, no recorded resolution order, no `pay-component.created` event, and no
// way to read the tenant's own 1.5× rate to scale from. So the seed runs through core/pay-components'
// `seedOvertimeMultipliers`, which is the admin screen's own `upsertPayComponent`.
//
// The rate is DERIVED from the reference item (see seedOvertimeMultipliers) — nothing here invents a
// figure. Existing codes are skipped, never overwritten, so a re-run cannot reset a rate someone has
// since corrected.
//
//   node --env-file=.env.production --import tsx scripts/seed-overtime-multipliers.ts [--tenant <id>] [--from OT1_5] [--from-multiplier 1.5]
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
// ADR-0080 D9 — through the pack FACADE, not the implementation. packs/payroll/service re-exports
// core/pay-components; importing that file directly is what the payroll pack ratchet refuses, and its
// allowlist only ever shrinks.
import { OvertimeReferenceUnusableError, seedOvertimeMultipliers } from '../packs/payroll/service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('seed:overtime-multipliers requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const only = arg('tenant');
  const fromCode = arg('from') ?? 'OT1_5';
  const fromMultiplier = Number(arg('from-multiplier') ?? '1.5');
  if (!(fromMultiplier > 0)) {
    console.error('--from-multiplier must be greater than zero (it is the multiple the reference rate already encodes).');
    process.exit(1);
  }

  const owner = createDb(ownerUrl);
  const all = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  const tenants = only ? all.filter((t) => t.id === only) : all;
  if (tenants.length === 0) {
    console.error(only ? `No tenant with id ${only}.` : 'No tenants.');
    await owner.client.end();
    process.exit(1);
  }
  console.log(`seed:overtime-multipliers — ${tenants.length} tenant(s), modelled on ${fromCode} at ${fromMultiplier}×`);

  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context (hr_admin authorizes the catalog write; no userId → event actor is `system`).
      const res = await seedOvertimeMultipliers(
        { tenantId: t.id, roles: ['hr_admin'], entitlementsExempt: 'sweeps' },
        { fromCode, fromMultiplier },
      );
      const parts = [
        res.created.length ? `created ${res.created.join(', ')}` : 'created none',
        res.skipped.length ? `already present ${res.skipped.join(', ')}` : null,
      ].filter(Boolean);
      console.log(`  ✓ ${t.name} (${t.id}): hourly rate ${res.hourlyRate} — ${parts.join('; ')}`);
    } catch (e) {
      // A tenant with no Overtime 1.5 is not a failure of this sweep — it simply has nothing to model on,
      // and inventing a rate for it is precisely what this script refuses to do.
      if (e instanceof OvertimeReferenceUnusableError && e.reason === 'not_found') {
        console.log(`  – ${t.name} (${t.id}): no ${fromCode} to model on, skipped`);
        continue;
      }
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(`seed:overtime-multipliers done — ${failures} failure(s).`);
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
