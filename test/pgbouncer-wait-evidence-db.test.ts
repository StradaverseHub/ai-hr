import postgres from 'postgres';
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
import { readWebPoolerWork, summarizePoolerWindow } from '../scripts/performance/pooler-wait-evidence.mjs';
import { poolerTarget, SHORT_WAIT_POOLER } from './helpers/pgbouncer-target';
import { closeAll, migrateTestDb } from './harness';

afterAll(closeAll);

it('measures a real queued backend assignment separately from server query time', async () => {
  await migrateTestDb();
  const target = await poolerTarget({ ...SHORT_WAIT_POOLER, queryWaitTimeoutSeconds: 10 }, process.env.TEST_DATABASE_URL!);
  if (!target) throw new Error('The verification requires a job-owned PgBouncer');
  const database = new URL(target.appUrl).pathname.slice(1);
  const consoleUrl = new URL(target.appUrl);
  consoleUrl.pathname = '/pgbouncer';
  const observer = postgres(consoleUrl.href, { max: 1, prepare: false, fetch_types: false, connect_timeout: 5 });
  const holder = postgres(target.appUrl, { max: 1, prepare: false, connect_timeout: 5 });
  const waitingClient = postgres(target.appUrl, { max: 1, prepare: false, connect_timeout: 5 });
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held: Promise<unknown> | undefined;
  let waiting: Promise<unknown> | undefined;
  try {
    const before = await readWebPoolerWork(target, database);
    held = holder.begin(async tx => {
      await tx`select 1`;
      ready.resolve();
      await release.promise;
    });
    void held.catch(ready.reject);
    await ready.promise;
    waiting = waitingClient`select pg_sleep(0.025)`.execute();
    void waiting.catch(() => {});
    await expect.poll(async () => {
      const pools = await observer.unsafe('SHOW POOLS').simple();
      return Number(pools.find(row => row.database === database)?.cl_waiting ?? 0);
    }, { interval: 25, timeout: 3_000 }).toBe(1);
    await pause(125);
    release.resolve();
    await Promise.all([held, waiting]);

    const after = await readWebPoolerWork(target, database);
    const report = summarizePoolerWindow(before, after);
    expect(report.available).toBe(true);
    expect(report.assignments).toBeGreaterThanOrEqual(2);
    expect(report.assignmentWaitUs).toBeGreaterThanOrEqual(100_000);
    expect(report.queryUs).toBeGreaterThanOrEqual(20_000);
    expect(report.meanAssignedWaitUs).toBeGreaterThan(0);
  } finally {
    release.resolve();
    await Promise.allSettled([held, waiting]);
    await Promise.allSettled([observer.end({ timeout: 5 }), holder.end({ timeout: 5 }), waitingClient.end({ timeout: 5 })]);
    target.stop();
  }
}, 180_000);
