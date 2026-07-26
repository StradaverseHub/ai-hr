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
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, owner } from './harness';
import { afterAll } from 'vitest';
import {
  ALL_MODULE_CODES,
  CORE_MODULE_CODES,
  DEFAULT_PROVISION_MODULE_CODES,
  LEGACY_ENABLED_MODULE_CODES,
  LEGACY_ENABLED_SETTINGS,
  LEGACY_MODULE_ENV_GATES,
  LEGACY_SETTING_ENV_GATES,
  MODULE_CATALOG,
  SELLABLE_MODULE_CODES,
  SETTING_CATALOG,
  missingModuleDependencies,
} from '../packs/catalog';

/** Strip block + line comments so prose about a gate cannot be mistaken for code that mutates it. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const repoFile = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

/** Every .ts/.tsx file under `dir`, recursively. Used to grep the application for a gate name. */
function collectSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : collectSources(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/**
 * Does the REPOSITORY ship this flag on? Two tracked files decide, and either one is enough:
 *   - `.env.example`                — what a fresh install copies (an ACTIVE line, not a commented one).
 *   - `deploy/enable-demo-flags.sh` — what the running deployment is actually set to.
 * This is the instrument that makes the parity set checkable instead of assertable in prose.
 */
function repoShipsFlagOn(varName: string): boolean {
  const shipped = new RegExp(`^${varName}=true\\s*$`, 'm').test(repoFile('.env.example'));
  const deployed = new RegExp(`^\\s*set_flag\\s+${varName}\\s+true\\s*$`, 'm').test(
    repoFile('deploy/enable-demo-flags.sh'),
  );
  return shipped || deployed;
}

/**
 * Settings that stay OUT of the parity backfill even when the deployment has the flag on.
 * ADR-0030 §3: enabling the audit hash chain on an existing database needs a one-time backfill of
 * historical events before the chain is complete, so a migration or a seeder must never be what
 * turns it on. Listed here rather than silently omitted, so the exception is visible and asserted.
 */
const SETTINGS_EXCLUDED_FROM_PARITY = new Set(['audit.hash_chain_enabled']);

/** Slice the whole statement that begins with `header` out of a migration file. */
function statementFrom(sqlText: string, header: string): string {
  const start = sqlText.indexOf(header);
  expect(start, `0313 no longer contains the statement \`${header}\``).toBeGreaterThan(-1);
  return sqlText.slice(start, sqlText.indexOf(';', start));
}
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

  it('the dependsOn graph is ACYCLIC — slice 2\'s resolver walks it', () => {
    // core/entitlements.ts used to say "the drift test forbids cycles". It did not: only the assertion
    // above existed, which checks the TARGETS are real, not that the graph terminates. Round 1 pushed a
    // 2-cycle into the catalog and reproduced a RangeError from the closure walk. The resolver is now
    // cycle-SAFE on its own (the visited set is threaded through the recursion, so a cycle returns an
    // answer instead of blowing the stack), but a cyclic catalog is still nonsense — "A requires B
    // requires A" cannot be provisioned or sold in any order — so it is refused here as well. Belt and
    // braces on purpose: the resolver must not hang on bad data, AND the data must not be bad.
    const deps = new Map(MODULE_CATALOG.map((m) => [m.code, m.dependsOn]));
    const VISITING = 1;
    const DONE = 2;
    const state = new Map<string, number>();
    const walk = (code: string, path: string[]): void => {
      if (state.get(code) === DONE) return;
      expect(state.get(code), `dependsOn cycle: ${[...path, code].join(' → ')}`).not.toBe(VISITING);
      state.set(code, VISITING);
      for (const dep of deps.get(code) ?? []) walk(dep, [...path, code]);
      state.set(code, DONE);
    };
    for (const m of MODULE_CATALOG) walk(m.code, []);
  });

  it('a CORE module depends only on CORE modules — slice 2\'s kill lever relies on it', () => {
    // core/entitlements.ts walks a core module's dependsOn closure so MODULE_KILL is transitive through
    // core (killing `employees` must take `leave` and `ess` down with it — round 3 found it did not).
    // That walk deliberately SKIPS a non-core dependency, because deciding one needs the snapshot and a
    // core code must stay answerable without one. The skip is only safe while no core module has such a
    // dependency, so it is refused here rather than left as an assumption in a comment.
    for (const m of MODULE_CATALOG.filter((x) => x.isCore)) {
      for (const dep of m.dependsOn) {
        expect(
          CORE_MODULE_CODES.includes(dep),
          `core module '${m.code}' depends on non-core '${dep}' — the resolver's core branch would ` +
            'skip it, so either make the dependency core or teach moduleEnabled to resolve it',
        ).toBe(true);
      }
    }
  });

  it('core and sellable partition the catalog, and no core module is billable', () => {
    expect([...CORE_MODULE_CODES, ...SELLABLE_MODULE_CODES].sort()).toEqual([...ALL_MODULE_CODES].sort());
    for (const m of MODULE_CATALOG.filter((x) => x.isCore)) {
      expect(m.billable, `core module '${m.code}' must not be billable`).toBe(false);
    }
  });

  it('the parity set is sellable, real, and never core', () => {
    // LEGACY_ENABLED_MODULE_CODES is what migration 0313 backfills onto every existing tenant. A core
    // code in that list would be refused by the tenant_module trigger and take the whole migration down
    // on a customer database; an unknown code would fail the module FK the same way.
    for (const code of LEGACY_ENABLED_MODULE_CODES) {
      expect(ALL_MODULE_CODES.includes(code), `parity module '${code}' is not in the catalog`).toBe(true);
      expect(CORE_MODULE_CODES.includes(code), `parity module '${code}' is core — core modules take no row`).toBe(
        false,
      );
    }
  });

  it('every sellable module and every setting declares what gates it TODAY', () => {
    // The gate map is what makes the parity set checkable. A new billable module or setting that
    // nobody maps to an env var (or to `null`, meaning "no gate — on for everyone") would drop out of
    // the ratchet below and could be silently omitted from the backfill, which is the whole failure
    // this slice exists to prevent.
    for (const code of SELLABLE_MODULE_CODES) {
      expect(code in LEGACY_MODULE_ENV_GATES, `module '${code}' has no entry in LEGACY_MODULE_ENV_GATES`).toBe(true);
    }
    for (const code of Object.keys(LEGACY_MODULE_ENV_GATES)) {
      expect(SELLABLE_MODULE_CODES.includes(code), `gate map names '${code}', which is not a sellable module`).toBe(
        true,
      );
    }
    const catalogKeys = SETTING_CATALOG.map((s) => s.key);
    for (const key of catalogKeys) {
      expect(key in LEGACY_SETTING_ENV_GATES, `setting '${key}' has no entry in LEGACY_SETTING_ENV_GATES`).toBe(true);
    }
    for (const key of Object.keys(LEGACY_SETTING_ENV_GATES)) {
      expect(catalogKeys.includes(key), `gate map names setting '${key}', which is not in the catalog`).toBe(true);
    }
  });

  it('the parity sets equal the flags this repository actually ships', () => {
    // THE RATCHET THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. LEGACY_ENABLED_MODULE_CODES excluded
    // multi_cycle_payroll and typed_pay_components on the stated grounds that "a fresh install does not
    // carry them", while .env.example ships both uncommented and set true and enable-demo-flags.sh sets
    // both on the server. Because the 0313 backfill is one-shot and slice 2's resolver is fail-closed,
    // that would have switched two paid payroll behaviours OFF on the live deployment at slice 3 — and
    // no test would have gone red, because test/env.ts deletes both vars so the suite sees them off
    // either way. Prose about which flags a deployment carries cannot be trusted; reading the env
    // files can. Both directions are asserted: absent-but-shipped-on AND present-but-shipped-off.
    for (const [code, gate] of Object.entries(LEGACY_MODULE_ENV_GATES)) {
      const on = gate === null || repoShipsFlagOn(gate);
      expect(
        LEGACY_ENABLED_MODULE_CODES.includes(code),
        on
          ? `'${code}' is ON in .env.example / enable-demo-flags.sh but missing from LEGACY_ENABLED_MODULE_CODES — slice 3 would switch it off for every existing customer`
          : `'${code}' is in LEGACY_ENABLED_MODULE_CODES but no tracked env file turns ${gate} on — slice 3 would switch it ON for customers who never had it`,
      ).toBe(on);
    }
    for (const [key, gate] of Object.entries(LEGACY_SETTING_ENV_GATES)) {
      if (SETTINGS_EXCLUDED_FROM_PARITY.has(key)) {
        expect(key in LEGACY_ENABLED_SETTINGS, `'${key}' is excluded from parity by ADR-0030 §3`).toBe(false);
        continue;
      }
      const on = repoShipsFlagOn(gate);
      expect(
        key in LEGACY_ENABLED_SETTINGS,
        on
          ? `setting '${key}' is ON in a tracked env file but missing from LEGACY_ENABLED_SETTINGS — slice 3 would switch it off`
          : `setting '${key}' is in LEGACY_ENABLED_SETTINGS but no tracked env file turns ${gate} on`,
      ).toBe(on);
    }
  });

  it('the 0313 backfill and its module bootstrap grant exactly the parity set', () => {
    // THE SECOND HALF OF THE C11 RATCHET. SQL cannot import packs/catalog.ts, so migration 0313 repeats
    // the parity codes as literals — the exact duplication this file exists to police everywhere else.
    // Read the migration and pin both lists to the constant, so a module added to (or removed from) the
    // parity set in TypeScript cannot silently leave the backfill behind.
    const sql = repoFile('db/migrations/0313_module_entitlements.sql');

    // Sliced from the tenant_module INSERT specifically, not by scanning for the first `CROSS JOIN` in
    // the file: there are two backfills now (modules and settings) and a whole-file scan would silently
    // read the wrong one the moment their order changed.
    const moduleBackfill = statementFrom(sql, 'INSERT INTO tenant_module (tenant_id, module_code, status)');
    const crossJoin = moduleBackfill.split('\n').find((l) => l.startsWith('CROSS JOIN (VALUES '));
    expect(crossJoin, '0313 has no module backfill CROSS JOIN — the parity set is not being granted').toBeDefined();
    const backfilled = [...crossJoin!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(backfilled, 'the 0313 backfill grants a different set than LEGACY_ENABLED_MODULE_CODES').toEqual(
      [...LEGACY_ENABLED_MODULE_CODES].sort(),
    );

    // The bootstrap rows that make the backfill's FK resolvable at migrate time (the catalog itself is
    // seeded afterwards by scripts/seed-catalogs.ts). Same codes, or the backfill cannot insert them.
    const bootstrap = statementFrom(sql, 'INSERT INTO module (code, name, category, billable, is_core) VALUES');
    const bootstrapped = [...bootstrap.matchAll(/^\s*\('([a-z_]+)',/gm)].map((m) => m[1]).sort();
    expect(bootstrapped, 'the 0313 module bootstrap does not cover every backfilled code').toEqual(
      [...LEGACY_ENABLED_MODULE_CODES].sort(),
    );

    // …and those bootstrap rows must agree with the catalog on the two flags that carry meaning, or the
    // seeder's ON CONFLICT DO UPDATE would be silently correcting a migration that shipped wrong.
    for (const m of MODULE_CATALOG.filter((x) => LEGACY_ENABLED_MODULE_CODES.includes(x.code))) {
      expect(bootstrap, `${m.code} bootstrap row`).toContain(`('${m.code}',`);
      expect(m.isCore, `${m.code} is bootstrapped as is_core=false`).toBe(false);
      expect(m.billable, `${m.code} is bootstrapped as billable=true`).toBe(true);
    }
  });

  it('the 0313 SETTING backfill and its definition bootstrap carry exactly LEGACY_ENABLED_SETTINGS', () => {
    // The module axis had a ratchet from the start and the setting axis had none — which is how three
    // settings that are ON in this deployment ended up resolving to `false` for every existing tenant.
    // Same instrument, one table over: read the statements the migration actually ships.
    const sql = repoFile('db/migrations/0313_module_entitlements.sql');

    const settingBackfill = statementFrom(sql, 'INSERT INTO tenant_setting (tenant_id, key, value, source)');
    const pairs = [...settingBackfill.matchAll(/\('([a-z_.]+)',\s*'([^']*)'::jsonb\)/g)];
    const backfilled = Object.fromEntries(pairs.map((m) => [m[1], JSON.parse(m[2]) as unknown]));
    expect(backfilled, 'the 0313 setting backfill differs from LEGACY_ENABLED_SETTINGS').toEqual(
      { ...LEGACY_ENABLED_SETTINGS },
    );
    expect(settingBackfill, "the backfilled values are Stradaverse's, not the customer's").toContain("'platform'");

    // The definition rows that make the backfill's FK resolvable at migrate time. Their SCOPE has to be
    // right in the migration and not merely corrected by the seeder afterwards: `scope` is what
    // tenant_setting's write policy joins against, so a migration that shipped 'tenant' for a platform
    // key would leave a window in which a customer admin could write it.
    const defBootstrap = statementFrom(
      sql,
      'INSERT INTO setting_definition (key, module_code, scope, value_type, default_value) VALUES',
    );
    const defined = [...defBootstrap.matchAll(/^\s*\('([a-z_.]+)',\s*'[a-z_]+',\s*'([a-z]+)',/gm)].map((m) => ({
      key: m[1],
      scope: m[2],
    }));
    expect(defined.map((d) => d.key).sort(), 'the setting bootstrap does not cover every backfilled key').toEqual(
      Object.keys(LEGACY_ENABLED_SETTINGS).sort(),
    );
    for (const d of defined) {
      const cat = SETTING_CATALOG.find((s) => s.key === d.key);
      expect(cat, `bootstrap defines unknown setting '${d.key}'`).toBeDefined();
      expect(d.scope, `'${d.key}' is bootstrapped with the catalog's scope`).toBe(cat!.scope);
    }
  });

  it('every setting names a module that exists (or is installation-wide)', () => {
    for (const s of SETTING_CATALOG) {
      if (s.moduleCode !== null) {
        expect(ALL_MODULE_CODES.includes(s.moduleCode), `setting '${s.key}' names unknown module`).toBe(true);
      }
    }
  });

  it('every named legacy gate is an env var the APPLICATION actually reads', () => {
    // The gate map is the pivot the whole parity argument turns on, and until now nothing checked that
    // the names in it are real. A typo, or a var that was renamed in the app and not here, produces a
    // map that reads plausibly, a `legacyEnabledModulesIn` that silently answers "off", and a seedBase
    // that agrees with itself — the tautology round 3 flagged one level down. Grepping the application
    // source for `process.env.<NAME>` is the independent check: the name has to exist where the feature
    // is actually gated, not merely in this catalog.
    //
    // Deliberately scans app/core/lib/db/packs/scripts and NOT test/: a gate that only tests read is
    // exactly the stale entry this is meant to catch.
    const sources = ['app', 'core', 'lib', 'db', 'packs', 'scripts', 'components']
      .flatMap((dir) => collectSources(path.resolve(__dirname, '..', dir)))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    expect(sources.length, 'source scan found nothing — the walker has drifted').toBeGreaterThan(10_000);
    const gates = [
      ...Object.values(LEGACY_MODULE_ENV_GATES).filter((g): g is string => g !== null),
      ...Object.values(LEGACY_SETTING_ENV_GATES),
    ];
    // INVERTED BY SLICE 3, deliberately — and this is the more valuable direction.
    //
    // Before slice 3 this asserted that every named gate IS still read by application code, which is
    // what you want while the map describes live env reads. Slice 3 migrated all eight onto
    // isModuleEnabled/settingEnabled, so the original assertion could only ever fail from here on —
    // it had done its job. The useful question afterwards is the opposite one: has anyone
    // REINTRODUCED an env read for a gate that is now a per-tenant entitlement?
    //
    // That is a real regression risk, not a hypothetical: an env read would be invisible to the
    // entitlement system, would apply to every tenant at once, and would silently outrank what a
    // customer actually bought. So the map stays (slice 3's backfill and the parity helpers still
    // need it) and the assertion flips to guard the migration instead of the pre-migration state.
    for (const gate of gates) {
      // \b, not `includes`: a TRUNCATED name is the likeliest typo and the one a substring test cannot
      // see — 'NOTIFICATIONS_ENABLE' is a substring of every `process.env.NOTIFICATIONS_ENABLED`, so
      // `includes` accepted it (verified by mutating the map and watching this stay green).
      expect(
        new RegExp(`process\\.env\\.${gate}\\b`).test(sources),
        `process.env.${gate} is read by application code again. That gate is a per-tenant entitlement ` +
          'as of ADR-0077 slice 3 — an env read bypasses the entitlement system, applies to every ' +
          'tenant at once, and overrides what the customer actually bought. Use isModuleEnabled() or ' +
          'settingEnabled() with the session context instead.',
      ).toBe(false);
    }
  });

  it('the operator form pre-ticks exactly the modules every customer already runs', () => {
    // The console was the one entitlement writer with no parity story: an untouched form queued a
    // customer with ZERO rows, which is "everything the product does today" before slice 3 and "none of
    // it" after. DEFAULT_PROVISION_MODULE_CODES is derived from the gate map rather than listed, and
    // pinned here in both directions so a module that gains a gate leaves the default in the same commit.
    expect([...DEFAULT_PROVISION_MODULE_CODES].sort()).toEqual(
      SELLABLE_MODULE_CODES.filter((c) => LEGACY_MODULE_ENV_GATES[c] === null).sort(),
    );
    expect(DEFAULT_PROVISION_MODULE_CODES.length, 'an empty default would restore the original hole').toBeGreaterThan(0);
    for (const code of DEFAULT_PROVISION_MODULE_CODES) {
      expect(CORE_MODULE_CODES.includes(code), `'${code}' is core — it takes no entitlement row`).toBe(false);
    }
    // …and the form has to USE it. Read-the-file, the same ratchet this suite applies to the migration:
    // a constant nothing imports is a comment.
    const page = repoFile('app/operator/page.tsx');
    expect(page, 'the operator form must default-tick from the catalog constant').toContain(
      'DEFAULT_PROVISION_MODULE_CODES.includes(m.code)',
    );
  });

  it('an incoherent pick set names the dependencies it is missing', () => {
    // `dependsOn` was declared, seeded, and read by nobody. Slice 2 ANDs the closure, so a module sold
    // without its parent writes an ACTIVE row that resolves DISABLED — a paid entitlement that is
    // silently inert. These cases pin the helper both seams now call.
    expect(missingModuleDependencies(['multi_cycle_payroll'])).toEqual(['payroll']);
    expect(missingModuleDependencies(['multi_cycle_payroll', 'payroll'])).toEqual([]);
    // toil depends on leave (CORE — always satisfied, never a row) and attendance (sellable).
    expect(missingModuleDependencies(['toil'])).toEqual(['attendance']);
    expect(missingModuleDependencies(['toil', 'attendance'])).toEqual([]);
    // Transitive: employees is core, so payroll alone is coherent; the closure must not report it.
    expect(missingModuleDependencies(['payroll'])).toEqual([]);
    expect(missingModuleDependencies([])).toEqual([]);
    // The form's own default must be coherent, or the console ships a request that its own guard rejects.
    expect(
      missingModuleDependencies(DEFAULT_PROVISION_MODULE_CODES),
      'the pre-ticked default must satisfy its own dependsOn closure',
    ).toEqual([]);
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

/**
 * ── THE SLICE-3 WORKLIST ────────────────────────────────────────────────────────────────────────────
 *
 * Every test file that turns a tracked gate on (or off) by writing `process.env` itself.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. test/harness.ts used to record this as prose — "ONE PLACE THIS
 * STILL DIVERGES, KNOWINGLY: four test files" — and it was wrong by an order of magnitude. seedBase
 * computes the entitlement set ONCE, in beforeEach, from the env as it stands at that instant; most of
 * these files mutate their gate INSIDE the test body, i.e. afterwards, so no row is ever seeded for it.
 * Whether a file gets a row is therefore decided by ORDERING, not intent:
 *   - test/payroll-reset.test.ts sets its flag BEFORE seedBase → it gets a tenant_setting row;
 *   - test/multicycle-kernel.test.ts sets its flag AFTER → it does not.
 * When slice 3 moves a gate from `process.env` onto the entitlement resolver, EVERY file below needs a
 * matching `setModule(...)` / `setSetting(...)`. That is the migration list, and it has to be a fact
 * about the tree rather than a recollection — a file added between now and then must show up in it.
 *
 * Pinned as an exact map, so both directions fail loudly: a new file that mutates a gate is red until
 * it is listed, and a file that stops mutating one is red until it is removed. Regenerate by running the
 * scan below and pasting the result; do not edit an entry to make a failure go away without also asking
 * what changed about that file's gating.
 *
 * test/env.ts, test/harness.ts and test/global-setup.ts are excluded: they are the process-level setup
 * that DEFINES the baseline every file below deviates from, not deviations themselves.
 */
const SLICE3_ENV_GATE_WORKLIST: Readonly<Record<string, readonly string[]>> = {
  // EMPTY, and that is slice 3's completion criterion rather than a disabled test.
  //
  // This map began as a 46-file inventory of every test that moved itself off seedBase's baseline by
  // writing a feature-gate env var. Slice 3 converted all of them to setModule()/setSetting(), so no
  // test mutates a tracked gate any more and the computed map below is {} too.
  //
  // The assertion stays live and still bites in BOTH directions: adding a `process.env.<GATE> = ...`
  // to any test file now fails this test. That is the point — an env write is invisible to the
  // entitlement system, so a test using one would be asserting against a mechanism the application no
  // longer reads, and would pass or fail for reasons unrelated to what it claims to prove.
};

describe('the env-gate divergence between seedBase and the suite', () => {
  it('the slice-3 worklist is a pinned inventory, not a prose estimate', () => {
    const gates = [
      ...Object.values(LEGACY_MODULE_ENV_GATES).filter((g): g is string => g !== null),
      ...Object.values(LEGACY_SETTING_ENV_GATES),
    ].sort();
    const infra = new Set(['env.ts', 'harness.ts', 'global-setup.ts']);
    const actual: Record<string, string[]> = {};
    for (const name of fs.readdirSync(__dirname).sort()) {
      if (!name.endsWith('.ts') || infra.has(name)) continue;
      // COMMENTS STRIPPED FIRST. Without this the scan counts prose: a converted file whose docblock
      // explains "this used to `delete process.env.TYPED_PAY_COMPONENTS_ENABLED`" was still being
      // reported as mutating the gate, so the worklist could never reach empty and the ratchet would
      // have had to permanently list files that no longer touch env at all. Found while draining the
      // list in slice 3 — loans-payroll and overtime-provenance were flagged for their docblocks alone.
      const src = stripComments(fs.readFileSync(path.join(__dirname, name), 'utf8'));
      // An ASSIGNMENT or a DELETE. Both move the file off seedBase's baseline; a bare read does not.
      const hit = gates.filter((g) =>
        new RegExp(`(process\\.env\\.${g}\\s*=[^=]|delete\\s+process\\.env\\.${g})`).test(src),
      );
      if (hit.length > 0) actual[name] = hit;
    }
    expect(
      actual,
      'a test file started (or stopped) mutating a tracked feature gate. Add or remove it in ' +
        'SLICE3_ENV_GATE_WORKLIST above — that map is the list of files slice 3 has to convert from ' +
        'env writes to setModule/setSetting calls.',
    ).toEqual({ ...SLICE3_ENV_GATE_WORKLIST });
  });

});
