import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import { afterAll, expect, it } from 'vitest';
import { ACCOUNT_TASK_CLAIM_PREVIEW, HOME_ACCOUNT_TASK_READ, accountTaskStatement, accountTaskStatementSections, readAccountTaskBundle } from '../core/account-task-bundle';
import type { SessionContext, Tx } from '../db/client';
import { withTenant } from '../db/client';
import { createClaimType } from '../packs/claims/service';
import { arrayScope } from './helpers/account-task-scope-array';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

const dialect = new PgDialect();
const modules = { attendance: true, claims: true, performance: true, rewards: true, lifecycle: false };
const scenarios = [
  { name: 'approvals', modules, notices: true },
  { name: 'passive-shell', modules: { ...modules, claims: false }, notices: false },
];
type Row = { principal: boolean; claims: { snapshot: boolean; total: number; items: unknown[] } | null };

afterAll(closeAll);

function taskQuery(tx: Tx, session: SessionContext, scenario: typeof scenarios[number], ids: readonly string[]) {
  const read = { companyIds: ids, personal: false, notices: scenario.notices };
  return accountTaskStatement(accountTaskStatementSections(tx, session, scenario.modules, read), session);
}

function nativeConnection(tx: Tx) {
  return Reflect.get(Reflect.get(tx, 'session'), 'client') as postgres.TransactionSql;
}

async function timed<T>(read: () => PromiseLike<T>) {
  const start = performance.now();
  const value = await read();
  return { value, ms: Math.round(performance.now() - start) };
}

