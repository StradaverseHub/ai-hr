/**
 * Seed the MODULE and SETTING catalogs from packs/catalog.ts (ADR-0077 slice 1, convention C11).
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION
 * ----------------------------------------
 * Migrations here are hand-written SQL applied by drizzle-kit (package.json:19). SQL cannot read a
 * TypeScript module, so a catalog whose source of truth is `packs/catalog.ts` can never be seeded "at
 * migrate time" — an early draft of the slice plan said it could, and it is simply not expressible.
 * Encoding the rows as INSERT literals inside a migration would work exactly once and then rot: the
 * catalog would live in two places and the drift test could not tell which was right.
 *
 * FOUR CALL SITES, ALL NAMED (C11). Every bootstrap that produces a usable database runs this:
 *   1. deploy/deploy.sh          — after `pnpm db:migrate`, before the conditional demo seed
 *   2. test/global-setup.ts      — into the TEMPLATE, before workers are stamped from it
 *   3. cleanroom-verify.sh       — after migrate, before vitest
 *   4. db/seed.ts                — so a dev box that only ever runs db:seed is not a special case
 * Miss one and the omission shows up as a foreign-key violation in an unrelated test, which is a
 * miserable way to learn about it — so `test/module-catalog-drift.test.ts` asserts the DB catalog
 * equals the code catalog, and that test runs in every one of those environments.
 *
 * IDEMPOTENT BY CONSTRUCTION (C3). `ON CONFLICT DO UPDATE` on the natural key: re-running reconciles
 * a changed description or sort order without duplicating rows, and never touches the per-tenant
 * `tenant_module` / `tenant_setting` rows that reference these. Deleting a catalog row is deliberately
 * NOT automatic — a code row disappearing would otherwise cascade into a customer's entitlements. The
 * drift test reports extras loudly instead, and removal is a deliberate migration.
 *
 * RUNS AS THE OWNER. Both catalogs are SELECT-only to ai_hr_app by explicit REVOKE (migration 0313),
 * so this must connect with MIGRATION_DATABASE_URL. That is the point: the application can never
 * write the catalog its own policies join against.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { MODULE_CATALOG, SETTING_CATALOG } from '../packs/catalog';
import * as schema from '../db/schema';

/**
 * A bare drizzle handle. Deliberately NOT `db/client`'s: that module builds the application
 * singleton at import time and throws unless DATABASE_URL is set (db/client.ts:72-76). A bootstrap
 * script runs before the app's own env is necessarily complete — and the test template build has no
 * app URL at all — so this connects the way test/global-setup.ts does, with a raw postgres handle.
 */
type Db = ReturnType<typeof drizzle>;

/**
 * Upsert both catalogs. Exported so the test harness and db/seed.ts can call it inside their own
 * connection rather than shelling out to a second process.
 */
export async function seedCatalogs(db: Db): Promise<{ modules: number; settings: number }> {
  // Parent-before-child: `parent_module` is a self-FK, so `toil` cannot land before `leave`. Sorting
  // by (parentModule === null ? 0 : 1) is enough — the catalog is only ever one level deep, and the
  // drift test asserts that, so a future grandchild fails loudly instead of failing on insert order.
  const modules = [...MODULE_CATALOG].sort((a, b) => Number(a.parentModule != null) - Number(b.parentModule != null));

  for (const m of modules) {
    await db
      .insert(schema.module_)
      .values({
        code: m.code,
        name: m.name,
        category: m.category,
        description: m.description,
        dependsOn: m.dependsOn,
        billable: m.billable,
        isCore: m.isCore,
        parentModule: m.parentModule,
        packBacked: m.packBacked,
        sortOrder: m.sortOrder,
      })
      .onConflictDoUpdate({
        target: schema.module_.code,
        set: {
          name: m.name,
          category: m.category,
          description: m.description,
          dependsOn: m.dependsOn,
          billable: m.billable,
          isCore: m.isCore,
          parentModule: m.parentModule,
          packBacked: m.packBacked,
          sortOrder: m.sortOrder,
        },
      });
  }

  for (const s of SETTING_CATALOG) {
    await db
      .insert(schema.settingDefinition)
      .values({
        key: s.key,
        moduleCode: s.moduleCode,
        scope: s.scope,
        valueType: s.valueType,
        defaultValue: s.defaultValue,
        defaultOnInstall: s.defaultOnInstall,
        customerVisible: s.customerVisible,
        description: s.description,
        sortOrder: s.sortOrder,
      })
      .onConflictDoUpdate({
        target: schema.settingDefinition.key,
        set: {
          moduleCode: s.moduleCode,
          scope: s.scope,
          valueType: s.valueType,
          defaultValue: s.defaultValue,
          defaultOnInstall: s.defaultOnInstall,
          customerVisible: s.customerVisible,
          description: s.description,
          sortOrder: s.sortOrder,
        },
      });
  }

  return { modules: MODULE_CATALOG.length, settings: SETTING_CATALOG.length };
}

/** Run against an arbitrary connection string — used by the test template build and the clean-room. */
export async function seedCatalogsAt(url: string): Promise<{ modules: number; settings: number }> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await seedCatalogs(drizzle(client));
  } finally {
    // The test template must have NO open connections when CREATE DATABASE ... TEMPLATE copies it
    // (test/global-setup.ts:20-25), so closing here is load-bearing, not tidiness. Callers that
    // already hold a connection should call seedCatalogs(db) directly and keep owning it.
    await client.end({ timeout: 10 });
  }
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required — the catalogs are owner-writable only.');
  const { modules, settings } = await seedCatalogsAt(url);
  // Printed counts, per C5: a silent seeder is indistinguishable from one that did nothing.
  console.log(`▸ Catalogs seeded: ${modules} modules, ${settings} settings.`);
}

// Direct-invocation guard, matching scripts/provision-runner.ts:330 — importing this module for
// `seedCatalogs` must not fire `main()`.
if (process.argv[1] && process.argv[1].endsWith('seed-catalogs.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
