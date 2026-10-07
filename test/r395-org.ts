/**
 * r395 — the shared org, contexts, generic table filler and evaluation helpers used by
 * test/r395-visibility-equivalence.test.ts (reads) and test/r395-write-path-equivalence.test.ts (writes).
 * Not a test file. See the equivalence test's header for what the org contains and why.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { owner, resetDb, seedBase, type Base } from './harness';

export type Policy = { table: string; policy: string; cmd: string; calls: number; oldQual: string; newQual: string; withCheck: string | null };
export const FIXTURE = JSON.parse(readFileSync('test/fixtures/r395-policy-quals.json', 'utf8')) as { policies: Policy[] };
export const POLICIES = FIXTURE.policies;
export const TABLES = [...new Set(POLICIES.map((p) => p.table))].sort();

export const pg = owner.client;
export type Row = Record<string, unknown>;
export const q = async (text: string, params: unknown[] = []): Promise<Row[]> =>
  (await pg.unsafe(text, params as never[])) as unknown as Row[];

// ── mutations (non-vacuity) ─────────────────────────────────────────────────────────────────────────────
export const MUTATIONS: Record<string, (def: string) => string> = {
  // (d) drop the HOD arm
  hod: (d) => replaceAllOrThrow(d, 'SELECT h.employment_id FROM hod h', 'SELECT h.employment_id FROM hod h WHERE false'),
  // (c) drop the manager walk's company clamp (seed and recursive step)
  clamp: (d) =>
    replaceAllOrThrow(
      replaceAllOrThrow(d, 'app.is_company_descendant(sub.company_id, m.company_id)', 'true'),
      'app.is_company_descendant(sub.company_id, d.root_company)',
      'true',
    ),
  // ignore valid_to on every reporting line
  valid_to: (d) => replaceAllOrThrow(d, '(rl.valid_to IS NULL OR rl.valid_to > CURRENT_DATE)', 'true'),
  // ignore terminated_on everywhere (`e.` / `sub.` / `mid.terminated_on IS NULL` → true)
  terminated: (d) => {
    const re = /\b[a-z_]+\.terminated_on IS NULL/gi;
    if (!re.test(d)) throw new Error('mutation anchor not found: terminated_on');
    return d.replace(re, 'true');
  },
};
export function replaceAllOrThrow(s: string, from: string, to: string): string {
  // pg_get_functiondef returns the body as written; match case-insensitively on the keyword spelling.
  const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const n = (s.match(re) ?? []).length;
  if (n === 0) throw new Error(`mutation anchor not found: ${from}`);
  return s.replace(re, to);
}

// ── the org ────────────────────────────────────────────────────────────────────────────────────────────
export type Ctx = { name: string; tenantId: string; userId: string; roles: string[]; grants: { role: string; companyId: string | null }[] };
export let b: Base;
export let T2: string;
export const E: Record<string, string> = {}; // employment ids by name
export const P: Record<string, string> = {}; // person ids by name
export const C: Record<string, string> = {}; // company ids
export const D: Record<string, string> = {}; // department ids
export let CONTEXTS: Ctx[] = [];
export let ALL_EMP: string[] = [];
export let ALL_PERSON: string[] = [];
export let TENANT_OF_PERSON: [string, string][] = [];
export const fill: Record<string, { rows: number; errors: string[] }> = {};

async function company(tenantId: string, name: string, parent: string | null) {
  const [r] = await q(`insert into company (tenant_id, legal_name, parent_company_id) values ($1, $2, $3) returning id`, [tenantId, name, parent]);
  return r.id as string;
}
async function dept(tenantId: string, companyId: string, name: string, parent: string | null) {
  const [r] = await q(`insert into department (tenant_id, company_id, name, parent_department_id) values ($1, $2, $3, $4) returning id`, [
    tenantId, companyId, name, parent,
  ]);
  return r.id as string;
}
async function person(tenantId: string, name: string) {
  const [r] = await q(`insert into person (tenant_id, full_name, primary_email) values ($1, $2, $3) returning id`, [
    tenantId, name, `${name}_${randomUUID().slice(0, 8)}@r395.local`,
  ]);
  P[name] = r.id as string;
  return r.id as string;
}
/** An employment with ONE current assignment in `deptId`. `terminated` sets terminated_on in the past. */
async function emp(tenantId: string, name: string, personId: string, companyId: string, deptId: string, terminated = false) {
  const [r] = await q(
    `insert into employment (tenant_id, person_id, company_id, hired_on, terminated_on)
     values ($1, $2, $3, '2024-01-01', ${terminated ? `current_date - 30` : 'null'}) returning id`,
    [tenantId, personId, companyId],
  );
  const id = r.id as string;
  await q(
    `insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from)
     values ($1, $2, $3, $4, 'full_time', '2024-01-01')`,
    [tenantId, id, deptId, companyId],
  );
  E[name] = id;
  return id;
}
/** Shorthand: a new person + one employment. */
async function hire(name: string, companyId: string, deptId: string, terminated = false, tenantId = b.tenantId) {
  return emp(tenantId, name, await person(tenantId, name), companyId, deptId, terminated);
}
async function line(sub: string, mgr: string, opts: { type?: string; from?: string; to?: string; superseded?: boolean } = {}) {
  await q(
    `insert into reporting_line (tenant_id, subordinate_employment_id, manager_employment_id, line_type, valid_from, valid_to, superseded_at)
     values ($1, $2, $3, $4::reporting_line_type, ${opts.from ?? `'2024-01-01'`}, ${opts.to ?? 'null'}, ${opts.superseded ? 'now()' : 'null'})`,
    [b.tenantId, sub, mgr, opts.type ?? 'administrative'],
  );
}
export async function login(name: string, tenantId: string, personId: string | null, roles: string[], grants: Ctx['grants']): Promise<Ctx> {
  const [u] = await q(`insert into app_user (tenant_id, workos_user_id, person_id) values ($1, $2, $3) returning id`, [
    tenantId, `user_${randomUUID()}`, personId,
  ]);
  for (const g of grants) {
    await q(`insert into role_assignment (tenant_id, app_user_id, company_id, role) values ($1, $2, $3, $4::role)`, [
      tenantId, u.id, g.companyId, g.role,
    ]);
  }
  return { name, tenantId, userId: u.id as string, roles, grants };
}
export const g = (role: string, companyId: string | null = null) => ({ role, companyId });

