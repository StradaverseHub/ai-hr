/**
 * The web application's database path through a real PgBouncer in transaction mode.
 *
 * withTenant sets RLS GUCs as transaction-local settings, so a pooled server connection handed to the
 * next client must carry nothing of the previous tenant. Every test here runs with far more clients than
 * server connections, so that server connections really are shared between tenants.
 */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {DatabaseAdmissionError} from '../db/admission';
import {createDb, type SessionContext} from '../db/client';
import {actorOf, appendEvent} from '../db/events';
import {adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base} from './harness';
import {isDatabaseCapacityFailure} from '../db/read-retry';
import {POOLER_PREPARED_STATEMENT_LIMIT, poolerTarget, SHORT_WAIT_POOLER, type PoolerTarget} from './helpers/pgbouncer-target';
import {ACCOUNT_TASK_CLAIM_PREVIEW, accountTaskStatement, accountTaskStatementSections, readAccountTaskBundle} from '../core/account-task-bundle';
import {assignRole, revokeRole} from '../core/admin';
import {createClaimType} from '../packs/claims/service';
import {arrayScope} from './helpers/account-task-scope-array';
import {buildScaleFixture} from './helpers/ai-centre-scale-fixture';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; };
const appPool = (target: PoolerTarget, max: number, admissionWaitMs?: number) => {
  const url = new URL(target.appUrl);
  url.searchParams.set('application_name', 'pooler-' + randomUUID());
  return createDb(url.toString(), {max, ...(admissionWaitMs === undefined ? {} : {admissionWaitMs})});
};

let target: PoolerTarget | null = null;
let a: Base;
let b: Base;

/** Backends the app role holds on this worker database right now, seen from a direct owner connection. */
async function appBackends(): Promise<number> {
  const database = new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1);
  const [row] = await owner.client<{n: number}[]>`select count(*)::int as n from pg_stat_activity where datname = ${database} and usename = 'ai_hr_app'`;
  return row.n;
}

const available = await (async () => { target = await poolerTarget(); return target !== null; })();
let shortWait: PoolerTarget | null = null;
const shortWaitAvailable = available && await (async () => { shortWait = await poolerTarget(SHORT_WAIT_POOLER); return shortWait !== null; })();

