import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

const accessConfigurationKey = (tenantId: string) => 'access-configuration:' + tenantId;

/**
 * Bounded Access lock waits (production incident, 10 November 2026).
 *
 * One long Access holder (an employee import that held the exclusive lock for minutes) left every other
 * caller blocked in pg_advisory_xact_lock with no timeout. Each waiter kept its pool connection, the
 * ten-connection pool filled with waiters, and every page in the process hung, including pages that never
 * touch the Access lock.
 *
 * A waiter gives up after ACCESS_CONFIGURATION_LOCK_WAIT_MS with SQLSTATE 55P03. That aborts and rolls back
 * its transaction, which returns the connection to the pool, and lib/public-error.ts already shows 55P03 as
 * the retryable "busy, please try again" message. Connection capacity is owned by the database admission
 * layer (db/admission.ts) before a connection is borrowed; this lock does not ration waiters itself. The
 * hotfix's per-process cap of three waiters was removed (owner decision, 11 November 2026): it refused
 * ordinary concurrency, such as four assistant turns in one company, as busy.
 *
 * The uncontended path is unchanged: one try-lock statement, the same single round trip as the blocking
 * call it replaces. pg_try_advisory_xact_lock respects queued conflicting waiters, so trying first does
 * not let a caller jump ahead of the queue, and it succeeds immediately when this transaction already
 * holds the lock in the same mode. lock_timeout is narrowed only around the wait and restored afterwards,
 * so the transaction's later row-lock waits keep their existing behaviour.
 *
 * This bounds the damage. It does not make a caller succeed while an import holds the lock: those
 * callers get a retryable refusal after the bound instead of a hang. Shortening the import's lock hold is
 * separate work.
 */
export const ACCESS_CONFIGURATION_LOCK_WAIT_MS = 5000;

async function acquireBounded(tx: Tx, tenantId: string, shared: boolean): Promise<void> {
  const key = accessConfigurationKey(tenantId);
  const [fast] = shared
    ? await tx.execute<{acquired: boolean}>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) as acquired`)
    : await tx.execute<{acquired: boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`);
  if (fast?.acquired === true) return;
  // PostgreSQL 16 refuses a no-wait request whose mode conflicts with a queued waiter even when this
  // transaction already holds the stronger lock, so an exclusive holder re-entering through a shared reader
  // fails the try. It is no waiter: the exclusive hold already covers the shared request, so it returns
  // without narrowing lock_timeout or joining the queue (teras-turn-timing, four concurrent turns).
  if (shared) {
    const [held] = await tx.execute<{held: boolean}>(sql`select exists(select 1 from pg_catalog.pg_locks l
      cross join (select hashtextextended(${key},0) as k) target
      where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.mode = 'ExclusiveLock'
        and l.database = (select oid from pg_catalog.pg_database where datname = current_database())
        and l.classid::bigint = ((target.k >> 32) & 4294967295) and l.objid::bigint = (target.k & 4294967295)
        and l.objsubid = 1) as held`);
    if (held?.held === true) return;
  }
  // pg_settings is materialised before the projection runs, so `saved` is the value from before this
  // set_config. Keep any tighter limit the caller already set; 0 means "no limit".
  const [prior] = await tx.execute<{saved: string}>(sql`select setting || coalesce(unit, '') as saved,
    set_config('lock_timeout', (case when setting::bigint = 0 then ${ACCESS_CONFIGURATION_LOCK_WAIT_MS}::bigint
      else least(setting::bigint, ${ACCESS_CONFIGURATION_LOCK_WAIT_MS}::bigint) end)::text || 'ms', true)
    from pg_catalog.pg_settings where name = 'lock_timeout'`);
  // A timed-out wait raises the driver's own 55P03 error, deliberately not wrapped: callers such as
  // core/probation.ts and core/payroll-leave.ts already recognise that exact shape as "busy, retry".
  // The transaction is then aborted, so lock_timeout is not restored; SET LOCAL ends with the rollback.
  if (shared) await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${key},0))`);
  else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
  await tx.execute(sql`select set_config('lock_timeout', ${prior.saved}, true)`);
}

/** Join before reading authority or counting recovery administrators in every access-affecting writer. */
export async function lockAccessConfigurationTx(tx:Tx,tenantId:string){
  await acquireBounded(tx, tenantId, false);
}

/** Navigation reads may wait for an access edit and can overlap other readers. */
export async function lockAccessConfigurationReadTx(tx: Tx, tenantId: string) {
  await acquireBounded(tx, tenantId, true);
}

/** Personnel readers must not occupy pool connections while waiting for the same tenant. */
export async function tryLockAccessConfigurationTx(tx: Tx, tenantId: string): Promise<boolean> {
  const [row] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${accessConfigurationKey(tenantId)},0)) as acquired`);
  return row.acquired;
}

/** Standalone Personnel reads fail fast behind a configuration writer and can overlap each other. */
export async function tryLockAccessConfigurationReadTx(tx: Tx, tenantId: string): Promise<boolean> {
  const [row] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${accessConfigurationKey(tenantId)},0)) as acquired`);
  return row.acquired;
}

/** Profile/register writers join the physical configuration tuple before policy or subject locks.
 * This is a write barrier, not an access edit or an ESS approval bypass. */
export async function lockProfileValueWritesTx(tx:Tx,tenantId:string){
  await lockAccessConfigurationTx(tx,tenantId);
  await tx.execute(sql`select app.access_profile_policy_write_lock()`);
}
