import {AsyncLocalStorage} from 'node:async_hooks';
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';

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

/** The longest a fail-fast exclusive try waits to be granted ahead of the waiters queued behind its own
 * shared hold. PostgreSQL grants that request at once; the bound only covers a holder arriving in between. */
export const ACCESS_CONFIGURATION_TRY_UPGRADE_WAIT_MS = 250;

/** Same retryable class as PostgreSQL's lock_not_available, so existing 55P03 handling applies unchanged.
 * This module never raises it: a caller that gave up after its own bounded attempts (for example
 * core/access-exclusive-wait.ts) uses it to refuse. */
export class AccessConfigurationBusyError extends Error {
  readonly code = '55P03';
  constructor(options?: ErrorOptions) {
    super('Access configuration is busy. Please try again.', options);
    this.name = 'AccessConfigurationBusyError';
  }
}

/** What this backend and every other backend currently hold, granted, on one advisory key. */
async function advisoryHoldTx(tx: Tx, key: string): Promise<{exclusive: boolean; shared: boolean; others: boolean}> {
  const [row] = await tx.execute<{exclusive: boolean; shared: boolean; others: boolean}>(sql`select
      coalesce(bool_or(l.pid = pg_backend_pid() and l.mode = 'ExclusiveLock'), false) as exclusive,
      coalesce(bool_or(l.pid = pg_backend_pid() and l.mode = 'ShareLock'), false) as shared,
      coalesce(bool_or(l.pid is distinct from pg_backend_pid()), false) as others
    from pg_catalog.pg_locks l
    cross join (select hashtextextended(${key},0) as k) target
    where l.locktype = 'advisory' and l.granted
      and l.database = (select oid from pg_catalog.pg_database where datname = current_database())
      and l.classid::bigint = ((target.k >> 32) & 4294967295) and l.objid::bigint = (target.k & 4294967295)
      and l.objsubid = 1`);
  return {exclusive: row?.exclusive === true, shared: row?.shared === true, others: row?.others === true};
}

async function acquireBounded(tx: Tx, tenantId: string, shared: boolean): Promise<void> {
  return acquireBoundedAdvisoryLockTx(tx, accessConfigurationKey(tenantId), shared);
}

/** A held-to-commit advisory lock with the same bounded wait as the Access lock. Any caller that can
 * meet a long holder uses this so a waiter cannot keep a pool connection forever. */
export async function acquireBoundedAdvisoryLockTx(tx: Tx, key: string, shared: boolean): Promise<void> {
  const [fast] = shared
    ? await tx.execute<{acquired: boolean}>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) as acquired`)
    : await tx.execute<{acquired: boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`);
  if (fast?.acquired === true) return;
  await waitBoundedAdvisoryLockTx(tx, key, shared);
}

