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
 *   3. cleanroom-verify.sh       — after migrate, rehearsing (1) against a virgin database
 *   4. db/seed.ts                — so a dev box that only ever runs db:seed is not a special case
 * `test/module-catalog-drift.test.ts` asserts the DB catalog equals the code catalog, so (2) and (4)
 * fail loudly if they are dropped. (1) and (3) are NOT covered by that: the clean room migrates and
 * seeds `ai_hr_cleanroom`, but test/env.ts repoints every worker at `ai_hr_test_w<n>` and
 * test/global-setup.ts rebuilds its own template, so vitest never reads the database the clean room
 * seeded — what step (3) proves is that the seeder RUNS CLEANLY against a freshly migrated schema,
 * which is exactly the deploy.sh path and the reason it is rehearsed at all. Do not read the presence
 * of a green gate as evidence that deploy.sh's seed step is exercised end to end.
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
import { and, eq, inArray } from 'drizzle-orm';
import {
  MODULE_CATALOG,
  SETTING_CATALOG,
  type ModuleCatalogEntry,
  type SettingCatalogEntry,
} from '../packs/catalog';
import * as schema from '../db/schema';

/**
 * A bare drizzle handle. Deliberately NOT `db/client`'s: that module builds the application
 * singleton at import time and throws unless DATABASE_URL is set (db/client.ts:72-76). A bootstrap
 * script runs before the app's own env is necessarily complete — and the test template build has no
 * app URL at all — so this connects the way test/global-setup.ts does, with a raw postgres handle.
 */
type Db = ReturnType<typeof drizzle>;

/**
 * The catalogs to seed. A PARAMETER with the real catalogs as its default, for one reason: both guards
 * below are the seeder's only fail-loud paths and neither was reachable from a test, because the rows
 * they refuse can only be produced by EDITING packs/catalog.ts. Injecting a mutated catalog is how a
 * test states "someone flipped this row" without a source edit. Production call sites pass nothing.
 */
export type CatalogSource = {
  modules: readonly ModuleCatalogEntry[];
  settings: readonly SettingCatalogEntry[];
};

/**
 * Upsert both catalogs. Exported so the test harness and db/seed.ts can call it inside their own
 * connection rather than shelling out to a second process.
 */
export async function seedCatalogs(
  db: Db,
  catalog: CatalogSource = { modules: MODULE_CATALOG, settings: SETTING_CATALOG },
): Promise<{ modules: number; settings: number }> {
  // PROMOTING A MODULE billable -> core IS THE MIRROR OF THE SETTING GUARD BELOW, and until round 3 the
  // comment there claimed this existed when it did not. `tenant_module`'s core guard is a trigger that
  // refuses INSERT and UPDATE on any row whose module is core, so a catalog edit flipping `is_core` on
  // a module customers already hold would sail through ON CONFLICT DO UPDATE and FREEZE every one of
  // those rows: they stay in force, cannot be re-dated, re-statused or expired, and only DELETE is left.
  // Refuse, and make the maintainer write a migration that decides what happens to the rows first.
  const promotingToCore = catalog.modules.filter((m) => m.isCore).map((m) => m.code);
  if (promotingToCore.length > 0) {
    const held = await db
      .selectDistinct({ code: schema.tenantModule.moduleCode })
      .from(schema.tenantModule)
      .where(inArray(schema.tenantModule.moduleCode, promotingToCore));
    if (held.length > 0) {
      const codes = held.map((r) => r.code).join(', ');
      throw new Error(
        `Refusing to promote ${codes} to is_core: tenant_module rows exist for those codes and the ` +
          '0313 core guard would freeze them (no INSERT, no UPDATE — only DELETE). Write a migration ' +
          'that removes or reassigns those entitlements first (ADR-0077 slice 1).',
      );
    }
  }

  // Parent-before-child: `parent_module` is a self-FK, so `toil` cannot land before `leave`. Sorting
  // by (parentModule === null ? 0 : 1) is enough — the catalog is only ever one level deep, and the
  // drift test asserts that, so a future grandchild fails loudly instead of failing on insert order.
  const modules = [...catalog.modules].sort(
    (a, b) => Number(a.parentModule != null) - Number(b.parentModule != null),
  );

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

  // PROMOTING A SETTING tenant -> platform IS NOT A SEEDER'S DECISION TO MAKE SILENTLY. The scope join
  // in tenant_setting's write policy is evaluated when a row is WRITTEN and never again, so a key that
  // gains scope='platform' leaves every value a customer already wrote in force AND unremovable (the
  // USING arm now filters their DELETE out). This is the setting axis's half of the is_core guard at
  // the top of this function. Refuse, and make the maintainer write a migration that decides what
  // happens to those rows — reprovenance them, or delete them.
  const promoting = catalog.settings.filter((s) => s.scope === 'platform').map((s) => s.key);
  if (promoting.length > 0) {
    const stale = await db
      .selectDistinct({ key: schema.tenantSetting.key })
      .from(schema.tenantSetting)
      .innerJoin(schema.settingDefinition, eq(schema.settingDefinition.key, schema.tenantSetting.key))
      .where(
        and(
          eq(schema.tenantSetting.source, 'customer'),
          // The DB still says tenant-scoped while the code above now says platform — that IS the promotion.
          eq(schema.settingDefinition.scope, 'tenant'),
          inArray(schema.tenantSetting.key, promoting),
        ),
      );
    if (stale.length > 0) {
      const keys = stale.map((r) => r.key).join(', ');
      throw new Error(
        `Refusing to promote ${keys} to scope='platform': customer-written tenant_setting rows exist for ` +
          'those keys and would stay in force but become uneditable. Write a migration that reprovenances ' +
          'or removes them first (ADR-0077 slice 1).',
      );
    }
  }

  for (const s of catalog.settings) {
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

  return { modules: catalog.modules.length, settings: catalog.settings.length };
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
