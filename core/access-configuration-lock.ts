import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

const accessConfigurationKey = (tenantId: string) => 'access-configuration:' + tenantId;

/**
 * Bounded Access lock waits (production incident, 10 November 2026).
 *
 * One long Access holder (an employee import that held the exclusive lock for minutes) left every other
 * caller blocked in pg_advisory_xact_lock with no timeout. Each waiter kept its pool connection, the
 * ten-connection pool filled with waiters, and every page in the process hung, including pages that never
 * touch the Access lock. Two bounds stop one holder from taking the whole site down:
 *
 * 1. A waiter gives up after ACCESS_CONFIGURATION_LOCK_WAIT_MS with SQLSTATE 55P03. That aborts and rolls
 *    back its transaction, which returns the connection to the pool, and lib/public-error.ts already shows
 *    55P03 as the retryable "busy, please try again" message.
 * 2. At most ACCESS_CONFIGURATION_MAX_WAITERS connections per process may wait for the lock at once. A
 *    request beyond that is refused immediately with the same retryable class, so the remaining pool
 *    connections stay free for work that does not need the lock (login, Home and other reads).
 *
 * The uncontended path is unchanged: one try-lock statement, the same single round trip as the blocking
 * call it replaces. pg_try_advisory_xact_lock respects queued conflicting waiters, so trying first does
 * not let a caller jump ahead of the queue, and it succeeds immediately when this transaction already
 * holds the lock. lock_timeout is narrowed only around the wait and restored afterwards, so the
 * transaction's later row-lock waits keep their existing behaviour.
 *
 * This bounds the damage. It does not make a caller succeed while an import holds the lock: those
 * callers get a retryable refusal instead of a hang. Shortening the import's lock hold is separate work.
 */
export const ACCESS_CONFIGURATION_LOCK_WAIT_MS = 5000;
export const ACCESS_CONFIGURATION_MAX_WAITERS = 3;

/** Same retryable class as PostgreSQL's lock_not_available, so existing 55P03 handling applies unchanged. */
export class AccessConfigurationBusyError extends Error {
  readonly code = '55P03';
  constructor(options?: ErrorOptions) {
    super('Access configuration is busy. Please try again.', options);
    this.name = 'AccessConfigurationBusyError';
  }
}

let waiters = 0;

/** Tests only: the number of this process's connections currently waiting for an Access lock. */
export function accessConfigurationLockWaitersForTests(): number {
  return waiters;
}

async function acquireBounded(tx: Tx, tenantId: string, shared: boolean): Promise<void> {
  const key = accessConfigurationKey(tenantId);
  const [fast] = shared
    ? await tx.execute<{acquired: boolean}>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) as acquired`)
    : await tx.execute<{acquired: boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`);
  if (fast?.acquired === true) return;
  if (waiters >= ACCESS_CONFIGURATION_MAX_WAITERS) throw new AccessConfigurationBusyError();
  waiters++;
  // Counted only until the wait itself returns. A connection that has been granted the lock is no longer
  // waiting, so its lock_timeout restore round trip must not occupy a waiter slot: counting it refused an
  // ordinary fourth caller while only two connections were actually waiting (teras-turn-timing, 4 turns).
  let waiting = true;
  try {
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
    waiting = false;
    waiters--;
    await tx.execute(sql`select set_config('lock_timeout', ${prior.saved}, true)`);
  } finally {
    if (waiting) waiters--;
  }
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