describe.skipIf(!available)('web transactions through PgBouncer transaction pooling', () => {
  beforeAll(async () => {
    process.env.AUDIT_HASH_CHAIN_ENABLED = 'true';
    await migrateTestDb();
    await resetDb();
    a = await seedBase();
    b = await seedBase();
  });
  afterAll(async () => {
    delete process.env.AUDIT_HASH_CHAIN_ENABLED;
    target?.stop();
    shortWait?.stop();
    await closeAll();
  });

  it('logs in as the application role, keeping its row-level security', async () => {
    const pool = appPool(target!, 2);
    try {
      const [row] = await pool.client<{usr: string; sess: string; bypass: boolean}[]>`
        select current_user as usr, session_user as sess, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
      expect(row).toEqual({usr: 'ai_hr_app', sess: 'ai_hr_app', bypass: false});
      // With no tenant set, RLS shows nothing, whichever server connection this statement landed on.
      const [counted] = await pool.client<{n: number}[]>`select count(*)::int as n from company`;
      expect(counted.n).toBe(0);
    } finally { await pool.client.end({timeout: 5}); }
  });

  it('never lets one tenant see another tenant across multiplexed server connections', async () => {
    const pool = appPool(target!, 16);
    const contexts: [SessionContext, string][] = [[adminCtx(a), a.tenantId], [adminCtx(b), b.tenantId]];
    let checks = 0;
    try {
      await Promise.all(Array.from({length: 240}, (_, index) => {
        const [ctx, tenantId] = contexts[index % 2];
        return pool.withTenant(ctx, async tx => {
          const [settings] = await tx.execute(sql`select current_setting('app.tenant_id', true) as tenant, current_setting('app.user_id', true) as usr, current_setting('jit') as jit`) as unknown as {tenant: string; usr: string; jit: string}[];
          // JIT is off inside every tenant transaction (db/client.ts bootstrapTenantTx), on whichever server connection.
          expect(settings).toEqual({tenant: tenantId, usr: ctx.userId, jit: 'off'});
          const visible = await tx.execute(sql`select distinct tenant_id::text as tenant from company`) as unknown as {tenant: string}[];
          expect(visible).toEqual([{tenant: tenantId}]);
          checks++;
        });
      }));
      expect(checks).toBe(240);
    } finally { await pool.client.end({timeout: 5}); }
  });

  it('leaves no tenant setting behind after commit or rollback, on any reused server connection', async () => {
    const pool = appPool(target!, 12);
    const failure = new Error('fictional rollback');
    const backends = new Set<number>();
    try {
      // The server's own JIT setting, before any tenant transaction switched it off for itself.
      const [server] = await pool.client<{jit: string}[]>`select current_setting('jit') as jit`;
      for (let round = 0; round < 20; round++) {
        await Promise.all(Array.from({length: 12}, async (_, worker) => {
          const ctx = worker % 2 ? adminCtx(a) : adminCtx(b);
          // Half of the transactions commit and half roll back; neither may leave the GUC set.
          await pool.withTenant(ctx, async tx => {
            await tx.execute(sql`select 1`);
            if (worker % 3 === 0) throw failure;
          }).catch(error => { if (error !== failure) throw error; });
          const [after] = await pool.client<{tenant: string | null; pid: number; jit: string}[]>`select current_setting('app.tenant_id', true) as tenant, pg_backend_pid() as pid, current_setting('jit') as jit`;
          backends.add(after.pid);
          expect(after.tenant ?? '').toBe('');
          // Transaction-local like the identity: the next client on this server connection has the server's JIT setting.
          expect(after.jit).toBe(server.jit);
        }));
      }
      // Twelve clients ran on no more than the configured server connections.
      expect(backends.size).toBeGreaterThan(0);
      expect(backends.size).toBeLessThanOrEqual(target!.serverConnections);
    } finally { await pool.client.end({timeout: 5}); }
  });

  it('reuses one array-scoped task plan across pooled clients, scopes and backend recovery', async () => {
    const tenant = await seedBase();
    const otherTenant = await seedBase();
    for (const base of [tenant, otherTenant]) {
      for (const module of ['attendance', 'claims', 'performance', 'rewards']) {
        await setModule(base.tenantId, module, 'active');
      }
    }
    const fixture = await buildScaleFixture(tenant, {employments: 1000, events: 0});
    expect(fixture.companyIds).toHaveLength(71);
    expect(fixture.employmentIds).toHaveLength(1000);
    const claimType = await createClaimType(fixture.personas.group, {
      code: 'POOLEDPLAN', name: 'Fictional pooled task comparison', defaultTaxable: false, requiresReceipt: false,
    });
    await owner.client`
      insert into claim_request (tenant_id, employment_id, claim_type_id, amount, incurred_on, description, status)
      select e.tenant_id, e.id, ${claimType.id}::uuid, '12.50', '2026-02-02', 'Fictional pending claim', 'pending'
      from employment e cross join generate_series(1, 10)
      where e.tenant_id = ${tenant.tenantId}::uuid and e.terminated_on is null
    `;
    await owner.client`analyze claim_request`;

    const modules = {attendance: true, claims: true, performance: true, rewards: true, lifecycle: false};
    const read = {companyIds: fixture.companyIds, personal: false, notices: true};
    const dialect = new PgDialect();
    type TaskRow = {principal: boolean; claims: {snapshot: boolean; total: number}};
    const sessions = [fixture.personas.group, fixture.personas.single, await entitledCtx(otherTenant), fixture.personas.group];
    const clients = sessions.map(() => appPool(shortWait ?? target!, 1));
    const samples = [];
    try {
      for (const [index, session] of sessions.entries()) {
        const sample = await clients[index].withTenant(session, async tx => {
          const companyIds = index === 1 ? [fixture.singleCompanyId] : read.companyIds;
          const scopedRead = {...read, companyIds};
          const statement = accountTaskStatement(accountTaskStatementSections(tx, session, modules, scopedRead), session);
          const query = arrayScope(dialect.sqlToQuery(statement), companyIds);
          const [backend] = await tx.execute<{pid: number; mode: string}>(sql`
            select pg_backend_pid() as pid, current_setting('plan_cache_mode') as mode
          `);
          expect(backend.mode).toBe('auto');
          const unpreparedStart = performance.now();
          const expected = await tx.execute<TaskRow>(statement);
          const unpreparedMs = performance.now() - unpreparedStart;
          expect(expected[0]?.principal).toBe(true);
          expect(expected[0]?.claims.snapshot).toBe(true);
          const planUses = async () => {
            const [counts] = await tx.execute<{uses: number}>(sql`
              select coalesce(sum(generic_plans), 0)::int as uses
              from pg_prepared_statements where statement = ${query.statement}
            `);
            return counts.uses;
          };
          const previousUses = await planUses();
          await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
          // Measure the pinned driver protocol on the same authorized transaction as the normal query.
          const connection = Reflect.get(Reflect.get(tx, 'session'), 'client') as postgres.TransactionSql;
          const preparedStart = performance.now();
          const actual = await connection.unsafe<TaskRow[]>(query.statement, query.params, {prepare: true});
          const preparedMs = performance.now() - preparedStart;
          expect([...actual]).toEqual([...expected]);
          expect(await planUses()).toBe(previousUses + 1);
          return {pid: backend.pid, previousUses, claimTotal: actual[0].claims.total, unpreparedMs, preparedMs};
        }, {readOnlySnapshot: true});
        samples.push(sample);
      }
    } finally {
      await Promise.all(clients.map(client => client.client.end({timeout: 5})));
    }
    expect(new Set(samples.map(sample => sample.pid)).size).toBe(1);
    expect(samples[0].claimTotal).toBeGreaterThan(samples[1].claimTotal);
    expect(samples[1].claimTotal).toBeGreaterThan(ACCOUNT_TASK_CLAIM_PREVIEW);
    expect(samples[1].previousUses).toBe(1);
    expect(samples[2].claimTotal).toBe(0);
    expect(samples[3].claimTotal).toBe(samples[0].claimTotal);
    expect(samples[3].previousUses).toBeGreaterThanOrEqual(2);

    // Run the same SQL with overlapping transactions on the standard three-backend pool.
    // Use separate statement names for the two planning modes and reverse their order in the second pass.
    const primaryScopes = [
      {name: 'group-all', session: fixture.personas.group, scope: read},
      {name: 'group-selected', session: fixture.personas.group, scope: {...read, companyIds: [fixture.singleCompanyId]}},
      {name: 'company', session: fixture.personas.single, scope: read},
      {name: 'foreign', session: sessions[2], scope: read},
    ];
    const otherWidths = [2, 17, 35, 71].map(width => ({
      name: 'group-' + width, session: fixture.personas.group, scope: {...read, companyIds: fixture.companyIds.slice(0, width)},
    }));
    const lanes = [...primaryScopes, ...otherWidths].map(scope => ({...scope, client: appPool(target!, 1)}));
    type Mode = 'unnamed' | 'named-auto' | 'named-generic';
    const prefix = (mode: Mode) => '/* fixture-task-plan-' + mode + ' */ ';
    const concurrentRounds = [];
    let pooledPlanCounts: {backends: number; autoUses: number; forcedUses: number} | undefined;
    try {
      const readTask = (lane: typeof lanes[number], mode: Mode) => lane.client.withTenant(lane.session, async tx => {
        const statement = accountTaskStatement(accountTaskStatementSections(tx, lane.session, modules, lane.scope), lane.session);
        if (mode === 'unnamed') return [...await tx.execute<TaskRow>(statement)];
        if (mode === 'named-generic') await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
        const query = arrayScope(dialect.sqlToQuery(statement), lane.scope.companyIds);
        const connection = Reflect.get(Reflect.get(tx, 'session'), 'client') as postgres.TransactionSql;
        return [...await connection.unsafe<TaskRow[]>(prefix(mode) + query.statement, query.params, {prepare: true})];
      }, {readOnlySnapshot: true});
      const expected = await Promise.all(lanes.map(lane => readTask(lane, 'unnamed')));
      expect(expected.slice(0, 4).map(rows => rows[0]?.principal)).toEqual([true, true, true, true]);
      expect(expected.slice(0, 4).map(rows => rows[0]?.claims.total)).toEqual([
        samples[0].claimTotal, samples[1].claimTotal, samples[1].claimTotal, 0,
      ]);

      const modes = ['unnamed', 'named-auto', 'named-generic'] as const;
      for (const mode of modes) await Promise.all(lanes.map(lane => readTask(lane, mode)));
      for (const mode of [...modes, ...[...modes].reverse()]) {
        const phaseStarted = performance.now();
        const timings = [];
        for (let round = 0; round < 4; round++) {
          timings.push(...await Promise.all(lanes.map(async (lane, index) => {
            const started = performance.now();
            const result = await readTask(lane, mode);
            const elapsedMs = performance.now() - started;
            expect(result).toEqual(expected[index]);
            return {scope: lane.name, elapsedMs};
          })));
        }
        concurrentRounds.push({mode, elapsedMs: performance.now() - phaseStarted, timings});
      }

      const backends = await Promise.all(lanes.map(lane => lane.client.withTenant(lane.session, async tx => {
        const [facts] = await tx.execute<{pid: number; autoUses: number; forcedUses: number; forcedCustom: number}>(sql`
          select pg_backend_pid() as pid, pg_sleep(0.05),
            coalesce(sum(generic_plans + custom_plans) filter (where starts_with(statement, ${prefix('named-auto')})), 0)::int as "autoUses",
            coalesce(sum(generic_plans) filter (where starts_with(statement, ${prefix('named-generic')})), 0)::int as "forcedUses",
            coalesce(sum(custom_plans) filter (where starts_with(statement, ${prefix('named-generic')})), 0)::int as "forcedCustom"
          from pg_prepared_statements
        `);
        return facts;
      }, {readOnlySnapshot: true})));
      const unique = [...new Map(backends.map(row => [row.pid, row])).values()];
      expect(unique.length).toBe(target!.serverConnections);
      expect(unique.every(row => row.autoUses > 0 && row.forcedUses > 0 && row.forcedCustom === 0)).toBe(true);
      pooledPlanCounts = {
        backends: unique.length,
        autoUses: unique.reduce((sum, row) => sum + row.autoUses, 0),
        forcedUses: unique.reduce((sum, row) => sum + row.forcedUses, 0),
      };
    } finally {
      await Promise.all(lanes.map(lane => lane.client.client.end({timeout: 5})));
    }

    // Change a real role while the server retains the same prepared statement.
    const scoped = fixture.personas.single;
    const [grant] = await owner.client<{id: string}[]>`
      select id from role_assignment
      where app_user_id = ${scoped.userId!}::uuid and tenant_id = ${scoped.tenantId}::uuid
        and role = 'hr_admin' and company_id = ${fixture.singleCompanyId}::uuid
    `;
    expect(grant?.id).toBeTruthy();
    await assignRole(fixture.personas.group, {appUserId: scoped.userId!, role: 'employee'});
    const employeeGrant = {role: 'employee', companyId: null} as const;
    const stale = {...scoped, roles: ['hr_admin', 'employee'], grants: [...scoped.grants!, employeeGrant]};
    const fresh = {...scoped, roles: ['employee'], grants: [employeeGrant]};
    const pool = appPool(shortWait ?? target!, 1);
    const rollback = new Error('fictional prepared read rollback');
    try {
      const inspect = (session: SessionContext, abort = false, companyIds: readonly string[] = read.companyIds) => pool.withTenant(session, async tx => {
        const scopedRead = {...read, companyIds};
        const statement = accountTaskStatement(accountTaskStatementSections(tx, session, modules, scopedRead), session);
        const query = arrayScope(dialect.sqlToQuery(statement), companyIds);
        const text = '/* fixture-task-plan-revocation */ ' + query.statement;
        const [before] = await tx.execute<{pid: number; mode: string; uses: number}>(sql`
          select pg_backend_pid() as pid, current_setting('plan_cache_mode') as mode,
            coalesce(sum(generic_plans), 0)::int as uses from pg_prepared_statements where statement = ${text}
        `);
        expect(before.mode).toBe('auto');
        const expected = [...await tx.execute<TaskRow>(statement)];
        await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
        const connection = Reflect.get(Reflect.get(tx, 'session'), 'client') as postgres.TransactionSql;
        const rows = [...await connection.unsafe<TaskRow[]>(text, query.params, {prepare: true})];
        expect(rows).toEqual(expected);
        if (abort) throw rollback;
        return {backend: before.pid, previousUses: before.uses, row: rows[0]};
      }, {readOnlySnapshot: true});

      const beforeRevocation = await inspect(stale);
      expect(beforeRevocation.row.principal).toBe(true);
      expect(beforeRevocation.row.claims.total).toBe(samples[1].claimTotal);
      await expect(inspect(stale, true, [fixture.singleCompanyId])).rejects.toBe(rollback);
      await revokeRole(fixture.personas.group, {roleAssignmentId: grant.id});
      const afterRevocation = await inspect(stale);
      expect(afterRevocation.backend).toBe(beforeRevocation.backend);
      expect(afterRevocation.previousUses).toBe(beforeRevocation.previousUses + 2);
      expect(afterRevocation.row.principal).toBe(false);
      await expect(readAccountTaskBundle(stale, modules, read)).resolves.toBeNull();
      const refreshed = await inspect(fresh);
      expect(refreshed.row.principal).toBe(true);
      expect(refreshed.row.claims.total).toBe(0);
      const beforeEviction = await inspect(fresh);
      expect(beforeEviction.previousUses).toBeGreaterThan(0);

      // Fill the server's statement cache with newer entries without disconnecting the web client.
      const evictionBackend = await pool.withTenant(fresh, async tx => {
        const [backend] = await tx.execute<{pid: number}>(sql`select pg_backend_pid() as pid`);
        const connection = Reflect.get(Reflect.get(tx, 'session'), 'client') as postgres.TransactionSql;
        for (let index = 0; index < POOLER_PREPARED_STATEMENT_LIMIT; index++) {
          await connection.unsafe(`select $1::int + ${index}`, [index], {prepare: true});
        }
        return backend.pid;
      }, {readOnlySnapshot: true});
      const afterEviction = await inspect(fresh, false, [fixture.singleCompanyId]);
      expect(afterEviction.backend).toBe(evictionBackend);
      expect(afterEviction.backend).toBe(beforeEviction.backend);
      expect(afterEviction.previousUses).toBe(0);
      expect(afterEviction.row).toEqual(refreshed.row);

      // Recycle only the idle backend just observed in this test worker's database.
      const direct = postgres(process.env.TEST_DATABASE_URL!, {max: 1});
      try {
        const [stopped] = await direct<{terminated: boolean}[]>`
          select pg_terminate_backend(pid, 5000) as terminated
          from pg_stat_activity
          where datname = current_database() and usename = current_user
            and state = 'idle' and pid = ${afterEviction.backend} and pid <> pg_backend_pid()
        `;
        expect(stopped?.terminated).toBe(true);
      } finally { await direct.end({timeout: 5}); }

      const afterReconnect = await inspect(fresh);
      expect(afterReconnect.backend).not.toBe(afterEviction.backend);
      expect(afterReconnect.previousUses).toBe(0);
      expect(afterReconnect.row).toEqual(refreshed.row);
      expect((await inspect(stale)).row).toEqual(afterRevocation.row);
    } finally {
      await pool.client.end({timeout: 5});
    }

    const timings = (mode: Mode) => {
      const values = concurrentRounds.filter(round => round.mode === mode)
        .flatMap(round => round.timings.map(sample => sample.elapsedMs)).sort((left, right) => left - right);
      const percentile = (fraction: number) => Math.round(values[Math.ceil(values.length * fraction) - 1]);
      return {samples: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95)};
    };
    console.info('ACCOUNT_TASK_ARRAY_POOL_PROFILE', JSON.stringify({
      scopes: lanes.map(lane => lane.scope.companyIds.length),
      unnamed: timings('unnamed'), namedAuto: timings('named-auto'), namedGeneric: timings('named-generic'), pooledPlanCounts,
      evictionRecovered: true, backendReplaced: true, revocationEnforced: true,
    }));
    const evidence = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
    if (evidence) writeFileSync(join(evidence, 'account-task-pooler-plan.json'), JSON.stringify({
      source: process.env.AIHR_CI_HEAD,
      companies: fixture.companyIds.length,
      employments: fixture.employmentIds.length,
      samples: samples.map(({pid: _pid, ...sample}) => sample),
      concurrentRounds,
      pooledPlanCounts,
    }));
  }, 120_000);

  it('holds a transaction advisory lock across clients and releases it at commit', async () => {
    const pool = appPool(target!, 4);
    const ctx = adminCtx(a);
    const key = Math.floor(Math.random() * 2_000_000_000) + 1;
    const held = deferred(), finish = deferred();
    const order: string[] = [];
    try {
      const holder = pool.withTenant(ctx, async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
        order.push('first-acquired');
        held.resolve();
        await finish.promise;
        order.push('first-committing');
      });
      await held.promise;
      const [denied] = await pool.withTenant(ctx, tx => tx.execute(sql`select pg_try_advisory_xact_lock(${key}::bigint) as ok`)) as unknown as {ok: boolean}[];
      expect(denied.ok).toBe(false);
      const waiter = pool.withTenant(ctx, async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
        order.push('second-acquired');
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(order).toEqual(['first-acquired']);
      finish.resolve();
      await Promise.all([holder, waiter]);
      expect(order).toEqual(['first-acquired', 'first-committing', 'second-acquired']);
      const [released] = await pool.withTenant(ctx, tx => tx.execute(sql`select pg_try_advisory_xact_lock(${key}::bigint) as ok`)) as unknown as {ok: boolean}[];
      expect(released.ok).toBe(true);
    } finally { finish.resolve(); await pool.client.end({timeout: 5}); }
  });

  it('keeps the audit chain contiguous when concurrent pooled transactions append to it', async () => {
    const pool = appPool(target!, 10);
    const ctx = adminCtx(a);
    const appended = 40;
    try {
      await Promise.all(Array.from({length: appended}, (_, index) => pool.withTenant(ctx, tx => appendEvent(tx, {
        tenantId: ctx.tenantId, aggregateType: 'test', aggregateId: randomUUID(), eventType: `pooler.event.${index}`, actor: actorOf(ctx), payload: {index},
      }))));
      const rows = await owner.client<{seq: string; prev: string; hash: string}[]>`
        select chain_seq as seq, prev_hash as prev, hash from domain_event where tenant_id = ${ctx.tenantId}::uuid and chain_seq is not null order by chain_seq`;
      expect(rows).toHaveLength(appended);
      rows.forEach((row, index) => {
        expect(Number(row.seq)).toBe(Number(rows[0].seq) + index);
        expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
        if (index > 0) expect(row.prev).toBe(rows[index - 1].hash);
      });
    } finally { await pool.client.end({timeout: 5}); }
  });

  it('still applies fair per-tenant admission on a pooled connection', async () => {
    const pool = appPool(target!, 4, 10_000);
    const tenantA = adminCtx(a), tenantB = adminCtx(b);
    const entered = [deferred(), deferred(), deferred()], release = [deferred(), deferred(), deferred()];
    const order: string[] = [];
    try {
      // A pool of four reserves one permit for sign-in. Alone, tenant A may use the other three.
      const holders = release.map((gate, index) => pool.withTenant(tenantA, async () => { entered[index].resolve(); await gate.promise; }));
      await Promise.all(entered.map(gate => gate.promise));
      // A queues first and B second. Once B has work, A is above its fair share of two, so B goes first.
      const laterA = pool.withTenant(tenantA, async () => { order.push('a'); });
      await new Promise(resolve => setTimeout(resolve, 100));
      const waitingB = pool.withTenant(tenantB, async tx => { order.push('b'); return (await tx.execute(sql`select app.current_tenant_id() as tenant`))[0]; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(order).toEqual([]);
      release[0].resolve();
      await expect(waitingB).resolves.toEqual({tenant: b.tenantId});
      release[1].resolve(); release[2].resolve();
      await Promise.all([...holders, laterA]);
      expect(order).toEqual(['b', 'a']);
    } finally { release.forEach(gate => gate.resolve()); await pool.client.end({timeout: 5}); }
  });

  it('serves many more clients than server connections, all successfully', async () => {
    // GitHub runs 150. A developer machine reaching Docker through a port forward should use fewer.
    const clients = Number(process.env.TEST_PGBOUNCER_MANY_CLIENTS ?? 150), transactions = 3;
    const before = await appBackends();
    let peak = before, sampling = true;
    const sampler = (async () => { while (sampling) { peak = Math.max(peak, await appBackends()); await new Promise(resolve => setTimeout(resolve, 50)); } })();
    const connections = Array.from({length: clients}, () => postgres(target!.appUrl, {max: 1, connect_timeout: 60, onnotice: () => {}}));
    let completed = 0;
    try {
      await Promise.all(connections.map(async (client, index) => {
        const tenant = index % 2 ? a.tenantId : b.tenantId;
        for (let transaction = 0; transaction < transactions; transaction++) {
          await client.begin(async tx => {
            await tx`select set_config('app.tenant_id', ${tenant}, true)`;
            const [row] = await tx`select current_setting('app.tenant_id') as tenant`;
            expect(row.tenant).toBe(tenant);
            completed++;
          });
        }
      }));
    } finally {
      sampling = false;
      await sampler;
      await Promise.all(connections.map(client => client.end({timeout: 5})));
    }
    expect(completed).toBe(clients * transactions);
    expect(peak - before).toBeLessThanOrEqual(target!.serverConnections);
    console.log(`[pooler] ${clients} clients, peak ${peak - before} server connections, ${completed} transactions`);
  });

  /**
   * postgres.js fetches array types on every new connection, in a promise nothing awaited. Behind a pooler
   * that query can be the one that waits for a server connection; when PgBouncer refused it with
   * query_wait_timeout the rejection was unhandled, which ends a plain Node process. patches/postgres@3.4.9.patch
   * handles it: the waiting query fails with the pooler's error and the next connection fetches the types.
   */
  it.skipIf(!shortWaitAvailable)('fails a new connection\'s timed-out first query cleanly, with no unhandled rejection, and recovers', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    const holder = postgres(shortWait!.appUrl, {max: 1, onnotice: () => {}});
    const fresh = postgres(shortWait!.appUrl, {max: 1, onnotice: () => {}});
    try {
      await holder`select 1`;
      // The pooler has one server connection; hold it past the two-second query_wait_timeout.
      const held = holder`select pg_sleep(4)`.then(rows => rows);
      const database = new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1);
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await owner.client<{n: number}[]>`select count(*)::int as n from pg_stat_activity where datname = ${database} and state = 'active' and query like 'select pg_sleep%'`;
        if (row.n > 0) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // This client's connection has never run a query, so its first statement is postgres.js's type fetch.
      const refused = await fresh`select 1 as ok`.then(() => null, (error: unknown) => error);
      expect(refused).toMatchObject({code: '08P01', message: 'query_wait_timeout'});
      expect(isDatabaseCapacityFailure(refused)).toBe(true);
      await held;
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(unhandled).toEqual([]);
      // Capacity is back: the same client reconnects and parses arrays, so the type fetch ran again.
      const [row] = await fresh<{words: string[]; numbers: number[]}[]>`select array['a','b']::text[] as words, array[1,2]::int4[] as numbers`;
      expect(row).toEqual({words: ['a', 'b'], numbers: [1, 2]});
    } finally {
      process.off('unhandledRejection', listener);
      await Promise.all([holder.end({timeout: 5}), fresh.end({timeout: 5})]);
    }
  });
});
