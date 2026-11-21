import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import { afterAll, expect, it } from 'vitest';
import { ACCOUNT_TASK_CLAIM_PREVIEW, accountTaskStatement, accountTaskStatementSections } from '../core/account-task-bundle';
import { createDb, withTenant } from '../db/client';
import { applicationDatabaseUrl } from '../db/pooling';
import { createClaimType } from '../packs/claims/service';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

afterAll(closeAll);

const dialect = new PgDialect();
const modules = { attendance: true, claims: true, performance: true, rewards: true, lifecycle: false };
type Row = { principal: boolean; claims: { snapshot: boolean; total: number; items: unknown[] } };
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

function nativeConnection(tx: Tx) {
  // Inspect the pinned Drizzle/postgres.js integration without adding an escape hatch to the application API.
  return Reflect.get(Reflect.get(tx, 'session'), 'client') as postgres.TransactionSql;
}

async function planCounters(tx: Tx, statement: string) {
  const [counts] = await tx.execute<{ generic: number; custom: number }>(sql`
    select coalesce(sum(generic_plans), 0)::int as generic, coalesce(sum(custom_plans), 0)::int as custom
    from pg_prepared_statements where statement = ${statement}
  `);
  return counts;
}

async function measure<T>(read: () => PromiseLike<T>) {
  const start = performance.now();
  const result = await read();
  return { result, milliseconds: Math.round((performance.now() - start) * 10) / 10 };
}

