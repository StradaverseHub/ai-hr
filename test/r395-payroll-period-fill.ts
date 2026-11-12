/**
 * r395 — gives the shared org's payroll runs the pay period that migration 5055's deferred trigger still requires.
 *
 * 5055 made payroll_batch.pay_period_id nullable for a payroll history job's staged draft batch only;
 * app.payroll_batch_period_required refuses every other batch without one when it commits. The generic filler in
 * test/r395-org.ts (bytes pinned by .github/ci/r395-write-split.test.mjs) skips nullable references, so each of its
 * autocommitted payroll_batch rows is refused and the tables that require a batch (payslip) are left empty too.
 *
 * After setupOrg(), this rebuilds exactly those rows through the filler's own per-table builders: the same plan
 * (one row per employment of both tenants, plus the NULL-subject rows), the same index sequence, and pay_period_id
 * bound the way the filler binds a required parent, rotating through the tenant's filler-made pay periods. Then it
 * refills, in required-parent order, every filled table that required a batch. No trigger, policy or constraint is
 * touched. It is a no-op when the filler already committed batches, and it refuses to add rows to any table that
 * already holds some, so nothing it writes can duplicate or replace a filler row.
 */
import { BUILDERS, EMPS, PER_TENANT, POLICIES, T2, TABLES, b, fill, q, refCache, type Row } from './r395-org';

const BATCH = 'payroll_batch';
const PERIOD = 'pay_period';
// Mirrors fillTables: the tables it fills, and the seeded tables it never fills generically.
const SUPPORT = ['payslip', ...PER_TENANT];
const SEEDED = new Set(['employment', 'person', 'assignment']);
const ACCOUNT_ONLY = ['feedback_request', 'feedback_attachment'];

const count = async (table: string): Promise<number> => {
  const [r] = await q(`select count(*)::int as n from "${table}" where tenant_id in ($1, $2)`, [b.tenantId, T2]);
  return r.n as number;
};

/** The policy subject columns fillTables nulls for its NULL-subject rows, per table. */
function policyColumns(): Map<string, Set<string>> {
  const cols = new Map<string, Set<string>>();
  for (const p of POLICIES) {
    for (const m of p.oldQual.matchAll(/app\.can_see_(?:employment|person)\(([a-z_]+)\)/g)) {
      if (!cols.has(p.table)) cols.set(p.table, new Set());
      cols.get(p.table)!.add(m[1]);
    }
  }
  return cols;
}

/** The filled tables that require a payroll batch, directly or through another filled table, parents first. */
async function batchDependents(targets: string[]): Promise<string[]> {
  const fks = await q(`
    select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as ref, a.attnotnull as required
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and array_length(c.conkey, 1) = 1 and c.connamespace = 'public'::regnamespace`);
  const required = fks.filter((f) => f.required && targets.includes(f.tbl as string) && targets.includes(f.ref as string) && f.ref !== f.tbl);
  const dependents = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of required) {
      const tbl = f.tbl as string;
      if (tbl !== BATCH && !dependents.has(tbl) && (f.ref === BATCH || dependents.has(f.ref as string))) {
        dependents.add(tbl);
        grew = true;
      }
    }
  }
  const ordered: string[] = [];
  const visit = (t: string, seen = new Set<string>()) => {
    if (ordered.includes(t) || seen.has(t)) return;
    seen.add(t);
    for (const f of required.filter((x) => x.tbl === t && dependents.has(x.ref as string))) visit(f.ref as string, seen);
    ordered.push(t);
  };
  [...dependents].sort().forEach((t) => visit(t));
  return ordered;
}

/** fillTables' per-table loop, run again for one table with its existing builder and optional parent bindings. */
async function refill(table: string, policyCols: Map<string, Set<string>>, bind?: (e: Row, i: number) => Record<string, string> | null) {
  const build = BUILDERS.get(table);
  if (!build) throw new Error(`r395 filler built no ${table} rows to repair`);
  const cols = await q(
    `select column_name as name, is_nullable = 'YES' as nullable from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [table],
  );
  const nullableTargets = [...(policyCols.get(table) ?? [])].filter((pc) => cols.find((c) => c.name === pc)?.nullable);
  const perTenant = PER_TENANT.includes(table)
    ? [EMPS.find((x) => x.tenant_id === b.tenantId)!, EMPS.find((x) => x.tenant_id === T2)!]
    : EMPS;
  const plan: [Row, boolean][] = perTenant.map((e) => [e, false]);
  if (nullableTargets.length && !ACCOUNT_ONLY.includes(table)) plan.push([EMPS[0], true], [EMPS[EMPS.length - 1], true]);
  fill[table] = { rows: 0, errors: [] };
  let i = 0;
  for (const [e, nullCol] of plan) {
    const index = i++;
    const bindings = bind ? bind(e, index) : {};
    const stmt = bindings ? await build(e, index, nullCol, bindings) : null;
    if (!stmt) {
      if (!fill[table].errors.includes('missing referenced row')) fill[table].errors.push('missing referenced row');
      continue;
    }
    try {
      await q(stmt);
      fill[table].rows++;
    } catch (err) {
      const msg = String((err as Error).message).slice(0, 160);
      if (!fill[table].errors.includes(msg)) fill[table].errors.push(msg);
    }
  }
}

/** Call once, straight after setupOrg(). */
export async function supplyR395PayrollPeriods() {
  if ((await count(BATCH)) > 0) return;
  const targets = [...new Set([...TABLES, ...SUPPORT])].filter((t) => !SEEDED.has(t));
  const dependents = await batchDependents(targets);
  for (const t of dependents) {
    const n = await count(t);
    if (n !== 0) throw new Error(`r395 ${t} holds ${n} rows without any payroll batch; refusing to refill it`);
  }
  // The filler binds a required parent as ids[i % ids.length] over the tenant's rows ordered by id.
  const periods = new Map<string, string[]>();
  for (const tenant of [b.tenantId, T2]) {
    periods.set(tenant, (await q(`select id from "${PERIOD}" where tenant_id = $1 order by id`, [tenant])).map((r) => r.id as string));
  }
  const policyCols = policyColumns();
  await refill(BATCH, policyCols, (e, i) => {
    const ids = periods.get(e.tenant_id as string) ?? [];
    return ids.length ? { [PERIOD]: ids[i % ids.length] } : null;
  });
  // The filler cached the tenants' empty batch lists (and any empty dependent lists); forget them so it looks again.
  for (const key of [...refCache.keys()]) if ([BATCH, ...dependents].includes(key.split('|')[0])) refCache.delete(key);
  for (const t of dependents) await refill(t, policyCols);
}
