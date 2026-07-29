/**
 * System Analysis & Dependency Explorer (deec1691) — the generated half of the requested explorer,
 * moved at r79 from the operator plane to Admin and sold as a module that DEFAULTS OFF.
 *
 * Four properties are worth pinning, and none of them is "the query returns rows":
 *
 *   1. IT IS GENERATED, NOT AUTHORED. Nothing about the topology is written down in this repo, so the
 *      tests assert against pg_catalog and against the packs' own `satelliteTables` declarations rather
 *      than against a hand-written expected map. A hard-coded parent list would be exactly the stale
 *      artefact the plan refused to build, reproduced in the test suite.
 *   2. THE MODULE IS THE CONTROL, NOT THE MENU. The original placement argument (operator-only, on
 *      information-disclosure grounds) was overruled by the reporter for a real reason — during setup
 *      there is one tenant, and the reference is wanted under Admin. What replaces it is an
 *      entitlement, so the tests that matter are the ones proving the SERVICE refuses: a hidden nav row
 *      is decoration, and if these stop throwing the module is reachable by typing its address.
 *   3. IT IS OFF UNTIL SOLD. A tenant seeded with the standard parity set has no `system_explorer` row
 *      and must be refused — asserted, not assumed from the catalog flags.
 *   4. IT NAMES NO SECRETS. Tables holding keys, credentials and sign-in tokens are withheld from the
 *      listing AND from both ends of every edge, a withheld name is indistinguishable from a
 *      nonexistent one, and the deny-list is pinned against the live schema so it cannot go stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SECRET_TABLES,
  SYSTEM_EXPLORER_MODULE,
  NotAdminError,
  describeTableRelationships,
  listSchemaTables,
} from '../core/schema-explorer';
import { ModuleNotEnabledError } from '../core/entitlements';
import {
  DEFAULT_PROVISION_MODULE_CODES,
  LEGACY_ENABLED_MODULE_CODES,
  LEGACY_MODULE_ENV_GATES,
  MODULE_CATALOG,
} from '../packs/catalog';
import { MODULE_CODES_WITH_NAV } from '../lib/nav-entitlements';
import { SCREENS } from '../lib/permissions';
import { listPacks, type ModulePack } from '../packs/registry';
import '../packs/register-all';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import type { SessionContext } from '../db/client';

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'app/admin/system-explorer/page.tsx';
const HREF = '/admin/system-explorer';
const readRepo = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A tenant that HAS bought the explorer, with an admin session resolved from its real rows. */
async function entitledAdmin(base: Base): Promise<SessionContext> {
  await setModule(base.tenantId, SYSTEM_EXPLORER_MODULE, 'active');
  // AFTER setModule — the snapshot is a point-in-time read, exactly as it is for a real session.
  return entitledCtx(base);
}

/**
 * ONE SET OF HOOKS FOR THE WHOLE FILE, at module scope, and that is not a style preference.
 *
 * `closeAll()` ends the two SHARED postgres clients this file's harness hands out. Declared inside a
 * describe, its afterAll fires when THAT block finishes — so the first block would close the pool and
 * every later block's resetDb would die with CONNECTION_ENDED, which reads like an infrastructure
 * flake rather than a test-file bug. (It did: nine failures, all "write CONNECTION_ENDED".) At module
 * scope the teardown happens once, after the last block.
 */
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closeAll();
});

