// One-off / maintenance CLI (e7eb5d83 rev 5, step 1b) — RETIRE THE LEGACY FLAT MILEAGE RATE by promoting it
// into the rate TABLE it was superseded by, without changing what anybody is paid by one sen.
//
//   node --env-file=.env.production --import tsx scripts/backfill-mileage-flat-rate.ts [--apply] [--effective-from=YYYY-MM-DD]
//
// ── WHY THIS EXISTS ──
// Before 0408 a mileage rate was one flat scalar buried in a claim-limit row:
// `claim_policy.rate_config = {kind:'mileage_flat', ratePerKm}`. 0408 replaced it with claim_mileage_rate —
// banded, vehicle-classed, grade-scoped, effective-dated — and priceAndCheckClaimTx prefers that table,
// falling back to the flat scalar only when the tenant has built no table at all.
//
// On the reference tenant that fallback is not a corner case, it is THE LIVE PATH: MILEAGE 001 carries
// {kind:'mileage_flat', ratePerKm:0.7} and every claim_mileage_rate row sits on GRADE 12 (PERMANENT), which
// has zero employments. So every mileage claim in the company is priced by the scalar, and the scalar lives
// on a screen that no longer has a field for it — one re-save of the Mileage limit would blank it and every
// filer would meet "No mileage rate has been set up for this claim type yet".
//
// setClaimPolicy's rate_config carry-forward (step 1a) stops the SAVE from blanking it. This script removes
// the dependency altogether: a company-wide band table carrying the identical rate, over the identical
// period, so the fallback stops being load-bearing.
//
// ── WHY IT CANNOT CHANGE AN AMOUNT ──
//   • The band written is a single open band [0 km → ∞] at the same ratePerKm, and priceMileage over one
//     open band is exactly `km × ratePerKm` — computeClaimAmount's mileage_flat arithmetic, character for
//     character.
//   • valid_from defaults to the FLAT POLICY'S OWN valid_from, so the table covers precisely the period the
//     scalar covered. Nothing before it changes, nothing after it changes.
//   • A grade with its own table still wins: resolveMileageRateBands tries (grade, class) → (grade, any) →
//     (null, class) → (null, any), and this writes only the last tier. GRADE 12 keeps its 1.00/0.80/0.60.
//   • Already-filed claims store their amount; nothing recomputes. The only visible difference is that new
//     claims now carry a mileage stamp explaining the arithmetic, where before they carried none.
//
// ── IDEMPOTENT ──
// A claim type that already has an OPEN company-wide 'any' table is SKIPPED, never closed and re-opened. A
// second run is a no-op and says so. Dry-run by default; pass --apply to write.
import { createDb } from '../db/client';
import { tenant, claimPolicy, claimType, claimMileageRate } from '../db/schema';
import { and, eq, isNull } from 'drizzle-orm';
// ADR-0080 D9 — through the pack FACADE, never `core/claims` directly. The import ratchet
// (test/claims-pack-drift.test.ts) fails any new file that reaches past it, and its allowlist is audited
// kernel-contract debt that only ever shrinks — it is not a place to register a new caller.
import { setMileageRateTable } from '../packs/claims/service';

type Plan = {
  tenantId: string;
  tenantName: string;
  claimTypeId: string;
  claimTypeCode: string;
  ratePerKm: number;
  effectiveFrom: string;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const fromArg = process.argv.find((a) => a.startsWith('--effective-from='))?.split('=')[1] ?? null;
  if (fromArg != null && !/^\d{4}-\d{2}-\d{2}$/.test(fromArg)) {
    console.error('--effective-from must be YYYY-MM-DD');
    process.exit(1);
  }

  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('backfill:mileage-flat-rate requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`backfill:mileage-flat-rate — ${tenants.length} tenant(s)${apply ? '' : '  (DRY RUN — pass --apply to write)'}`);

  const plans: Plan[] = [];
  let skipped = 0;
  for (const t of tenants) {
    // Every OPEN policy version still carrying the legacy scalar. Read with the owner connection and an
    // explicit tenant predicate rather than through withTenant: this is an enumeration across tenants.
    const openFlat = await owner.db
      .select({
        claimTypeId: claimPolicy.claimTypeId,
        code: claimType.code,
        rateConfig: claimPolicy.rateConfig,
        validFrom: claimPolicy.validFrom,
      })
      .from(claimPolicy)
      .innerJoin(claimType, eq(claimType.id, claimPolicy.claimTypeId))
      .where(and(eq(claimPolicy.tenantId, t.id), isNull(claimPolicy.validTo)));

    for (const row of openFlat) {
      if (row.rateConfig?.kind !== 'mileage_flat') continue;
      const ratePerKm = row.rateConfig.ratePerKm;
      if (!(ratePerKm > 0)) {
        console.log(`  ! ${t.name}: ${row.code} carries a mileage_flat rate of ${ratePerKm} — not a rate, skipped`);
        continue;
      }
      // The guard that makes a re-run a no-op: an existing OPEN company-wide 'any' table is left alone.
      // Closing and re-inserting it would be behaviour-identical but would rewrite the tenant's own rate
      // history, and a maintenance script must never do that.
      const [existing] = await owner.db
        .select({ id: claimMileageRate.id })
        .from(claimMileageRate)
        .where(
          and(
            eq(claimMileageRate.tenantId, t.id),
            eq(claimMileageRate.claimTypeId, row.claimTypeId),
            eq(claimMileageRate.vehicleClass, 'any'),
            isNull(claimMileageRate.gradeId),
            isNull(claimMileageRate.validTo),
          ),
        )
        .limit(1);
      if (existing) {
        skipped += 1;
        console.log(`  = ${t.name}: ${row.code} already has an open company-wide table — skipped`);
        continue;
      }
      plans.push({
        tenantId: t.id,
        tenantName: t.name,
        claimTypeId: row.claimTypeId,
        claimTypeCode: row.code,
        ratePerKm,
        effectiveFrom: fromArg ?? row.validFrom,
      });
    }
  }

  for (const p of plans) {
    const line = `${p.tenantName}: ${p.claimTypeCode} → company-wide band [0 km → ∞] @ ${p.ratePerKm}/km from ${p.effectiveFrom}`;
    if (!apply) {
      console.log(`  · ${line}`);
      continue;
    }
    try {
      // SYSTEM context — hr_admin authorizes the config write; no userId, so the event actor is `system`.
      await setMileageRateTable(
        { tenantId: p.tenantId, roles: ['hr_admin'], entitlementsExempt: 'sweeps' },
        {
          claimTypeId: p.claimTypeId,
          gradeId: null,
          vehicleClass: 'any',
          effectiveFrom: p.effectiveFrom,
          bands: [{ fromKm: 0, toKm: null, ratePerKm: p.ratePerKm }],
        },
      );
      console.log(`  ✓ ${line}`);
    } catch (e) {
      console.error(`  ✗ ${line}: ${(e as Error).message}`);
      await owner.client.end();
      process.exit(1);
    }
  }

  console.log(
    `backfill:mileage-flat-rate done — ${plans.length} table(s) ${apply ? 'written' : 'to write'}, ${skipped} already present.`,
  );
  await owner.client.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
