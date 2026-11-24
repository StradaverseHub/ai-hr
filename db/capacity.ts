/**
 * The connection budget for every process of one installation (ADR 2026-11-06, phase 3).
 *
 * Fleet equation, checked at deploy and at web start against the server's real limit:
 *
 *   C + B + R <= max_connections - superuser_reserved_connections
 *
 *   C  AIHR_DB_TOTAL_CONNECTIONS, the web fleet's connections (AIHR_APP_WORKERS W x AIHR_DB_POOL_MAX P)
 *   B  AIHR_DB_BACKGROUND_CONNECTIONS, every non-web process that can run at once:
 *      the import worker, timer jobs, the Entra worker and the report renderer
 *   R  AIHR_DB_RESERVED_CONNECTIONS, migrations, backups, monitoring and operator sessions
 *
 * Non-web processes declare AIHR_DB_PROCESS_ROLE=worker in their unit and get a small pool
 * (default 2), instead of inheriting the web pool of 10 that nothing counted.
 *
 * Background lanes (ADR 0181 J1). B keeps covering what it covered before lanes: the default import worker
 * (aihr-bank-import.service, which serves every lane as the fallback), the timers, the Entra worker and the report
 * renderer. Each DEDICATED lane process an installation runs beside it is counted on top, so a fleet without lanes is
 * budgeted exactly as before and turning lanes on can never silently overdraw the server:
 *
 *   L  AIHR_WORKER_LANES, the dedicated lanes (comma separated: payroll, tax, import, export), each
 *      queue owner 1 + app pool AIHR_DB_POOL_MAX 2 = 3 connections. Only the default service opens
 *      the probation owner pool, so it holds 4.
 *   C + B + 3L + R <= max_connections - superuser_reserved_connections
 *
 * Five lane processes (the default service and four dedicated lanes) hold 4 + 4 x 3 = 16 connections, the whole
 * default B on their own, which is why the dedicated lanes are added to B rather than carved out of it.
 *
 * Fairness inside one process, with P the pool size and W the web worker count (P = floor(C/W)):
 *
 *   authentication reserve   A = 0 when P < 3, otherwise ceil(P/8)
 *                            permits tenant work may never hold, so a login can always start
 *   tenant fair share        T = max(1, floor(5P/8)), work-conserving (db/admission.ts): a tenant alone
 *                            on the pool uses all of P - A; the share binds once another tenant has work
 *   other tenants keep       O = P - T - A, at least 1 whenever P >= 3
 *   authentication ceiling   ceil(P/2), so a login flood still leaves pages half the pool
 *   tenant waiting           floor(3*maxWaiting/4) per tenant, maxWaiting = floor(2048/W); queue entries
 *                            cannot be reclaimed, so one tenant can never fill the whole queue
 *   authentication waiting   floor(maxWaiting/8), counted apart from the tenant queue
 *
 * Each process decides alone and the load balancer knows nothing about tenants, so the shares
 * must hold per process. When tenants compete, one tenant settles to T*W connections, about 5/8 of
 * C whatever W is, and logins always keep A*W reserved connections. Below three connections a
 * process cannot reserve for both: with P=2 a contended tenant is held to one connection and login
 * goes first on the other; with P=1 only the ordering can help.
 */
import {WORKER_LANES, type WorkerLane} from '../core/bulk-job-lanes';

export type DatabaseProcessRole = 'web' | 'worker';

const WEB_POOL_DEFAULT = 10;
const WORKER_POOL_DEFAULT = 2;
const WORKER_POOL_CEILING = 8;
const WEB_WAITING = 2048;
const WORKER_WAITING = 64;
export const BACKGROUND_CONNECTIONS_DEFAULT = 16;
/** Connections of one worker-lane process (scripts/bank-import-runner.ts): the queue-owner connection
 * (db/worker-connection.ts, max 1) and the app pool; the default lane also opens the probation owner pool (max 1). */
export const WORKER_OWNER_CONNECTIONS = 1;
export const WORKER_PROBATION_OWNER_CONNECTIONS = 1;
export function workerLaneProcessConnections(lane: WorkerLane, poolMax = WORKER_POOL_DEFAULT) {
  return WORKER_OWNER_CONNECTIONS + poolMax + (lane === 'default' ? WORKER_PROBATION_OWNER_CONNECTIONS : 0);
}
export const WORKER_LANES_ENV = 'AIHR_WORKER_LANES';
/** The dedicated lanes declared for this installation (AIHR_WORKER_LANES). The default lane is aihr-bank-import.service
 * itself and is already in B, so it cannot be declared again. */
export function dedicatedWorkerLanes(env: Record<string, string | undefined>): WorkerLane[] {
  const raw = env[WORKER_LANES_ENV]?.trim();
  if (!raw) return [];
  const lanes = raw.split(',').map(lane => lane.trim());
  const allowed = WORKER_LANES.filter(lane => lane !== 'default') as readonly string[];
  if (lanes.some(lane => !allowed.includes(lane)) || new Set(lanes).size !== lanes.length)
    throw new Error(`${WORKER_LANES_ENV} must list distinct lanes from ${allowed.join(', ')}, separated by commas.`);
  return lanes as WorkerLane[];
}
export const RESERVED_CONNECTIONS_DEFAULT = 5;