it('compares plan reuse with the production task statement under live role and scope checks', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  for (const code of ['attendance', 'claims', 'performance', 'recruitment', 'rewards', 'lifecycle']) {
    await setModule(base.tenantId, code, 'active');
  }
  const group = await buildScaleFixture(base, { employments: 1000, events: 0 });
  const claimType = await createClaimType(await entitledCtx(base), {
    code: 'TASKPLAN', name: 'Fictional task planning comparison', defaultTaxable: false, requiresReceipt: false,
  });
  await owner.client`
    insert into claim_request (tenant_id, employment_id, claim_type_id, amount, incurred_on, description, status)
    select e.tenant_id, e.id, ${claimType.id}::uuid, '12.50', '2026-02-02', 'Fictional pending claim', 'pending'
    from employment e cross join generate_series(1, 10)
    where e.tenant_id = ${base.tenantId}::uuid and e.terminated_on is null
  `;
  await owner.client`analyze claim_request`;
  expect(group.companyIds).toHaveLength(71);
  expect(group.employmentIds).toHaveLength(1000);

  const cases = [
    { name: 'group-all', session: group.personas.group, companyIds: [...group.companyIds] },
    { name: 'group-selected', session: group.personas.group, companyIds: [group.singleCompanyId] },
    { name: 'company-hr', session: group.personas.single, companyIds: [group.singleCompanyId] },
  ];
  const receipts = [];
  for (const { name, session, companyIds } of cases) {
    const receipt = await withTenant(session, async tx => {
      const read = { companyIds, personal: false, notices: true };
      const statement = accountTaskStatement(accountTaskStatementSections(tx, session, modules, read), session);
      const query = dialect.sqlToQuery(statement);
      const connection = nativeConnection(tx);
      const params = query.params as postgres.ParameterOrJSON<never>[];
      const [drizzleBackend] = await tx.execute<{ pid: number; mode: string }>(sql`
        select pg_backend_pid() as pid, current_setting('plan_cache_mode') as mode
      `);
      const [nativeBackend] = await connection<{ pid: number }[]>`select pg_backend_pid() as pid`;
      expect(nativeBackend?.pid).toBe(drizzleBackend?.pid);
      expect(drizzleBackend?.mode).toBe('auto');
      await tx.execute(sql`set local jit=off`);
      const before = await planCounters(tx, query.sql);
      const baseline = async () => measure(() => tx.execute<Row>(statement));
      const expected = await baseline();
      expect(expected.result[0]?.principal).toBe(true);
      expect(expected.result[0]?.claims.snapshot).toBe(true);
      expect(expected.result[0]?.claims.total).toBeGreaterThan(ACCOUNT_TASK_CLAIM_PREVIEW);
      expect(expected.result[0]?.claims.items).toHaveLength(ACCOUNT_TASK_CLAIM_PREVIEW);
      expect(await planCounters(tx, query.sql)).toEqual(before);

      await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
      const named = [];
      for (let attempt = 0; attempt < 7; attempt++) {
        const sample = await measure(() => connection.unsafe<Row[]>(query.sql, params, { prepare: true }));
        expect([...sample.result]).toEqual([...expected.result]);
        named.push(sample.milliseconds);
      }
      const after = await planCounters(tx, query.sql);
      expect(after.generic - before.generic).toBe(named.length);
      expect(after.custom).toBe(before.custom);

      await tx.execute(sql`set local plan_cache_mode=auto`);
      const restored = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const sample = await baseline();
        expect([...sample.result]).toEqual([...expected.result]);
        restored.push(sample.milliseconds);
      }
      expect(await planCounters(tx, query.sql)).toEqual(after);
      return {
        name, claimTotal: expected.result[0].claims.total,
        statementShape: createHash('sha256').update(query.sql).digest('hex'),
        baselineMs: [expected.milliseconds, ...restored], namedGenericMs: named,
        genericExecutions: after.generic - before.generic,
      };
    }, { readOnlySnapshot: true });
    receipts.push(receipt);
  }
  expect(receipts[0].claimTotal).toBeGreaterThan(receipts[1].claimTotal);
  expect(receipts[1].claimTotal).toBe(receipts[2].claimTotal);

  // Keep one backend while ordinary withTenant transactions install different principal settings.
  const url = new URL(applicationDatabaseUrl(process.env).url);
  url.searchParams.set('application_name', 'aihr-task-plan-identity-replay');
  const isolated = createDb(url.href, { max: 1 });
  const identityReplay = [];
  try {
    for (const session of [group.personas.group, group.personas.single, group.personas.group]) {
      const sample = await isolated.withTenant(session, async tx => {
        const read = { companyIds: group.companyIds, personal: false, notices: true };
        const statement = accountTaskStatement(accountTaskStatementSections(tx, session, modules, read), session);
        const query = dialect.sqlToQuery(statement);
        await tx.execute(sql`set local jit=off`);
        const [transaction] = await tx.execute<{ pid: number; mode: string }>(sql`
          select pg_backend_pid() as pid, current_setting('plan_cache_mode') as mode
        `);
        expect(transaction.mode).toBe('auto');
        const expected = await tx.execute<Row>(statement);
        expect(expected[0]?.principal).toBe(true);
        const before = await planCounters(tx, query.sql);
        await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
        const params = query.params as postgres.ParameterOrJSON<never>[];
        const actual = await nativeConnection(tx).unsafe<Row[]>(query.sql, params, { prepare: true });
        expect([...actual]).toEqual([...expected]);
        const after = await planCounters(tx, query.sql);
        expect(after).toEqual({ generic: before.generic + 1, custom: 0 });
        return { pid: transaction.pid, previousUses: before.generic, claimTotal: actual[0].claims.total };
      }, { readOnlySnapshot: true });
      identityReplay.push(sample);
    }
  } finally {
    await isolated.client.end({ timeout: 5 });
  }
  expect(new Set(identityReplay.map(sample => sample.pid)).size).toBe(1);
  expect(identityReplay.map(sample => sample.previousUses)).toEqual([0, 1, 2]);
  expect(identityReplay.map(sample => sample.claimTotal)).toEqual([
    receipts[0].claimTotal, receipts[2].claimTotal, receipts[0].claimTotal,
  ]);

  // The pooler caches by SQL text even when generic executions bind every company value.
  const planShapeCensus = await withTenant(group.personas.group, async tx => {
    const scenarios = [
      { name: 'approvals', modules, notices: true },
      { name: 'passive-shell', modules: { ...modules, claims: false }, notices: false },
    ];
    return scenarios.map(scenario => {
      const shapes = new Set<string>();
      const session = group.personas.group;
      const queryFor = (companyIds: readonly string[]) => {
        const read = { companyIds, personal: false, notices: scenario.notices };
        return dialect.sqlToQuery(accountTaskStatement(accountTaskStatementSections(tx, session, scenario.modules, read), session));
      };
      for (let count = 1; count <= group.companyIds.length; count++) {
        const ids = group.companyIds.slice(0, count);
        const query = queryFor(ids);
        expect(queryFor([...ids].reverse()).sql).toBe(query.sql);
        shapes.add(query.sql);
      }
      return { name: scenario.name, companySizes: group.companyIds.length, uniqueSqlShapes: shapes.size };
    });
  }, { readOnlySnapshot: true });
  expect(planShapeCensus.every(row => row.uniqueSqlShapes > 1)).toBe(true);
  console.info('ACCOUNT_TASK_PLAN_SHAPES', JSON.stringify(planShapeCensus));

  const directory = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if (directory) writeFileSync(join(directory, 'account-task-prepared-plan-scale.json'), JSON.stringify({
    source: process.env.AIHR_CI_HEAD, companies: group.companyIds.length,
    employments: group.employmentIds.length, receipts,
    identityReplay: identityReplay.map(({ previousUses, claimTotal }) => ({ previousUses, claimTotal })), planShapeCensus,
  }));
}, 120000);