describe('deec1691 — the explorer reads the live schema', () => {
  it('reads BOTH directions of every foreign key from the live catalog', async () => {
    const s = await entitledAdmin(await seedBase());
    const employment = await describeTableRelationships(s, 'employment');
    expect(employment).not.toBeNull();
    expect(employment!.primaryKey).toEqual(['id']);

    // The expectation is derived from pg_catalog, not typed out: whatever the schema currently says
    // about employment is what the explorer must say. This is the property the whole feature rests on.
    const expected = (await owner.db.execute(
      sql`
        select src.relname as from_table, tgt.relname as to_table
          from pg_constraint c
          join pg_class src on src.oid = c.conrelid
          join pg_class tgt on tgt.oid = c.confrelid
          join pg_namespace sn on sn.oid = src.relnamespace
         where c.contype = 'f' and sn.nspname = 'public'
           and (src.relname = 'employment' or tgt.relname = 'employment')`,
    )) as unknown as { from_table: string; to_table: string }[];

    // Withheld ends removed from the expectation too, so this compares the explorer against what it
    // PROMISES to show rather than papering over a filter that dropped more than it claimed.
    const visible = expected.filter((e) => !SECRET_TABLES.has(e.from_table) && !SECRET_TABLES.has(e.to_table));
    expect(employment!.references.map((e) => e.toTable).sort()).toEqual(
      visible.filter((e) => e.from_table === 'employment').map((e) => e.to_table).sort(),
    );
    expect(employment!.referencedBy.map((e) => e.fromTable).sort()).toEqual(
      visible.filter((e) => e.to_table === 'employment').map((e) => e.from_table).sort(),
    );
    expect(employment!.withheldEdges).toBe(expected.length - visible.length);
    // Sanity that the schema under test is the one we think it is — an employment IS pointed at by
    // the leave ledger and the payslip, which is the "which records hang off this one" question the
    // reporter actually asked.
    expect(employment!.referencedBy.map((e) => e.fromTable)).toEqual(
      expect.arrayContaining(['leave_request', 'payslip']),
    );
    // Every edge carries the referential action, so "what happens to the children" is answerable
    // without opening a migration.
    expect(employment!.references.every((e) => e.onDelete.length > 0)).toBe(true);
  });

  it('shows a self-referencing table on BOTH sides rather than hiding the cycle', async () => {
    const s = await entitledAdmin(await seedBase());
    const dept = await describeTableRelationships(s, 'department');
    expect(dept!.references.map((e) => e.toTable)).toContain('department');
    expect(dept!.referencedBy.map((e) => e.fromTable)).toContain('department');
  });

  it('takes module ownership from the packs own satelliteTables declarations, both directions', async () => {
    const s = await entitledAdmin(await seedBase());
    const { tables } = await listSchemaTables(s);
    const owned = new Map(tables.map((r) => [r.table, r.moduleCode]));

    // Forward: every table a registered pack declares (and that actually exists) is reported as that
    // pack's. This is what makes the "related module" column real rather than guessed.
    for (const pack of listPacks('module') as ModulePack[]) {
      for (const decl of pack.satelliteTables ?? []) {
        if (!owned.has(decl.table)) continue; // declared but not in this schema — not this test's business
        expect(owned.get(decl.table), `${decl.table} is declared by the ${pack.id} pack`).toBe(pack.id);
      }
    }

    // Reverse: an unclaimed table reports NO module rather than a plausible-looking guess. person and
    // employment are the shared spine (ADR-0080 D5) and belong to no pack.
    expect(owned.get('person')).toBeNull();
    expect(owned.get('employment')).toBeNull();
    // …and a pack-owned one is not left unclaimed.
    expect(owned.get('leave_request')).toBe('leave');
    expect(owned.get('attendance_punch')).toBe('attendance');
  });

  it('returns null for a name that is not a table, and never builds SQL from it', async () => {
    const s = await entitledAdmin(await seedBase());
    expect(await describeTableRelationships(s, 'no_such_table')).toBeNull();
    // The name arrives from a query string. Bound, not interpolated — so this is a miss, not a syntax
    // error and not a second statement.
    expect(await describeTableRelationships(s, `x'; drop table employment; --`)).toBeNull();
    expect(await owner.db.execute(sql`select 1 as ok from employment limit 1`)).toBeDefined();
  });
});

