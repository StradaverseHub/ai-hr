/**
 * Record-relationship explorer (deec1691) — the schema topology, GENERATED on every request.
 *
 * The reporter asked for a whole "System Analysis & Dependency Explorer": table relationships AND a
 * function/screen/API dependency map. Only the first half is built, and the split is deliberate. The
 * relationship half is a PROPERTY OF THE RUNNING DATABASE — pg_constraint knows exactly which table
 * points at which, so a map read from it is correct by construction and can never go stale. The
 * function half is a property of the TypeScript source; nothing at runtime knows that Basic Salary is
 * read by payroll, the EA form and three reports. Hand-maintained it is wrong within a week, and a
 * wrong dependency map is worse than none because someone trusts it and skips a check. If it is ever
 * built it must be generated at build time (ts-morph / the compiler API) and pinned by a drift test.
 *
 * WHY pg_catalog AND NOT information_schema. The plan named information_schema; the catalog is used
 * instead because information_schema's views are PRIVILEGE-FILTERED against current_user. The app
 * connects as the non-privileged `ai_hr_app` role, so any table it holds no grant on — `tenant` is
 * the obvious one — would simply be absent, and every edge into it would vanish with it. That is the
 * silent-incompleteness failure the whole item exists to avoid: the map would look finished and be
 * missing the spine. pg_catalog is readable by every role and describes the schema as it really is.
 *
 * ── PLACEMENT: ADMIN, BEHIND AN ENTITLEMENT (r79, deec1691 revision) ────────────────────────────
 *
 * This file used to refuse anyone but an operator, on the argument that schema topology in a
 * multi-tenant product is information disclosure and belongs to whoever builds the product. The
 * reporter overruled that, for a real reason: during setup there is exactly one tenant — theirs — and
 * the reference is wanted under Admin where setup happens. The refusal is not abandoned, it is
 * RELOCATED: the screen is now a sellable module (`system_explorer`, ADR-0077) that DEFAULTS OFF, so
 * a customer onboarded tomorrow simply is not sold it. No code change, no scramble.
 *
 * `assertModuleEnabled` here is the control, not the nav row and not the page's redirect. A hidden
 * menu entry is a courtesy; this throw is what makes typing the address useless.
 *
 * ── WHAT IT CAN AND CANNOT REVEAL ──────────────────────────────────────────────────────────────
 *
 * CANNOT: any tenant's data, its own included. Every statement below reads pg_catalog — relation
 * names, primary-key column names, foreign-key column names and referential actions. Not one of them
 * touches a business table, counts a row, or takes a tenant predicate, so there is nothing for a
 * cross-tenant leak to ride on. No SECURITY DEFINER helper and no owner-role connection is used;
 * `withTenant` keeps the statements on the ordinary `ai_hr_app` role under RLS, and pg_catalog is
 * readable by every role anyway — the transaction is here for connection handling, not privilege.
 *
 * CAN: the shape of the product. Which record types exist, which point at which, what happens to the
 * children on delete, and which module owns each. That IS commercially sensitive (it is the product's
 * design), which is exactly why it is entitlement-gated rather than free.
 *
 * WITHHELD ON PURPOSE: `SECRET_TABLES`. Table names are structure, not data — but a list that names
 * `pii_key` and `statutory_signing_key` beside everything else is, in effect, a map of where the keys
 * are kept, and that is worth nothing to an administrator setting the product up. They are removed
 * from the listing AND from both sides of every edge, and the counts are reported so the map says it
 * is incomplete rather than pretending to be whole — silent incompleteness being the failure this
 * feature exists to avoid.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { isAdmin } from '../lib/authz';
import { assertModuleEnabled } from './entitlements';
import { MODULE_CATALOG } from '../packs/catalog';
import { listPacks, type ModulePack } from '../packs/registry';
// Side-effect import: registering the module packs IS the import (packs/register-all.ts). Without it
// listPacks('module') returns an empty array — silently, not as an error — and every table would read
// as unowned.
import '../packs/register-all';

/** The catalog code this screen is sold as (ADR-0077). Default OFF: a tenant with no row cannot use it. */
export const SYSTEM_EXPLORER_MODULE = 'system_explorer';

/**
 * Tables the explorer never names, because naming them is a key inventory rather than a data model.
 *
 * The test suite pins that every entry is a REAL table in the current schema. That matters more than
 * it looks: a renamed or dropped table would otherwise leave a dead string here, the withheld count
 * would over-report, and the actual successor table would appear in the picker with nothing flagging
 * it. A stale deny-list that still reads plausibly is the worst outcome available.
 *
 * Deliberately NOT here: `app_user`, `role_assignment`, `person`. They hold identity, not secrets
 * (authentication itself lives with WorkOS), and they are load-bearing in the relationship map an
 * administrator actually came for — a map with the user spine cut out of it would mislead.
 */
