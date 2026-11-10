/**
 * A real PgBouncer in transaction mode for the integration tests.
 *
 * On GitHub's Linux runners, or locally with TEST_PGBOUNCER_DOCKER=1, this starts job-owned containers
 * against the test PostgreSQL with host networking, the way .github/ci/postgres.sh runs the database.
 * TEST_PGBOUNCER_HOSTPORT instead names a running pooler (and TEST_PGBOUNCER_SHORT_WAIT_HOSTPORT one with
 * a one-connection pool and a two-second query_wait_timeout). Elsewhere it returns null and the tests are
 * skipped, never silently faked.
 */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export type PoolerTarget = {appUrl: string; serverConnections: number; stop: () => void};
export type PoolerShape = {name: 'main' | 'short-wait'; serverConnections: number; queryWaitTimeoutSeconds: number};

export const MAIN_POOLER: PoolerShape = {name: 'main', serverConnections: 3, queryWaitTimeoutSeconds: 60};
export const SHORT_WAIT_POOLER: PoolerShape = {name: 'short-wait', serverConnections: 1, queryWaitTimeoutSeconds: 2};

// PgBouncer 1.25.2, multi-architecture index. Named by digest, so a retagged image cannot change what this proves.
const IMAGE = 'edoburu/pgbouncer@sha256:7d7a27d9e90985cab5cf42256f5c13a3120baa4b055b69df37beb272b89b2340';

const docker = (...args: string[]) => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000});

async function waitForPort(host: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const open = await new Promise<boolean>(resolve => {
      const socket = createConnection({host, port});
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The test PgBouncer did not start listening.');
}

function throughPooler(hostPort: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.host = hostPort;
  return url.toString();
}

const dockerAllowed = () => (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true') || process.env.TEST_PGBOUNCER_DOCKER === '1';

export async function poolerTarget(shape: PoolerShape = MAIN_POOLER): Promise<PoolerTarget | null> {
  const explicit = shape.name === 'main' ? process.env.TEST_PGBOUNCER_HOSTPORT : process.env.TEST_PGBOUNCER_SHORT_WAIT_HOSTPORT;
  if (explicit) {
    const serverConnections = shape.name === 'main' ? Number(process.env.TEST_PGBOUNCER_SERVER_CONNECTIONS ?? shape.serverConnections) : shape.serverConnections;
    return {appUrl: throughPooler(explicit), serverConnections, stop: () => {}};
  }
  if (!dockerAllowed()) return null;

  const database = new URL(process.env.TEST_DATABASE_URL!);
  const port = 56432 + (shape.name === 'main' ? 0 : 20) + Number(process.env.VITEST_POOL_ID ?? 1);
  const name = `aihr-pooler-test-${process.env.GITHUB_RUN_ID ?? 'local'}-${port}`;
  const directory = mkdtempSync(join(tmpdir(), 'aihr-pooler-'));
  writeFileSync(join(directory, 'userlist.txt'), `"${decodeURIComponent(database.username)}" ""\n`);
  writeFileSync(join(directory, 'pgbouncer.ini'), [
    '[databases]', `* = host=${database.hostname} port=${database.port || 5432}`,
    '[pgbouncer]', 'listen_addr = 127.0.0.1', `listen_port = ${port}`, 'unix_socket_dir =',
    // trust only where the job's own PostgreSQL trusts its loopback. Production uses SCRAM verifiers (deploy/pgbouncer).
    database.password ? 'auth_type = scram-sha-256' : 'auth_type = trust', 'auth_file = /etc/pgbouncer/userlist.txt',
    'pool_mode = transaction', `default_pool_size = ${shape.serverConnections}`, 'reserve_pool_size = 0',
    `max_db_connections = ${shape.serverConnections}`, 'max_client_conn = 1000', 'max_prepared_statements = 200',
    'server_reset_query =', `query_wait_timeout = ${shape.queryWaitTimeoutSeconds}`, '',
  ].join('\n'));
  if (database.password) writeFileSync(join(directory, 'userlist.txt'), `"${decodeURIComponent(database.username)}" "${decodeURIComponent(database.password)}"\n`);
  docker('rm', '-fv', name);
  docker('create', '--name', name, '--label', 'aihr-owner=pooler-test', '--network', 'host', '--entrypoint', '/usr/bin/pgbouncer', IMAGE, '/etc/pgbouncer/pgbouncer.ini');
  docker('cp', join(directory, 'pgbouncer.ini'), `${name}:/etc/pgbouncer/pgbouncer.ini`);
  docker('cp', join(directory, 'userlist.txt'), `${name}:/etc/pgbouncer/userlist.txt`);
  docker('start', name);
  await waitForPort('127.0.0.1', port);
  return {appUrl: throughPooler(`127.0.0.1:${port}`), serverConnections: shape.serverConnections, stop: () => { try { docker('rm', '-fv', name); } catch { /* the job's teardown removes it */ } }};
}
