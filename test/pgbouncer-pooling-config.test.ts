/** Connection selection, the server budget, deployment validation and the rendered pooler configuration. */
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {DATABASE_CAPACITY_DIGEST} from '../db/admission';
import {assertFleetFitsServer} from '../db/capacity';
import {applicationDatabaseUrl, fleetEnvForServerBudget, isPoolerCapacityError, pooledClientOptions} from '../db/pooling';
import {isDatabaseCapacityFailure, markDatabaseCapacityFailure} from '../db/read-retry';
// @ts-expect-error plain deployment script, no declaration file
import {customerEnvironmentErrors} from '../deploy/check-customer-env.mjs';
// @ts-expect-error plain deployment script, no declaration file
import {pgbouncerSizing, renderFiles} from '../deploy/pgbouncer/render-config.mjs';

const DIRECT = 'postgresql://ai_hr_app:fixture@db.internal:5432/ai_hr?sslmode=verify-full';
const POOLED = 'postgresql://ai_hr_app:fixture@127.0.0.1:6432/ai_hr';

describe('which URL the application singleton uses', () => {
  it('is the direct URL, unchanged, when no pooled URL is configured', () => {
    expect(applicationDatabaseUrl({DATABASE_URL: DIRECT})).toEqual({url: DIRECT, pooled: false});
    expect(applicationDatabaseUrl({DATABASE_URL: DIRECT, DATABASE_POOLED_URL: '  '})).toEqual({url: DIRECT, pooled: false});
  });
  it('is the pooled URL for a web process', () => {
    expect(applicationDatabaseUrl({DATABASE_URL: DIRECT, DATABASE_POOLED_URL: POOLED})).toEqual({url: POOLED, pooled: true});
    expect(applicationDatabaseUrl({DATABASE_URL: DIRECT, DATABASE_POOLED_URL: POOLED, AIHR_DB_PROCESS_ROLE: 'web'}).pooled).toBe(true);
  });
  it('stays direct for a worker, even one that inherits the pooled URL', () => {
    expect(applicationDatabaseUrl({DATABASE_URL: DIRECT, DATABASE_POOLED_URL: POOLED, AIHR_DB_PROCESS_ROLE: 'worker'})).toEqual({url: DIRECT, pooled: false});
  });
  it('still requires DATABASE_URL', () => {
    expect(() => applicationDatabaseUrl({DATABASE_POOLED_URL: POOLED})).toThrow('DATABASE_URL is not set');
  });
});

describe('driver options on the pooled path only', () => {
  it('loads array types through the socket hook instead of on every connection', () => {
    const options = pooledClientOptions(POOLED);
    expect(options.fetch_types).toBe(false);
    expect(typeof options.socket).toBe('function');
  });
  it('leaves a direct client exactly as postgres.js configures it by default', async () => {
    process.env.DATABASE_URL ??= 'postgres://nobody:nothing@127.0.0.1:1/no_database';
    const {createDb} = await import('../db/client');
    const direct = createDb('postgres://nobody:nothing@127.0.0.1:1/direct_default_probe', {max: 1});
    const pooled = createDb('postgres://nobody:nothing@127.0.0.1:1/pooled_probe', {max: 1, pooled: true});
    try {
      expect(direct.client.options.fetch_types).toBe(true);
      expect(direct.client.options.socket).toBeUndefined();
      expect(pooled.client.options.fetch_types).toBe(false);
      expect(typeof pooled.client.options.socket).toBe('function');
    } finally { await Promise.all([direct.client.end({timeout: 1}), pooled.client.end({timeout: 1})]); }
  });
});

