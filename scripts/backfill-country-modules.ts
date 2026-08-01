/**
 * ADR-0077 slice 6 — grant every existing tenant the country modules its companies already operate in.
 *
 * WHY A SCRIPT AND NOT A MIGRATION, and this is not a style preference:
 *
 *   1. `tenant_module.module_code` has an FK to `module(code)`, and `deploy.sh` runs `db:migrate`
 *      BEFORE `seed-catalogs.ts`. A migration inserting `country-my` would fail on that FK, because
 *      the catalog row it references does not exist yet at migrate time.
 *   2. The rule is "insert a row WHERE A PACK IS REGISTERED". Only TypeScript can answer that —
 *      `packFor()` reads the registry. SQL would have to hard-code a country list and would silently
 *      rot the moment a second pack ships, which is the exact failure the country module exists to
 *      prevent.
 *
 * IDEMPOTENT, and permanently so rather than one-shot: it runs on every deploy, so a database this has
 * not yet been applied to still gets populated, and a company created between deploys is picked up on
 * the next one. `tenant_module` has NO unique constraint (only a PK on id), so `ON CONFLICT DO NOTHING`
 * would be a no-op — the insert is guarded by an explicit NOT EXISTS instead.
 *
 * TENANT-WIDE ROWS (`company_id IS NULL`) on purpose. The entitlement being expressed is "this customer
 * may operate Malaysia", not "this company is Malaysian" — the company already carries its own country.
 * That is what makes the MNC path work: platform grants `country-sg`, and only then may an admin create
 * an SG statutory company.
 *
 * IT PRINTS WHAT IT COULD NOT CLASSIFY. Companies whose country has no registered pack are reported
 * with their names, because that set is exactly the input to slice 6's non-statutory tier. It does NOT
 * fail the deploy on them: the tier that would let an operator declare such a company does not exist
 * yet, so failing here would block a deploy over a state nobody can currently resolve. When the tier
 * lands, this becomes the fail-closed check the plan describes.
 *
 * SHIPPED INERT: nothing resolves against `country-*` rows yet.
 *
 *   node --env-file=.env.production --import tsx scripts/backfill-country-modules.ts
 */
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db/client';
import { company, tenantModule } from '../db/schema';
import { packFor } from '../localization/registry';

function loadEnv() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // env supplied directly
    }
  }
}

/** The catalog code for a country's module. Lower-cased so 'MY' and 'my' cannot become two modules. */
export const countryModuleCode = (country: string): string => `country-${country.trim().toLowerCase()}`;

export async function backfillCountryModules(url: string): Promise<{
  granted: number;
  alreadyPresent: number;
  unpacked: { company: string; country: string }[];
}> {
  const owner = createDb(url);
  const companies = await owner.db
    .select({ id: company.id, tenantId: company.tenantId, name: company.legalName, country: company.country })
    .from(company);

  let granted = 0;
  let alreadyPresent = 0;
  const unpacked: { company: string; country: string }[] = [];
  // Deduped by (tenant, code): one tenant-wide row per country, however many companies share it.
  const wanted = new Map<string, { tenantId: string; code: string }>();

  for (const c of companies) {
    if (!packFor(c.country)) {
      unpacked.push({ company: c.name, country: c.country ?? '(none)' });
      continue;
    }
    const code = countryModuleCode(c.country!);
    wanted.set(`${c.tenantId}:${code}`, { tenantId: c.tenantId, code });
  }

  for (const { tenantId, code } of wanted.values()) {
    const [existing] = await owner.db
      .select({ id: tenantModule.id })
      .from(tenantModule)
      .where(
        and(eq(tenantModule.tenantId, tenantId), eq(tenantModule.moduleCode, code), isNull(tenantModule.companyId)),
      )
      .limit(1);
    if (existing) {
      alreadyPresent += 1;
      continue;
    }
    await owner.db.insert(tenantModule).values({ tenantId, moduleCode: code, companyId: null, status: 'active' });
    granted += 1;
  }

  return { granted, alreadyPresent, unpacked };
}

if (process.argv[1]?.endsWith('backfill-country-modules.ts')) {
  loadEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('backfill-country-modules requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  backfillCountryModules(url)
    .then((r) => {
      console.log(`  Country modules: ${r.granted} granted, ${r.alreadyPresent} already present.`);
      if (r.unpacked.length > 0) {
        // Reported on EVERY deploy, not once: an unclassifiable company is a standing question, and a
        // one-time warning is a warning nobody sees again.
        console.log(`  ⚠️  ${r.unpacked.length} company(ies) have no registered country pack:`);
        for (const u of r.unpacked) console.log(`       ${u.company} (${u.country})`);
        console.log('       These are the non-statutory tier candidates (slice 6). Not fatal yet.');
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