export async function seedOrg() {
  b = await seedBase();
  const t = b.tenantId;
  C.A = b.companyId;
  C.A1 = await company(t, 'A1 Subsidiary', C.A);
  C.A2 = await company(t, 'A2 Grandchild', C.A1);
  C.B = await company(t, 'B Unrelated', null);

  // Departments. Managers sit in departments of their own so the HOD arm (every manager "heads" his own
  // department subtree) does not mask what the manager arm alone decides.
  D.ceo = await dept(t, C.A, 'CEO office', null);
  D.mid = await dept(t, C.A, 'Mid office', null);
  D.leaf = await dept(t, C.A, 'Leaf team', null);
  D.misc = await dept(t, C.A, 'Misc A', null);
  D.miscA1 = await dept(t, C.A1, 'Misc A1', null);
  D.miscA2 = await dept(t, C.A2, 'Misc A2', null);
  D.miscB = await dept(t, C.B, 'Misc B', null);
  D.a1m = await dept(t, C.A1, 'A1 manager office', null);
  // HOD tree: H (A) → H_sub (A) → H_A1 (A1); H_sub → H_B (B, clamp breaks) → H_B_A (A, unreachable: the
  // clamp is per HOP, so a company-A department below a company-B one is out too).
  D.H = await dept(t, C.A, 'H', null);
  D.H_sub = await dept(t, C.A, 'H sub', D.H);
  D.H_A1 = await dept(t, C.A1, 'H A1', D.H_sub);
  D.H_B = await dept(t, C.B, 'H B', D.H_sub);
  D.H_B_A = await dept(t, C.A, 'H B A', D.H_B);
  D.N = await dept(t, C.A, 'N (HOD without a live line)', null);
  D.R1 = await dept(t, C.A, 'R1', null);
  D.R2 = await dept(t, C.B, 'R2', null);

  // Administrative chain ceo → mid → leaf → leaf2.
  await hire('ceo', C.A, D.ceo);
  await hire('mid', C.A, D.mid);
  await hire('leaf', C.A, D.leaf);
  await hire('leaf2', C.A, D.leaf);
  await line(E.mid, E.ceo);
  await line(E.leaf, E.mid);
  await line(E.leaf2, E.leaf);
  // Terminated intermediate manager with a LIVE line under ceo and a report of his own.
  await hire('midT', C.A, D.misc, true);
  await hire('underMidT', C.A, D.misc);
  await line(E.midT, E.ceo);
  await line(E.underMidT, E.midT);
  // Company clamp: mid (A) → subco (A1) IN; mid → bemp (B) OUT.
  await hire('subco', C.A1, D.miscA1);
  await hire('bemp', C.B, D.miscB);
  await line(E.subco, E.mid);
  await line(E.bemp, E.mid);
  // Terminated report under mid: OUT.
  await hire('termleaf', C.A, D.misc, true);
  await line(E.termleaf, E.mid);
  // Line-validity edges under ceo.
  await hire('superseded', C.A, D.misc);
  await line(E.superseded, E.ceo, { superseded: true });
  await hire('expired', C.A, D.misc);
  await line(E.expired, E.ceo, { to: 'current_date - 1' });
  await hire('endsToday', C.A, D.misc);
  await line(E.endsToday, E.ceo, { to: 'current_date' });
  await hire('endsTomorrow', C.A, D.misc);
  await line(E.endsTomorrow, E.ceo, { to: 'current_date + 1' });
  await hire('future', C.A, D.misc);
  await line(E.future, E.ceo, { from: 'current_date + 30' });
  await hire('startsToday', C.A, D.misc);
  await line(E.startsToday, E.ceo, { from: 'current_date' });
  // Functional line: not visibility.
  await hire('fx', C.A, D.misc);
  await line(E.leaf, E.fx, { type: 'functional' });
  // Delegate line: subordinate = delegator (mid), manager = delegate. Not visibility either.
  await hire('delegate', C.A, D.misc);
  await line(E.mid, E.delegate, { type: 'delegate' });
  // Parent's verification (r395): non-administrative lines whose MANAGER is an INTERMEDIATE of the live chain
  // (mid). Only the recursive step of the manager walk can reach these, so they pin its own line-type filter:
  // without them a walk that followed functional/delegate lines from depth 2 down passed every test.
  await hire('fxUnderMid', C.A, D.misc);
  await line(E.fxUnderMid, E.mid, { type: 'functional' });
  await hire('dlgUnderMid', C.A, D.misc);
  await line(E.dlgUnderMid, E.mid, { type: 'delegate' });
  // A1 manager: A2 report IN (A2 descends from A1), A report OUT (A does not descend from A1).
  await hire('a1mgr', C.A1, D.a1m);
  await hire('a2sub', C.A2, D.miscA2);
  await hire('aUnderA1', C.A, D.misc);
  await line(E.a2sub, E.a1mgr);
  await line(E.aUnderA1, E.a1mgr);

  // HOD: hod in H with one live line (to hodsub in misc).
  await hire('hod', C.A, D.H);
  await hire('hodsub', C.A, D.misc);
  await line(E.hodsub, E.hod);
  await hire('hSub', C.A, D.H_sub);
  await hire('hA1', C.A1, D.H_A1);
  await hire('hB', C.B, D.H_B);
  await hire('hBA', C.A, D.H_B_A);
  await hire('hSubTerminated', C.A, D.H_sub, true); // HOD arm does not test the SUBJECT's termination
  // A past assignment in H_sub (ended), current one in misc: OUT of the HOD view.
  {
    const pid = await person(t, 'hPast');
    const [r] = await q(`insert into employment (tenant_id, person_id, company_id, hired_on) values ($1, $2, $3, '2024-01-01') returning id`, [t, pid, C.A]);
    E.hPast = r.id as string;
    await q(`insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from, valid_to)
             values ($1, $2, $3, $4, 'full_time', '2024-01-01', '2025-01-01')`, [t, E.hPast, D.H_sub, C.A]);
    await q(`insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from)
             values ($1, $2, $3, $4, 'full_time', '2025-01-01')`, [t, E.hPast, D.misc, C.A]);
  }
  // A SUPERSEDED assignment in H_sub, live one in misc: OUT.
  {
    const pid = await person(t, 'hSuperseded');
    const [r] = await q(`insert into employment (tenant_id, person_id, company_id, hired_on) values ($1, $2, $3, '2024-01-01') returning id`, [t, pid, C.A]);
    E.hSuperseded = r.id as string;
    await q(`insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from, superseded_at)
             values ($1, $2, $3, $4, 'full_time', '2024-01-01', now())`, [t, E.hSuperseded, D.H_sub, C.A]);
    await q(`insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from)
             values ($1, $2, $3, $4, 'full_time', '2024-01-01')`, [t, E.hSuperseded, D.misc, C.A]);
  }
  // HOD whose only line has EXPIRED: no HOD view of N.
  await hire('hodNoLine', C.A, D.N);
  await hire('nMember', C.A, D.N);
  await hire('nOldSub', C.A, D.misc);
  await line(E.nOldSub, E.hodNoLine, { to: 'current_date - 1' });

  // Rehire: one person, r1 in A TERMINATED (still holds a line to rsub1), r2 in B active (line to rsub2).
  P.rehire = await person(t, 'rehire');
  await emp(t, 'r1', P.rehire, C.A, D.R1, true);
  await emp(t, 'r2', P.rehire, C.B, D.R2);
  await hire('rsub1', C.A, D.misc);
  await hire('rsub2', C.B, D.miscB);
  await line(E.rsub1, E.r1);
  await line(E.rsub2, E.r2);
  // Two ACTIVE employments of one person (A and A1).
  P.dual = await person(t, 'dual');
  await emp(t, 'dualA', P.dual, C.A, D.misc);
  await emp(t, 'dualA1', P.dual, C.A1, D.miscA1);
  // A terminated employee who can still log in.
  await hire('gone', C.A, D.misc, true);
  // Partners and admins with persons of their own.
  await hire('payrollPartner', C.A, D.misc);
  await hire('perfPartner', C.A1, D.miscA1);
  await hire('adminA', C.A, D.misc);
  // A person with no employment (only admins can see them).
  await person(t, 'noEmployment');

  // Second tenant: its ids are in every universe and must never appear.
  const [t2] = await q(`insert into tenant (workos_org_id, name) values ($1, 'Other tenant') returning id`, [`org_${randomUUID()}`]);
  T2 = t2.id as string;
  C.T2 = await company(T2, 'T2 Co', null);
  D.T2 = await dept(T2, C.T2, 'T2 dept', null);
  await hire('t2boss', C.T2, D.T2, false, T2);
  await hire('t2emp', C.T2, D.T2, false, T2);
  await q(`insert into reporting_line (tenant_id, subordinate_employment_id, manager_employment_id, line_type, valid_from)
           values ($1, $2, $3, 'administrative', '2024-01-01')`, [T2, E.t2emp, E.t2boss]);

  CONTEXTS = [
    await login('employee (leaf2)', t, P.leaf2, ['employee'], [g('employee')]),
    await login('manager top (ceo)', t, P.ceo, ['manager'], [g('manager')]),
    await login('manager intermediate (mid)', t, P.mid, ['manager'], [g('manager')]),
    await login('manager + HOD of own team (leaf)', t, P.leaf, ['manager'], [g('manager')]),
    await login('HOD (hod)', t, P.hod, ['manager'], [g('manager')]),
    await login('HOD with only an expired line', t, P.hodNoLine, ['manager'], [g('manager')]),
    await login('A1 manager (clamp)', t, P.a1mgr, ['manager'], [g('manager')]),
    await login('delegate', t, P.delegate, ['manager'], [g('manager')]),
    await login('functional manager', t, P.fx, ['manager'], [g('manager')]),
    await login('rehired manager (terminated A + active B)', t, P.rehire, ['manager'], [g('manager')]),
    await login('two active employments', t, P.dual, ['employee'], [g('employee')]),
    await login('terminated employee', t, P.gone, ['employee'], [g('employee')]),
    await login('terminated intermediate manager', t, P.midT, ['manager'], [g('manager')]),
    await login('login without a person', t, null, ['employee'], [g('employee')]),
    await login('hr_admin scoped to A', t, P.adminA, ['hr_admin'], [g('hr_admin', C.A)]),
    await login('hr_admin scoped to A1', t, null, ['hr_admin'], [g('hr_admin', C.A1)]),
    await login('hr_admin group-wide', t, null, ['hr_admin'], [g('hr_admin')]),
    await login('super_admin group-wide', t, null, ['super_admin'], [g('super_admin')]),
    await login('hr_admin scoped to B', t, null, ['hr_admin'], [g('hr_admin', C.B)]), // super_admin is group-wide only (role_assignment_super_admin_group_wide)
    await login('payroll_partner (A)', t, P.payrollPartner, ['payroll_partner'], [g('payroll_partner', C.A)]),
    await login('performance_comp_partner (A1)', t, P.perfPartner, ['performance_comp_partner'], [g('performance_comp_partner', C.A1)]),
    await login('manager + hr_admin(B)', t, P.mid, ['manager', 'hr_admin'], [g('manager'), g('hr_admin', C.B)]),
    await login('other tenant manager', T2, P.t2boss, ['manager'], [g('manager')]),
  ];
  // No user at all (a tenant context with app.user_id '').
  CONTEXTS.push({ name: 'no user', tenantId: t, userId: '', roles: [], grants: [] });

  ALL_EMP = (await q(`select id from employment where tenant_id in ($1, $2) order by id`, [t, T2])).map((r) => r.id as string);
  const pr = await q(`select id, tenant_id from person where tenant_id in ($1, $2) order by id`, [t, T2]);
  ALL_PERSON = pr.map((r) => r.id as string);
  TENANT_OF_PERSON = pr.map((r) => [r.id as string, r.tenant_id as string]);
}

