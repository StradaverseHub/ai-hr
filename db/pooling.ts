/**
 * Transaction pooling for the web application's database connection (ADR 2026-11-10, deploy/pgbouncer/README.md).
 *
 * DATABASE_POOLED_URL points the web application at PgBouncer. When it is unset nothing changes: the
 * application connects with DATABASE_URL, exactly as it did before pooling existed.
 *
 * Only the application singleton in db/client.ts uses this. Every other connection names its own URL and
 * stays direct: migrations, the owner connections that hold session advisory locks, backups, the platform
 * pool and all non-web processes.
 */
import {pgErrorChain} from '../lib/db-error';
import {databaseProcessRole} from './capacity';

/** Pooled clients load array types once per process rather than once per connection (db/pooled-types.mjs). */
export {pooledClientOptions} from './pooled-types.mjs';

/**
 * Non-web processes ignore the pooled URL even when they inherit it from a shared environment file: they
 * hold session advisory locks and are counted in the direct background budget (deploy/pgbouncer/README.md).
 */
export function applicationDatabaseUrl(env: Record<string, string | undefined>): {url: string; pooled: boolean} {
  const direct = env.DATABASE_URL;
  if (!direct) throw new Error('DATABASE_URL is not set');
  const pooled = env.DATABASE_POOLED_URL?.trim();
  if (!pooled || databaseProcessRole(env) === 'worker') return {url: direct, pooled: false};
  return {url: pooled, pooled: true};
}

/**
 * The environment to check against the server's real limit. Behind the pooler, the web fleet's
 * connections reach PgBouncer rather than PostgreSQL, so the fleet costs the server only the pooler's
 * own ceiling (max_db_connections, declared as AIHR_DB_POOLER_SERVER_CONNECTIONS).
 */
export function fleetEnvForServerBudget(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!env.DATABASE_POOLED_URL?.trim()) return env;
  const raw = env.AIHR_DB_POOLER_SERVER_CONNECTIONS;
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > 1000)
    throw new Error('AIHR_DB_POOLER_SERVER_CONNECTIONS must be the pooler\'s max_db_connections, from 1 to 1000, when DATABASE_POOLED_URL is set.');
  const workers = env.AIHR_APP_WORKERS ?? '1';
  return {
    ...env,
    AIHR_APP_WORKERS: workers,
    AIHR_DB_POOL_MAX: '1',
    AIHR_DB_TOTAL_CONNECTIONS: String(Math.max(Number(raw), Number(workers))),
  };
}

/** PgBouncer's refusals when it has no capacity. Nothing started on the server, so a read may retry. */
const POOLER_CAPACITY_MESSAGE = /^(query_wait_timeout|no more connections allowed)/;

export function isPoolerCapacityError(error: unknown): boolean {
  return pgErrorChain(error).some(link => link.code === '08P01' && POOLER_CAPACITY_MESSAGE.test(link.message ?? ''));
}
