/**
 * r395 / migration 0515 — the WRITE path is unchanged: every INSERT … RETURNING / UPDATE … RETURNING that
 * worked under the per-row policies still works, and every one that was refused is still refused.
 *
 * WHY THIS FILE EXISTS. The first 0515 put can_see_person's admin arm INSIDE the set (`p = ANY (persons
 * of the tenant)`). Reads were provably identical (test/r395-visibility-equivalence.test.ts), and yet every
 * admin hire failed: `INSERT INTO person … RETURNING` checks the new row against the SELECT policy, the set
 * is computed from the statement's snapshot, and the row being inserted is not in it. 216 suite tests went
 * red. A read-only proof cannot see that, so this one compares WRITES, under (a) the live (new) policies and
 * (b) the52 unaffected OLD USING clauses restored in the same transaction, then rolled back.
 * The five explicit0560/0561 replacements retain their exact current graphs on both sides; changed account-only
 * semantics are separately proved, never asserted equivalent to0515:
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
import { assertTestingFeedbackPolicyGraph,currentFeedbackPolicySnapshot,testingFeedbackHistoricalKeys } from './r395-current-feedback-policies';
import {assertCurrentProfilePolicyGraph,currentProfilePolicySnapshot,profileHistoricalPolicyKey} from './r395-current-profile-policies';
import {
  LIVE_SWAPPABLE_POLICIES, seedLegacyFeedbackParent, BUILDERS, C, CONTEXTS, D, E, EMPS, P, POLICIES, Rollback, T2, b, inCtx, pg, q, setupOrg, type Ctx, type Row,
} from './r395-org';

const OLD_USING = LIVE_SWAPPABLE_POLICIES.map((p) => `alter policy "${p.policy}" on "${p.table}" using (${p.oldQual})`);
let NEW_USING:string[]=[];
const originalLiveUsing=new Map<string,string>();
const WRITE_TABLES = [...new Set(POLICIES.filter((p) => ['ALL', 'INSERT', 'UPDATE'].includes(p.cmd)).map((p) => p.table))].sort();

// Existing UUID-rotated parents may already have their unique child slot occupied. Give the
// additional child subjects explicit empty parents, preserving every original positive/negative case.
const FRESH_SUBJECTS=['freshChildA','freshChildB','freshChildA1'] as const;
const ORIGINAL_FRESH_SUBJECTS=new Set(['freshA','freshB','freshA1']);
const DIRECT_PARENT_TABLES=new Set(['attendance','employment_review','performance_review']);
const POSITIVE_CHILD_TABLES=new Set(['attendance_punch','leave_cancellation_step','leave_request_date',
  'replacement_leave_request_date','employment_review_reminder','loan_repayment','payroll_batch','review_goal']);
const POSITIVE_PARENT_TABLES=['attendance','leave_request','leave_cancellation_request',
  'replacement_leave_request','employment_review','employee_loan','pay_period','performance_review','performance_goal'] as const;
const freshParents=new Map<string,Record<string,string>>();


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
let currentFeedbackPolicies:Row[]=[];
let currentProfilePolicies:Row[]=[];

const SUBJECTS = [
  'ceo', 'mid', 'leaf', 'leaf2', 'subco', 'bemp', 'midT', 'underMidT', 'termleaf', 'expired', 'future', 'hod', 'hodsub',
  'hSub', 'hA1', 'hB', 'hSubTerminated', 'hPast', 'nMember', 'a2sub', 'aUnderA1', 'r1', 'r2', 'rsub1', 'rsub2', 'dualA',
  'dualA1', 'gone', 'delegate', 'payrollPartner', 'perfPartner', 'adminA', 't2emp', 't2boss', 'freshA', 'freshB', 'freshA1', ...FRESH_SUBJECTS,
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
    // ROLLBACK TO retains the named savepoint. Release it after restoring the row state so
    // thousands of comparisons do not accumulate nested subtransactions. No parameters:
    // postgres-js unsafe uses one simple-protocol round trip for both cleanup commands.
    await tx.unsafe(`rollback to savepoint w; release savepoint w`);
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
    expect(await currentFeedbackPolicySnapshot(tx),'0561 graph before write comparison').toEqual(currentFeedbackPolicies);
    expect(await currentProfilePolicySnapshot(tx),'0560 Profile graph before write comparison').toEqual(currentProfilePolicies);
    await tx.unsafe(`set local role ai_hr_app`);
    const after: Outcome[] = [];
    for (const s of stmts) after.push(await attempt(tx, s));
    await tx.unsafe(`reset role`);
    for (const s of OLD_USING) await tx.unsafe(s);
    await tx.unsafe(`set local role ai_hr_app`);
    const before: Outcome[] = [];
    for (const s of stmts) before.push(await attempt(tx, s));
    await tx.unsafe('reset role');
    expect(await currentFeedbackPolicySnapshot(tx),'0561 graph after historical write comparison').toEqual(currentFeedbackPolicies);
    expect(await currentProfilePolicySnapshot(tx),'0560 Profile graph after historical write comparison').toEqual(currentProfilePolicies);
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

/** One isolated fixture per Vitest file; optional reports identify their partition explicitly. */
let registered = false;
export function registerR395WriteFixture(reportLabel: 'primary' | 'secondary' | 'tertiary') {
  if (registered || !['primary','secondary','tertiary'].includes(reportLabel)) throw new Error('One named r395 write fixture per isolated file');
  registered = true;
beforeAll(async () => {
  await setupOrg();
  currentFeedbackPolicies=await assertTestingFeedbackPolicyGraph();
  currentProfilePolicies=await assertCurrentProfilePolicyGraph();
  const live=await q(`select tablename,policyname,qual from pg_policies where schemaname='public' order by tablename,policyname`);
  for(const p of LIVE_SWAPPABLE_POLICIES){
    const row=live.find(r=>r.tablename===p.table&&r.policyname===p.policy);
    expect(row,`${p.table}.${p.policy} current restoration source`).toBeTruthy();
    expect(row!.qual).toBeTypeOf('string');
    originalLiveUsing.set(`${p.table}.${p.policy}`,String(row!.qual));
  }
  // Restore actual current qualifiers, including the approved0540 assessment extension, not old fixture bytes.
  NEW_USING=LIVE_SWAPPABLE_POLICIES.map(p=>`alter policy "${p.policy}" on "${p.table}" using (${originalLiveUsing.get(`${p.table}.${p.policy}`)})`);
  await loadVolatile();
  // FRESH subjects: employments with no generic rows yet, so a write is not masked by a one-per-employment
  // unique constraint. freshA reports to ceo, freshB to r2 (company B), freshA1 sits in the HOD's H_A1.
  for (const [name, co, dept, mgr] of [['freshA', 'A', 'misc', 'ceo'], ['freshB', 'B', 'miscB', 'r2'], ['freshA1', 'A1', 'H_A1', null],
    ['freshChildA','A','misc','ceo'],['freshChildB','B','miscB','r2'],['freshChildA1','A1','H_A1',null]] as const) {
    const [pp] = await q(`insert into person (tenant_id, full_name, primary_email) values ($1, $2, $3) returning id`, [b.tenantId, name, `${name}_${randomUUID().slice(0, 8)}@r395.local`]);
    const [ee] = await q(`insert into employment (tenant_id, person_id, company_id, hired_on) values ($1, $2, $3, '2024-01-01') returning id, tenant_id, person_id, company_id`, [b.tenantId, pp.id, C[co]]);
    await q(`insert into assignment (tenant_id, employment_id, department_id, company_id, employment_type, valid_from) values ($1, $2, $3, $4, 'full_time', '2024-01-01')`, [b.tenantId, ee.id, D[dept], C[co]]);
    if (mgr) await q(`insert into reporting_line (tenant_id, subordinate_employment_id, manager_employment_id, line_type, valid_from) values ($1, $2, $3, 'administrative', '2024-01-01')`, [b.tenantId, ee.id, E[mgr]]);
    E[name] = ee.id as string;
    P[name] = pp.id as string;
    EMPS.push(ee);
    // A valid existing parent lets fresh-subject attachment INSERTs exercise RLS, not a binding error.
    await seedLegacyFeedbackParent(ee);
  }
  // These are fixture-only parent inserts under the ordinary owner; no policy, trigger or
  // uniqueness check is disabled. The cancellation parent binds the fresh leave request; both
  // performance parents name the same subject; the pay period names the same company.
  for(const [index,name] of FRESH_SUBJECTS.entries()){
    const subject=empRow(name),bindings:Record<string,string>={};
    for(const table of POSITIVE_PARENT_TABLES){
      const build=BUILDERS.get(table);expect(build,`positive-control builder ${table}`).toBeTruthy();
      const statement=await build!(subject,2000+index,false,bindings);
      expect(statement,`positive-control parent ${table} for ${name}`).toBeTypeOf('string');
      const [parent]=await q(statement!+' returning *');
      expect(parent.tenant_id,`${table} tenant`).toBe(subject.tenant_id);
      if(Object.hasOwn(parent,'employment_id'))expect(parent.employment_id,`${table} subject`).toBe(subject.id);
      if(Object.hasOwn(parent,'person_id'))expect(parent.person_id,`${table} person`).toBe(subject.person_id);
      if(Object.hasOwn(parent,'company_id'))expect(parent.company_id,`${table} company`).toBe(subject.company_id);
      if(table==='leave_cancellation_request')expect(parent.leave_request_id).toBe(bindings.leave_request);
      bindings[table]=String(parent.id);
    }
    freshParents.set(String(subject.id),bindings);
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
  if (process.env.R395_REPORT) (await import('node:fs')).writeFileSync(process.env.R395_REPORT + '.' + reportLabel + '.json', JSON.stringify(REPORT, null, 2));
  await closeAll();
});

  beforeAll(() => {
    expect(CONTEXTS).toHaveLength(24);
    expect(CONTEXTS[0].name).toBe('employee (leaf2)');
    expect(CONTEXTS[16].name).toBe('hr_admin group-wide');
  });
}

export const compareGenericWriteContext = async (i: number) => {
      const ctx = CONTEXTS[i];
      const stmts: string[] = [];
      const labels: string[] = [];
      for (const t of WRITE_TABLES) {
        const build = BUILDERS.get(t);
        if (build) {
          let k = 0;
          for (const s of SUBJECTS) {
            const subject=empRow(s);
            const sql = await build(subject, 1000 + k++, false,POSITIVE_CHILD_TABLES.has(t)?freshParents.get(String(subject.id)):undefined);
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
        if(ctx.name==='hr_admin group-wide'){
          const match=/^insert (\w+) for (\w+)$/.exec(labels[k]);
          if(match&&((POSITIVE_CHILD_TABLES.has(match[1])&&FRESH_SUBJECTS.includes(match[2] as typeof FRESH_SUBJECTS[number]))
            ||(DIRECT_PARENT_TABLES.has(match[1])&&ORIGINAL_FRESH_SUBJECTS.has(match[2])))){
            expect(before[k],`constraint-valid positive control: ${labels[k]}`).toMatch(/^ok:/);
            expect(after[k],`current-policy positive control: ${labels[k]}`).toMatch(/^ok:/);
          }
        }
        tally('generic', labels[k].split(' for ')[0], before[k]);
      }
    };
export const assertGenericWriteNonVacuity = () => {
    const g = REPORT.generic;
    const inserts = Object.entries(g).filter(([k]) => k.startsWith('insert '));
    const allowed = inserts.filter(([, v]) => v.ok > 0).map(([k]) => k);
    const refused = inserts.filter(([, v]) => v.rlsRefused > 0).map(([k]) => k);
    console.log(`[r395-write] insert tables with an allowed attempt: ${allowed.length}/${inserts.length}; with an RLS refusal: ${refused.length}/${inserts.length}`);
    console.log(`[r395-write] tallies ${JSON.stringify(g)}`);
    expect(allowed.length).toBeGreaterThanOrEqual(40);
    expect(refused.length).toBeGreaterThanOrEqual(40);
    expect(Object.entries(g).filter(([k, v]) => k.startsWith('update ') && v.ok > 0).length).toBeGreaterThanOrEqual(40);
  };
export {OLD_USING,NEW_USING,originalLiveUsing,WRITE_TABLES,ADMIN_IN_SET_FN,ADMIN_IN_SET_USING,
 currentFeedbackPolicies,currentProfilePolicies,attempt,proj,bothWays,empRow,REPORT,tally};
export type {Outcome};
