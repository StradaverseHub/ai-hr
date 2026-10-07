/**
 * r395 / migration 0515 — the WRITE path is unchanged: every INSERT … RETURNING / UPDATE … RETURNING that
 * worked under the per-row policies still works, and every one that was refused is still refused.
 *
 * WHY THIS FILE EXISTS. The first 0515 put can_see_person's admin arm INSIDE the set (`p = ANY (persons
 * of the tenant)`). Reads were provably identical (test/r395-visibility-equivalence.test.ts), and yet every
 * admin hire failed: `INSERT INTO person … RETURNING` checks the new row against the SELECT policy, the set
 * is computed from the statement's snapshot, and the row being inserted is not in it. 216 suite tests went
 * red. A read-only proof cannot see that, so this one compares WRITES, under (a) the live (new) policies and
 * (b) all 57 OLD USING clauses restored in the same transaction, then rolled back:
 *
 *   1. per context (24) × every rewritten policy whose command admits INSERT/UPDATE (all 53 ALL policies):
 *      a generic INSERT … RETURNING for each of ~26 subject employments (own, reports, HOD members, other
 *      companies, terminated, the other tenant), and a no-op UPDATE … RETURNING of the whole table — the
 *      outcome (allowed + the returned rows, or refused + the error) must be identical;
 *   2. person INSERT … RETURNING and employment INSERT … RETURNING (into A, A1, A2, B and the other tenant)
 *      for EVERY context;
 *   3. a parent and its child in ONE statement through a data-modifying CTE (person → employment, and
 *      employment → assignment). The application never does this (no `WITH … AS (INSERT|UPDATE|DELETE`
 *      outside db/migrations — searched for r395), so this covers the pattern, not a live caller;
 *   4. the REAL core/org hireEmployee, called through withTenant for admin and non-admin contexts under the
 *      new policies and again with the old USING clauses committed in place (restored in `finally`).
 *
 * NON-VACUITY: `R395_WRITE_MUTATION=admin_in_set` installs the first 0515's form (admin arm folded into
 * visible_person_ids, `p = ANY (set)` in the six person policies) for the whole file; the hire tests and the
 * person INSERT … RETURNING comparisons must then fail by name. An always-on test shows the same refusal
 * inside a rolled-back transaction.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { closeAll, harnessSnapshot } from './harness';
import {
  BUILDERS, C, CONTEXTS, D, E, EMPS, P, POLICIES, Rollback, T2, b, inCtx, pg, q, setupOrg, type Ctx, type Row,
} from './r395-org';

const OLD_USING = POLICIES.map((p) => `alter policy "${p.policy}" on "${p.table}" using (${p.oldQual})`);
const NEW_USING = POLICIES.map((p) => `alter policy "${p.policy}" on "${p.table}" using (${p.newQual})`);
const WRITE_TABLES = [...new Set(POLICIES.filter((p) => ['ALL', 'INSERT', 'UPDATE'].includes(p.cmd)).map((p) => p.table))].sort();

// The first 0515's person form — the defect, re-installable for the mutation run.
const ADMIN_IN_SET_FN = `
CREATE OR REPLACE FUNCTION app.visible_person_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH visible AS (
    SELECT p.id FROM person p WHERE (SELECT app.is_admin()) AND p.tenant_id = app.current_tenant_id()
    UNION
    SELECT u.person_id FROM app_user u WHERE u.id = app.current_user_id() AND u.tenant_id = app.current_tenant_id()
    UNION
    SELECT e.person_id FROM employment e WHERE e.tenant_id = app.current_tenant_id() AND e.id = ANY ((SELECT app.visible_employment_ids())::uuid[])
  )
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL;
$$`;
// Deparsed, the arm reads `( SELECT app.is_admin() AS is_admin) OR ` (person_rls flattens it into a 3-way OR).
const ADMIN_ARM_TEXT = '( SELECT app.is_admin() AS is_admin) OR ';
const ADMIN_IN_SET_USING = POLICIES.filter((p) => p.newQual.includes(ADMIN_ARM_TEXT)).map(
  (p) => `alter policy "${p.policy}" on "${p.table}" using (${p.newQual.replace(ADMIN_ARM_TEXT, '')})`,
);
let originalPersonFn = '';

const SUBJECTS = [
  'ceo', 'mid', 'leaf', 'leaf2', 'subco', 'bemp', 'midT', 'underMidT', 'termleaf', 'expired', 'future', 'hod', 'hodsub',
  'hSub', 'hA1', 'hB', 'hSubTerminated', 'hPast', 'nMember', 'a2sub', 'aUnderA1', 'r1', 'r2', 'rsub1', 'rsub2', 'dualA',
  'dualA1', 'gone', 'delegate', 'payrollPartner', 'perfPartner', 'adminA', 't2emp', 't2boss', 'freshA', 'freshB', 'freshA1',
];

type Outcome = string; // "ok:<sorted returned rows>" or "err:<sqlstate>:<message>"
/** Run one statement under a savepoint, as ai_hr_app; return a comparable outcome; always roll the savepoint back. */
async function attempt(tx: typeof pg, sql: string): Promise<Outcome> {
  await tx.unsafe(`savepoint w`);
  try {
    const rows = (await tx.unsafe(sql)) as unknown as Row[];
    return `ok:${JSON.stringify(rows.map((r) => r.j as string).sort())}`;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    // ids in messages are deterministic (same statement text both sides), so the full message is compared.
    return `err:${err.code}:${err.message}`;
  } finally {
    await tx.unsafe(`rollback to savepoint w`);
  }
}

