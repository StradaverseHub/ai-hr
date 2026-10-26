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

import {OLD_USING,NEW_USING,originalLiveUsing,WRITE_TABLES,ADMIN_IN_SET_FN,ADMIN_IN_SET_USING,
 currentFeedbackPolicies,currentProfilePolicies,attempt,proj,bothWays,empRow,REPORT,tally,
 registerR395WriteFixture,compareGenericWriteContext,assertGenericWriteNonVacuity,type Outcome} from './r395-write-fixture';
import {WRITE_CONTEXT_PARTITIONS} from './r395-write-context-partitions.mjs';
registerR395WriteFixture('primary');

describe('r395 write path — setup', () => {
  it('53 rewritten policies admit writes; builders exist for every write table except the hand-written three', () => {
    expect(WRITE_TABLES.length).toBe(53);
    expect(POLICIES).toHaveLength(57);
    expect(LIVE_SWAPPABLE_POLICIES).toHaveLength(52);
    expect(POLICIES.filter(p=>!LIVE_SWAPPABLE_POLICIES.includes(p)).map(p=>`${p.table}.${p.policy}`).sort()).toEqual([...testingFeedbackHistoricalKeys,profileHistoricalPolicyKey].sort());
    expect(CONTEXTS.length).toBe(24);
    expect(ADMIN_IN_SET_USING.length, 'six person policies carry the admin arm').toBe(6);
    const missing = WRITE_TABLES.filter((t) => !BUILDERS.has(t));
    // employment / person / assignment hold the org's real rows and are written by hand below.
    expect(missing.sort()).toEqual(['assignment', 'employment', 'person']);
  });
});

describe('r395 write path — generic INSERT … RETURNING and UPDATE … RETURNING, every table, every context', () => {
  it.each(WRITE_CONTEXT_PARTITIONS.primary)(
    'context #%i: identical outcomes under old and new policies',
    compareGenericWriteContext,
    180_000,
  );

  it('the generic writes are not vacuous: inserts were both allowed and RLS-refused somewhere, and updates returned rows', assertGenericWriteNonVacuity);
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
    expect(await currentFeedbackPolicySnapshot(),'0561 graph before real hire comparison').toEqual(currentFeedbackPolicies);
    expect(await currentProfilePolicySnapshot(),'0560 Profile graph before real hire comparison').toEqual(currentProfilePolicies);
    const after = await hireOutcome(ctxName, co, dept, `${tag}_new`);
    let before = '';
    try {
      for (const s of OLD_USING) await q(s);
      before = await hireOutcome(ctxName, co, dept, `${tag}_old`);
    } finally {
      for (const s of NEW_USING) await q(s);
      if (process.env.R395_WRITE_MUTATION === 'admin_in_set') for (const s of ADMIN_IN_SET_USING) await q(s);
    }
    expect(await currentFeedbackPolicySnapshot(),'0561 graph after real hire restoration').toEqual(currentFeedbackPolicies);
    expect(await currentProfilePolicySnapshot(),'0560 Profile graph after real hire restoration').toEqual(currentProfilePolicies);
    expect(after, `hire as ${ctxName} into ${co}`).toBe(before);
    if (expectHired) expect(after, `hire as ${ctxName} into ${co} succeeds`).toBe('hired');
    else expect(after, `hire as ${ctxName} into ${co} is refused`).toMatch(/^refused:/);
  }, 60_000);
  it('the live policies are restored after the hire swaps', async () => {
    const live = new Map((await q(`select tablename, policyname, qual from pg_policies`)).map((r) => [`${r.tablename}.${r.policyname}`, r.qual]));
    expect(await currentFeedbackPolicySnapshot(),'0561 graph retained after all swaps').toEqual(currentFeedbackPolicies);
    expect(await currentProfilePolicySnapshot(),'0560 Profile graph retained after all swaps').toEqual(currentProfilePolicies);
    if (!process.env.R395_WRITE_MUTATION) for (const p of LIVE_SWAPPABLE_POLICIES) expect(live.get(`${p.table}.${p.policy}`)).toBe(originalLiveUsing.get(`${p.table}.${p.policy}`));
  });
});
