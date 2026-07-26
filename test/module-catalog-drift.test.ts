/**
 * ADR-0077 slice 1 — the catalog drift ratchet (convention C11/C9).
 *
 * The module catalog exists in two places by necessity: `packs/catalog.ts` (the source of truth, which
 * migrations cannot read) and the `module` table (which policies and foreign keys join against). This
 * file is what stops them diverging.
 *
 * It also pins the catalog-vs-pack-registry correspondence in BOTH directions, because that is the
 * distinction the whole design rests on and the one the original plan got wrong: a `ModulePack` is a
 * CODE identity, a catalog row is a COMMERCIAL one, and they are not the same set. `toil` is billable
 * with no pack; `leave` has a pack but is core. A test that only checked one direction would let a new
 * pack ship unsellable, or a catalog row point at a pack that does not exist.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, owner } from './harness';
import { afterAll } from 'vitest';
import {
  ALL_MODULE_CODES,
  CORE_MODULE_CODES,
  MODULE_CATALOG,
  SELLABLE_MODULE_CODES,
  SETTING_CATALOG,
} from '../packs/catalog';
import '../packs/register-all';
import { listPacks } from '../packs/registry';

afterAll(async () => {
  await closeAll();
});

describe('module catalog — code and database agree', () => {
  it('every code-side module exists in the database with identical flags', async () => {
    // The seeder ran at template-build time (test/global-setup.ts); if it did not, this is the test
    // that says so, instead of an unrelated suite failing on a foreign key.
    const rows = await owner.db
      .select({
        code: schema.module_.code,
        isCore: schema.module_.isCore,
        billable: schema.module_.billable,
        parentModule: schema.module_.parentModule,
        packBacked: schema.module_.packBacked,
      })
      .from(schema.module_);
    const byCode = new Map(rows.map((r) => [r.code, r]));

    expect(rows.length, 'DB catalog is empty — scripts/seed-catalogs.ts did not run at bootstrap').toBeGreaterThan(0);

    for (const m of MODULE_CATALOG) {
      const row = byCode.get(m.code);
      expect(row, `module '${m.code}' is missing from the database catalog`).toBeDefined();
      expect(row!.isCore, `${m.code}.is_core`).toBe(m.isCore);
      expect(row!.billable, `${m.code}.billable`).toBe(m.billable);
      expect(row!.parentModule, `${m.code}.parent_module`).toBe(m.parentModule);
      expect(row!.packBacked, `${m.code}.pack_backed`).toBe(m.packBacked);
    }
  });

  it('the database carries no module the code does not know about', async () => {
    // Extras are reported rather than deleted: a row that vanished from code may still be referenced
    // by a live customer's entitlement, and cascading that away is not something a seeder should do
    // silently. Removal is a deliberate migration.
    const rows = await owner.db.select({ code: schema.module_.code }).from(schema.module_);
    const extra = rows.map((r) => r.code).filter((c) => !ALL_MODULE_CODES.includes(c));
    expect(extra, 'DB has module rows absent from packs/catalog.ts — remove them in a migration').toEqual([]);
  });

  it('every code-side setting exists in the database with the same scope', async () => {
    const rows = await owner.db
      .select({ key: schema.settingDefinition.key, scope: schema.settingDefinition.scope })
      .from(schema.settingDefinition);
    const byKey = new Map(rows.map((r) => [r.key, r.scope]));
    for (const s of SETTING_CATALOG) {
      expect(byKey.get(s.key), `setting '${s.key}' scope`).toBe(s.scope);
    }
  });
});

describe('module catalog — the pack correspondence, both directions', () => {
  it('every registered module pack has a catalog row that claims it', () => {
    // Direction 1: add a pack, forget the catalog row → it can never be sold or gated. Caught here.
    const packIds = listPacks('module').map((p) => p.id).sort();
    expect(packIds.length, 'no packs registered — packs/register-all.ts is not doing its job').toBeGreaterThan(0);
    for (const id of packIds) {
      const row = MODULE_CATALOG.find((m) => m.code === id);
      expect(row, `pack '${id}' has no catalog entry in packs/catalog.ts`).toBeDefined();
      expect(row!.packBacked, `catalog row '${id}' must be marked packBacked`).toBe(true);
    }
  });

  it('every packBacked catalog row names a pack that is actually registered', () => {
    // Direction 2: mark a row packBacked with no such pack → the slice-4 nav filter would look for a
    // pack that never resolves, and the module would be invisible rather than merely disabled.
    const packIds = new Set(listPacks('module').map((p) => p.id));
    for (const m of MODULE_CATALOG.filter((x) => x.packBacked)) {
      expect(packIds.has(m.code), `catalog row '${m.code}' is packBacked but no such pack is registered`).toBe(true);
    }
  });

  it('a sub-module names a real parent, and the hierarchy is exactly one level deep', () => {
    // The seeder inserts parents before children by a single sort key, which is only sufficient while
    // the tree is one level deep. Asserting the depth here is what makes that safe rather than lucky.
    for (const m of MODULE_CATALOG.filter((x) => x.parentModule)) {
      const parent = MODULE_CATALOG.find((p) => p.code === m.parentModule);
      expect(parent, `'${m.code}' names unknown parent '${m.parentModule}'`).toBeDefined();
      expect(parent!.parentModule, `'${m.parentModule}' is itself a child — catalog must stay one level deep`).toBeNull();
    }
  });

  it('every dependsOn target is a real module code', () => {
    for (const m of MODULE_CATALOG) {
      for (const dep of m.dependsOn) {
        expect(ALL_MODULE_CODES.includes(dep), `'${m.code}' depends on unknown module '${dep}'`).toBe(true);
      }
    }
  });

  it('core and sellable partition the catalog, and no core module is billable', () => {
    expect([...CORE_MODULE_CODES, ...SELLABLE_MODULE_CODES].sort()).toEqual([...ALL_MODULE_CODES].sort());
    for (const m of MODULE_CATALOG.filter((x) => x.isCore)) {
      expect(m.billable, `core module '${m.code}' must not be billable`).toBe(false);
    }
  });

  it('every setting names a module that exists (or is installation-wide)', () => {
    for (const s of SETTING_CATALOG) {
      if (s.moduleCode !== null) {
        expect(ALL_MODULE_CODES.includes(s.moduleCode), `setting '${s.key}' names unknown module`).toBe(true);
      }
    }
  });

  it('a platform-scoped setting never arrives switched on by an install', async () => {
    // The risk switches (payroll reset/unlock) and the audit chain are platform-scoped precisely
    // because turning them on is a decision. A defaultOnInstall of `true` on one of those would hand
    // every newly-provisioned customer an open escape hatch, which is the opposite of the intent.
    for (const s of SETTING_CATALOG.filter((x) => x.scope === 'platform')) {
      expect(s.defaultOnInstall, `platform setting '${s.key}' must not default ON at install`).not.toBe(true);
    }
    const rows = await owner.db
      .select({ key: schema.settingDefinition.key })
      .from(schema.settingDefinition)
      .where(eq(schema.settingDefinition.scope, 'platform'));
    expect(rows.length, 'the platform-scoped settings must exist in the DB too').toBeGreaterThan(0);
  });
});