/** The bounded wait after a missed try, in the mode already decided. */
async function waitBoundedAdvisoryLockTx(tx: Tx, key: string, shared: boolean): Promise<void> {
  // PostgreSQL 16 refuses a no-wait request whose mode conflicts with a queued waiter even when this
  // transaction already holds the stronger lock, so an exclusive holder re-entering through a shared reader
  // fails the try. It is no waiter: the exclusive hold already covers the shared request, so it returns
  // without narrowing lock_timeout or joining the queue (teras-turn-timing, four concurrent turns). Under
  // the reader/writer lock this is every configuration editor that calls an ordinary shared writer.
  if (shared && (await advisoryHoldTx(tx, key)).exclusive) return;
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

/**
 * Ordinary writers and readers that need configuration and authority to stay stable while they run.
 * Shared: writers overlap each other and only exclude an access configuration editor. Take it before
 * reading authority, a policy or counting anything that an editor can change.
 */
export async function lockAccessConfigurationTx(tx:Tx,tenantId:string){
  await acquireBounded(tx, tenantId, true);
}

/**
 * Editors of access configuration and the authority inputs other writers depend on: access groups,
 * grants, membership, role_assignment, app_user, app_invitation, the company tree, policy settings
 * and catalogues. Exclusive, so an editor is serialized against every writer depending on it.
 */
export async function lockAccessConfigurationWriteTx(tx:Tx,tenantId:string){
  // Test-only: a shared holder asking for exclusive would deadlock against another one doing the same. A read-only
  // transaction is exempt: it is granted the shared lock below and can never upgrade.
  if (process.env.AIHR_ACCESS_LOCK_STRICT === 'on') {
    const [held] = await tx.execute<{mode: 'X'|'S'|null; read_only: boolean}>(sql`select app.access_lock_mode_held(${tenantId}::uuid) as mode,
      current_setting('transaction_read_only') = 'on' as read_only`);
    if (held?.mode === 'S' && held.read_only !== true) throw new Error('Access lock strict mode: shared holder requested the exclusive lock');
  }
  await acquireAccessExclusiveUnlessReadOnlyTx(tx, tenantId);
}

/**
 * The exclusive Access lock, except in a READ ONLY transaction, which gets the shared lock (staging, 11 November
 * 2026). A read-only transaction cannot change configuration or anything another writer depends on, so it never
 * needs to exclude ordinary writers; the shared lock still excludes every Access editor for the rest of the
 * transaction. Readers in a REPEATABLE READ snapshot see exactly the rows they saw before. This is what keeps a read
 * that reaches a mode-joining helper (joinAccessConfigurationTx, the AI control check) while holding nothing from
 * taking the exclusive lock: the Employee Master report and the Personnel export read 2,000 employments that way.
 * One statement decides the mode and tries it, the same single round trip as the exclusive try it replaces.
 */
async function acquireAccessExclusiveUnlessReadOnlyTx(tx: Tx, tenantId: string): Promise<void> {
  const key = accessConfigurationKey(tenantId);
  const [fast] = await tx.execute<{read_only: boolean; acquired: boolean}>(sql`select current_setting('transaction_read_only') = 'on' as read_only,
    case when current_setting('transaction_read_only') = 'on' then pg_try_advisory_xact_lock_shared(hashtextextended(${key},0))
      else pg_try_advisory_xact_lock(hashtextextended(${key},0)) end as acquired`);
  if (fast?.acquired === true) return;
  await waitBoundedAdvisoryLockTx(tx, key, fast?.read_only === true);
}

const accessDisplayRead = new AsyncLocalStorage<true>();
/**
 * A page section or card that only displays what an owner returns (staging, 11 November 2026). Inside it, the
 * mode-joining helpers (joinAccessConfigurationTx, the AI control check, the AI principal read) take the shared Access
 * lock when their transaction holds none, instead of the exclusive lock they keep for callers that may write later.
 * Use it only around an owner call whose result is presentation; an explicit lockAccessConfigurationWriteTx inside is
 * unchanged, and a read-only transaction is shared anyway.
 */
export function withAccessDisplayRead<T>(read: () => Promise<T>): Promise<T> {
  return accessDisplayRead.run(true, read);
}
export const inAccessDisplayRead = (): boolean => accessDisplayRead.getStore() === true;

/** Navigation reads may wait for an access edit and can overlap other readers. */
export async function lockAccessConfigurationReadTx(tx: Tx, tenantId: string) {
  await acquireBounded(tx, tenantId, true);
}

/**
 * Writers that can reduce the usable system-administrator set (ending or blacklisting an employment of a
 * person with a login, archiving a user, removing a role) while holding only the shared lock. Serialises
 * the last-administrator check: of two concurrent removals, the second sees the first's committed result.
 */
export async function lockAccessAdministratorSetTx(tx:Tx,tenantId:string){
  await tx.execute(sql`select app.access_administrator_set_lock(${tenantId}::uuid)`);
}

/**
 * Fail-fast exclusive request: callers give the connection back on a miss instead of waiting.
 *
 * PostgreSQL 16 refuses every no-wait request that conflicts with a queued waiter, without looking at what
 * this transaction already holds. A transaction that holds the lock shared, alone, with a writer queued
 * behind it is therefore refused the exclusive lock although nothing but its own hold stands in the way; the
 * queued writer cannot run before this transaction ends either. A blocking request in that exact state is
 * granted at once, ahead of the queue, so this asks for it inside a savepoint under a short lock_timeout. Any
 * other holder is a real conflict and stays a miss. A miss never aborts the caller's transaction.
 */
export async function tryLockAccessConfigurationTx(tx: Tx, tenantId: string): Promise<boolean> {
  const key = accessConfigurationKey(tenantId);
  const [row] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`);
  if (row.acquired) return true;
  const hold = await advisoryHoldTx(tx, key);
  if (hold.exclusive) return true;
  if (!hold.shared || hold.others) return false;
  try {
    await tx.transaction(async upgrade => {
      const [prior] = await upgrade.execute<{saved: string}>(sql`select setting || coalesce(unit, '') as saved,
        set_config('lock_timeout', (case when setting::bigint = 0 then ${ACCESS_CONFIGURATION_TRY_UPGRADE_WAIT_MS}::bigint
          else least(setting::bigint, ${ACCESS_CONFIGURATION_TRY_UPGRADE_WAIT_MS}::bigint) end)::text || 'ms', true)
        from pg_catalog.pg_settings where name = 'lock_timeout'`);
      await upgrade.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
      await upgrade.execute(sql`select set_config('lock_timeout', ${prior.saved}, true)`);
    });
    return true;
  } catch (error) {
    // The savepoint rolled back: lock_timeout is the caller's again and the shared hold is untouched.
    if (pgSqlState(error) === '55P03') return false;
    throw error;
  }
}

/** Standalone Personnel reads fail fast behind a configuration writer and can overlap each other. An
 * exclusive hold by this transaction already covers the request, which PostgreSQL 16 would refuse as soon
 * as another writer is queued behind that hold. */
export async function tryLockAccessConfigurationReadTx(tx: Tx, tenantId: string): Promise<boolean> {
  const key = accessConfigurationKey(tenantId);
  const [row] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) as acquired`);
  return row.acquired || (await advisoryHoldTx(tx, key)).exclusive;
}