describe('deec1691 — THE GATE: the service refuses, not the menu', () => {
  it('is OFF for a tenant nobody sold it to — asserted against a real seeded tenant', async () => {
    // seedBase grants `legacyEnabledModulesIn(process.env)`, i.e. this deployment's parity set. If
    // `system_explorer` ever creeps into that set, this fails BEFORE the service assertions below can
    // pass for the wrong reason.
    const base = await seedBase();
    const rows = (await owner.db.execute(
      sql`select module_code from tenant_module where tenant_id = ${base.tenantId}`,
    )) as unknown as { module_code: string }[];
    expect(rows.map((r) => r.module_code)).not.toContain(SYSTEM_EXPLORER_MODULE);
  });

  it('THE CONTROL: an admin of an unentitled tenant is refused BY THE SERVICE, named', async () => {
    const base = await seedBase();
    const s = await entitledCtx(base); // hr_admin, no system_explorer row
    // Asserted by NAME and by moduleCode, not merely "something threw": a rejects.toThrow() here would
    // pass just as happily on a typo'd import, a null dereference, or an unrelated database error —
    // which is exactly how a gate quietly becomes decorative.
    for (const call of [listSchemaTables(s), describeTableRelationships(s, 'employment')]) {
      const err = await call.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, 'the service must refuse an unentitled tenant').not.toBeNull();
      expect((err as Error).name).toBe('ModuleNotEnabledError');
      expect(err).toBeInstanceOf(ModuleNotEnabledError);
      expect((err as ModuleNotEnabledError).moduleCode).toBe(SYSTEM_EXPLORER_MODULE);
    }
  });

  it('…and DISCRIMINATES: the same admin succeeds once the module is granted', async () => {
    // Without this the test above would pass for a service that always threw.
    const base = await seedBase();
    const s = await entitledAdmin(base);
    const { tables } = await listSchemaTables(s);
    expect(tables.length).toBeGreaterThan(50);
    expect(await describeTableRelationships(s, 'employment')).not.toBeNull();
  });

  it('an expired grant is not a grant — the row alone does not open the door', async () => {
    const base = await seedBase();
    await setModule(base.tenantId, SYSTEM_EXPLORER_MODULE, 'active', null, new Date(Date.now() - 60_000));
    const s = await entitledCtx(base);
    const err = await listSchemaTables(s).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('ModuleNotEnabledError');
  });

  it('refuses a non-admin of an ENTITLED tenant, by name', async () => {
    const base = await seedBase();
    await setModule(base.tenantId, SYSTEM_EXPLORER_MODULE, 'active');
    const employee = await entitledCtx(base, ['employee']);
    const err = await listSchemaTables(employee).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('NotAdminError');
    expect(err).toBeInstanceOf(NotAdminError);
  });

  it('checks the MODULE before the role, so a refusal never confirms who is privileged', async () => {
    // An unentitled tenant answers "no such module" to everyone. Answering "you are not an admin"
    // would tell an employee the feature exists and that someone else can reach it.
    const base = await seedBase();
    const employee = await entitledCtx(base, ['employee']);
    const err = await listSchemaTables(employee).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('ModuleNotEnabledError');
  });
});

describe('deec1691 — what it withholds', () => {
  it('every withheld name is a REAL table — the deny-list cannot silently go stale', async () => {
    // A renamed or dropped table would leave a dead string in SECRET_TABLES, and its successor would
    // appear in the picker with nothing flagging it. Fail here instead.
    const rows = (await owner.db.execute(sql`
      select rel.relname as table_name
        from pg_class rel
        join pg_namespace n on n.oid = rel.relnamespace
       where n.nspname = 'public' and rel.relkind = 'r'
    `)) as unknown as { table_name: string }[];
    const live = new Set(rows.map((r) => r.table_name));
    for (const name of SECRET_TABLES) {
      expect(live.has(name), `SECRET_TABLES names '${name}', which is not a table in this schema`).toBe(true);
    }
    expect(SECRET_TABLES.size).toBeGreaterThan(0);
  });

  it('names no withheld table in the listing, in any edge, or as a lookup', async () => {
    const s = await entitledAdmin(await seedBase());
    const { tables, withheldTables } = await listSchemaTables(s);

    for (const row of tables) expect(SECRET_TABLES.has(row.table), `${row.table} is listed`).toBe(false);
    // The count is reported rather than swallowed — a map that looks complete and is not is the
    // failure this whole feature exists to avoid.
    expect(withheldTables).toBe(SECRET_TABLES.size);

    // A withheld name must be INDISTINGUISHABLE from a nonexistent one, or the screen becomes a
    // yes/no oracle for "does this installation store signing keys".
    for (const name of SECRET_TABLES) {
      expect(await describeTableRelationships(s, name), `${name} must answer like an unknown name`).toBeNull();
    }

    // …and no edge on any listed table may name one either. Walked over every table rather than a
    // sample: a single unfiltered edge is all it takes.
    for (const row of tables) {
      const detail = await describeTableRelationships(s, row.table);
      for (const e of [...detail!.references, ...detail!.referencedBy]) {
        expect(SECRET_TABLES.has(e.fromTable), `${e.constraint} names ${e.fromTable}`).toBe(false);
        expect(SECRET_TABLES.has(e.toTable), `${e.constraint} names ${e.toTable}`).toBe(false);
      }
    }
  });

  it('reads only pg_catalog — no business table, no row count, no owner connection', () => {
    // The safety argument in the header is "it cannot leak another tenant's data because it never
    // reads data". That is a property of the SQL, so it is checked against the SQL.
    const src = readRepo('core/schema-explorer.ts');
    const statements = [...src.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]);
    expect(statements.length, 'the statement scan has drifted').toBeGreaterThan(0);
    for (const stmt of statements) {
      // Every FROM/JOIN target must be a pg_catalog relation (or an inline unnest of one).
      for (const m of stmt.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
        const rel = m[1].toLowerCase();
        expect(
          rel.startsWith('pg_') || rel === 'unnest',
          `core/schema-explorer.ts reads '${rel}' — it must touch nothing but pg_catalog`,
        ).toBe(true);
      }
      expect(/count\s*\(/i.test(stmt), 'no row counting').toBe(false);
    }
    // And it must not reach for a privileged connection to "see more". COMMENTS STRIPPED FIRST: the
    // header of that file argues at length about why there is no SECURITY DEFINER helper here, and a
    // negative assertion that fails on the prose explaining the rule teaches people to delete the rule.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code, 'runs under RLS as ai_hr_app, via withTenant').toContain('withTenant');
  });
});

