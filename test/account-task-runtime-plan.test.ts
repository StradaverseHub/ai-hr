import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, expect, it } from 'vitest';
import { accountTaskStatement, accountTaskStatementSections, readAccountTaskBundle } from '../core/account-task-bundle';
import { createDb, type SessionContext, type Tx } from '../db/client';
import { isSharedCarrierTransaction } from '../db/shared-read';
import { applicationDatabaseUrl } from '../db/pooling';
import { createClaimType } from '../packs/claims/service';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

afterAll(closeAll);

const dialect = new PgDialect();
const modules = { attendance: true, claims: true, performance: true, rewards: true, lifecycle: false };
type Row = { principal: boolean; claims: { total: number; items: unknown[] } };

const statementFor = (tx: Tx, session: SessionContext, companyIds?: readonly string[]) => accountTaskStatement(
  accountTaskStatementSections(tx, session, modules, { companyIds, personal: false, notices: true }), session,
);

it('uses the production prepared reader across company widths and retains transaction-local authority', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  for (const code of ['attendance', 'claims', 'performance', 'rewards']) {
    await setModule(base.tenantId, code, 'active');
  }
  const fixture = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);
  const session = fixture.personas.group;
  const type = await createClaimType(session, {
    code: 'RUNTIMETASKPLAN', name: 'Fictional runtime plan proof', defaultTaxable: false, requiresReceipt: false,
  });
  await owner.client`
    insert into claim_request (tenant_id, employment_id, claim_type_id, amount, incurred_on, description, status)
    select tenant_id,id,${type.id}::uuid,'1.00','2026-02-02','Fictional pending claim','pending'
    from employment where tenant_id=${base.tenantId}::uuid and terminated_on is null
  `;

  const url = new URL(applicationDatabaseUrl(process.env).url);
  url.searchParams.set('application_name', 'aihr-account-runtime-plan-test');
  const isolated = createDb(url.toString(), { max: 1 });
  try {
    const shape = await isolated.withTenant(session, async tx => {
      const texts = fixture.companyIds.map((_, index) =>
        dialect.sqlToQuery(statementFor(tx, session, fixture.companyIds.slice(0, index + 1))).sql);
      expect(new Set(texts).size).toBe(1);
      return texts[0];
    });
    const selection = [fixture.companyIds[0]];
    const read = (context: SessionContext, ids: readonly string[]) =>
      isolated.readPreparedTenantRows<Row>(context, tx => statementFor(tx, context, ids));
    const [all] = await read(session, fixture.companyIds);
    const [one] = await read(session, selection);
    const [scoped] = await read(fixture.personas.single, fixture.companyIds);
    expect([all.principal, one.principal, scoped.principal]).toEqual([true, true, true]);
    expect(all.claims.total).toBeGreaterThan(one.claims.total);
    expect(one.claims.total).toBeGreaterThan(0);
    const [scopedOwn] = await read(fixture.personas.single, [fixture.singleCompanyId]);
    expect(scopedOwn).toEqual(scoped);
    const [plan] = await isolated.withTenant(session, tx => tx.execute<{ generic: number; mode: string }>(sql`
      select sum(generic_plans)::int as generic, current_setting('plan_cache_mode') as mode
      from pg_prepared_statements where statement=${shape}
    `));
    expect(plan).toEqual({ generic: 4, mode: 'auto' });

    await isolated.withSharedReadSnapshot(session, async () => {
      const [result] = await isolated.readPreparedTenantRows<Row>(session, tx => {
        expect(isSharedCarrierTransaction(tx)).toBe(true);
        return statementFor(tx, session, selection);
      });
      expect(result).toEqual(one);
      const [settings] = await isolated.withTenant(session, tx =>
        tx.execute<{ mode: string }>(sql`select current_setting('plan_cache_mode') as mode`));
      expect(settings.mode).toBe('auto');
    });

    // The signed-in shell reads this shape with Claims disabled inside a shared carrier.
    // Compare automatic and forced planning on separate connections so one mode cannot warm the other.
    url.searchParams.set('application_name', 'aihr-account-shell-generic-plan-test');
    const forced = createDb(url.toString(), { max: 1 });
    const samples = Array.from({ length: 24 }, (_, index) => ({
      actor: [session, fixture.personas.multi, fixture.personas.single][index % 3],
      companyIds: fixture.companyIds.slice(0, [1, 17, 35, 71][index % 4]),
    }));
    const shellModules = { ...modules, claims: false };
    const shellShapes = new Set<string>();
    const planCounts = async (database: typeof isolated) => database.withTenant(session, async tx => {
      const [counts] = await tx.execute<{ generic: number; custom: number; shapes: number }>(sql`
        select coalesce(sum(generic_plans),0)::int as generic, coalesce(sum(custom_plans),0)::int as custom,
          count(*)::int as shapes
        from pg_prepared_statements where statement in (${sql.join([...shellShapes].map(shape => sql`${shape}`), sql`, `)})
      `);
      return counts;
    });
    const shellTimes = { carrier: [] as number[], standalone: [] as number[] };
    try {
      for (const { actor, companyIds } of samples) {
        const shellStatement = (tx: Tx) => accountTaskStatement(accountTaskStatementSections(tx, actor,
          shellModules, { companyIds, personal: false, notices: true }), actor);
        const carrierStarted = performance.now();
        const shared = await isolated.withSharedReadSnapshot(actor, () =>
          isolated.readPreparedTenantRows<Row>(actor, tx => {
            expect(isSharedCarrierTransaction(tx)).toBe(true);
            const statement = shellStatement(tx);
            shellShapes.add(dialect.sqlToQuery(statement).sql);
            return statement;
          }));
        shellTimes.carrier.push(Math.round(performance.now() - carrierStarted));
        const standaloneStarted = performance.now();
        const standalone = await forced.readPreparedTenantRows<Row>(actor, shellStatement);
        shellTimes.standalone.push(Math.round(performance.now() - standaloneStarted));
        expect(shared[0]?.principal).toBe(true);
        expect([...shared]).toEqual([...standalone]);
      }
      const [auto, generic] = await Promise.all([planCounts(isolated), planCounts(forced)]);
      expect(auto.generic + auto.custom).toBe(samples.length);
      expect(generic).toEqual({ generic: samples.length, custom: 0, shapes: shellShapes.size });
      const p95 = (durations: number[]) => durations.sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1];
      console.info(JSON.stringify({ shellPlanComparison: { auto, generic,
        carrierP95Ms: p95(shellTimes.carrier), standaloneP95Ms: p95(shellTimes.standalone) } }));
    } finally {
      await forced.client.end({ timeout: 5 });
    }

    const readOptions = { personal: false, notices: true };
    expect((await readAccountTaskBundle(session, modules, { ...readOptions, companyIds: [] }))?.claims?.total).toBe(0);
    expect((await readAccountTaskBundle(session, modules, readOptions))?.claims?.total).toBe(all.claims.total);
  } finally {
    await isolated.client.end({ timeout: 5 });
  }
}, 90_000);