describe('the server budget behind a pooler', () => {
  const limits = {maxConnections: 100, superuserReserved: 3};
  const fleet = {AIHR_APP_WORKERS: '8', AIHR_DB_POOL_MAX: '30', AIHR_DB_TOTAL_CONNECTIONS: '240', AIHR_DB_BACKGROUND_CONNECTIONS: '16', AIHR_DB_RESERVED_CONNECTIONS: '5'};
  it('passes the environment through untouched without a pooled URL', () => {
    const env = {...fleet};
    expect(fleetEnvForServerBudget(env)).toBe(env);
    expect(() => assertFleetFitsServer(fleetEnvForServerBudget(env), limits)).toThrow('Connection budget exceeds the database');
  });
  it('counts the pooler ceiling instead of the web fleet', () => {
    const budget = assertFleetFitsServer(fleetEnvForServerBudget({...fleet, DATABASE_POOLED_URL: POOLED, AIHR_DB_POOLER_SERVER_CONNECTIONS: '12'}), limits);
    expect(budget.webConnections).toBe(12);
    expect(budget.requiredConnections).toBe(12 + 16 + 5);
  });
  it('keeps counting the control plane pools, which stay direct', () => {
    const budget = assertFleetFitsServer(fleetEnvForServerBudget({...fleet, DATABASE_POOLED_URL: POOLED, AIHR_DB_POOLER_SERVER_CONNECTIONS: '12', PLATFORM_DATABASE_URL: 'postgres://p:p@db/ai_hr'}), limits);
    expect(budget.webConnections).toBe(12 + 2 * 8);
  });
  it('refuses a pooled deployment that does not declare the pooler ceiling', () => {
    expect(() => fleetEnvForServerBudget({...fleet, DATABASE_POOLED_URL: POOLED})).toThrow('AIHR_DB_POOLER_SERVER_CONNECTIONS');
  });
});

describe('pooler capacity errors', () => {
  const wrapped = (message: string) => Object.assign(new Error('Failed query: select 1'), {name: 'DrizzleQueryError', cause: Object.assign(new Error(message), {code: '08P01'})});
  it.each(['query_wait_timeout', 'no more connections allowed (max_client_conn)'])('%s counts as a capacity failure', message => {
    const error = wrapped(message);
    expect(isPoolerCapacityError(error)).toBe(true);
    expect(isDatabaseCapacityFailure(error)).toBe(true);
    expect(markDatabaseCapacityFailure(error)).toMatchObject({digest: DATABASE_CAPACITY_DIGEST});
  });
  it('does not treat other protocol errors as capacity', () => {
    const error = wrapped('server conn crashed?');
    expect(isPoolerCapacityError(error)).toBe(false);
    expect(isDatabaseCapacityFailure(error)).toBe(false);
  });
});

describe('deployment validation of the pooled URL', () => {
  const valid = {
    NODE_ENV: 'production', AUTH_PROVIDER: 'internal', AUTH_SESSION_KEY: 'a'.repeat(64), AUTH_PUBLIC_ORIGIN: 'https://hr.customer.com',
    AI_CONFIG_SECRET: 'fixture-encryption-password', TERAS_PROPOSAL_SECRET: 'fixture-proposal-signing-secret-0123456789', AUDIT_HASH_CHAIN_ENABLED: 'true',
    DATABASE_URL: DIRECT, MIGRATION_DATABASE_URL: 'postgresql://ai_hr_owner:fixture@db.internal:5432/ai_hr?sslmode=verify-full',
    DATABASE_POOLED_URL: POOLED, AIHR_DB_POOLER_SERVER_CONNECTIONS: '12',
  };
  const pooledErrors = (changes: Record<string, string | undefined> = {}) =>
    (customerEnvironmentErrors({...valid, ...changes}, '/nonexistent') as string[]).filter(message => /DATABASE_POOLED_URL|AIHR_DB_POOLER|stay a direct/.test(message));
  it('accepts the loopback pooler in front of the direct URL', () => expect(pooledErrors()).toEqual([]));
  it('checks nothing about pooling when no pooled URL is set', () => expect(pooledErrors({DATABASE_POOLED_URL: undefined, AIHR_DB_POOLER_SERVER_CONNECTIONS: undefined})).toEqual([]));
  it('refuses a different role or database', () => {
    expect(pooledErrors({DATABASE_POOLED_URL: 'postgresql://ai_hr_owner:fixture@127.0.0.1:6432/ai_hr'})).toEqual(['DATABASE_POOLED_URL must use the same role and database as DATABASE_URL.']);
    expect(pooledErrors({DATABASE_POOLED_URL: 'postgresql://ai_hr_app:fixture@127.0.0.1:6432/other'})).toEqual(['DATABASE_POOLED_URL must use the same role and database as DATABASE_URL.']);
  });
  it('refuses the database itself, and a migration URL on the pooler', () => {
    expect(pooledErrors({DATABASE_POOLED_URL: DIRECT})).toEqual(expect.arrayContaining(['DATABASE_POOLED_URL must point at the pooler, not at the database DATABASE_URL already reaches.']));
    expect(pooledErrors({MIGRATION_DATABASE_URL: 'postgresql://ai_hr_owner:fixture@127.0.0.1:6432/ai_hr'})).toEqual(expect.arrayContaining(['MIGRATION_DATABASE_URL must stay a direct connection, not the pooler.']));
  });
  it('requires TLS verification for a pooler that is not on loopback', () => {
    expect(pooledErrors({DATABASE_POOLED_URL: 'postgresql://ai_hr_app:fixture@pool.internal:6432/ai_hr'})).toEqual(['DATABASE_POOLED_URL must use sslmode=verify-full for a remote database; use a trusted certificate and its private DNS name.']);
  });
  it('requires the pooler ceiling', () => {
    expect(pooledErrors({AIHR_DB_POOLER_SERVER_CONNECTIONS: undefined})).toEqual(["AIHR_DB_POOLER_SERVER_CONNECTIONS must be the pooler's max_db_connections when DATABASE_POOLED_URL is set."]);
  });
});