describe('deec1691 — the module, the placement, and the wiring', () => {
  it('is catalogued as sellable, non-core, and OFF for everyone by default', () => {
    const row = MODULE_CATALOG.find((m) => m.code === SYSTEM_EXPLORER_MODULE);
    expect(row, 'system_explorer is in the module catalog').toBeDefined();
    expect(row!.isCore, 'core modules are on for every tenant — this must not be one').toBe(false);
    expect(row!.billable).toBe(true);
    expect(row!.packBacked, 'it owns no tables and registers no pack').toBe(false);
    // THE DEFAULT-OFF PROOF at the catalog level, in all three places it could leak on:
    //   - not in the parity set  ⇒ migration 0313 grants it to no existing tenant,
    //   - a named (unset) gate   ⇒ `legacyEnabledModulesIn` never emits it for db/seed or the harness,
    //   - not pre-ticked         ⇒ the provisioning form does not sell it by accident.
    expect(LEGACY_ENABLED_MODULE_CODES).not.toContain(SYSTEM_EXPLORER_MODULE);
    expect(LEGACY_MODULE_ENV_GATES[SYSTEM_EXPLORER_MODULE], 'null would mean "on for everyone"').toBe(
      'SYSTEM_EXPLORER_ENABLED',
    );
    expect(DEFAULT_PROVISION_MODULE_CODES).not.toContain(SYSTEM_EXPLORER_MODULE);
  });

  it('is mounted under app/admin ONLY — the operator route is gone, not duplicated', () => {
    // Read-the-file, the same ratchet the module-catalog suite applies to migrations. The reporter
    // moved this surface deliberately; leaving the old copy behind would keep an ungated-by-module
    // route alive on the operator plane, and a page under app/admin/anything-else would type-check and
    // pass every other test in this file.
    //
    // COMMENTS STRIPPED, and it matches an IMPORT rather than the bare string. The first version did
    // neither and failed on components/sidebar.tsx — whose nav row carries a comment naming
    // core/schema-explorer.ts as the service that refuses. A placement guard that fires on prose
    // explaining the placement is a guard people delete, and the sidebar imports nothing of the sort.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const IMPORTS = /(?:from|import)\s+['"][^'"]*core\/schema-explorer['"]/;
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && IMPORTS.test(strip(fs.readFileSync(p, 'utf8')))) {
          importers.push(path.relative(ROOT, p).split(path.sep).join('/'));
        }
      }
    };
    for (const d of ['app', 'components']) walk(path.join(ROOT, d));
    expect(importers, 'exactly one surface reads the explorer service').toEqual([PAGE]);
    expect(fs.existsSync(path.join(ROOT, 'app/operator/schema')), 'the operator route is removed').toBe(false);
  });

  it('the page carries BOTH guards — the admin gate and the module gate', () => {
    const src = readRepo(PAGE);
    // requireAdmin is also what makes the route visible to test/function-access.test.ts's guard scan,
    // which is how it earns a permission-matrix column instead of being an undescribable screen.
    expect(src).toContain('requireAdmin()');
    expect(src).toContain(`requireModule('${SYSTEM_EXPLORER_MODULE}')`);
  });

  it('has a permission-matrix column, so Security & Permissions can describe it', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'systemExplorer');
    expect(screen, 'a screen with no column is one the access grid silently omits').toBeDefined();
    expect(screen!.guard).toBe('requireAdmin');
    expect(screen!.routes).toEqual([HREF]);
    expect(screen!.href).toBe(HREF);
  });

  it('the rail gates the row, and the hand-written href map agrees with the row and the route', () => {
    // MODULE_OF_HREF is derived from pack descriptors for every other module; this one has no pack, so
    // its entry is a literal. Three things must agree and none of them can see the others.
    expect(MODULE_CODES_WITH_NAV as readonly string[]).toContain(SYSTEM_EXPLORER_MODULE);
    const sidebar = readRepo('components/sidebar.tsx');
    expect(sidebar).toContain(`['${HREF}', '${SYSTEM_EXPLORER_MODULE}'] as const`);
    // Exactly once, so the row cannot be duplicated into an ungated position.
    expect(sidebar.split(`href: '${HREF}'`).length - 1, 'one nav row for the explorer').toBe(1);
    expect(sidebar).toContain(`labelKey: 'systemExplorer'`);
    expect(fs.existsSync(path.join(ROOT, PAGE)), 'the nav row points at a route that exists').toBe(true);
  });
});

