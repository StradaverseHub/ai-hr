#!/usr/bin/env node
// Renders pgbouncer.ini and pgbouncer_hba.conf from sizing inputs. No dependencies, no database access.
// The formula lives here so install, documentation and tests agree. See README.md, "Sizing".
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function integer(env, name, {fallback, min, max}) {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return Number(raw);
}

/**
 * The server-side budget of the pooler, and how it is split.
 *
 *   budget   = max_connections - superuser_reserved - background - reserved - platform
 *   default  = clamp(2 x cores + 2, 4, floor(7/8 x budget))     the working pool
 *   reserve  = max(1, ceil(default / 8))                        for bursts, granted after reserve_pool_timeout
 *   server   = default + reserve                                the pooler's hard ceiling (max_db_connections)
 *   clients  = max(2000, 2 x W x P + 64)                        max_client_conn
 *   minimum  = ceil(default / 4)                                pre-warmed server connections
 */
export function pgbouncerSizing(env) {
  const cores = integer(env, 'AIHR_DB_CPU_CORES', {min: 1, max: 256});
  const maxConnections = integer(env, 'AIHR_DB_MAX_CONNECTIONS', {min: 10, max: 10000});
  const superuserReserved = integer(env, 'AIHR_DB_SUPERUSER_RESERVED', {fallback: 3, min: 1, max: 200});
  const background = integer(env, 'AIHR_DB_BACKGROUND_CONNECTIONS', {fallback: 16, min: 1, max: 200});
  const reserved = integer(env, 'AIHR_DB_RESERVED_CONNECTIONS', {fallback: 5, min: 1, max: 200});
  const workers = integer(env, 'AIHR_APP_WORKERS', {fallback: 1, min: 1, max: 64});
  const poolMax = integer(env, 'AIHR_DB_POOL_MAX', {fallback: 10, min: 1, max: 50});
  // Each web process holds a separate direct two-connection pool when the control plane is on (db/platform.ts).
  const platform = env.PLATFORM_DATABASE_URL ? 2 * workers : 0;
  const serverBudget = maxConnections - superuserReserved - background - reserved - platform;
  if (serverBudget < 5) throw new Error(`The pooler needs at least 5 server connections but the budget leaves ${serverBudget}: raise max_connections or lower AIHR_DB_BACKGROUND_CONNECTIONS.`);
  const defaultPoolSize = Math.max(4, Math.min(2 * cores + 2, Math.floor((serverBudget * 7) / 8)));
  const reservePoolSize = Math.min(Math.max(1, Math.ceil(defaultPoolSize / 8)), serverBudget - defaultPoolSize);
  const clientConnections = workers * poolMax;
  return {
    defaultPoolSize,
    reservePoolSize,
    minPoolSize: Math.ceil(defaultPoolSize / 4),
    maxDbConnections: defaultPoolSize + reservePoolSize,
    maxClientConn: Math.max(2000, 2 * clientConnections + 64),
    serverBudget,
    clientConnections,
  };
}

function bounded(env, name, fallback, min, max) {
  return integer(env, name, {fallback, min, max});
}