describe('the pooler sizing and rendered configuration', () => {
  const inputs = {AIHR_DB_CPU_CORES: '4', AIHR_DB_MAX_CONNECTIONS: '100', AIHR_PGBOUNCER_DATABASE_HOST: 'db.internal', AIHR_APP_WORKERS: '4', AIHR_DB_POOL_MAX: '8'};
  it('sizes the working pool from the database cores', () => {
    expect(pgbouncerSizing(inputs)).toMatchObject({defaultPoolSize: 10, reservePoolSize: 2, minPoolSize: 3, maxDbConnections: 12, maxClientConn: 2000, serverBudget: 76});
    expect(pgbouncerSizing({...inputs, AIHR_DB_CPU_CORES: '16'})).toMatchObject({defaultPoolSize: 34, reservePoolSize: 5});
  });
  it('stays inside the server budget when cores would ask for more', () => {
    const sized = pgbouncerSizing({...inputs, AIHR_DB_CPU_CORES: '64', AIHR_DB_MAX_CONNECTIONS: '50'});
    expect(sized.serverBudget).toBe(26);
    expect(sized.defaultPoolSize).toBe(22);
    expect(sized.maxDbConnections).toBeLessThanOrEqual(26);
  });
  it('reserves client slots for a large web fleet', () => {
    expect(pgbouncerSizing({...inputs, AIHR_APP_WORKERS: '32', AIHR_DB_POOL_MAX: '50'}).maxClientConn).toBe(3264);
  });
  it('refuses a budget with no room for the pooler', () => {
    expect(() => pgbouncerSizing({...inputs, AIHR_DB_MAX_CONNECTIONS: '20', AIHR_DB_BACKGROUND_CONNECTIONS: '14'})).toThrow('The pooler needs at least 5 server connections');
  });
  it('renders transaction pooling with no forced server user and no placeholder left', () => {
    const {ini, hba} = renderFiles(inputs);
    const databases = ini.slice(ini.indexOf('[databases]'), ini.indexOf('[pgbouncer]'));
    expect(ini).toMatch(/^pool_mode = transaction$/m);
    expect(ini).toMatch(/^default_pool_size = 10$/m);
    expect(ini).toMatch(/^max_db_connections = 12$/m);
    expect(ini).toMatch(/^server_tls_sslmode = verify-full$/m);
    expect(ini).toMatch(/^max_prepared_statements = 200$/m);
    expect(ini).toMatch(/^listen_addr = 127\.0\.0\.1$/m);
    expect(databases).toContain('ai_hr = host=db.internal port=5432 dbname=ai_hr');
    expect(databases).not.toMatch(/^[^;\n]*\buser\s*=/m);
    expect(`${ini}${hba}`).not.toContain('@@');
    expect(hba).toMatch(/^host\s+ai_hr\s+ai_hr_app\s+127\.0\.0\.1\/32\s+scram-sha-256$/m);
    expect(hba).not.toMatch(/^host\s+\S+\s+all\b/m);
  });
  it('refuses plaintext to a remote database and any non-loopback listener', () => {
    expect(() => renderFiles({...inputs, AIHR_PGBOUNCER_SERVER_TLS: 'disable'})).toThrow('Server TLS may be disabled only for a database on loopback.');
    expect(() => renderFiles({...inputs, AIHR_PGBOUNCER_LISTEN_ADDRESS: '0.0.0.0'})).toThrow('The listener is loopback only');
  });
  it('leaves the deployment scripts valid shell', () => {
    for (const script of ['install.sh', 'pool-status.sh', 'refresh-userlist.sh']) {
      expect(spawnSync('bash', ['-n', `deploy/pgbouncer/${script}`]).status).toBe(0);
    }
  });
});