describe('deec1691 — i18n, in all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  type Bundle = {
    admin: { systemExplorer: Record<string, string> };
    nav: Record<string, string>;
    operator: Record<string, unknown>;
  };
  const dict = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readRepo(`messages/${l}.json`)) as Bundle])) as
    Record<(typeof LOCALES)[number], Bundle>;

  // Every key the page asks for, listed here rather than trusted to the coverage test: check C of
  // test/i18n-coverage.test.ts matches LITERAL keys only and skips any file that opens two
  // namespaces, so this list is the thing that actually pins the screen's strings.
  const KEYS = [
    'title',
    'description',
    'recordType',
    'choose',
    'show',
    'formNote',
    'unknownTable',
    'sharedSpine',
    'primaryKey',
    'none',
    'references',
    'noReferences',
    'referencedBy',
    'noReferencedBy',
    'onDelete',
    'withheldNote',
    'withheldEdges',
  ] as const;

  it('the key list matches what the page actually renders (no key pinned that nothing uses)', () => {
    // Derived from the source, so a renamed key fails here rather than leaving a pinned string behind
    // that no screen reads — which is how a coverage list stops meaning anything.
    const used = new Set([...readRepo(PAGE).matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual([...KEYS].sort());
  });

  it('every key the page renders exists and is non-empty in every locale', () => {
    for (const l of LOCALES) {
      const block = dict[l].admin.systemExplorer;
      expect(block, `${l}: admin.systemExplorer exists`).toBeDefined();
      for (const k of KEYS) {
        expect(typeof block[k], `${l}: admin.systemExplorer.${k}`).toBe('string');
        expect(block[k].trim().length, `${l}: admin.systemExplorer.${k} non-empty`).toBeGreaterThan(0);
      }
      expect(typeof dict[l].nav.systemExplorer, `${l}: nav.systemExplorer`).toBe('string');
      expect(dict[l].nav.systemExplorer.trim().length, `${l}: nav.systemExplorer non-empty`).toBeGreaterThan(0);
    }
  });

  it('the strings are actually TRANSLATED, not English pasted six times', () => {
    // i18n-coverage only fails on missing/empty keys, so copying en into all six ships five locales in
    // English with a green build — the single most likely failure mode of a change like this.
    const en = dict.en;
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      for (const k of ['title', 'description', 'withheldNote', 'withheldEdges'] as const) {
        expect(dict[l].admin.systemExplorer[k], `${l}: ${k} differs from en`).not.toBe(en.admin.systemExplorer[k]);
      }
      expect(dict[l].nav.systemExplorer, `${l}: nav.systemExplorer differs from en`).not.toBe(en.nav.systemExplorer);
    }
  });

  it('the old operator.explorer block is gone from every locale (moved, not copied)', () => {
    for (const l of LOCALES) {
      expect(dict[l].operator.explorer, `${l}: operator.explorer was moved to admin.systemExplorer`).toBeUndefined();
    }
  });
});