it('preserves task facts with one bound company array across the supported selection widths', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  const foreign = await seedBase();
  for (const code of ['attendance', 'claims', 'performance', 'recruitment', 'rewards', 'lifecycle']) {
    await setModule(base.tenantId, code, 'active');
  }
  const group = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(group.companyIds).toHaveLength(71);
  expect(group.employmentIds).toHaveLength(1000);
  const claimType = await createClaimType(await entitledCtx(base), {
    code: 'ARRAYPLAN', name: 'Fictional task plan array', defaultTaxable: false, requiresReceipt: false,
  });
  await owner.client`
    insert into claim_request (tenant_id, employment_id, claim_type_id, amount, incurred_on, description, status)
    select e.tenant_id, e.id, ${claimType.id}::uuid, '12.50', '2026-02-02', 'Fictional pending claim', 'pending'
    from employment e cross join generate_series(1, 10)
    where e.tenant_id=${base.tenantId}::uuid and e.terminated_on is null
  `;
  await owner.client`analyze claim_request`;

  const [groupId] = group.companyIds;
  const scopes = [1, 2, 17, 35, 71].map(width => ({ width, ids: group.companyIds.slice(0, width) }));
  const results = [];
  for (const scenario of scenarios) {
    const session = group.personas.group;
    const result = await withTenant(session, async tx => {
      const existing = new Set<string>();
      const rewritten = new Set<string>();
      const rewrites = new Set<number>();
      for (let width = 1; width <= group.companyIds.length; width++) {
        const ids = group.companyIds.slice(0, width);
        const compiled = dialect.sqlToQuery(taskQuery(tx, session, scenario, ids));
        const bound = arrayScope(compiled, ids);
        existing.add(compiled.sql);
        rewritten.add(bound.statement);
        rewrites.add(bound.rewritten);
      }
      expect(existing.size).toBe(group.companyIds.length);
      expect(rewritten.size).toBe(1);
      expect(rewrites.size).toBe(1);
      const [statement] = rewritten;
      const timings = [];
      let firstClaimCount: number | undefined;
      let lastClaimCount: number | undefined;
      for (const { width, ids } of [...scopes, { width: 71, ids: [...group.companyIds].reverse() }]) {
        const original = taskQuery(tx, session, scenario, ids);
        const bound = arrayScope(dialect.sqlToQuery(original), ids);
        expect(bound.statement).toBe(statement);
        await tx.execute(sql`set local plan_cache_mode=auto`);
        const control = await timed(() => tx.execute<Row>(original));
        expect(control.value[0]?.principal).toBe(true);
        await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
        const candidate = await timed(() => nativeConnection(tx).unsafe<Row[]>(bound.statement, bound.params, { prepare: true }));
        expect([...candidate.value]).toEqual([...control.value]);
        if (scenario.modules.claims) {
          const claims = candidate.value[0].claims;
          expect(claims?.snapshot).toBe(true);
          if (width === 1) firstClaimCount = claims?.total;
          if (width === 71) {
            if (lastClaimCount !== undefined) expect(claims?.total).toBe(lastClaimCount);
            lastClaimCount = claims?.total;
            expect(claims?.items).toHaveLength(ACCOUNT_TASK_CLAIM_PREVIEW);
          }
        }
        timings.push({ width, baselineMs: control.ms, genericArrayMs: candidate.ms });
      }
      if (scenario.modules.claims) expect(lastClaimCount).toBeGreaterThan(firstClaimCount ?? -1);
      const [prepared] = await tx.execute<{ named: number; generic: number; custom: number }>(sql`
        select count(*)::int as named, sum(generic_plans)::int as generic, sum(custom_plans)::int as custom
        from pg_prepared_statements where statement=${statement}
      `);
      expect(prepared).toEqual({ named: 1, generic: timings.length, custom: 0 });
      return { name: scenario.name, existingShapes: existing.size, arrayShapes: rewritten.size, prepared, timings };
    }, { readOnlySnapshot: true });
    results.push(result);
  }

  const cases = [
    { session: group.personas.multi, ids: group.companyIds, noClaims: false },
    { session: group.personas.single, ids: [group.singleCompanyId], noClaims: false },
    { session: group.personas.single, ids: [groupId, group.singleCompanyId], noClaims: false },
    { session: group.personas.group, ids: [foreign.companyId], noClaims: true },
  ];
  for (const { session, ids, noClaims } of cases) {
    await withTenant(session, async tx => {
      const original = taskQuery(tx, session, scenarios[0], ids);
      const expected = await tx.execute<Row>(original);
      const bound = arrayScope(dialect.sqlToQuery(original), ids);
      await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
      const actual = await nativeConnection(tx).unsafe<Row[]>(bound.statement, bound.params, { prepare: true });
      expect(actual[0]?.principal).toBe(true);
      expect([...actual]).toEqual([...expected]);
      expect(actual[0]?.claims?.total ?? -1).toBe(noClaims ? 0 : Math.max(1, expected[0]?.claims?.total ?? 0));
    }, { readOnlySnapshot: true });
  }

  const session = group.personas.group;
  const home = await readAccountTaskBundle(session, modules);
  const empty = await readAccountTaskBundle(session, modules, { ...HOME_ACCOUNT_TASK_READ, companyIds: [] });
  expect(home?.read.companyIds).toBeUndefined();
  expect(home?.claims?.total).toBeGreaterThan(ACCOUNT_TASK_CLAIM_PREVIEW);
  expect(empty?.read.companyIds).toEqual([]);
  expect(empty?.claims).toEqual({ total: 0, items: [] });

  // Keep the existing owners' SQL for special scopes. An omitted selection is
  // account-wide. An explicitly empty selection is a real filter.
  await withTenant(session, async tx => {
    const texts = new Set<string>();
    for (const { selection, read } of [
      { selection: 'omitted', read: HOME_ACCOUNT_TASK_READ },
      { selection: 'empty', read: { ...HOME_ACCOUNT_TASK_READ, companyIds: [] } },
    ]) {
      const original = accountTaskStatement(accountTaskStatementSections(tx, session, modules, read), session);
      const query = dialect.sqlToQuery(original);
      texts.add(query.sql);
      await tx.execute(sql`set local plan_cache_mode=auto`);
      const expected = await tx.execute<Row>(original);
      expect(expected[0]?.principal).toBe(true);
      expect(expected[0]?.claims?.total).toBe(selection === 'empty' ? 0 : home?.claims?.total);
      await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
      const params = query.params as postgres.ParameterOrJSON<never>[];
      const actual = await nativeConnection(tx).unsafe<Row[]>(query.sql, params, { prepare: true });
      expect([...actual]).toEqual([...expected]);
    }
    expect(texts.size).toBe(2);
  }, { readOnlySnapshot: true });

  console.info('ACCOUNT_TASK_ARRAY_PROFILE', JSON.stringify(results));
  console.info('ACCOUNT_TASK_SPECIAL_SCOPES', JSON.stringify({ omittedClaims: home?.claims?.total, emptyClaims: empty?.claims?.total }));
}, 90000);