function reader(env: Record<string, string | undefined>) {
  return (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return Number(raw);
  };
}

export function databaseProcessRole(env: Record<string, string | undefined>): DatabaseProcessRole {
  const role = env.AIHR_DB_PROCESS_ROLE;
  if (role === undefined || role === 'web') return 'web';
  if (role === 'worker') return 'worker';
  throw new Error("AIHR_DB_PROCESS_ROLE must be 'web' or 'worker'.");
}

/** Static fleet budget; every web process must receive the same worker count and total. */
export function applicationDatabaseBudget(env: Record<string, string | undefined>) {
  const integer = reader(env);
  if (databaseProcessRole(env) === 'worker') {
    const poolMax = integer('AIHR_DB_POOL_MAX', WORKER_POOL_DEFAULT, 1, WORKER_POOL_CEILING);
    return {role: 'worker' as const, poolMax, workers: 1, totalConnections: poolMax, maxWaiting: WORKER_WAITING, waitMs: 30_000};
  }
  const poolMax = integer('AIHR_DB_POOL_MAX', WEB_POOL_DEFAULT, 1, 50);
  if ((env.AIHR_APP_WORKERS === undefined) !== (env.AIHR_DB_TOTAL_CONNECTIONS === undefined))
    throw new Error('Declare both AIHR_APP_WORKERS and AIHR_DB_TOTAL_CONNECTIONS for a shared application budget.');
  const workers = integer('AIHR_APP_WORKERS', 1, 1, 64);
  const totalConnections = integer('AIHR_DB_TOTAL_CONNECTIONS', poolMax, 1, 1000);
  if (poolMax * workers > totalConnections) throw new Error('Application workers exceed AIHR_DB_TOTAL_CONNECTIONS.');
  return {role: 'web' as const, poolMax, workers, totalConnections, maxWaiting: Math.floor(WEB_WAITING / workers), waitMs: 30_000};
}

/** Admission shares for one physical pool. See the formula above. */
export function databaseAdmissionShares(
  poolMax: number,
  maxWaiting: number,
  role: DatabaseProcessRole = 'web',
) {
  // A worker runs one tenant at a time and serves no logins, so reservations would only idle it.
  if (role === 'worker') return {authenticationReserve: 0, authenticationCapacity: poolMax, tenantFairShare: poolMax, otherTenantReserve: 0, maxWaitingPerTenant: maxWaiting, maxAuthenticationWaiting: maxWaiting};
  const authenticationReserve = poolMax < 3 ? 0 : Math.ceil(poolMax / 8);
  const authenticationCapacity = Math.max(1, Math.ceil(poolMax / 2));
  const tenantFairShare = Math.max(1, Math.floor((poolMax * 5) / 8));
  return {
    authenticationReserve,
    authenticationCapacity,
    tenantFairShare,
    otherTenantReserve: poolMax - tenantFairShare - authenticationReserve,
    maxWaitingPerTenant: Math.floor((maxWaiting * 3) / 4),
    maxAuthenticationWaiting: Math.floor(maxWaiting / 8),
  };
}

/** Every connection this installation may open, against the server's real limit. */
export function databaseFleetBudget(env: Record<string, string | undefined>) {
  const integer = reader(env);
  const web = applicationDatabaseBudget({...env, AIHR_DB_PROCESS_ROLE: 'web'});
  const backgroundConnections = integer('AIHR_DB_BACKGROUND_CONNECTIONS', BACKGROUND_CONNECTIONS_DEFAULT, 1, 200);
  const reservedConnections = integer('AIHR_DB_RESERVED_CONNECTIONS', RESERVED_CONNECTIONS_DEFAULT, 1, 200);
  // db/platform.ts: each web process holds a separate two-connection pool when the control plane is on.
  const webConnections = web.totalConnections + (env.PLATFORM_DATABASE_URL ? 2 * web.workers : 0);
  const workerLaneConnections = dedicatedWorkerLanes(env).reduce((sum, lane) => sum + workerLaneProcessConnections(lane), 0);
  return {
    webConnections,
    backgroundConnections,
    workerLaneConnections,
    reservedConnections,
    requiredConnections: webConnections + backgroundConnections + workerLaneConnections + reservedConnections,
  };
}

export type DatabaseConnectionLimits = {maxConnections: number; superuserReserved: number};

/** Refuses a configuration the PostgreSQL server cannot honour. Pure; callers fetch the limits. */
export function assertFleetFitsServer(env: Record<string, string | undefined>, limits: DatabaseConnectionLimits) {
  const fleet = databaseFleetBudget(env);
  const available = limits.maxConnections - limits.superuserReserved;
  if (fleet.requiredConnections > available) {
    throw new Error(
      `Connection budget exceeds the database: web ${fleet.webConnections} + background ${fleet.backgroundConnections} `
      + (fleet.workerLaneConnections ? `+ worker lanes ${fleet.workerLaneConnections} ` : '')
      + `+ reserved ${fleet.reservedConnections} = ${fleet.requiredConnections}, but only ${available} are available `
      + `(max_connections ${limits.maxConnections}, superuser_reserved_connections ${limits.superuserReserved}).`,
    );
  }
  return {...fleet, available};
}