/** Ordinary profile and register value writers: shared Access and a shared profile-policy lock, so writers overlap
 * each other and only exclude access and profile-policy editors. Pair with lockProfileSubjectTx. */
export async function lockProfileValueSharedTx(tx:Tx,tenantId:string){
  await lockAccessConfigurationTx(tx,tenantId);
  await tx.execute(sql`select app.access_profile_policy_value_lock()`);
}

/** Serialises value writers on one person or employment's registers (single primary contact, single highest
 * qualification, dependent de-duplication). Take it before reading or locking the subject's rows. */
export async function lockProfileSubjectTx(tx:Tx,tenantId:string,subjectId:string){
  await acquireBoundedAdvisoryLockTx(tx,`profile-subject:${tenantId}:${subjectId}`,false);
}

/** The Access lock mode this transaction holds: 'X', 'S', or null when it holds neither. */
export async function accessLockModeHeldTx(tx:Tx,tenantId:string):Promise<'X'|'S'|null>{
  const [row]=await tx.execute<{mode:'X'|'S'|null}>(sql`select app.access_lock_mode_held(${tenantId}::uuid) as mode`);
  return row?.mode??null;
}

/** Profile/register writers join the physical configuration tuple before policy or subject locks.
 * This is a write barrier, not an access edit or an ESS approval bypass. */
export async function lockProfileValueWritesTx(tx:Tx,tenantId:string){
  await lockAccessConfigurationWriteTx(tx,tenantId);
  await tx.execute(sql`select app.access_profile_policy_write_lock()`);
}
