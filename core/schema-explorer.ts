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
 * OPERATOR PLANE ONLY. This describes how the PRODUCT is built, not what a customer's data says, so
 * it belongs to the people who build it. Putting it on a tenant's System Settings screen — where the
 * request placed it — would hand every customer administrator the full schema topology of a
 * multi-tenant system, which is an information-disclosure decision rather than a UI one. Gated the
 * same three ways as core/operator.ts, and for the same reasons.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { isOperator } from '../lib/authz';
import { isDemoDeployment } from '../lib/demo-mode';
import { NotOperatorError } from './operator';
import { MODULE_CATALOG } from '../packs/catalog';
import { listPacks, type ModulePack } from '../packs/registry';
// Side-effect import: registering the module packs IS the import (packs/register-all.ts). Without it
// listPacks('module') returns an empty array — silently, not as an error — and every table would read
// as unowned.
import '../packs/register-all';

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
};

function assertOperator(ctx: SessionContext): void {
  if (isDemoDeployment()) {
    throw new NotOperatorError('The dependency explorer is not available on the demo deployment.');
  }
  if (!isOperator(ctx)) {
    throw new NotOperatorError('Only an operator can open the dependency explorer.');
  }
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
 * Every base table in the `public` schema, with its owning module.
 *
 * Tables no pack claims come back with a null moduleCode. That is not a gap to be filled in later —
 * it is the shared spine (person, employment, company, the domain-event log), which by ADR-0080 D5
 * belongs to no pack. The UI names it rather than leaving the cell blank, because a blank reads as
 * "we did not look".
 */
export async function listSchemaTables(ctx: SessionContext): Promise<TableSummary[]> {
  assertOperator(ctx);
  const owners = ownershipIndex();
  return withTenant(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select rel.relname as table_name
        from pg_class rel
        join pg_namespace n on n.oid = rel.relnamespace
       where n.nspname = 'public' and rel.relkind = 'r'
       order by rel.relname
    `)) as unknown as { table_name: string }[];
    return rows.map((r) => ({ table: r.table_name, ...(owners.get(r.table_name) ?? UNOWNED) }));
  });
}

/**
 * The relationship view of ONE table: its primary key, what it points at, and what points at it.
 *
 * Returns null for a name that is not a base table in `public` — including one that does not exist at
 * all. The name arrives from a query string, so it is passed as a BOUND PARAMETER and never
 * interpolated; nothing here builds SQL from it.
 */
export async function describeTableRelationships(
  ctx: SessionContext,
  table: string,
): Promise<TableRelationships | null> {
  assertOperator(ctx);
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

    const shaped: ForeignKeyEdge[] = edges.map((e) => ({
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
    };
  });
}
