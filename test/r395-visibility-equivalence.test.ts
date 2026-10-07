/**
 * r395 / migration 0515 — SET-BASED visibility is EXACTLY the per-row visibility it replaced.
 *
 * 0515 rewrote 57 policy USING clauses from `app.can_see_employment(X)` / `app.can_see_person(X)` (per row)
 * to `X = ANY ((SELECT app.visible_employment_ids())::uuid[])` / `…visible_person_ids()…` (once per
 * statement). This file is the proof that nobody sees one row more or one row less.
 *
 * THE ORG (seeded below, every edge named in a comment): companies A ⊃ A1 ⊃ A2 and an unrelated B; a
 * 4-level administrative chain ceo → mid → leaf → leaf2 with a TERMINATED intermediate manager (midT) who
 * still holds a live line; a SUPERSEDED, an EXPIRED, a valid-to-TODAY, a FUTURE-dated, a FUNCTIONAL and a
 * DELEGATE line; company-clamp cases both ways (A manager → A1 report is in, A1 manager → A report is out,
 * A manager → B report is out); a department tree with an HOD, a sub-department, an A1 sub-department, a
 * B department under it (per-hop clamp: it AND its A-company child are out), a terminated, a
 * past-assigned and a superseded-assigned member; an HOD whose only line has expired (no HOD view); a
 * REHIRED person (terminated employment in A that still manages a line, active employment in B that
 * manages a line); a person with two ACTIVE employments (A and A1); a terminated employee with a login; a
 * login with no person; and a SECOND TENANT whose ids are in the universe of every check.
 *
 * THE CONTEXTS (GUCs app.tenant_id / app.user_id / app.roles / app.grants, set exactly as db/client.ts
 * withTenant sets them, then SET ROLE ai_hr_app — the NOBYPASSRLS application role): see CONTEXTS.
 *
 * THE CHECKS, for every context:
 *   (i)   app.visible_employment_ids() as a set = { e : app.can_see_employment(e) } over every employment
 *         of BOTH tenants.
 *   (ii)  { p : (SELECT app.is_admin()) OR p = ANY (app.visible_person_ids()) } — the policies' person form —
 *         = { p : app.can_see_person(p) } over every person of both tenants, exactly (admins included).
 *   (iii) for EVERY table 0515 touched:
 *         (a) per policy, as the owner with the same GUCs, the rows `WHERE <old USING>` selects = the rows
 *             `WHERE <new USING>` selects — the old and new texts are test/fixtures/r395-policy-quals.json,
 *             generated from pg_policies before and after 0515;
 *         (b) as the APP ROLE, the rows visible through the live (new) policies = the rows visible after
 *             putting all 57 OLD USING clauses back inside the same transaction (then rolled back). (b) is
 *             the whole-system statement — it includes the other policies on each table and RLS inside
 *             each policy's sub-selects — which (a) alone could not make: a table with several permissive
 *             policies (toil_accrual has 3), or a qual whose EXISTS reads an RLS table (pay_period reads
 *             payroll_batch and payslip), does not show the app role "the rows the qual selects as owner".
 *   Tables are filled generically (one row per employment of both tenants, plus a NULL-subject row where
 *   the policy column is nullable), and the test PRINTS which tables got rows and which stayed empty.
 *
 * NON-VACUITY: four mutations of visible_employment_ids (drop the HOD arm; drop the manager arm's company
 * clamp; ignore reporting_line.valid_to; ignore terminated_on) must each break (i). Always-on tests assert
 * that; `R395_MUTATION=hod|clamp|valid_to|terminated` additionally installs the mutation for the whole file
 * so the equivalence assertions themselves go red with their names (run the file alone).
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAll } from './harness';
import {
  ALL_EMP, ALL_PERSON, CONTEXTS, MUTATIONS, POLICIES, Rollback, TABLES, TENANT_OF_PERSON, b, ctxByName, fill, inCtx,
  nameOf, pg, q, setBasedVsPerRow, setupOrg, sorted, visibleNames, type Row,
} from './r395-org';

const REPORT: Record<string, unknown> = {};

let originalDef = '';

beforeAll(async () => {
  await setupOrg();
  const [d] = await q(`select pg_get_functiondef('app.visible_employment_ids()'::regprocedure) as def`);
  originalDef = d.def as string;
  const m = process.env.R395_MUTATION;
  if (m) {
    if (!MUTATIONS[m]) throw new Error(`unknown R395_MUTATION ${m}`);
    await q(MUTATIONS[m](originalDef));
  }
}, 240_000);

afterAll(async () => {
  if (process.env.R395_MUTATION && originalDef) await q(originalDef);
  if (process.env.R395_REPORT) writeFileSync(process.env.R395_REPORT, JSON.stringify({ fill, ...REPORT }, null, 2));
  await closeAll();
});

describe('r395 — the seeded org exercises every branch (expected visibility, by name)', () => {
  it('manager top (ceo): the chain through live lines, clamp-admitted A1, nothing past a terminated manager, no invalid line', async () => {
    const v = await visibleNames(ctxByName('manager top (ceo)'));
    for (const n of ['ceo', 'mid', 'leaf', 'leaf2', 'subco', 'endsTomorrow', 'startsToday']) expect(v, n).toContain(n);
    // midT: a terminated subordinate. underMidT: only reachable through the terminated midT. bemp: company B
    // under an A root. termleaf: terminated. superseded / expired / endsToday / future: not a live line.
    for (const n of ['midT', 'underMidT', 'bemp', 'termleaf', 'superseded', 'expired', 'endsToday', 'future']) expect(v, n).not.toContain(n);
  });
  it('A1 manager: an A2 report is in, an A report is out (the clamp is to the ROOT manager company)', async () => {
    const v = await visibleNames(ctxByName('A1 manager (clamp)'));
    expect(v).toContain('a2sub');
    expect(v).not.toContain('aUnderA1');
  });
  it('HOD: department subtree with the per-hop company clamp; current assignments only; subject termination ignored', async () => {
    const v = await visibleNames(ctxByName('HOD (hod)'));
    for (const n of ['hod', 'hodsub', 'hSub', 'hA1', 'hSubTerminated']) expect(v, n).toContain(n);
    for (const n of ['hB', 'hBA', 'hPast', 'hSuperseded']) expect(v, n).not.toContain(n);
  });
  it('HOD whose only line expired sees neither the department nor the old report', async () => {
    expect(await visibleNames(ctxByName('HOD with only an expired line'))).toEqual(['hodNoLine']);
  });
  it('rehire: both own employments; the active employment manages; the terminated one does not', async () => {
    const v = await visibleNames(ctxByName('rehired manager (terminated A + active B)'));
    expect(v).toEqual(['r1', 'r2', 'rsub2'].sort());
  });
  it('delegate and functional lines grant no visibility; a terminated employee still sees self', async () => {
    expect(await visibleNames(ctxByName('delegate'))).toEqual(['delegate']);
    expect(await visibleNames(ctxByName('functional manager'))).toEqual(['fx']);
    expect(await visibleNames(ctxByName('terminated employee'))).toEqual(['gone']);
    expect(await visibleNames(ctxByName('terminated intermediate manager'))).toEqual(['midT']);
    expect(await visibleNames(ctxByName('two active employments'))).toEqual(['dualA', 'dualA1']);
    expect(await visibleNames(ctxByName('login without a person'))).toEqual([]);
    expect(await visibleNames(ctxByName('no user'))).toEqual([]);
  });
  it('hr_admin scoped to A sees A, A1, A2 and not B; hr_admin scoped to B sees B only (plus none of T2)', async () => {
    const v = await visibleNames(ctxByName('hr_admin scoped to A'));
    for (const n of ['ceo', 'subco', 'a2sub', 'dualA1']) expect(v, n).toContain(n);
    for (const n of ['bemp', 'r2', 'hB', 't2emp']) expect(v, n).not.toContain(n);
    const sb = await visibleNames(ctxByName('hr_admin scoped to B'));
    expect(sb.sort()).toEqual(['bemp', 'hB', 'r2', 'rsub2'].sort());
  });
});

describe('r395 (i)/(ii) — the set functions equal the per-row functions, for every context', () => {
  it('there are enough contexts and a two-tenant universe', () => {
    expect(CONTEXTS.length).toBeGreaterThanOrEqual(24);
    expect(ALL_EMP.length).toBeGreaterThanOrEqual(40);
    expect(ALL_PERSON.length).toBeGreaterThanOrEqual(40);
    expect(ALL_EMP.filter((id) => ['t2boss', 't2emp'].includes(nameOf(id))).length).toBe(2);
  });
  it.each([...Array(24).keys()])('context #%i: visible_employment_ids = can_see_employment, visible_person_ids = can_see_person', async (i) => {
    const ctx = CONTEXTS[i];
    const r = await setBasedVsPerRow(ctx);
    expect(Array.isArray(r.setEmp), `${ctx.name}: visible_employment_ids is never null`).toBe(true);
    expect(Array.isArray(r.setPerson), `${ctx.name}: visible_person_ids is never null`).toBe(true);
    expect(sorted(r.setEmp).map(nameOf), `(i) ${ctx.name}: employment set`).toEqual(r.rowEmp.map(nameOf));
    // (ii) EXACT, over every person of BOTH tenants, no carve-out: the policies' person form
    // `(SELECT app.is_admin()) OR p = ANY (visible_person_ids)` selects exactly what can_see_person does —
    // an admin's other-tenant persons included (can_see_person is TRUE for any id once is_admin()).
    expect(r.newPerson.map(nameOf), `(ii) ${ctx.name}: person set`).toEqual(r.rowPerson.map(nameOf));
    // and the set function itself never carries a person outside the context's tenant.
    const inTenant = new Set(TENANT_OF_PERSON.filter(([, t]) => t === ctx.tenantId).map(([id]) => id));
    expect(sorted(r.setPerson).every((id) => inTenant.has(id)), `(ii) ${ctx.name}: visible_person_ids stays in tenant`).toBe(true);
    (REPORT.contexts ??= {} as Record<string, unknown>);
    (REPORT.contexts as Record<string, unknown>)[ctx.name] = { employments: r.rowEmp.length, persons: r.rowPerson.length };
  });
});

describe('r395 (iii) — every rewritten table shows exactly the same rows', () => {
  it('the fixture lists 57 policies over the tables 0515 rewrote, and the filler put rows in most of them', async () => {
    expect(POLICIES.length).toBe(57);
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      const [r] = await q(`select count(*)::int as n from "${t}" where tenant_id = $1`, [b.tenantId]);
      counts[t] = r.n as number;
    }
    REPORT.rowsInTenant = counts;
    const filled = TABLES.filter((t) => counts[t] > 0);
    const empty = TABLES.filter((t) => counts[t] === 0);
    REPORT.filledTables = filled;
    REPORT.emptyTables = Object.fromEntries(empty.map((t) => [t, fill[t]?.errors ?? []]));
    console.log(`[r395] tables with rows: ${filled.length}/${TABLES.length}; empty: ${JSON.stringify(REPORT.emptyTables)}`);
    expect(empty, "every rewritten table holds rows in the seed").toEqual([]);
  });

  it.each([...Array(24).keys()])('context #%i: (a) old USING = new USING per policy, as owner', async (i) => {
    const ctx = CONTEXTS[i];
    let nonEmpty = 0;
    // (a) per policy, as the owner (no RLS on the sub-selects on EITHER side).
    await inCtx(ctx, async (tx) => {
      for (const p of POLICIES) {
        const [o] = (await tx.unsafe(`select array(select ctid::text from "${p.table}" where ${p.oldQual} order by ctid) as r`)) as unknown as Row[];
        const [n] = (await tx.unsafe(`select array(select ctid::text from "${p.table}" where ${p.newQual} order by ctid) as r`)) as unknown as Row[];
        expect(n.r, `(iii-a) ${ctx.name}: ${p.table}.${p.policy}`).toEqual(o.r);
        if ((o.r as string[]).length) nonEmpty++;
      }
    });
    // Non-vacuity of (a) for the contexts that see anything: some policy selected some row.
    if (!['no user', 'login without a person'].includes(ctx.name)) expect(nonEmpty, `${ctx.name}: some policy selected rows`).toBeGreaterThan(0);
  });

  it.each([...Array(24).keys()])('context #%i: (b) app-role rows identical under old vs new policies', async (i) => {
    const ctx = CONTEXTS[i];
    // (b) as the app role: live policies, then all 57 OLD USING clauses restored in the same transaction.
    const seen: Record<string, number> = {};
    await inCtx(ctx, async (tx) => {
      const read = async () => {
        const out: Record<string, string[]> = {};
        for (const t of TABLES) {
          const [r] = (await tx.unsafe(`select array(select ctid::text from "${t}" order by ctid) as r`)) as unknown as Row[];
          out[t] = r.r as string[];
        }
        return out;
      };
      await tx.unsafe(`set local role ai_hr_app`);
      const after = await read();
      await tx.unsafe(`reset role`);
      for (const p of POLICIES) await tx.unsafe(`alter policy "${p.policy}" on "${p.table}" using (${p.oldQual})`);
      await tx.unsafe(`set local role ai_hr_app`);
      const before = await read();
      for (const t of TABLES) {
        expect(after[t], `(iii-b) ${ctx.name}: ${t}`).toEqual(before[t]);
        seen[t] = before[t].length;
      }
    });
    (REPORT.rowsVisible ??= {} as Record<string, unknown>);
    (REPORT.rowsVisible as Record<string, unknown>)[ctx.name] = seen;
  });
});

describe('r395 — non-vacuity: each mutation of visible_employment_ids breaks (i)', () => {
  it.each(Object.keys(MUTATIONS))('mutation "%s" makes some context differ from can_see_employment', async (m) => {
    if (process.env.R395_MUTATION) return; // the whole file is already mutated
    const broken: string[] = [];
    try {
      await pg.begin(async (tx) => {
        await tx.unsafe(MUTATIONS[m](originalDef));
        for (const ctx of CONTEXTS) {
          await tx.unsafe(
            `select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.roles', $3, true), set_config('app.grants', $4, true)`,
            [ctx.tenantId, ctx.userId, ctx.roles.join(','), JSON.stringify(ctx.grants)],
          );
          const [r] = (await tx.unsafe(
            `select app.visible_employment_ids() as s, array(select x from unnest($1::uuid[]) x where app.can_see_employment(x)) as p`,
            [ALL_EMP],
          )) as unknown as Row[];
          if (JSON.stringify(sorted(r.s)) !== JSON.stringify(sorted(r.p))) broken.push(ctx.name);
        }
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    (REPORT.mutations ??= {} as Record<string, unknown>);
    (REPORT.mutations as Record<string, unknown>)[m] = broken;
    expect(broken.length, `mutation ${m} must be detected`).toBeGreaterThan(0);
  });
  it('the live function is the original after the mutation tests (rolled back)', async () => {
    const [d] = await q(`select pg_get_functiondef('app.visible_employment_ids()'::regprocedure) as def`);
    if (!process.env.R395_MUTATION) expect(d.def).toBe(originalDef);
  });
});