/** Columns whose value is not reproducible between two identical statements (random / sequence / clock). */
const volatileCols = new Map<string, string[]>();
async function loadVolatile() {
  const rows = await q(`select table_name, column_name, column_default from information_schema.columns where table_schema = 'public'`);
  for (const r of rows) {
    const d = String(r.column_default ?? '');
    if (/gen_random_uuid|uuid_generate|nextval|clock_timestamp|random\(|timeofday/.test(d)) {
      const t = r.table_name as string;
      if (!volatileCols.has(t)) volatileCols.set(t, []);
      volatileCols.get(t)!.push(r.column_name as string);
    }
  }
}
const proj = (t: string) => {
  const v = volatileCols.get(t) ?? [];
  return `(to_jsonb("${t}".*)${v.length ? ` - array[${v.map((c) => `'${c}'`).join(', ')}]` : ''})::text as j`;
};

/** Run the same list of statements under the NEW policies and then the OLD USING clauses; same transaction. */
async function bothWays(ctx: Ctx, stmts: string[]): Promise<{ after: Outcome[]; before: Outcome[] }> {
  return inCtx(ctx, async (tx) => {
    await tx.unsafe(`set local role ai_hr_app`);
    const after: Outcome[] = [];
    for (const s of stmts) after.push(await attempt(tx, s));
    await tx.unsafe(`reset role`);
    for (const s of OLD_USING) await tx.unsafe(s);
    await tx.unsafe(`set local role ai_hr_app`);
    const before: Outcome[] = [];
    for (const s of stmts) before.push(await attempt(tx, s));
    return { after, before };
  });
}

const empRow = (name: string) => EMPS.find((e) => e.id === E[name])!;
const REPORT: Record<string, Record<string, { ok: number; rlsRefused: number; otherError: number }>> = {};
const tally = (bucket: string, key: string, o: Outcome) => {
  REPORT[bucket] ??= {};
  REPORT[bucket][key] ??= { ok: 0, rlsRefused: 0, otherError: 0 };
  if (o.startsWith('ok:')) REPORT[bucket][key].ok++;
  else if (/row-level security|42501/.test(o)) REPORT[bucket][key].rlsRefused++;
  else REPORT[bucket][key].otherError++;
};

beforeAll(async () => {
  await setupOrg();
  await loadVolatile();
  // FRESH subjects: employments with no generic rows yet, so a write is not masked by a one-per-employment
  // unique constraint. freshA reports to ceo, freshB to r2 (company B), freshA1 sits in the HOD's H_A1.
  for (const [name, co, dept, mgr] of [['freshA', 'A', 'misc', 'ceo'], ['freshB', 'B', 'miscB', 'r2'], ['freshA1', 'A1', 'H_A1', null]] as const) {
    const [pp] = await q(`insert into person (tenant_id, full_name, primary_email) values ($1, $2, $3) returning id`, [b.tenantId, name, `${name}_${randomUUID().slice(0, 8)}@r395.local`]);
    const [ee] = await q(`insert into employment (tenant_id, person_id, company_id, hired_on) values ($1, $2, $3, '2024-01-01') returning id, tenant_id, person_id, company_id`, [b.tenantId, pp.id, C[co]]);
    await q(`insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from) values ($1, $2, $3, $4, 'full_time', '2024-01-01')`, [b.tenantId, ee.id, D[dept], C[co]]);
    if (mgr) await q(`insert into reporting_line (tenant_id, subordinate_employment_id, manager_employment_id, line_type, valid_from) values ($1, $2, $3, 'administrative', '2024-01-01')`, [b.tenantId, ee.id, E[mgr]]);
    E[name] = ee.id as string;
    P[name] = pp.id as string;
    EMPS.push(ee);
  }
  const [d] = await q(`select pg_get_functiondef('app.visible_person_ids()'::regprocedure) as def`);
  originalPersonFn = d.def as string;
  if (process.env.R395_WRITE_MUTATION === 'admin_in_set') {
    await q(ADMIN_IN_SET_FN);
    for (const s of ADMIN_IN_SET_USING) await q(s);
  } else if (process.env.R395_WRITE_MUTATION) {
    throw new Error(`unknown R395_WRITE_MUTATION ${process.env.R395_WRITE_MUTATION}`);
  }
}, 240_000);

afterAll(async () => {
  if (process.env.R395_WRITE_MUTATION && originalPersonFn) {
    await q(originalPersonFn);
    for (const s of NEW_USING) await q(s);
  }
  if (process.env.R395_REPORT) (await import('node:fs')).writeFileSync(process.env.R395_REPORT, JSON.stringify(REPORT, null, 2));
  await closeAll();
});

describe('r395 write path — setup', () => {
  it('53 rewritten policies admit writes; builders exist for every write table except the hand-written three', () => {
    expect(WRITE_TABLES.length).toBe(53);
    expect(CONTEXTS.length).toBe(24);
    expect(ADMIN_IN_SET_USING.length, 'six person policies carry the admin arm').toBe(6);
    const missing = WRITE_TABLES.filter((t) => !BUILDERS.has(t));
    // employment / person / assignment hold the org's real rows and are written by hand below.
    expect(missing.sort()).toEqual(['assignment', 'employment', 'person']);
  });
});

describe('r395 write path — generic INSERT … RETURNING and UPDATE … RETURNING, every table, every context', () => {
  it.each([...Array(24).keys()])(
    'context #%i: identical outcomes under old and new policies',
    async (i) => {
      const ctx = CONTEXTS[i];
      const stmts: string[] = [];
      const labels: string[] = [];
      for (const t of WRITE_TABLES) {
        const build = BUILDERS.get(t);
        if (build) {
          let k = 0;
          for (const s of SUBJECTS) {
            const sql = await build(empRow(s), 1000 + k++, false);
            if (!sql) continue;
            stmts.push(`${sql} returning ${proj(t)}`);
            labels.push(`insert ${t} for ${s}`);
          }
        }
        stmts.push(`update "${t}" set tenant_id = tenant_id returning ${proj(t)}`);
        labels.push(`update ${t}`);
      }
      const { after, before } = await bothWays(ctx, stmts);
      for (let k = 0; k < stmts.length; k++) {
        expect(after[k], `${ctx.name}: ${labels[k]}`).toBe(before[k]);
        tally('generic', labels[k].split(' for ')[0], before[k]);
      }
    },
    180_000,
  );

  it('the generic writes are not vacuous: inserts were both allowed and RLS-refused somewhere, and updates returned rows', () => {
    const g = REPORT.generic;
    const inserts = Object.entries(g).filter(([k]) => k.startsWith('insert '));
    const allowed = inserts.filter(([, v]) => v.ok > 0).map(([k]) => k);
    const refused = inserts.filter(([, v]) => v.rlsRefused > 0).map(([k]) => k);
    console.log(`[r395-write] insert tables with an allowed attempt: ${allowed.length}/${inserts.length}; with an RLS refusal: ${refused.length}/${inserts.length}`);
    console.log(`[r395-write] tallies ${JSON.stringify(g)}`);
    expect(allowed.length).toBeGreaterThanOrEqual(40);
    expect(refused.length).toBeGreaterThanOrEqual(40);
    expect(Object.entries(g).filter(([k, v]) => k.startsWith('update ') && v.ok > 0).length).toBeGreaterThanOrEqual(40);
  });
});

describe('r395 write path — person and employment INSERT … RETURNING, every context', () => {
  it.each([...Array(24).keys()])('context #%i: person, employment (A, A1, A2, B, other tenant) and assignment', async (i) => {
    const ctx = CONTEXTS[i];
    const t = b.tenantId;
    const stmts: string[] = [
      `insert into person (tenant_id, full_name, primary_email) values ('${ctx.tenantId}', 'W ${i}', 'w${i}@r395.local') returning ${proj('person')}`,
      `insert into person (tenant_id, full_name, primary_email) values ('${t === ctx.tenantId ? T2 : t}', 'X ${i}', 'x${i}@r395.local') returning ${proj('person')}`,
    ];
    for (const co of ['A', 'A1', 'A2', 'B', 'T2']) {
      const tenant = co === 'T2' ? T2 : t;
      const pid = co === 'T2' ? P.t2emp : P.noEmployment;
      stmts.push(
        `insert into employment (tenant_id, person_id, company_id, hired_on) values ('${tenant}', '${pid}', '${C[co]}', '2025-01-01') returning ${proj('employment')}`,
      );
    }
    for (const s of ['leaf2', 'subco', 'bemp', 'hSub', 'a2sub', 't2emp']) {
      const e = empRow(s);
      const dept = s === 't2emp' ? D.T2 : D.misc;
      stmts.push(
        `insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from, superseded_at)
         values ('${e.tenant_id}', '${e.id}', '${dept}', '${e.company_id}', 'full_time', '2025-06-01', now()) returning ${proj('assignment')}`,
      );
    }
    const { after, before } = await bothWays(ctx, stmts);
    for (let k = 0; k < stmts.length; k++) {
      expect(after[k], `${ctx.name}: ${stmts[k].slice(0, 60)}`).toBe(before[k]);
      tally('handwritten', stmts[k].split(' (')[0], before[k]);
    }
    const isAdmin = ctx.grants.some((g) => g.role === 'hr_admin' || g.role === 'super_admin');
    // The case that broke: an admin's own-tenant person INSERT … RETURNING is ALLOWED.
    if (isAdmin) {
      expect(after[0], `${ctx.name}: admin person INSERT … RETURNING`).toMatch(/^ok:/);
      expect(after.slice(2, 7).some((o) => o.startsWith('ok:')), `${ctx.name}: admin employment INSERT … RETURNING allowed somewhere`).toBe(true);
    }
  });

  it('every admin context inserted an employment with RETURNING in at least one company, under both policy sets', () => {
    const h = REPORT.handwritten['insert into employment'];
    expect(h.ok).toBeGreaterThan(0);
    expect(h.rlsRefused).toBeGreaterThan(0);
  });
});

describe('r395 write path — parent and child in ONE statement (data-modifying CTE)', () => {
  it.each([...Array(24).keys()])('context #%i: person→employment and employment→assignment CTEs', async (i) => {
    const ctx = CONTEXTS[i];
    const t = ctx.tenantId;
    const co = t === T2 ? C.T2 : C.A;
    const dept = t === T2 ? D.T2 : D.misc;
    const pid = t === T2 ? P.t2emp : P.noEmployment;
    const stmts = [
      `with p as (insert into person (tenant_id, full_name, primary_email) values ('${t}', 'CTE ${i}', 'cte${i}@r395.local') returning id)
       insert into employment (tenant_id, person_id, company_id, hired_on) select '${t}', p.id, '${co}', '2025-01-01' from p
       returning (to_jsonb(employment.*) - array['id', 'person_id'])::text as j`, // person_id: the CTE's fresh (random) person id
      `with e as (insert into employment (tenant_id, person_id, company_id, hired_on) values ('${t}', '${pid}', '${co}', '2025-01-01') returning id)
       insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from)
       select '${t}', e.id, '${dept}', '${co}', 'full_time', '2025-01-01' from e returning ${proj('assignment')}`,
      `with p as (insert into person (tenant_id, full_name, primary_email) values ('${t}', 'CTE2 ${i}', 'cte2${i}@r395.local') returning ${proj('person')})
       select j from p`,
    ];
    const { after, before } = await bothWays(ctx, stmts);
    for (let k = 0; k < stmts.length; k++) {
      expect(after[k], `${ctx.name}: CTE #${k}`).toBe(before[k]);
      tally('cte', `cte#${k}`, before[k]);
    }
  });
});

describe('r395 write path — non-vacuity: the first 0515 form refuses an admin person INSERT … RETURNING', () => {
  it('admin_in_set (rolled back): refused; live form: allowed', async () => {
    if (process.env.R395_WRITE_MUTATION) return; // the whole file is already mutated
    const admin = CONTEXTS.find((c) => c.name === 'hr_admin group-wide')!;
    const ins = `insert into person (tenant_id, full_name, primary_email) values ('${admin.tenantId}', 'NV', 'nv@r395.local') returning id::text as j`;
    let mutated: Outcome = '';
    let live: Outcome = '';
    try {
      await pg.begin(async (tx) => {
        await tx.unsafe(
          `select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.roles', $3, true), set_config('app.grants', $4, true)`,
          [admin.tenantId, admin.userId, admin.roles.join(','), JSON.stringify(admin.grants)],
        );
        await tx.unsafe(`set local role ai_hr_app`);
        live = await attempt(tx as unknown as typeof pg, ins);
        await tx.unsafe(`reset role`);
        await tx.unsafe(ADMIN_IN_SET_FN);
        for (const s of ADMIN_IN_SET_USING) await tx.unsafe(s);
        await tx.unsafe(`set local role ai_hr_app`);
        mutated = await attempt(tx as unknown as typeof pg, ins);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    expect(live).toMatch(/^ok:/);
    expect(mutated).toMatch(/row-level security policy for table "person"/);
  });
});

describe('r395 write path — the REAL hireEmployee, new policies vs old USING clauses committed in place', () => {
  const HIRE_CASES: [string, string, string, boolean][] = [
    // context, company key, department key, expected to hire
    ['hr_admin group-wide', 'A', 'misc', true],
    ['super_admin group-wide', 'B', 'miscB', true],
    ['hr_admin scoped to A', 'A1', 'miscA1', true],
    ['hr_admin scoped to A1', 'A1', 'miscA1', true],
    ['hr_admin scoped to A1', 'A', 'misc', false], // out of scope
    ['hr_admin scoped to B', 'B', 'miscB', true],
    ['manager + hr_admin(B)', 'B', 'miscB', true],
    ['manager + hr_admin(B)', 'A', 'misc', false], // out of scope
    ['employee (leaf2)', 'A', 'misc', false],
    ['manager top (ceo)', 'A', 'misc', false],
    ['payroll_partner (A)', 'A', 'misc', false],
  ];
  const hireOutcome = async (ctxName: string, co: string, dept: string, tag: string): Promise<string> => {
    const c = CONTEXTS.find((x) => x.name === ctxName)!;
    try {
      const r = await hireEmployee(
        { tenantId: c.tenantId, userId: c.userId, roles: c.roles, grants: c.grants, entitlements: harnessSnapshot(c.tenantId) },
        {
          person: { fullName: `Hire ${tag}`, primaryEmail: `hire_${tag}_${randomUUID().slice(0, 8)}@r395.local` },
          companyId: C[co],
          departmentId: D[dept],
          employmentType: 'full_time',
          hiredOn: '2025-01-01',
        },
      );
      return r?.employmentId ? 'hired' : `no employment id: ${JSON.stringify(r)}`;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      const cause = String(((e as { cause?: Error }).cause?.message) ?? '');
      // Strip the drizzle "Failed query: …" parameter list (it carries the fresh email); keep the reason.
      return `refused: ${(e as Error).name}: ${cause || msg.split('\nparams:')[0].slice(0, 200)}`;
    }
  };
  it.each(HIRE_CASES)('hireEmployee as %s into %s: same outcome under new and old policies', async (ctxName, co, dept, expectHired) => {
    const tag = `${ctxName}-${co}`.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const after = await hireOutcome(ctxName, co, dept, `${tag}_new`);
    let before = '';
    try {
      for (const s of OLD_USING) await q(s);
      before = await hireOutcome(ctxName, co, dept, `${tag}_old`);
    } finally {
      for (const s of NEW_USING) await q(s);
      if (process.env.R395_WRITE_MUTATION === 'admin_in_set') for (const s of ADMIN_IN_SET_USING) await q(s);
    }
    expect(after, `hire as ${ctxName} into ${co}`).toBe(before);
    if (expectHired) expect(after, `hire as ${ctxName} into ${co} succeeds`).toBe('hired');
    else expect(after, `hire as ${ctxName} into ${co} is refused`).toMatch(/^refused:/);
  }, 60_000);
  it('the live policies are restored after the hire swaps', async () => {
    const live = new Map((await q(`select tablename, policyname, qual from pg_policies`)).map((r) => [`${r.tablename}.${r.policyname}`, r.qual]));
    if (!process.env.R395_WRITE_MUTATION) for (const p of POLICIES) expect(live.get(`${p.table}.${p.policy}`)).toBe(p.newQual);
  });
});
