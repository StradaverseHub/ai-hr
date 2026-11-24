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
export type DatabaseProcessRole = 'web' | 'worker';

const WEB_POOL_DEFAULT = 10;
const WORKER_POOL_DEFAULT = 2;
const WORKER_POOL_CEILING = 8;
const WEB_WAITING = 2048;
const WORKER_WAITING = 64;
export const BACKGROUND_CONNECTIONS_DEFAULT = 16;
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

const CONNECTION_LIFETIME_DEFAULT_SECONDS = 6 * 60 * 60;

/**
 * How long the driver keeps one database connection before retiring it (ADR 0181, Phase 1).
 *
 * A new PostgreSQL backend starts with empty catalog caches. Under row security its first plan of each statement loads
 * the policies and definer functions it touches: 166 ms cold against 8–9 ms warm for the same statement, measured on
 * staging on 24 November 2026. postgres.js retires every connection after 30–60 minutes by default, so a pool kept
 * every backend permanently half cold. AIHR_DB_CONNECTION_LIFETIME_SECONDS (300 to 86,400, default 6 hours) sets the
 * base. Each connection draws its own lifetime from base to 1.25 × base, so a pool never recycles all at once.
 * Recycling stays bounded so a backend's caches and any server-side drift are still refreshed.
 */
export function databaseConnectionLifetime(env: Record<string, string | undefined>, random: () => number = Math.random): () => number {
  const base = reader(env)('AIHR_DB_CONNECTION_LIFETIME_SECONDS', CONNECTION_LIFETIME_DEFAULT_SECONDS, 300, 86_400);
  return () => Math.round(base * (1 + Math.min(Math.max(random(), 0), 1) / 4));
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
  return {
    webConnections,
    backgroundConnections,
    reservedConnections,
    requiredConnections: webConnections + backgroundConnections + reservedConnections,
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
      + `+ reserved ${fleet.reservedConnections} = ${fleet.requiredConnections}, but only ${available} are available `
      + `(max_connections ${limits.maxConnections}, superuser_reserved_connections ${limits.superuserReserved}).`,
    );
  }
  return {...fleet, available};
}