export const SECRET_TABLES: ReadonlySet<string> = new Set([
  'pii_key', // per-tenant PII encryption keys (ADR-0030)
  'statutory_signing_key', // vendor statutory-pack signing keys
  'ai_provider_config', // model provider credentials
  'app_invitation', // single-use activation tokens
  'payroll_step_up_challenge', // step-up authentication challenges
  'platform_user', // Stradaverse's own operator identities, not the tenant's
]);

/** Postgres `pg_constraint.confdeltype` → the referential action, spelled out. */
const ON_DELETE: Record<string, string> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

/** One foreign key, carrying BOTH ends so the same row can be read as a parent or as a child edge. */
export type ForeignKeyEdge = {
  constraint: string;
  /** The referencing (child) table. */
  fromTable: string;
  fromColumns: string[];
  /** The referenced (parent) table. */
  toTable: string;
  toColumns: string[];
  onDelete: string;
};

/** Which pack owns a table, resolved from the packs' own `satelliteTables` declarations. */
export type TableOwner = {
  /** Module code (= pack id, = ADR-0077 catalog code), or null for the shared spine. */
  moduleCode: string | null;
  /** The catalog's display name for that code, or null for the shared spine. */
  moduleName: string | null;
  /** The pack's own one-line note about the table, when it declared one. */
  note: string | null;
};

export type TableSummary = TableOwner & { table: string };

export type TableRelationships = TableSummary & {
  primaryKey: string[];
  /** Tables this one points AT — its parents. */
  references: ForeignKeyEdge[];
  /** Tables that point AT this one — its children. */
  referencedBy: ForeignKeyEdge[];
  /**
   * Edges dropped because the OTHER end is a withheld table. Surfaced rather than swallowed: "this
   * record type has 4 parents" and "this record type has 4 parents that I am willing to name" are
   * different statements, and a reader deciding whether a change is safe needs the second one labelled.
   */
  withheldEdges: number;
};

/** Refused when the caller is authenticated but not an administrator of this tenant. */
export class NotAdminError extends Error {
  constructor(message = 'Only an administrator can open the system explorer.') {
    super(message);
    this.name = 'NotAdminError';
  }
}

/**
 * The two gates, in this order and for this reason.
 *
 * MODULE FIRST. A tenant that was never sold the explorer has no such feature at all, so
 * `ModuleNotEnabledError` is the true answer for everyone in that tenant — an employee poking at the
 * URL learns exactly what an admin would, which is nothing about who is privileged here. Checking the
 * role first would answer "you are not an admin" and thereby confirm the feature exists.
 *
 * ROLE SECOND, in the SERVICE and not only in the page. `requireAdmin` in the route protects the
 * route; this protects the function, which is the boundary D3 puts enforcement at.
 */
function assertExplorerAccess(ctx: SessionContext): void {
  assertModuleEnabled(ctx, SYSTEM_EXPLORER_MODULE);
  if (!isAdmin(ctx)) throw new NotAdminError();
}

/**
 * table name → owning pack, from the registered module packs (ADR-0080 D5/D11 criterion 2).
 *
 * Built per call rather than memoised at module scope: registration happens at module load, but a dev
 * HMR re-evaluation can re-register, and the map is 60-odd entries over five packs. A stale cache
 * here would be exactly the drift this feature promises not to have.
 */
function ownershipIndex(): Map<string, TableOwner> {
  const names = new Map(MODULE_CATALOG.map((m) => [m.code, m.name]));
  const index = new Map<string, TableOwner>();
  for (const pack of listPacks('module') as ModulePack[]) {
    for (const decl of pack.satelliteTables ?? []) {
      index.set(decl.table, {
        moduleCode: pack.id,
        moduleName: names.get(pack.id) ?? pack.id,
        note: decl.note ?? null,
      });
    }
  }
  return index;
}

const UNOWNED: TableOwner = { moduleCode: null, moduleName: null, note: null };

/**
 * What the picker is built from: the tables the explorer will name, and how many it would not.
 *
 * The count travels WITH the list rather than in a second call, because the two are answers about the
 * same query and a screen that could render one without the other is a screen that can claim to be
 * complete while it is not. It is counted against the live schema, not printed as `SECRET_TABLES.size`,
 * so a deployment whose migrations have not all landed reports what is really being held back.
 */
export type SchemaOverview = {
  tables: TableSummary[];
  /** Withheld tables that genuinely exist here — see SECRET_TABLES for what and why. */
  withheldTables: number;
};

/**
 * Every base table in the `public` schema the explorer is willing to name, with its owning module.
 *
 * Tables no pack claims come back with a null moduleCode. That is not a gap to be filled in later —
 * it is the shared spine (person, employment, company, the domain-event log), which by ADR-0080 D5
 * belongs to no pack. The UI names it rather than leaving the cell blank, because a blank reads as
 * "we did not look".
 */
