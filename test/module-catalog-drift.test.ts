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
  DEFERRED_ENV_GATES,
  LEGACY_ENABLED_MODULE_CODES,
  LEGACY_ENABLED_SETTINGS,
  LEGACY_MODULE_ENV_GATES,
  LEGACY_SETTING_ENV_GATES,
  MODULE_CATALOG,
  SELLABLE_MODULE_CODES,
  SETTING_CATALOG,
  type SettingCatalogEntry,
  legacyEnabledModulesIn,
  legacyEnabledSettingsIn,
  missingModuleDependencies,
  settingsOnInstallFor,
} from '../packs/catalog';

/**
 * The env var names slice 3 left in place on purpose (see DEFERRED_ENV_GATES for why each one).
 * Derived, not re-listed: a typo'd name here would silently exempt nothing and be invisible, so the
 * lookup below asserts every deferred key is a real catalogued setting gate before trusting it.
 */
const DEFERRED_GATE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(DEFERRED_ENV_GATES).map((key) => {
    const gate = LEGACY_SETTING_ENV_GATES[key];
    if (!gate) throw new Error(`DEFERRED_ENV_GATES names '${key}', which is not a catalogued setting gate`);
    return gate;
  }),
);

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
 * Directories the env-read guard deliberately does NOT scan. THE EXCLUSION LIST IS THE EXPLICIT ONE,
 * and inverting it that way round is the fix for a real hole (review r2).
 *
 * The guard used to walk a hand-maintained INCLUSION list — app, core, lib, db, packs, scripts,
 * components — which silently omitted `localization/` and `i18n/`. Both are application code, and
 * localization/ already reaches for `process.env` in three places, so `process.env.TOIL_ENABLED ===
 * 'true'` added to a country pack would have been invisible to the guard while applying to every tenant
 * at once: precisely the failure the guard exists to catch. A missing directory cannot be detected by
 * the walker's own size tripwire either — 10k characters of app/ swamps it.
 *
 * So the scan now enumerates every top-level directory and subtracts these. A new top-level directory
 * of application code is covered the day it appears, and omitting one becomes a deliberate edit here.
 *   - test        — a gate only tests read is exactly the stale entry this is meant to catch, and
 *                   test/env.ts legitimately deletes the vars.
 *   - node_modules, .next, .git — not ours / build output.
 *   - public, content, messages, docs, deploy — no .ts sources; listed so their absence is a decision.
 */
const UNSCANNED_DIRS: ReadonlySet<string> = new Set([
  'test',
  'node_modules',
  '.next',
  '.git',
  'public',
  'content',
  'messages',
  'docs',
  'deploy',
]);

