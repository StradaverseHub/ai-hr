/**
 * Dead-peer detection for the connections of non-web processes (AIHR_DB_PROCESS_ROLE=worker), above all the
 * protected import worker (scripts/bank-import-runner.ts, deploy/systemd/BANK-IMPORT.md "Stall watchdog").
 *
 * The worker's queue-owner connection holds the Bank and Individual Transaction session advisory locks. When the
 * network path to a remote database fails, the server never sees the client go away: without these settings the
 * orphaned backend, and its locks, lasted until the server's own TCP keepalive (tcp_keepalives_idle 7200 s on
 * staging's PostgreSQL 16), long after the stall watchdog had restarted the worker.
 *
 * Server side, sent as startup parameters so every connection carries them from its first statement. All five are
 * USERSET in PostgreSQL 14 to 16, so the non-superuser roles (ai_hr_owner, ai_hr_app) may set them; a server that
 * refuses one fails the connection loudly rather than silently running without it.
 *   tcp_keepalives_idle 60 s, tcp_keepalives_interval 15 s, tcp_keepalives_count 8
 *       an idle backend whose client vanished is closed about 60 + 15 x 8 = 180 s later. Keepalive probes only
 *       run while the connection carries no unacknowledged data, so they never touch a live statement.
 *   tcp_user_timeout 180000 ms
 *       the same 3 min bound when the backend is sending (results, notices) to a client that no longer
 *       acknowledges, which keepalive does not cover; the kernel default retransmits for about 15 min.
 *   client_connection_check_interval 10000 ms
 *       a backend running a statement polls its socket every 10 s and cancels the statement once the client is
 *       known to be gone (a closed socket, or the keepalive above failing). It never ends a statement whose client
 *       is still connected. Its cost is one poll per 10 s of running statement.
 * Over a Unix-domain socket PostgreSQL ignores the TCP settings (SHOW reads 0); the connection check still works.
 * Parameters given in the connection URL's query string take precedence (postgres.js merges them last).
 *
 * Client side, postgres.js turns on SO_KEEPALIVE with a 60 s idle time (keep_alive). It is pinned here so a
 * PGKEEP_ALIVE in an inherited environment cannot switch it off. Node sets only the idle time; the operating
 * system's probe interval and count apply (Linux 75 s x 9, so about 12 min), which is still inside the stall
 * watchdog's 960 s minimum. The watchdog remains the client's backstop for a call that never returns.
 *
 * Web processes keep the driver defaults, unchanged: they may connect through PgBouncer (db/pooling.ts), which refuses
 * startup parameters it does not know, and they hold no session advisory locks.
 * Every worker-role process connects directly, so all of them (the import worker, timers, the Entra worker) get
 * these settings through db/client.ts.
 */
import postgres from 'postgres';
import type {DatabaseProcessRole} from './capacity';

export const WORKER_CLIENT_KEEPALIVE_SECONDS = 60;
export const WORKER_SERVER_SESSION_PARAMETERS = Object.freeze({
  tcp_keepalives_idle: 60,
  tcp_keepalives_interval: 15,
  tcp_keepalives_count: 8,
  tcp_user_timeout: 180_000,
  client_connection_check_interval: 10_000,
});
export type WorkerSessionParameter = keyof typeof WORKER_SERVER_SESSION_PARAMETERS;

/** Longest time, in seconds, before the server closes the backend of a client that has silently gone. */
export function workerServerDeadClientSeconds(parameters = WORKER_SERVER_SESSION_PARAMETERS): number {
  const keepalive = parameters.tcp_keepalives_idle + parameters.tcp_keepalives_interval * parameters.tcp_keepalives_count;
  return Math.max(keepalive, parameters.tcp_user_timeout / 1000) + parameters.client_connection_check_interval / 1000;
}

export type ProcessConnectionOptions = {keep_alive?: number; connection?: Partial<postgres.ConnectionParameters>};

/** postgres.js options for a process of this role: the dead-peer settings for a worker, nothing for the web. */
export function processConnectionOptions(role: DatabaseProcessRole): ProcessConnectionOptions {
  if (role !== 'worker') return {};
  return {keep_alive: WORKER_CLIENT_KEEPALIVE_SECONDS, connection: {...WORKER_SERVER_SESSION_PARAMETERS}};
}

/** The import worker's single queue-owner connection (MIGRATION_DATABASE_URL), with the worker settings. */
export function openImportWorkerOwner(url: string) {
  return postgres(url, {max: 1, onnotice: () => {}, ...processConnectionOptions('worker')});
}