export async function listSchemaTables(ctx: SessionContext): Promise<SchemaOverview> {
  assertExplorerAccess(ctx);
  const owners = ownershipIndex();
  return withTenant(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select rel.relname as table_name
        from pg_class rel
        join pg_namespace n on n.oid = rel.relnamespace
       where n.nspname = 'public' and rel.relkind = 'r'
       order by rel.relname
    `)) as unknown as { table_name: string }[];
    const visible = rows.filter((r) => !SECRET_TABLES.has(r.table_name));
    return {
      tables: visible.map((r) => ({ table: r.table_name, ...(owners.get(r.table_name) ?? UNOWNED) })),
      withheldTables: rows.length - visible.length,
    };
  });
}

/**
 * The relationship view of ONE table: its primary key, what it points at, and what points at it.
 *
 * Returns null for a name that is not a base table in `public` — including one that does not exist at
 * all, AND including a withheld one, so the screen cannot be used to confirm that `pii_key` is there.
 * The name arrives from a query string, so it is passed as a BOUND PARAMETER and never interpolated;
 * nothing here builds SQL from it.
 */
export async function describeTableRelationships(
  ctx: SessionContext,
  table: string,
): Promise<TableRelationships | null> {
  assertExplorerAccess(ctx);
  // Before the query, not after: a withheld name must be indistinguishable from a nonexistent one,
  // and the cheapest way to guarantee that is never to ask the database about it.
  if (SECRET_TABLES.has(table)) return null;
  const owners = ownershipIndex();
  return withTenant(ctx, async (tx) => {
    const exists = (await tx.execute(sql`
      select 1 as ok
        from pg_class rel
        join pg_namespace n on n.oid = rel.relnamespace
       where n.nspname = 'public' and rel.relkind = 'r' and rel.relname = ${table}
    `)) as unknown as { ok: number }[];
    if (!exists.length) return null;

    const pk = (await tx.execute(sql`
      select (select array_agg(a.attname order by k.ord)
                from unnest(c.conkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns
        from pg_constraint c
        join pg_class rel on rel.oid = c.conrelid
        join pg_namespace n on n.oid = rel.relnamespace
       where c.contype = 'p' and n.nspname = 'public' and rel.relname = ${table}
    `)) as unknown as { columns: string[] | null }[];

    // Both directions in ONE query — a foreign key is one row whichever end you are standing at, and
    // splitting it into two near-identical statements is how the two halves drift apart.
    const edges = (await tx.execute(sql`
      select c.conname as constraint_name,
             src.relname as from_table,
             tgt.relname as to_table,
             c.confdeltype as on_delete,
             (select array_agg(a.attname order by k.ord)
                from unnest(c.conkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as from_columns,
             (select array_agg(a.attname order by k.ord)
                from unnest(c.confkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as to_columns
        from pg_constraint c
        join pg_class src on src.oid = c.conrelid
        join pg_class tgt on tgt.oid = c.confrelid
        join pg_namespace sn on sn.oid = src.relnamespace
        join pg_namespace tn on tn.oid = tgt.relnamespace
       where c.contype = 'f'
         and sn.nspname = 'public' and tn.nspname = 'public'
         and (src.relname = ${table} or tgt.relname = ${table})
       order by src.relname, tgt.relname, c.conname
    `)) as unknown as {
      constraint_name: string;
      from_table: string;
      to_table: string;
      on_delete: string;
      from_columns: string[];
      to_columns: string[];
    }[];

    // An edge is withheld when its OTHER end is a secret table. Filtered in TypeScript rather than in
    // the SQL predicate so the count below is the number actually dropped, not a difference between
    // two queries that could silently agree while both being wrong.
    const visible = edges.filter((e) => !SECRET_TABLES.has(e.from_table) && !SECRET_TABLES.has(e.to_table));

    const shaped: ForeignKeyEdge[] = visible.map((e) => ({
      constraint: e.constraint_name,
      fromTable: e.from_table,
      fromColumns: e.from_columns,
      toTable: e.to_table,
      toColumns: e.to_columns,
      onDelete: ON_DELETE[e.on_delete] ?? e.on_delete,
    }));

    return {
      table,
      ...(owners.get(table) ?? UNOWNED),
      primaryKey: pk[0]?.columns ?? [],
      // A self-referencing table (reporting_line, department's parent) appears in BOTH lists, on
      // purpose: it genuinely is its own parent and its own child, and hiding one side would make the
      // cycle invisible in the one place a reader is looking for it.
      references: shaped.filter((e) => e.fromTable === table),
      referencedBy: shaped.filter((e) => e.toTable === table),
      withheldEdges: edges.length - visible.length,
    };
  });
}