// ── generic filler: one row per employment in every touched table ──────────────────────────────────────
export type Col = { name: string; dataType: string; udt: string; nullable: boolean; hasDefault: boolean };
export async function fillTables() {
  // payslip: read by the pay_period / payroll_batch quals. The rest are NOT NULL parents of target rows,
  // filled ONE row per tenant (PER_TENANT) rather than one per employment.
  const support = ['payslip', ...PER_TENANT];
  // employment / person / assignment already hold the org's real rows; a generic row there would add
  // employments and persons (and move visibility) that the named expectations do not describe.
  const seeded = new Set(['employment', 'person', 'assignment']);
  const targets = [...new Set([...TABLES, ...support])].filter((t) => !seeded.has(t));
  const fks = await q(`
    select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as ref
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and array_length(c.conkey, 1) = 1 and c.connamespace = 'public'::regnamespace`);
  const checks = await q(`
    select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def
    from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace`);
  const enums = await q(`select t.typname, (array_agg(e.enumlabel order by e.enumsortorder))[1] as first
                         from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname`);
  const enumFirst = new Map(enums.map((r) => [r.typname as string, r.first as string]));
  // Order: a target referenced by another target first.
  const ordered: string[] = [];
  const visit = (t: string, seen = new Set<string>()) => {
    if (ordered.includes(t) || seen.has(t)) return;
    seen.add(t);
    for (const fk of fks.filter((f) => f.tbl === t && targets.includes(f.ref as string) && f.ref !== t)) visit(fk.ref as string, seen);
    ordered.push(t);
  };
  // leave_ledger BEFORE leave_encashment_snapshot: a frozen snapshot makes a trigger refuse ledger rows.
  visit('leave_ledger');
  targets.forEach((t) => visit(t));

  const emps = await q(`select id, tenant_id, person_id, company_id from employment where tenant_id in ($1, $2) order by id`, [b.tenantId, T2]);
  EMPS = emps;
  const users = await q(`select id, tenant_id from app_user where tenant_id in ($1, $2) order by id`, [b.tenantId, T2]);
  const policyCols = new Map<string, Set<string>>();
  for (const p of POLICIES) {
    for (const m of p.oldQual.matchAll(/app\.can_see_(?:employment|person)\(([a-z_]+)\)/g)) {
      if (!policyCols.has(p.table)) policyCols.set(p.table, new Set());
      policyCols.get(p.table)!.add(m[1]);
    }
  }

  for (const table of ordered) {
    fill[table] = { rows: 0, errors: [] };
    const cols = (
      await q(
        `select column_name as name, data_type as "dataType", udt_name as udt, is_nullable = 'YES' as nullable,
                (column_default is not null or is_identity = 'YES' or is_generated = 'ALWAYS') as "hasDefault"
         from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [table],
      )
    ).map((r) => r as unknown as Col);
    const tableChecks = checks.filter((c) => c.tbl === table).map((c) => c.def as string);
    const tableFks = new Map(fks.filter((f) => f.tbl === table).map((f) => [f.col as string, f.ref as string]));
    const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

    const build = async (e: Row, i: number, nullPolicyCol: boolean): Promise<string | null> => {
      const names: string[] = [];
      const vals: string[] = [];
      for (const c of cols) {
        const ref = tableFks.get(c.name);
        const isPolicyCol = policyCols.get(table)?.has(c.name) ?? false;
        let v: string | null = null;
        const override = OVERRIDES[table]?.[c.name];
        if (override !== undefined) v = override;
        else if (c.name === 'tenant_id') v = lit(e.tenant_id as string);
        else if (isPolicyCol && nullPolicyCol) v = 'null';
        else if (ref === 'employment' || (isPolicyCol && /employment_id$/.test(c.name))) {
          // The policy's own column (and the first employment FK) is THIS employment; any other employment
          // FK is a different one, so a two-sided row (peer / subject) is not trivially self-referential.
          const sameTenant = emps.filter((x) => x.tenant_id === e.tenant_id);
          v = isPolicyCol || c.name === 'employment_id' ? lit(e.id as string) : lit(sameTenant[(i + 1) % sameTenant.length].id as string);
        } else if (ref === 'person' || (isPolicyCol && c.name === 'person_id')) v = lit(e.person_id as string);
        else if (ref === 'company' || c.name === 'company_id') v = lit(e.company_id as string);
        else if (ref === 'app_user') {
          if (c.nullable) continue;
          v = lit(users.find((u) => u.tenant_id === e.tenant_id)!.id as string);
        } else if (ref === 'tenant') v = lit(e.tenant_id as string);
        else if (ref) {
          if (c.nullable) continue;
          // ROTATE through the parent's rows so child rows hang off many parents (and so many employments),
          // not all off the first one.
          const key = `${ref}|${e.tenant_id}`;
          if (!refCache.has(key)) {
            try {
              const rows = await q(`select id from "${ref}" where ${refHasTenant(ref) ? `tenant_id = $1` : 'true'} order by id`, refHasTenant(ref) ? [e.tenant_id] : []);
              refCache.set(key, rows.map((x) => x.id as string));
            } catch {
              refCache.set(key, []);
            }
          }
          const ids = refCache.get(key)!;
          if (ids.length === 0) return null;
          v = lit(ids[i % ids.length]);
        } else if (c.nullable || c.hasDefault) continue;
        else v = scalarFor(c, tableChecks, enumFirst, i);
        names.push(`"${c.name}"`);
        vals.push(v);
      }
      return `insert into "${table}" (${names.join(', ')}) values (${vals.join(', ')})`;
    };

    BUILDERS.set(table, build);
    const tenantCols = new Set(cols.map((c) => c.name));
    if (!tenantCols.has('tenant_id')) fill[table].errors.push('no tenant_id column');
    let i = 0;
    const nullableTargets = [...(policyCols.get(table) ?? [])].filter((pc) => cols.find((c) => c.name === pc)?.nullable);
    const perTenant = PER_TENANT.includes(table)
      ? [emps.find((x) => x.tenant_id === b.tenantId)!, emps.find((x) => x.tenant_id === T2)!]
      : emps;
    const plan: [Row, boolean][] = perTenant.map((e) => [e, false]);
    if (nullableTargets.length) plan.push([emps[0], true], [emps[emps.length - 1], true]);
    for (const [e, nullCol] of plan) {
      const stmt = await build(e, i++, nullCol);
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
}
export const tenantTables = new Set<string>();
export const refCache = new Map<string, string[]>();
export const PER_TENANT = ['review_cycle', 'claim_type', 'clocking_location', 'shift'];
/** Column values a CHECK constraint needs that the generic filler cannot infer. */
export const OVERRIDES: Record<string, Record<string, string>> = {
  attendance_correction: { proposed_check_in: 'now()' }, // attendance_correction_at_least_one
  roster_assignment: { is_rest_day: 'true' }, // roster_assignment_shift_xor_rest (shift_id stays null)
  // attendance_clock_capture: the photo/geo CHECKs (a 1-byte "photo" whose size matches, a fix inside the radius).
  attendance_clock_capture: {
    command_digest: `repeat('a', 64)`, photo_digest: `repeat('b', 64)`, photo_mime_type: `'image/jpeg'`,
    photo_size: '1', photo_bytes: `'\\x00'::bytea`, thumbnail_bytes: `'\\x00'::bytea`, decoded_width: '1', decoded_height: '1',
    lat: '0', lng: '0', accuracy_m: '0', distance_m: '0', radius_m: '1',
  },
};
function refHasTenant(ref: string) {
  return tenantTables.has(ref);
}
function scalarFor(c: Col, checks: string[], enumFirst: Map<string, string>, i: number): string {
  const allowed = checks
    .map((d) => d.match(new RegExp(`(?<![a-z_])${c.name}\\)?(?:::text)? = ANY \\(\\(?ARRAY\\['([^']*)'`)))
    .find(Boolean);
  if (allowed) return `'${allowed[1]}'`;
  if (c.dataType === 'USER-DEFINED' && enumFirst.has(c.udt)) return `'${enumFirst.get(c.udt)}'`;
  if (c.dataType === 'ARRAY') return `'{}'`;
  switch (c.udt) {
    case 'uuid': return `'${randomUUID()}'`;
    case 'text': case 'varchar': case 'bpchar': case 'citext': return `'r395-${i}'`;
    case 'int2': case 'int4': case 'int8': case 'numeric': case 'float4': case 'float8': return '1';
    case 'date': return 'current_date';
    case 'timestamptz': case 'timestamp': return 'now()';
    case 'bool': return 'false';
    case 'jsonb': case 'json': return `'{}'`;
    case 'bytea': return `'\\x00'`;
    case 'interval': return `'1 day'`;
    case 'time': case 'timetz': return `'09:00'`;
    case 'inet': return `'127.0.0.1'`;
    case 'daterange': return `'[2026-01-01,2026-01-02)'`;
    default: return 'null';
  }
}

// ── evaluation helpers ─────────────────────────────────────────────────────────────────────────────────
export class Rollback extends Error {}
/** Run `fn` in an owner transaction with the context's GUCs set exactly as withTenant sets them, then roll back. */
export async function inCtx<T>(ctx: Ctx, fn: (tx: typeof pg) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await pg.begin(async (tx) => {
      await tx.unsafe(
        `select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.roles', $3, true), set_config('app.grants', $4, true)`,
        [ctx.tenantId, ctx.userId, ctx.roles.join(','), JSON.stringify(ctx.grants)],
      );
      out = await fn(tx as unknown as typeof pg);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out as T;
}
export const sorted = (xs: unknown) => [...((xs as string[] | null) ?? [])].map(String).sort();

export async function setBasedVsPerRow(ctx: Ctx) {
  return inCtx(ctx, async (tx) => {
    await tx.unsafe(`set local role ai_hr_app`);
    const [r] = (await tx.unsafe(
      `select app.visible_employment_ids() as set_emp,
              array(select x from unnest($1::uuid[]) x where app.can_see_employment(x)) as row_emp,
              app.visible_person_ids() as set_person,
              array(select x from unnest($2::uuid[]) x
                    where (select app.is_admin()) or x = any ((select app.visible_person_ids())::uuid[])) as new_person,
              array(select x from unnest($2::uuid[]) x where app.can_see_person(x)) as row_person`,
      [ALL_EMP, ALL_PERSON],
    )) as unknown as Row[];
    return {
      setEmp: r.set_emp as string[] | null,
      rowEmp: sorted(r.row_emp),
      setPerson: r.set_person as string[] | null,
      newPerson: sorted(r.new_person),
      rowPerson: sorted(r.row_person),
    };
  });
}

export const nameOf = (id: string) => Object.entries(E).find(([, v]) => v === id)?.[0] ?? Object.entries(P).find(([, v]) => v === id)?.[0] ?? id;
export const visibleNames = async (ctx: Ctx) => sorted((await setBasedVsPerRow(ctx)).setEmp).map(nameOf).sort();
export const ctxByName = (n: string) => {
  const c = CONTEXTS.find((x) => x.name === n);
  if (!c) throw new Error(`no context ${n}`);
  return c;
};

/** Statement builders per filled table: (employment row, index, nullPolicyCol) → INSERT text, or null. */
export const BUILDERS = new Map<string, (e: Row, i: number, nullPolicyCol: boolean) => Promise<string | null>>();
export let EMPS: Row[] = [];

/** Seed the org, fill every rewritten table, and check the filler left the org alone. */
export async function setupOrg() {
  await resetDb();
  await seedOrg();
  // Which tables have a tenant_id (for picking referenced rows).
  for (const r of await q(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id'`)) {
    tenantTables.add(r.table_name as string);
  }
  await fillTables();
  const empAfter = (await q(`select id from employment where tenant_id in ($1, $2) order by id`, [b.tenantId, T2])).map((r) => r.id as string);
  const personAfter = (await q(`select id from person where tenant_id in ($1, $2) order by id`, [b.tenantId, T2])).map((r) => r.id as string);
  if (empAfter.length !== ALL_EMP.length || personAfter.length !== ALL_PERSON.length) throw new Error('the filler changed the org');
}