/** Every top-level directory that is not explicitly excluded, plus root-level .ts/.tsx files. */
function applicationSourceFiles(): string[] {
  const root = path.resolve(__dirname, '..');
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !UNSCANNED_DIRS.has(e.name))
    .map((e) => path.join(root, e.name));
  // middleware.ts and friends live at the root and run on every request; the original list named
  // middleware.ts by hand and would have missed a sibling.
  const rootFiles = entries.filter((e) => e.isFile() && /\.tsx?$/.test(e.name)).map((e) => path.join(root, e.name));
  return [...dirs.flatMap(collectSources), ...rootFiles];
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
    // Scans every top-level directory EXCEPT the explicit `UNSCANNED_DIRS` — notably not test/, since a
    // gate that only tests read is exactly the stale entry this is meant to catch. The inclusion list
    // this replaced omitted localization/ and i18n/, which are application code that already reads
    // process.env; see UNSCANNED_DIRS for why the exclusion list is the explicit one.
    //
    // COMMENTS ARE STRIPPED and root-level .ts files are included. Both were holes: this file's own
    // `stripComments` was applied to the worklist scan below but not here, so (a) the deferred half of
    // this check could be satisfied by PROSE mentioning `process.env.AUDIT_HASH_CHAIN_ENABLED`, keeping
    // a stale carve-out — and therefore a permanent hole in the reintroduction guard — alive after the
    // gate was migrated, and (b) the reintroduction half could fail on a comment, which is a false
    // positive that teaches people to weaken the guard. middleware.ts runs on every request and sat
    // outside the walk entirely.
    const files = applicationSourceFiles();
    const root = path.resolve(__dirname, '..');
    // PER FILE as well as joined. The joined corpus answers "does anything anywhere read this?", which
    // is the right question for the two EXISTENTIAL checks below — and the wrong one for the FORM check,
    // which has to hold at every occurrence. See that check for the regression it could not see.
    const perFile = files.map((f) => ({
      rel: path.relative(root, f),
      src: stripComments(fs.readFileSync(f, 'utf8')),
    }));
    const sources = perFile.map((f) => f.src).join('\n');
    expect(sources.length, 'source scan found nothing — the walker has drifted').toBeGreaterThan(10_000);
    // Name-check a file from each corner of the walk. The size tripwire above cannot see a MISSING
    // DIRECTORY (app/ alone swamps 10k chars), which is how localization/ stayed unscanned; these pin
    // the specific directories that were absent plus the root file that was hand-listed.
    const rel = perFile.map((f) => f.rel);
    for (const expected of ['middleware.ts', 'localization/statutory-pack/trust.ts', 'i18n/request.ts']) {
      expect(
        rel.includes(expected),
        `${expected} must be inside the env-read scan — if it moved, keep the directory in the walk`,
      ).toBe(true);
    }
    expect(rel.some((f) => f.startsWith('test/')), 'test/ must stay OUT of the scan').toBe(false);
    /**
     * Every way application code can reach `process.env.<GATE>`.
     *
     * The original guard matched only the dotted member form, and the access FORM is the easier bypass
     * to miss — harder to see than the truncated-name case its own comment argues about.
     * `process.env['TOIL_ENABLED']` and `const { TOIL_ENABLED } = process.env` both reintroduce a
     * deployment-level gate that outranks what the customer bought, and both sailed through.
     *
     * A fully general answer needs the TypeScript compiler API (an aliased `const env = process.env`
     * defeats any regex). This covers the three forms anyone actually writes; the aliased case is
     * deliberately left, because a guard that is honest about its edges beats one that claims more than
     * it checks.
     */
    const envReadRe = (gate: string) =>
      new RegExp(
        // process.env.GATE   |   process.env['GATE'] / process.env["GATE"]
        `process\\s*\\.\\s*env\\s*(?:\\.\\s*${gate}\\b|\\[\\s*['"\`]${gate}['"\`]\\s*\\])` +
          // const { …, GATE, … } = process.env
          `|\\{[^}]*\\b${gate}\\b[^}]*\\}\\s*=\\s*process\\s*\\.\\s*env\\b`,
        's',
      );
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
    for (const gate of gates.filter((g) => !DEFERRED_GATE_NAMES.has(g))) {
      // \b, not `includes`: a TRUNCATED name is the likeliest typo and the one a substring test cannot
      // see — 'NOTIFICATIONS_ENABLE' is a substring of every `process.env.NOTIFICATIONS_ENABLED`, so
      // `includes` accepted it (verified by mutating the map and watching this stay green).
      expect(
        envReadRe(gate).test(sources),
        `process.env.${gate} is read by application code again (dotted, bracketed or destructured). ` +
          'That gate is a per-tenant entitlement as of ADR-0077 slice 3 — an env read bypasses the ' +
          'entitlement system, applies to every tenant at once, and overrides what the customer ' +
          'actually bought. Use isModuleEnabled() or settingEnabled() with the session context instead.',
      ).toBe(false);
    }

    // The OTHER direction, and the reason DEFERRED_ENV_GATES is a policed list rather than a comment:
    // a deferred gate must still be genuinely env-read. If someone migrates one to an entitlement and
    // leaves the entry behind, the exemption above would silently keep excusing a gate that no longer
    // needs excusing — and the next reintroduced env read for it would sail through. Failing here
    // forces the entry to be deleted in the same commit that migrates the gate.
    for (const [key, owningSlice] of Object.entries(DEFERRED_ENV_GATES)) {
      const gate = LEGACY_SETTING_ENV_GATES[key];
      expect(
        envReadRe(gate).test(sources),
        `process.env.${gate} is listed in DEFERRED_ENV_GATES ("${owningSlice}") but no application ` +
          'code reads it any more. If it was migrated to an entitlement, delete its DEFERRED_ENV_GATES ' +
          'entry in the same commit — a stale entry is a permanent hole in the reintroduction guard above.',
      ).toBe(true);
      // …AND IT MUST BE READ AS `=== 'true'`, IN EVERY FILE THAT READS IT. Presence of the name is not
      // enough: db/client.ts read AUDIT_HASH_CHAIN_ENABLED with a bare truthiness test, so
      // `.env.example`'s own `=false` line ARMED the ADR-0030 chain — the string 'false' is truthy. The
      // parity value slice 3 records for this gate (OFF, in packs/catalog.ts and 0313) was therefore
      // wrong for every deployment that copied the template, and slice 8 would have disarmed a chain it
      // believed had never run. The FORM is the thing that was wrong, so the form is what this asserts.
      //
      // PER FILE, NOT OVER THE JOINED CORPUS (review r2). This used to be one `.test(sources)`, i.e.
      // "does SOME file compare this gate with === 'true'?" — and scripts/check-audit-chain-gate.ts,
      // added by this same slice, supplies a passing occurrence forever. So the shipped defect could be
      // restored in db/client.ts and this stayed green: `const raw = process.env.AUDIT_HASH_CHAIN_ENABLED`
      // is already on line 81, and changing the decision two lines below it to `return !!raw` needs no
      // token this scan can see. One truthy read is enough to arm or disarm the chain, so a correct read
      // existing somewhere else proves nothing.
      //
      // Per file it is exact, and it enforces a convention db/client.ts already commits to in a comment:
      // "Written out in full rather than `raw === 'true'` so the gate FORM is greppable". Binding the
      // value to a variable and deciding on the variable — in any form, including
      // `const { GATE } = process.env` — leaves the owning file without the literal comparison and fails
      // here, which is precisely the mutation the corpus-wide version could not see.
      const literalTrueRe = new RegExp(
        `process\\s*\\.\\s*env\\s*(?:\\.\\s*${gate}\\b|\\[\\s*['"\`]${gate}['"\`]\\s*\\])\\s*===\\s*'true'`,
      );
      const readers = perFile.filter((f) => envReadRe(gate).test(f.src));
      expect(readers.length, `no file reads ${gate} — the reader scan has drifted`).toBeGreaterThan(0);
      for (const f of readers) {
        expect(
          literalTrueRe.test(f.src),
          `${f.rel} reads process.env.${gate} but never compares it with === 'true' IN THIS FILE. A ` +
            "truthiness test makes the literal string 'false' enable the feature, which is how this gate " +
            'shipped armed on every deployment that copied .env.example while every document recorded it ' +
            'as off. A correct comparison in some OTHER file does not make this one safe: one truthy ' +
            'read is enough to arm or disarm the chain. Write the comparison out in full here.',
        ).toBe(true);
      }

      // …AND NO OCCURRENCE MAY SIT IN A BOOLEAN POSITION. This is the direct statement of the rule the
      // per-file check above enforces structurally: the literal comparison must exist in the owning file,
      // and no read anywhere may be a bare truthiness test. Both are needed — the per-file check catches
      // a decision moved onto a bound variable (which leaves no token here to inspect), and this catches
      // `if (process.env.GATE)` written beside a correct comparison in the same file.
      //
      // Scanned per OCCURRENCE, per FILE. An occurrence is fine when it is compared against a string
      // literal, and fine when it is merely bound to a variable (`const raw = process.env.X;` — the
      // preflight prints the raw value in its refusal message, a legitimate non-deciding read). It is
      // REFUSED in a boolean position: `if (…)`, `!…`, `… && …`, `… || …`, `… ? … : …`.
      const occurrenceRe = new RegExp(
        `process\\s*\\.\\s*env\\s*(?:\\.\\s*${gate}\\b|\\[\\s*['"\`]${gate}['"\`]\\s*\\])`,
        'g',
      );
      const comparedToLiteral = /^\s*[=!]==\s*['"`]/;
      const truthyAfter = /^\s*(?:\)|&&|\|\||\?(?![.?]))/;
      const truthyBefore = /(?:\bif\s*\(|\bwhile\s*\(|!|&&|\|\|)\s*$/;
      let occurrences = 0;
      for (const f of perFile) {
        for (const m of f.src.matchAll(occurrenceRe)) {
          occurrences += 1;
          const head = f.src.slice(0, m.index);
          const tail = f.src.slice(m.index + m[0].length);
          const safe = comparedToLiteral.test(tail) || (!truthyAfter.test(tail) && !truthyBefore.test(head));
          expect(
            safe,
            `${f.rel} uses process.env.${gate} as a TRUTHINESS test (near "${m[0]}${tail.slice(0, 24)}"). ` +
              "The literal string 'false' is truthy, which is exactly how this gate shipped armed on " +
              "every deployment that copied .env.example. Compare it with === 'true'.",
          ).toBe(true);
        }
      }
      // Belt and braces on the scan itself: a regex that silently stopped matching would make the loop
      // above vacuously true, which is the failure mode of every "assert inside a loop" check.
      expect(occurrences, `the ${gate} occurrence scan found nothing — the regex has drifted`).toBeGreaterThan(0);
    }

    /**
     * THE COMPUTED-KEY FORM, which the per-gate regexes structurally cannot see.
     *
     * `envReadRe` needs the gate NAME as a literal. `process.env[someVariable]` has no literal, so a
     * helper that looks a gate name up — say `process.env[LEGACY_MODULE_ENV_GATES[code]]` — reintroduces
     * a deployment-level gate that outranks what the customer bought and is invisible to every check
     * above. That is not hypothetical: `core/entitlements.ts` already uses exactly this form for the
     * kill-lever parser, which is why the answer is an OWNERS list rather than a ban.
     *
     * Same shape as the exemption-owners ratchet elsewhere in this file: the pattern is allowed in named
     * files that justify it, and adding a new one is a deliberate edit here rather than a silent
     * regression. (The ALIASED case — `const env = process.env` — remains uncovered and is stated as
     * such in envReadRe's note; a guard honest about its edges beats one that claims more than it checks.)
     *
     * Today's owners, and why each is not a feature gate:
     *   - core/entitlements.ts — the MODULE_KILL / SETTING_KILL lever parser; the levers are named by
     *     `envName`, and a kill lever only ever forces something OFF.
     *   - core/ai-config.ts, lib/ai/registry.ts, lib/ai/crypto.ts — AI provider credentials and model
     *     names looked up by the provider metadata's `envKeyVars` / `envModelVar`. A secret, not a
     *     capability: nothing a customer buys is decided here.
     */
    const COMPUTED_ENV_KEY_OWNERS: ReadonlySet<string> = new Set([
      'core/entitlements.ts',
      'core/ai-config.ts',
      'lib/ai/registry.ts',
      'lib/ai/crypto.ts',
    ]);
    const computedKeyRe = /process\s*\.\s*env\s*\[\s*(?!['"`])/;
    for (const f of perFile) {
      if (COMPUTED_ENV_KEY_OWNERS.has(f.rel)) continue;
      expect(
        computedKeyRe.test(f.src),
        `${f.rel} indexes process.env with a COMPUTED key. Every gate-name check in this test needs a ` +
          'string literal, so a computed key is invisible to all of them — a lookup like ' +
          'process.env[GATE_MAP[code]] would silently restore a deployment-level gate over the ' +
          'entitlement system. Use isModuleEnabled()/settingEnabled(), or add this file to ' +
          'COMPUTED_ENV_KEY_OWNERS with a reason.',
      ).toBe(false);
    }
    // …and the owners list must not rot: a named owner that no longer uses the form is a standing hole.
    for (const owner of COMPUTED_ENV_KEY_OWNERS) {
      const f = perFile.find((x) => x.rel === owner);
      expect(f, `COMPUTED_ENV_KEY_OWNERS names ${owner}, which is not in the scan`).toBeTruthy();
      expect(
        computedKeyRe.test(f!.src),
        `${owner} no longer indexes process.env with a computed key — drop it from ` +
          'COMPUTED_ENV_KEY_OWNERS in the same commit, or the exemption outlives its reason.',
      ).toBe(true);
    }

    /**
     * THE INDIRECT FORM, which is how G1 was actually false while every check above passed (review r3).
     *
     * `legacyEnabledModulesIn(env)` / `legacyEnabledSettingsIn(env)` resolve a MIGRATED gate by name —
     * `env[LEGACY_MODULE_ENV_GATES[code]] === 'true'` — but they index a PARAMETER, so `computedKeyRe`
     * (which needs the literal `process.env[`) never sees them, and the caller passes `process.env`
     * without ever naming a gate, so `envReadRe` never sees it either. `app/operator/page.tsx` did
     * exactly that: `defaultProvisionModuleCodesIn(process.env)` was a live read of
     * NOTIFICATIONS_ENABLED / MULTI_CYCLE_PAYROLL_ENABLED / TYPED_PAY_COMPONENTS_ENABLED, in a page, on
     * every request, invisible to the whole ratchet — and retiring those vars (the point of this slice)
     * would have silently dropped three modules from every new customer's pre-ticks.
     *
     * So the helpers themselves get an owners list, in the same shape as COMPUTED_ENV_KEY_OWNERS. Each
     * owner is a place where "what is this PROCESS's env giving tenants today?" is the actual question:
     *   - packs/catalog.ts                         — where they are defined.
     *   - db/seed.ts                               — the dev/demo seeder, matching what the box runs.
     *   - scripts/reconcile-entitlement-parity.ts  — the one-shot parity CLI; reading the env IS its job
     *                                                (its header argues this at length: SQL cannot).
     * Nothing under app/, core/ or lib/ may be here. test/harness.ts is a legitimate fourth caller and
     * is simply not scanned (UNSCANNED_DIRS excludes test/).
     */
    const PARITY_ENV_HELPER_OWNERS: ReadonlySet<string> = new Set([
      'packs/catalog.ts',
      'db/seed.ts',
      'scripts/reconcile-entitlement-parity.ts',
    ]);
    const parityHelperRe = /\b(?:legacyEnabledModulesIn|legacyEnabledSettingsIn)\s*\(/;
    for (const f of perFile) {
      if (PARITY_ENV_HELPER_OWNERS.has(f.rel)) continue;
      expect(
        parityHelperRe.test(stripComments(f.src)),
        `${f.rel} calls legacyEnabledModulesIn/legacyEnabledSettingsIn. Those resolve MIGRATED gate ` +
          'names out of an env-shaped bag, which every gate-name check in this file is structurally ' +
          'blind to — that is exactly how app/operator/page.tsx read three migrated gates from ' +
          'process.env while this suite stayed green. Read the entitlement (isModuleEnabled / ' +
          'settingEnabled) or a tracked constant, or add this file to PARITY_ENV_HELPER_OWNERS with a ' +
          'reason.',
      ).toBe(false);
    }
    for (const owner of PARITY_ENV_HELPER_OWNERS) {
      const f = perFile.find((x) => x.rel === owner);
      expect(f, `PARITY_ENV_HELPER_OWNERS names ${owner}, which is not in the scan`).toBeTruthy();
      expect(
        parityHelperRe.test(stripComments(f!.src)),
        `${owner} no longer calls the parity helpers — drop it from PARITY_ENV_HELPER_OWNERS in the ` +
          'same commit, or the exemption outlives its reason.',
      ).toBe(true);
    }
    // NO APPLICATION SOURCE MAY BE AN OWNER. Stated as its own assertion rather than left to whoever
    // edits the set: the three owners above are a seeder, a maintenance CLI and the catalog itself, and
    // the guarantee G1 makes is about what runs on a REQUEST.
    for (const owner of PARITY_ENV_HELPER_OWNERS) {
      expect(
        owner.startsWith('app/') || owner.startsWith('core/') || owner.startsWith('lib/'),
        `${owner} is application source and cannot be a PARITY_ENV_HELPER_OWNERS exemption — that is ` +
          'the G1 violation this list exists to prevent, not a case it can license.',
      ).toBe(false);
    }

    /**
     * THE QUIET READERS ARE PAGE-ONLY, and until now that boundary was the one convention in this slice
     * stated in prose and enforced by nothing (review r3).
     *
     * `isModuleEnabledOrFalse` / `settingEnabledOrDefault` swallow an infrastructure failure and answer
     * "off". core/entitlements.ts draws the line sharply — "For PAGES … and never for a service entry
     * point", because "using the quiet form in a service would convert an incident into a silent
     * refusal that looks like a plan change". Every other convention here is ratcheted; this one was
     * not, and the failure mode is quiet by construction: an authorization decision degrading into a
     * refusal that renders as "not on your plan".
     */
    const QUIET_READER_OWNERS: ReadonlySet<string> = new Set(['core/entitlements.ts']);
    const quietReaderRe = /\b(?:isModuleEnabledOrFalse|settingEnabledOrDefault)\b/;
    for (const f of perFile) {
      if (f.rel.startsWith('app/') || QUIET_READER_OWNERS.has(f.rel)) continue;
      expect(
        quietReaderRe.test(stripComments(f.src)),
        `${f.rel} references isModuleEnabledOrFalse/settingEnabledOrDefault outside app/. Those forms ` +
          'swallow an infrastructure failure and answer "off" — correct for a page that must still ' +
          'render, wrong for a service, where it turns an incident into a silent refusal that looks ' +
          'like a plan change. Use isModuleEnabled/assertModuleEnabled/settingEnabled here.',
      ).toBe(false);
    }
    for (const owner of QUIET_READER_OWNERS) {
      const f = perFile.find((x) => x.rel === owner);
      expect(f, `QUIET_READER_OWNERS names ${owner}, which is not in the scan`).toBeTruthy();
      expect(
        quietReaderRe.test(stripComments(f!.src)),
        `${owner} no longer defines the quiet readers — drop it from QUIET_READER_OWNERS.`,
      ).toBe(true);
    }
    // …and the boundary is only meaningful if the forms are actually USED where they belong.
    expect(
      perFile.filter((f) => f.rel.startsWith('app/') && quietReaderRe.test(stripComments(f.src))).length,
      'no page uses the quiet readers any more — either the pages regressed to the throwing form, or ' +
        'the regex drifted and this whole check is vacuous',
    ).toBeGreaterThan(0);
  });

  it('the operator form pre-ticks exactly the modules every customer already runs', () => {
    // The console was the one entitlement writer with no parity story: an untouched form queued a
    // customer with ZERO rows, which is "everything the product does today" before slice 3 and "none of
    // it" after. DEFAULT_PROVISION_MODULE_CODES is derived rather than listed, and pinned here in both
    // directions so a module that joins or leaves the parity set changes the form default in the same
    // commit.
    //
    // A CONSTANT NOW, NOT AN ENV-DERIVED FUNCTION (review r3). This test used to build an inline
    // `deployEnv` literal, pass it to `defaultProvisionModuleCodesIn`, and pin the seven-module answer.
    // Honest, carefully built, and about something other than what it named: the PAGE read
    // `process.env` at request time, sourced from `.env.production` — untracked, absent from
    // `deploy/.env.production.example`, never written by `deploy.sh`, and populated only by a manual
    // demo-only script `deploy.sh` does not call. So the test certified a parity no deployment
    // mechanism produced, while its companion assertion pinned the DEGRADED four-module answer
    // (`defaultProvisionModuleCodesIn({})`) as correct — the state a fresh production install already
    // lands in. The fix was to stop reading env in application source at all; what remains is a
    // constant, and this asserts the constant against the tracked files that define the parity set.
    //
    // DERIVED FROM THE TRACKED FILES, NOT FROM THE CONSTANT IT IS BUILT FROM. Asserting
    // `DEFAULT_PROVISION_MODULE_CODES === SELLABLE ∩ LEGACY_ENABLED_MODULE_CODES` would restate the
    // definition and pass for any definition; `repoShipsFlagOn` re-reads `.env.example` and
    // `deploy/enable-demo-flags.sh`, which is where the answer actually comes from.
    for (const code of SELLABLE_MODULE_CODES) {
      const gate = LEGACY_MODULE_ENV_GATES[code];
      const runsHere = gate === null || repoShipsFlagOn(gate);
      expect(
        DEFAULT_PROVISION_MODULE_CODES.includes(code),
        runsHere
          ? `'${code}' runs on this deployment (${gate ?? 'no gate'}) but is not pre-ticked — a customer ` +
            'provisioned from an untouched form would arrive without something every other customer has'
          : `'${code}' is gated by ${gate}, which no tracked env file turns on — pre-ticking it would SELL ` +
            'a capability nobody currently runs',
      ).toBe(runsHere);
    }
    expect(DEFAULT_PROVISION_MODULE_CODES.length, 'an empty default would restore the original hole').toBeGreaterThan(0);
    for (const code of DEFAULT_PROVISION_MODULE_CODES) {
      expect(CORE_MODULE_CODES.includes(code), `'${code}' is core — it takes no entitlement row`).toBe(false);
    }
    // THE ANSWER ITSELF, spelled out rather than recomputed. Both sides above derive from the same two
    // constants, so a change to LEGACY_ENABLED_MODULE_CODES moves them together; this literal is what
    // makes such a change visible.
    expect(
      [...DEFAULT_PROVISION_MODULE_CODES].sort(),
      'the form default must cover every module this deployment runs, or provisioning is a silent downgrade',
    ).toEqual(['attendance', 'claims', 'multi_cycle_payroll', 'notifications', 'payroll', 'performance', 'typed_pay_components']);
    // …including the three the four ungated codes do NOT cover. `toil` must stay OUT: TOIL_ENABLED is
    // set in no tracked env file, so no customer runs it today and pre-ticking it would SELL something.
    for (const code of ['notifications', 'multi_cycle_payroll', 'typed_pay_components']) {
      expect(DEFAULT_PROVISION_MODULE_CODES.includes(code), `'${code}' runs on this box and must be pre-ticked`).toBe(true);
    }
    expect(DEFAULT_PROVISION_MODULE_CODES.includes('toil'), 'toil is gated by a flag no tracked file sets').toBe(false);
    // The deploy script is where the env-gated three are actually turned on — read it, so a flag
    // removed there without touching the parity story fails here rather than on deploy day.
    const flags = repoFile('deploy/enable-demo-flags.sh');
    for (const gate of ['NOTIFICATIONS_ENABLED', 'MULTI_CYCLE_PAYROLL_ENABLED', 'TYPED_PAY_COMPONENTS_ENABLED']) {
      expect(flags, `deploy/enable-demo-flags.sh no longer sets ${gate} — re-derive the parity default`).toContain(
        `set_flag ${gate} true`,
      );
    }
    expect(missingModuleDependencies([...DEFAULT_PROVISION_MODULE_CODES])).toEqual([]);

    // …and the form has to USE it. Read-the-file, the same ratchet this suite applies to the migration:
    // a constant nothing imports is a comment.
    const page = repoFile('app/operator/page.tsx');
    expect(page, 'the operator form must default-tick from the catalog constant').toContain(
      'DEFAULT_PROVISION_MODULE_CODES.includes(m.code)',
    );
    // THE NEGATIVE, which is the whole point of the change: the page must not consult the environment
    // for this at all — not directly, and not by handing `process.env` to a helper that indexes it.
    expect(
      stripComments(page),
      'app/operator/page.tsx must not read process.env: the three module gates it used to resolve there ' +
        'are migrated gates, and no gate-name check in this file can see them through a helper parameter',
    ).not.toContain('process.env');
  });

  it('provisionTenant seeds settings from defaultOnInstall — NEVER from what this box is booted with', () => {
    // INVERTED (review r2). The first version of this test asserted the opposite and was the same
    // wrong-requirement shape as D5: it pinned that provisionTenant writes `legacyEnabledSettingsIn(
    // process.env)`, i.e. that every NEW customer arrives with whatever the deployment's env has on.
    // On the live box that is PAYROLL_RESET_ENABLED and PAYROLL_UNLOCK_ENABLED, so every customer
    // created from then on could revert a processed payroll run and unlock a closed one on day one.
    //
    // packs/catalog.ts records the opposite decision explicitly — `defaultOnInstall: false` on the risk
    // switches, "a purchased module must never arrive with an escape hatch already open, even though
    // the demo deployment has all three env flags ON today" — and confines the parity argument to an
    // ALREADY-PROVISIONED tenant. Parity is about tenants that exist; `defaultOnInstall` is about
    // tenants being created. The gap for tenants created between slice 1 and slice 3 belongs to
    // scripts/reconcile-entitlement-parity.ts, which is one-shot and sign-off gated.
    //
    // An over-grant here is also irreversible through the product: both keys are scope='platform', and
    // 0313's tenant_setting_write policy requires scope='tenant', so ai_hr_app can never delete them.
    // COMMENTS STRIPPED, the same lesson this file already learned twice in this slice: the negative
    // assertions below fail on PROSE otherwise, and the code they police is correct precisely because
    // someone wrote a paragraph naming the mechanism it must not use. The positive ones are stripped
    // too, so a docblock quoting the right call can never satisfy them either.
    const src = stripComments(repoFile('db/provision.ts'));
    expect(src, 'provisionTenant must seed the install defaults').toContain('settingsOnInstallFor(picked)');
    expect(src, '…into tenant_setting').toContain('.insert(tenantSetting)');
    expect(src, "…with platform provenance, matching 0313's backfill").toContain("source: 'platform'");
    expect(
      src,
      'provisioning must NOT seed the env parity set — that is the reconcile script\'s job, for tenants that already exist',
    ).not.toContain('legacyEnabledSettingsIn');
    expect(src, 'nor the raw constant').not.toContain('LEGACY_ENABLED_SETTINGS');

    // …and the helper itself must never hand a platform-scoped switch out ON at install, whatever the
    // module set. Read-the-file pins the call; this pins the VALUE, which is the thing that hurts.
    for (const codes of [SELLABLE_MODULE_CODES, ['payroll'], ['payroll', 'attendance', 'notifications']]) {
      for (const { key, value } of settingsOnInstallFor(codes)) {
        const def = SETTING_CATALOG.find((s) => s.key === key);
        expect(def, `settingsOnInstallFor produced an uncatalogued key '${key}'`).toBeDefined();
        expect(value, `install default for '${key}' must equal its catalog defaultOnInstall`).toBe(def!.defaultOnInstall);
        if (def!.scope === 'platform') {
          expect(value, `platform-scoped '${key}' must never arrive ON at install — ai_hr_app cannot turn it off`).not.toBe(
            true,
          );
        }
      }
    }
    // A module the tenant did NOT buy contributes nothing: `defaultOnInstall` means "when the owning
    // module is installed", and an installation-wide setting (moduleCode null) is nobody's purchase.
    expect(settingsOnInstallFor([]).map((s) => s.key)).toEqual([]);

    // THE RULE, ASSERTED AS THE RULE (slice 3 review). This used to say "buying payroll emits every
    // payroll-owned setting key", which pinned the wrong mechanism: it made writing a row that says
    // exactly what the catalog default already says look like the requirement. It is the opposite of a
    // requirement. `tenant_setting.value` is NOT NULL while 0313:78-80 documents a NULL
    // `default_on_install` as "nothing to apply", and — the part that bites today — both payroll risk
    // switches are scope='platform', so 0313's write policy means ai_hr_app can never change a row
    // provisioning writes, and reconcile-entitlement-parity.ts reads ANY existing row as "a decision was
    // recorded, hands off". A row identical to the default therefore buys nothing and forecloses both
    // remaining levers. So: emit a row only when the install value SAYS something the default does not.
    //
    // DRIVEN BY A SYNTHETIC CATALOG, because against the real one the rule is UNOBSERVABLE (review r2).
    // The first version of this loop re-implemented settingsOnInstallFor's filter character for
    // character on the expected side and evaluated it over a domain where every entry has
    // `defaultOnInstall === defaultValue` — so both sides were [] for every pick set and the assertion
    // could not fail for any catalog. That is the same wrong-reason pass this slice keeps producing, on
    // the very mechanism that decides whether a brand-new tenant arrives with an unclosable platform row.
    // Hand-written expectations over a fixture are the only way to state the rule as a fact.
    const fake: SettingCatalogEntry[] = [
      // same as default ⇒ NO row, even though payroll is bought.
      { key: 'fake.same_as_default', moduleCode: 'payroll', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: false, customerVisible: true, description: '', sortOrder: 1 },
      // differs from default ⇒ ROW, carrying the INSTALL value.
      { key: 'fake.on_at_install', moduleCode: 'payroll', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: true, customerVisible: true, description: '', sortOrder: 2 },
      // null install value ⇒ NO row (0313 documents NULL as "nothing to apply"; tenant_setting.value is NOT NULL).
      { key: 'fake.null_install', moduleCode: 'payroll', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: null, customerVisible: true, description: '', sortOrder: 3 },
      // differs from default, but the owning module was NOT bought ⇒ NO row.
      { key: 'fake.unbought_module', moduleCode: 'claims', scope: 'tenant', valueType: 'boolean', defaultValue: false, defaultOnInstall: true, customerVisible: true, description: '', sortOrder: 4 },
      // installation-wide (moduleCode null) is nobody's purchase ⇒ NO row, whatever its install value.
      { key: 'fake.installation_wide', moduleCode: null, scope: 'platform', valueType: 'boolean', defaultValue: false, defaultOnInstall: true, customerVisible: false, description: '', sortOrder: 5 },
    ];
    expect(settingsOnInstallFor(['payroll'], fake)).toEqual([{ key: 'fake.on_at_install', value: true }]);
    expect(settingsOnInstallFor(['payroll', 'claims'], fake).map((s) => s.key).sort()).toEqual([
      'fake.on_at_install',
      'fake.unbought_module',
    ]);
    expect(settingsOnInstallFor([], fake)).toEqual([]);
    // A non-boolean install value comes through as itself, not coerced — the column is jsonb.
    expect(
      settingsOnInstallFor(
        ['payroll'],
        [{ ...fake[0], key: 'fake.number', valueType: 'number', defaultValue: 0, defaultOnInstall: 7 }],
      ),
    ).toEqual([{ key: 'fake.number', value: 7 }]);
    // …and TODAY that set is exactly ONE key, stated rather than left to be inferred from the rule
    // above. It used to be empty, and the emptiness was itself the defect (review r3): with no install
    // row for `payroll.individual_txn_pay_enabled`, a tenant provisioned tomorrow would be the ONLY one
    // on the deployment whose one-off transaction ledger silently stops reaching the payslip — 0313
    // backfilled a `true` row for every tenant that already existed, and INDIVIDUAL_TXN_PAY_ENABLED is
    // on. It is `scope: 'tenant'`, so it is not the unclosable-hatch case the paragraph above guards
    // against; the loop above independently forbids any PLATFORM key arriving on.
    //
    // This pin is deliberately a whole-list equality, not an `includes`: the day a SECOND setting gains
    // a non-default install value, this fails and someone re-reads the paragraph above before writing
    // an unclosable platform row by accident.
    expect(
      settingsOnInstallFor(SELLABLE_MODULE_CODES).map((s) => s.key),
      'exactly one catalogued setting differs from its default at install — see settingsOnInstallFor',
    ).toEqual(['payroll.individual_txn_pay_enabled']);
    expect(
      settingsOnInstallFor(SELLABLE_MODULE_CODES),
      '…and it must arrive ON, which is the whole reason it is not left to the default',
    ).toEqual([{ key: 'payroll.individual_txn_pay_enabled', value: true }]);
    // It is the PAYROLL module's, so a customer who does not buy payroll gets nothing.
    expect(settingsOnInstallFor(['claims', 'attendance'])).toEqual([]);
    expect(settingsOnInstallFor(['payroll']).map((s) => s.key)).toEqual(['payroll.individual_txn_pay_enabled']);
  });

  it('every setting key the application gates on is catalogued', () => {
    /**
     * A TYPO'D KEY IS A 500, NOT A DISABLED FEATURE — so it has to fail here instead (review r2).
     *
     * The two axes degrade differently and the asymmetry is real. `moduleEnabled` answers FALSE for an
     * unknown module code: a typo disables. `getSetting` throws a BARE `Error` for a key absent from
     * SETTING_CATALOG, deliberately not an `EntitlementError` — so `settingEnabledOrDefault`, which
     * catches only `EntitlementsResolutionFailedError`, cannot swallow it. The five pages that call it
     * are server components with no `app/error.tsx` and no `app/global-error.tsx` above them, so a
     * mistyped literal takes the whole route down rather than the one feature.
     *
     * Failing loud on a wiring bug is the right call; letting it fail in production is not. This is the
     * check that makes the loud failure happen at the right time.
     */
    const catalogued = new Set(SETTING_CATALOG.map((s) => s.key));
    // core/entitlements.ts is the DEFINITION site — it declares both functions and forwards a `key`
    // parameter — so it has no literal to check and would fail the "every call site uses a literal"
    // count below for the right reason. Excluded by name rather than by a cleverer regex.
    const callSites = applicationSourceFiles()
      .filter((f) => !f.endsWith(path.join('core', 'entitlements.ts')))
      .map((f) => ({ rel: path.relative(path.resolve(__dirname, '..'), f), src: stripComments(fs.readFileSync(f, 'utf8')) }));
    const anyCallRe = /\bsettingEnabled(?:OrDefault)?\s*\(/g;
    const literalCallRe = /\bsettingEnabled(?:OrDefault)?\s*\(\s*[A-Za-z_$][\w$.]*\s*,\s*(['"`])([^'"`]+)\1/g;
    let literalCalls = 0;
    let anyCalls = 0;
    for (const f of callSites) {
      anyCalls += [...f.src.matchAll(anyCallRe)].length;
      for (const m of f.src.matchAll(literalCallRe)) {
        literalCalls += 1;
        expect(
          catalogued.has(m[2]),
          `${f.rel} gates on setting key '${m[2]}', which is not in SETTING_CATALOG. getSetting throws a ` +
            'bare Error for an unknown key and settingEnabledOrDefault cannot catch it, so this is a 500 ' +
            'on the route, not a disabled feature.',
        ).toBe(true);
      }
    }
    expect(literalCalls, 'the call-site scan found nothing — the regex has drifted').toBeGreaterThan(0);
    // BOTH SIDES. A call whose key is a variable is invisible to the check above, which would make the
    // guard quietly partial. Keeping the two counts equal means introducing a computed key is a
    // deliberate edit here rather than a silent hole.
    expect(
      literalCalls,
      'every settingEnabled/settingEnabledOrDefault call outside core/entitlements.ts must pass a ' +
        'STRING LITERAL key, or this catalogue check cannot see it',
    ).toBe(anyCalls);
  });

  it('the DEPLOY.md parity step names a script the repo actually ships', () => {
    // deploy/DEPLOY.md is TRACKED and instructs the operator to run
    // scripts/reconcile-entitlement-parity.ts in the slice-3 maintenance window. That script is the only
    // remedy for tenants provisioned after 0313 ran — the population that would otherwise lose
    // notifications, multi_cycle_payroll and typed_pay_components at the flip, with typed_pay_components
    // silently changing payslip numbers. Review r2 found it UNTRACKED: a git-based deploy would pull the
    // instruction and not the file, and the step would fail with ENOENT at exactly the wrong moment.
    // Same read-the-file ratchet this suite already applies to 0313, provision.ts and the operator form.
    const md = repoFile('deploy/DEPLOY.md');
    expect(md).toContain('scripts/reconcile-entitlement-parity.ts');
    expect(
      fs.existsSync(path.resolve(__dirname, '..', 'scripts/reconcile-entitlement-parity.ts')),
      'DEPLOY.md tells the operator to run scripts/reconcile-entitlement-parity.ts — it must exist in the repo',
    ).toBe(true);
    // DRY RUN BY DEFAULT. Its failure direction is a silent, permanent grant, so the bare invocation
    // must be the one that cannot cause it and the runbook must not tell anyone otherwise.
    const script = repoFile('scripts/reconcile-entitlement-parity.ts');
    expect(script, 'writing must be opt-in via --apply, not the default').toContain("process.argv.includes('--apply')");
    expect(script, "…and there must be no '--dry-run' opt-out left to imply the inverse").not.toContain("'--dry-run'");

    // The audit-chain preflight is the other tracked-instruction-needs-a-real-file case, and it is
    // stronger: deploy.sh RUNS it, so an ENOENT there aborts the deploy under `set -e`.
    expect(
      fs.existsSync(path.resolve(__dirname, '..', 'scripts/check-audit-chain-gate.ts')),
      'deploy/deploy.sh runs scripts/check-audit-chain-gate.ts before the restart — it must exist',
    ).toBe(true);
    const sh = repoFile('deploy/deploy.sh');
    expect(sh, 'the chain preflight must run in deploy.sh, not merely be documented').toContain(
      'scripts/check-audit-chain-gate.ts',
    );
    // The INVOCATION, not a mention of the path: a comment naming the script would otherwise satisfy
    // the ordering check while the deploy never ran it. (deploy.sh is shell, so `stripComments` — which
    // knows `//` and `/* */` — cannot help here; matching the command line is the equivalent.)
    const restartAt = sh.indexOf('systemctl restart');
    const checkAt = sh.indexOf('node --env-file=.env.production --import tsx scripts/check-audit-chain-gate.ts');
    expect(checkAt, 'deploy.sh must INVOKE the preflight, not merely mention it').toBeGreaterThan(-1);
    expect(checkAt, 'the preflight must run BEFORE the restart, or it is checking the wrong thing').toBeLessThan(restartAt);
    // …and BEFORE the build, so a refusal costs nothing. It used to run after build + migrate +
    // catalog-seed, which left a refused deploy serving the OLD code against a MIGRATED schema.
    const buildAt = sh.indexOf('pnpm build');
    expect(checkAt, 'a refused chain preflight must not leave a built-and-migrated box behind').toBeLessThan(buildAt);

    // THE PARITY RECONCILIATION IS A ONE-SHOT, AND THIS ASSERTION IS INVERTED ON PURPOSE (review r2).
    //
    // It previously demanded the opposite — that deploy.sh run `--preflight` as a blocking gate — and
    // that assertion pinned a deadlock. `settingsOnInstallFor` emits a row only when `defaultOnInstall`
    // differs from `defaultValue`, and the two payroll RISK switches deliberately keep both false — so
    // `db/provision.ts` writes no PLATFORM-scoped `tenant_setting` row for a new tenant, by an explicit
    // decision recorded at that call site, while `deploy/enable-demo-flags.sh` has both flags true on
    // the live box. So the preflight counted every tenant created after 0313 as two rows short —
    // permanently — and the first customer provisioned after the slice-3 deploy would have blocked every
    // deploy after it. Its two escapes were `--apply` (writing `payroll.reset_enabled=true` /
    // `payroll.unlock_enabled=true` for a brand-new tenant: `scope='platform'` rows `ai_hr_app` can never
    // close again, the exact over-grant provision.ts refuses) and ENTITLEMENT_PARITY_ACKNOWLEDGED=true
    // (disabling the check forever). `--created-before` (review r3) is what makes the verdict answerable
    // at all; it does not make this a gate, for the reason below.
    //
    // The script's own header says it cannot tell "predates the row" from "deliberately unticked" and
    // asks a human to read the plan against the customer records. A check whose only correct resolution
    // is human sign-off is a runbook step, not a `set -e` gate — which is what DEPLOY.md said all along.
    // The INVOCATION, not a mention — same convention as the chain preflight two assertions up, and
    // necessary here because deploy.sh's comment explains at length WHY the script is not run from it.
    expect(
      sh.indexOf('node --env-file=.env.production --import tsx scripts/reconcile-entitlement-parity.ts'),
      'deploy.sh must NOT run the parity reconciliation: provisionTenant deliberately writes no ' +
        'tenant_setting rows, so a blocking preflight can never reach a clean state and its only ' +
        'escapes are a permanent platform-scoped over-grant or permanently disabling the check. It is a ' +
        'one-shot for the slice-3 window, documented in DEPLOY.md.',
    ).toBe(-1);
    // …but the mode must still EXIST, because DEPLOY.md offers it as the scripted "did I finish?" check
    // an operator runs by hand after --apply.
    expect(script, 'the preflight mode DEPLOY.md points at must exist in the script').toContain(
      "process.argv.includes('--preflight')",
    );
    expect(md, 'DEPLOY.md must carry the parity step as a hand-run one-shot').toContain('--apply');

    // THE DOCUMENTED WINDOW HAS TO BE REACHABLE (review r3). DEPLOY.md has always said to run the
    // reconciliation "after `migrate`, before restarting the service", and deploy.sh offered no way to
    // stop there: one `set -e` script, install → check → build → migrate → seed → restart, whose only
    // argument was --reseed. So the achievable order was migrate-and-restart THEN reconcile, leaving a
    // window in which every post-0313 tenant runs slice-3 code with typed_pay_components resolving OFF
    // — payroll numbers change with no error. A runbook step no shipped tooling can perform is a
    // fiction, so both halves are pinned: the flag exists, and it stops BEFORE the restart.
    expect(sh, 'deploy.sh must offer the stop point DEPLOY.md prescribes').toContain('--migrate-only');
    const migrateOnlyExitAt = sh.indexOf('if [ "$MIGRATE_ONLY" = "1" ]');
    expect(migrateOnlyExitAt, 'the --migrate-only flag must actually gate an early exit').toBeGreaterThan(-1);
    expect(
      migrateOnlyExitAt,
      'the --migrate-only exit must come BEFORE the restart, or it stops at the wrong place',
    ).toBeLessThan(sh.indexOf('systemctl restart'));
    expect(
      migrateOnlyExitAt,
      '…and AFTER the migration + catalog seed, since every row the reconcile writes has a foreign key ' +
        'into the catalogs',
    ).toBeGreaterThan(sh.indexOf('scripts/seed-catalogs.ts'));
    expect(md, 'DEPLOY.md must point at the stop point it now depends on').toContain('--migrate-only');

    // THE FLIP BOUNDARY, which is what stops the reconcile over-granting a post-flip tenant two
    // platform switches. Pinned in the script AND the runbook: an option nothing documents is not a
    // control, and a documented option the script does not enforce is worse.
    expect(script, '--apply must be bounded by the flip date').toContain('--created-before=');
    expect(
      stripComments(script),
      'the script must REFUSE --apply without a boundary, not merely mention one',
    ).toContain('if (apply && !createdBeforeAt)');
    expect(md, 'DEPLOY.md must carry the boundary in the command it tells the operator to run').toContain(
      '--created-before=',
    );

    // THE ENV TEMPLATE deploy.sh POINTS AT MUST EXIST — asserted as "the named file is in the repo",
    // which is the actual requirement, and NOT as "the string .env.production.example is absent".
    //
    // That inverted form is what this assertion said after round 1, on the premise that
    // deploy/.env.production.example "does not exist in the repo". It does; it is tracked, and it is the
    // production template — ai_hr_app/ai_hr_owner URLs, SHARE_PASSWORD, DEV_TENANT_ID, and no feature
    // gates at all. The assertion therefore pinned a REGRESSION: it forced deploy.sh to send operators to
    // .env.example instead, which is the DEVELOPER template — superuser MIGRATION_DATABASE_URL against
    // ai_hr_dev, TEST_* URLs, no SHARE_PASSWORD, and MULTI_CYCLE_PAYROLL_ENABLED /
    // TYPED_PAY_COMPONENTS_ENABLED / PAYROLL_RESET_ENABLED / PAYROLL_UNLOCK_ENABLED all active and true.
    // DEPLOY.md then tells the operator to run the parity reconciliation with --apply against that env,
    // which would grant every customer two platform-scoped payroll risk switches that ai_hr_app can
    // never close. A test asserting the absence of a string cannot notice what replaced it.
    const templateMatch = sh.match(/copy ([^\s,]+\.example)/);
    expect(templateMatch, 'deploy.sh must tell the operator which template to copy').toBeTruthy();
    const template = templateMatch![1];
    expect(
      fs.existsSync(path.resolve(__dirname, '..', template)),
      `deploy.sh tells the operator to copy '${template}', which is not in the repo`,
    ).toBe(true);
    expect(template, 'the PRODUCTION template is deploy/.env.production.example — .env.example is the dev one').toBe(
      'deploy/.env.production.example',
    );
    // …and the reason, pinned rather than described: the dev template really does ship these on, so
    // pointing production at it is not a cosmetic difference.
    const devTemplate = repoFile('.env.example');
    expect(
      /^(MULTI_CYCLE_PAYROLL_ENABLED|TYPED_PAY_COMPONENTS_ENABLED|PAYROLL_RESET_ENABLED|PAYROLL_UNLOCK_ENABLED)=true$/m.test(
        devTemplate,
      ),
      '.env.example is the developer template and ships feature gates ON — that is why production copies the other one',
    ).toBe(true);
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
    // Deferred gates excluded: they are STILL env-driven by design (DEFERRED_ENV_GATES), so a test
    // that sets one is using the mechanism the application actually reads — correct, not a leftover.
    // audit-hash-chain.test.ts and leave-year-config.test.ts set AUDIT_HASH_CHAIN_ENABLED for exactly
    // that reason; listing them as unconverted work would be a lie the ratchet could never retire.
    const gates = [
      ...Object.values(LEGACY_MODULE_ENV_GATES).filter((g): g is string => g !== null),
      ...Object.values(LEGACY_SETTING_ENV_GATES),
    ]
      .filter((g) => !DEFERRED_GATE_NAMES.has(g))
      .sort();
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

  it("the suite's entitlement BASELINE is empty — asserted, not described", () => {
    // WHY THIS IS AN ASSERTION AND NOT A COMMENT. test/harness.ts's seedBase derives every test
    // tenant's `tenant_module` / `tenant_setting` rows — and `adminCtx`'s snapshot — from
    // `legacyEnabledModulesIn(process.env)` / `legacyEnabledSettingsIn(process.env)`. So the contents of
    // the ENVIRONMENT decide the entitlement baseline of ~247 files. test/env.ts loads `.env.local`,
    // which is untracked, and .env.example ships PAYROLL_RESET_ENABLED and PAYROLL_UNLOCK_ENABLED as
    // active lines — so before slice 3's round-1 review, a developer whose .env.local set
    // NOTIFICATIONS_ENABLED ran the whole suite with the `notifications` module ON while CI ran it OFF.
    // The harness docblock stated the opposite ("no test tenant in the suite carries a single
    // tenant_setting row today") as a FACT about a file nobody can see from here.
    //
    // The worklist scan above cannot catch this: it greps test files for env MUTATIONS, and this is
    // about env PRESENCE at process start. test/env.ts now deletes all nine tracked gates; this pins
    // the consequence, so adding a tenth gate to the map without adding the delete turns the suite red
    // here — with a message that says which — instead of somewhere unrelated on one machine only.
    expect(
      legacyEnabledModulesIn(process.env).filter((c) => LEGACY_MODULE_ENV_GATES[c] !== null),
      'a tracked module gate survived test/env.ts — delete it there, or the whole suite silently ' +
        'runs with a module the baseline does not have',
    ).toEqual([]);
    expect(
      legacyEnabledSettingsIn(process.env),
      'a tracked setting gate survived test/env.ts — delete it there; every catalogued default is ' +
        'false and the suite is written against that baseline',
    ).toEqual([]);
    // The null-gate modules (payroll/attendance/claims/performance) are NOT env-driven and must stay:
    // they are what every tenant runs, and dropping them would be a different failure entirely.
    expect([...legacyEnabledModulesIn(process.env)].sort()).toEqual(
      LEGACY_ENABLED_MODULE_CODES.filter((c) => LEGACY_MODULE_ENV_GATES[c] === null).sort(),
    );
    // …and every tracked gate really is absent, named individually so the failure says which.
    // DEFERRED gates are excluded: they are still genuinely env-read (DEFERRED_ENV_GATES), and
    // test/audit-hash-chain.test.ts legitimately sets AUDIT_HASH_CHAIN_ENABLED for its own run.
    for (const gate of [
      ...Object.values(LEGACY_MODULE_ENV_GATES).filter((g): g is string => g !== null),
      ...Object.values(LEGACY_SETTING_ENV_GATES),
    ].filter((g) => !DEFERRED_GATE_NAMES.has(g))) {
      expect(process.env[gate], `${gate} must be deleted in test/env.ts`).toBeUndefined();
    }
  });
});