/** Everything the templates need. Throws with the setting name, never a value that could be a credential. */
export function renderValues(env) {
  const sizing = pgbouncerSizing(env);
  const host = env.AIHR_PGBOUNCER_DATABASE_HOST ?? '';
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('AIHR_PGBOUNCER_DATABASE_HOST must be the database host name, matching its certificate.');
  const database = env.AIHR_PGBOUNCER_DATABASE_NAME ?? 'ai_hr';
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error('AIHR_PGBOUNCER_DATABASE_NAME must be a plain database name.');
  const tlsMode = env.AIHR_PGBOUNCER_SERVER_TLS ?? 'verify-full';
  if (!['verify-full', 'disable'].includes(tlsMode)) throw new Error('AIHR_PGBOUNCER_SERVER_TLS must be verify-full, or disable for a loopback database only.');
  const caFile = env.AIHR_PGBOUNCER_SERVER_CA_FILE ?? (tlsMode === 'disable' ? '' : '/etc/ssl/certs/aihr-database-ca.pem');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (tlsMode === 'disable' && !loopback) throw new Error('Server TLS may be disabled only for a database on loopback.');
  if (tlsMode === 'verify-full' && !/^\/[A-Za-z0-9._/-]+$/.test(caFile)) throw new Error('AIHR_PGBOUNCER_SERVER_CA_FILE must be an absolute path.');
  const listenAddress = env.AIHR_PGBOUNCER_LISTEN_ADDRESS ?? '127.0.0.1';
  if (listenAddress !== '127.0.0.1') throw new Error('The listener is loopback only. Client TLS for a remote listener is a separate review (README.md, "TLS").');
  return {
    ...sizing,
    DATABASE_HOST: host,
    DATABASE_PORT: bounded(env, 'AIHR_PGBOUNCER_DATABASE_PORT', 5432, 1, 65535),
    DATABASE_NAME: database,
    LISTEN_ADDRESS: listenAddress,
    LISTEN_PORT: bounded(env, 'AIHR_PGBOUNCER_LISTEN_PORT', 6432, 1, 65535),
    MAX_PREPARED_STATEMENTS: bounded(env, 'AIHR_PGBOUNCER_MAX_PREPARED_STATEMENTS', 200, 1, 5000),
    DEFAULT_POOL_SIZE: sizing.defaultPoolSize,
    MIN_POOL_SIZE: sizing.minPoolSize,
    RESERVE_POOL_SIZE: sizing.reservePoolSize,
    MAX_DB_CONNECTIONS: sizing.maxDbConnections,
    MAX_CLIENT_CONN: sizing.maxClientConn,
    SERVER_IDLE_TIMEOUT: bounded(env, 'AIHR_PGBOUNCER_SERVER_IDLE_TIMEOUT', 300, 30, 86400),
    QUERY_WAIT_TIMEOUT: bounded(env, 'AIHR_PGBOUNCER_QUERY_WAIT_TIMEOUT', 30, 1, 600),
    SERVER_TLS_SSLMODE: tlsMode,
    SERVER_TLS_CA_FILE: caFile,
  };
}

export function renderTemplate(template, values) {
  const rendered = template.replace(/@@([A-Z_]+)@@/g, (_, key) => {
    if (!(key in values)) throw new Error(`The template names an unknown value: ${key}`);
    return String(values[key]);
  });
  if (rendered.includes('@@')) throw new Error('Rendered output still contains a placeholder.');
  return rendered;
}

export function renderFiles(env, directory = HERE) {
  const values = renderValues(env);
  return {
    values,
    ini: renderTemplate(readFileSync(path.join(directory, 'pgbouncer.ini.template'), 'utf8'), values),
    hba: renderTemplate(readFileSync(path.join(directory, 'pgbouncer_hba.conf.template'), 'utf8'), values),
  };
}

// Usage: render-config.mjs <output directory>. Inputs come from the environment.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const output = process.argv[2];
  if (!output) { console.error('Usage: render-config.mjs <output directory>'); process.exit(2); }
  try {
    const {values, ini, hba} = renderFiles(process.env);
    writeFileSync(path.join(output, 'pgbouncer.ini'), ini, {mode: 0o640});
    writeFileSync(path.join(output, 'pgbouncer_hba.conf'), hba, {mode: 0o640});
    // Goes into the deployment environment. deploy.sh checks it against max_connections.
    console.log(`AIHR_DB_POOLER_SERVER_CONNECTIONS=${values.maxDbConnections}`);
    console.log(`default_pool_size=${values.defaultPoolSize} reserve_pool_size=${values.reservePoolSize} max_client_conn=${values.maxClientConn} server_budget=${values.serverBudget}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Rendering failed.');
    process.exit(1);
  }
}
