/**
 * A real PgBouncer in transaction mode for the integration test.
 *
 * TEST_PGBOUNCER_HOSTPORT points at a running pooler. Otherwise, on GitHub's Linux runners only, this
 * starts a job-owned container against the job's own PostgreSQL, the way .github/ci/postgres.sh does.
 * Elsewhere it returns null and the integration test is skipped, never silently faked.
 */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export type PoolerTarget = {appUrl: string; serverConnections: number; stop: () => void};

// PgBouncer 1.25.2. Named by digest, so a retagged image cannot change what this test proves.
const IMAGE = 'edoburu/pgbouncer@sha256:7d7a27d9e90985cab5cf42256f5c13a3120baa4b055b69df37beb272b89b2340';
const SERVER_CONNECTIONS = 3;

const docker = (...args: string[]) => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000});

async function waitForPort(host: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
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

export async function poolerTarget(): Promise<PoolerTarget | null> {
  const explicit = process.env.TEST_PGBOUNCER_HOSTPORT;
  if (explicit) return {appUrl: throughPooler(explicit), serverConnections: Number(process.env.TEST_PGBOUNCER_SERVER_CONNECTIONS ?? SERVER_CONNECTIONS), stop: () => {}};
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') return null;

  const database = new URL(process.env.TEST_DATABASE_URL!);
  const port = 56432 + Number(process.env.VITEST_POOL_ID ?? 1);
  const name = `aihr-pooler-test-${process.env.GITHUB_RUN_ID ?? 'run'}-${port}`;
  const directory = mkdtempSync(join(tmpdir(), 'aihr-pooler-'));
  writeFileSync(join(directory, 'userlist.txt'), '"ai_hr_app" ""\n');
  writeFileSync(join(directory, 'pgbouncer.ini'), [
    '[databases]', `* = host=${database.hostname} port=${database.port}`,
    '[pgbouncer]', 'listen_addr = 127.0.0.1', `listen_port = ${port}`, 'unix_socket_dir =',
    'auth_type = trust', 'auth_file = /etc/pgbouncer/userlist.txt',
    'pool_mode = transaction', `default_pool_size = ${SERVER_CONNECTIONS}`, 'reserve_pool_size = 0', `max_db_connections = ${SERVER_CONNECTIONS}`,
    'max_client_conn = 1000', 'max_prepared_statements = 200', 'server_reset_query =', 'query_wait_timeout = 60', '',
  ].join('\n'));
  docker('rm', '-fv', name);
  docker('create', '--name', name, '--network', 'host', '--entrypoint', '/usr/bin/pgbouncer', IMAGE, '/etc/pgbouncer/pgbouncer.ini');
  docker('cp', join(directory, 'pgbouncer.ini'), `${name}:/etc/pgbouncer/pgbouncer.ini`);
  docker('cp', join(directory, 'userlist.txt'), `${name}:/etc/pgbouncer/userlist.txt`);
  docker('start', name);
  await waitForPort('127.0.0.1', port);
  return {appUrl: throughPooler(`127.0.0.1:${port}`), serverConnections: SERVER_CONNECTIONS, stop: () => { try { docker('rm', '-fv', name); } catch { /* the job's teardown removes it */ } }};
}
