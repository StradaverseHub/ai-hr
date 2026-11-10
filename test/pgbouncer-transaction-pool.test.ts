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
import {poolerTarget, type PoolerTarget} from './helpers/pgbouncer-target';

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
          const [settings] = await tx.execute(sql`select current_setting('app.tenant_id', true) as tenant, current_setting('app.user_id', true) as usr`) as unknown as {tenant: string; usr: string}[];
          expect(settings).toEqual({tenant: tenantId, usr: ctx.userId});
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
      for (let round = 0; round < 20; round++) {
        await Promise.all(Array.from({length: 12}, async (_, worker) => {
          const ctx = worker % 2 ? adminCtx(a) : adminCtx(b);
          // Half of the transactions commit and half roll back; neither may leave the GUC set.
          await pool.withTenant(ctx, async tx => {
            await tx.execute(sql`select 1`);
            if (worker % 3 === 0) throw failure;
          }).catch(error => { if (error !== failure) throw error; });
          const [after] = await pool.client<{tenant: string | null; pid: number}[]>`select current_setting('app.tenant_id', true) as tenant, pg_backend_pid() as pid`;
          backends.add(after.pid);
          expect(after.tenant ?? '').toBe('');
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

  it('still applies per-tenant admission on a pooled connection', async () => {
    const pool = appPool(target!, 4, 250);
    const ctx = adminCtx(a);
    const held = [deferred(), deferred()], finish = deferred();
    try {
      // A pool of four allows one tenant two connections and reserves one for sign-in.
      const holders = held.map(gate => pool.withTenant(ctx, async () => { gate.resolve(); await finish.promise; }));
      await Promise.all(held.map(gate => gate.promise));
      await expect(pool.withTenant(ctx, async () => 'over-share')).rejects.toBeInstanceOf(DatabaseAdmissionError);
      await expect(pool.withTenant(adminCtx(b), async tx => (await tx.execute(sql`select app.current_tenant_id() as tenant`))[0])).resolves.toEqual({tenant: b.tenantId});
      finish.resolve();
      await Promise.all(holders);
    } finally { finish.resolve(); await pool.client.end({timeout: 5}); }
  });

  it('serves many more clients than server connections, all successfully', async () => {
    const clients = 150, transactions = 3;
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
});
