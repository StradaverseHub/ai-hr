/**
 * The web application's database path through a real PgBouncer in transaction mode.
 *
 * withTenant sets RLS GUCs as transaction-local settings, so a pooled server connection handed to the
 * next client must carry nothing of the previous tenant. Every test here runs with far more clients than
 * server connections, so that server connections really are shared between tenants.
 */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import postgres from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {DatabaseAdmissionError} from '../db/admission';
import {createDb, type SessionContext} from '../db/client';
import {actorOf, appendEvent} from '../db/events';
import {adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';
import {isDatabaseCapacityFailure} from '../db/read-retry';
import {poolerTarget, SHORT_WAIT_POOLER, type PoolerTarget} from './helpers/pgbouncer-target';

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
