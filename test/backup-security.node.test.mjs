/** Run: node --test test/backup-security.node.test.mjs
 * Disposable PG16 cluster with verified TLS; no shared application/test database is used.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihr-backup-sec-'));
const pg = process.env.PG_BIN ?? ['/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']
  .find(dir => fs.existsSync(path.join(dir, 'initdb')));
const envBase = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
const helper = path.join(root, 'scripts/backup-connection.py');
const capture = path.join(tmp, 'argv.jsonl');
const mockBin = path.join(tmp, 'bin');
const staging = path.join(tmp, 'staging');
const destination = path.join(tmp, 'destination');
const ownerPassword = " owner '$\\:@&雪 end ";
const appPassword = " app '$\\:@&雪 end ";
let adminUrl, appUrl, port, dump;
let started = false;

function run(command, args, env = {}, input) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 90_000,
    env: { ...envBase, PG_BIN: pg, ...env }, input });
}
function ok(result) {
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
function query(sql, database = 'postgres') {
  return ok(run(path.join(pg, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    { PGHOST: tmp, PGPORT: String(port), PGUSER: 'postgres', PGDATABASE: database }, sql));
}
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const clientRecords = () => fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const privateMode = target => assert.equal(fs.statSync(target).mode & 0o077, 0, `${target} permits group/other access`);

before(async () => {
  assert.ok(pg, 'PostgreSQL 16 binaries or PG_BIN are required.');
  port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(() => resolve(selected)); });
  });
  const data = path.join(tmp, 'data');
  ok(run(path.join(pg, 'initdb'), ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=scram-sha-256', '--no-locale']));
  ok(run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(tmp, 'server.key'), '-out', path.join(tmp, 'server.crt')]));
  fs.chmodSync(path.join(tmp, 'server.key'), 0o600);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${tmp}'\nshared_buffers='16MB'\nmax_connections=12\nssl=on\nssl_cert_file='${tmp}/server.crt'\nssl_key_file='${tmp}/server.key'\n`);
  ok(run(path.join(pg, 'pg_ctl'), ['-D', data, '-l', path.join(tmp, 'pg.log'), '-w', 'start']));
  started = true;
  query(`ALTER ROLE postgres PASSWORD ${quote(ownerPassword)}; CREATE ROLE ai_hr_app LOGIN NOBYPASSRLS PASSWORD ${quote(appPassword)}; CREATE DATABASE ai_hr_security;`);
  query(fs.readFileSync(path.join(root, 'test/r291-backup-fixture.sql'), 'utf8'), 'ai_hr_security');
  const suffix = `@localhost:${port}/ai_hr_security?sslmode=verify-full&sslrootcert=${encodeURIComponent(path.join(tmp, 'server.crt'))}&keepalives=1`;
  adminUrl = `postgresql://postgres:${encodeURIComponent(ownerPassword)}${suffix}`;
  appUrl = `postgresql://ai_hr_app:${encodeURIComponent(appPassword)}${suffix}`;
  fs.mkdirSync(mockBin);
  for (const executable of ['psql', 'pg_dump', 'pg_restore']) {
    fs.writeFileSync(path.join(mockBin, executable), `#!${process.execPath}\n` +
      `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';\n` +
      `const keys=['PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','PGSERVICEFILE'];\n` +
      `const service=process.env.PGSERVICEFILE;\n` +
      `fs.appendFileSync(process.env.CAPTURE, JSON.stringify({tool:${JSON.stringify(executable)}, args:process.argv.slice(2), env:Object.fromEntries(keys.map(k=>[k,process.env[k]])), serviceMode:service ? fs.statSync(service).mode & 511 : null, serviceText:service ? fs.readFileSync(service,'utf8') : null})+'\\n',{mode:384});\n` +
      `const r=spawnSync(${JSON.stringify(path.join(pg, executable))},process.argv.slice(2),{stdio:'inherit',env:process.env}); process.exit(r.status ?? 1);\n`, { mode: 0o700 });
  }
});
after(() => {
  if (started) ok(run(path.join(pg, 'pg_ctl'), ['-D', path.join(tmp, 'data'), '-m', 'immediate', '-w', 'stop']));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('real TLS backup and restore keep all credential URLs out of every client argv', () => {
  fs.mkdirSync(staging, { mode: 0o755 });
  const result = run('/bin/bash', ['-x', path.join(root, 'scripts/backup-db.sh')], {
    PG_BIN: mockBin, CAPTURE: capture, BACKUP_DATABASE_URL: adminUrl, BACKUP_APP_DATABASE_URL: appUrl,
    BACKUP_STAGING: staging, BACKUP_DEST: destination, BACKUP_ALLOW_LOCAL_DEST: '1', BACKUP_KEEP_LOCAL: '1',
  });
  ok(result);
  assert.match(result.stdout, /BACKUP_RESULT=PASS/);
  const name = fs.readdirSync(staging).find(name => name.endsWith('.dump'));
  assert.ok(name);
  dump = path.join(staging, name);
  privateMode(staging);
  for (const name of fs.readdirSync(staging)) privateMode(path.join(staging, name));
  for (const name of fs.readdirSync(destination)) privateMode(path.join(destination, name));
  const rehearsal = run('/bin/bash', ['-x', path.join(root, 'scripts/restore-rehearsal.sh'), '--dump', dump, '--scratch', 'ai_hr_security_rehearsal'], {
    PG_BIN: mockBin, CAPTURE: capture, REHEARSAL_DATABASE_URL: adminUrl, REHEARSAL_APP_DATABASE_URL: appUrl,
    REHEARSAL_LOG: path.join(tmp, 'rehearsal.log'),
  });
  ok(rehearsal);
  assert.match(rehearsal.stdout, /RESTORE_REHEARSAL_RESULT=PASS stage=verdict exit=0/);
  const clients = clientRecords().filter(record => !record.args.includes('--version') && !record.args.includes('--list'));
  for (const tool of ['psql', 'pg_dump', 'pg_restore']) assert.ok(clients.some(record => record.tool === tool), `${tool} did not execute`);
  for (const record of clients) {
    assert.ok(!JSON.stringify(record.args).includes('postgresql://'));
    for (const secret of [ownerPassword, appPassword, adminUrl, appUrl]) assert.ok(!record.args.some(arg => arg.includes(secret)));
    assert.equal(record.env.PGSSLMODE, 'verify-full');
    assert.equal(record.env.PGSSLROOTCERT, path.join(tmp, 'server.crt'));
    assert.equal(record.serviceMode, 0o600);
    assert.match(record.serviceText, /keepalives=1/);
    assert.ok(!fs.existsSync(record.env.PGSERVICEFILE), 'temporary connection file was not cleaned up');
  }
  assert.ok(clients.some(record => record.env.PGPASSWORD === ownerPassword));
  assert.ok(clients.some(record => record.env.PGPASSWORD === appPassword));
  assert.ok(clients.some(record => record.env.PGDATABASE === 'ai_hr_security_rehearsal'));
  for (const secret of [ownerPassword, appPassword, adminUrl, appUrl]) {
    assert.ok(!(result.stdout + result.stderr + rehearsal.stdout + rehearsal.stderr).includes(secret));
  }
});

test('invalid connection details cannot leak into diagnostics or invoke a client', () => {
  const secret = 'secret-that-must-not-appear';
  const result = run('python3', [helper, '--', '/usr/bin/false'], {
    AIHR_CONNECTION_URL: `postgresql://name:${secret}@localhost/db?invalid=${secret}`,
  });
  assert.equal(result.status, 2);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test('application postgres.js driver requires a trusted certificate for verify-full URLs', () => {
  const probe = `import postgres from 'postgres';
    const db = postgres(process.env.AIHR_TLS_PROBE_URL, { max: 1, connect_timeout: 3 });
    try { const rows = await db\`select current_database() as name\`; console.log(rows[0].name); }
    catch (error) { console.error(error.code ?? 'CONNECTION_FAILED'); process.exitCode = 1; }
    finally { await db.end({ timeout: 1 }); }`;
  const url = `postgresql://postgres:${encodeURIComponent(ownerPassword)}@localhost:${port}/ai_hr_security?sslmode=verify-full`;
  const trusted = run(process.execPath, ['--input-type=module', '--eval', probe], {
    AIHR_TLS_PROBE_URL: url, NODE_EXTRA_CA_CERTS: path.join(tmp, 'server.crt'), NODE_TLS_REJECT_UNAUTHORIZED: '1',
  });
  assert.equal(ok(trusted), 'ai_hr_security');
  const untrusted = run(process.execPath, ['--input-type=module', '--eval', probe], {
    AIHR_TLS_PROBE_URL: url, NODE_EXTRA_CA_CERTS: '', NODE_TLS_REJECT_UNAUTHORIZED: '1',
  });
  assert.equal(untrusted.status, 1);
  assert.match(untrusted.stderr, /SELF_SIGNED_CERT|UNABLE_TO_VERIFY/);
  for (const result of [trusted, untrusted]) {
    assert.ok(!(result.stdout + result.stderr).includes(ownerPassword));
  }
});

test('scratch database override beats a dbname query parameter without losing verified TLS', () => {
  const result = run('python3', [helper, '--database', 'postgres', '--', path.join(pg, 'psql'), '-X', '-qAt', '-c', 'SELECT current_database();'], {
    AIHR_CONNECTION_URL: `${adminUrl}&dbname=this_database_does_not_exist`,
  });
  assert.equal(ok(result), 'postgres');
});

test('nonempty nonprivate staging is refused without chmodding unrelated content', () => {
  const directory = path.join(tmp, 'not-a-private-staging-directory');
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, 'unrelated'), 'leave me alone');
  const result = run('python3', [helper, '--private-dir', directory]);
  assert.equal(result.status, 2);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(directory, 'unrelated'), 'utf8'), 'leave me alone');
});

test('staging symlink is refused without changing its target permissions', () => {
  const target = path.join(tmp, 'unrelated');
  const symlink = path.join(tmp, 'staging-link');
  fs.mkdirSync(target, { mode: 0o755 });
  fs.symlinkSync(target, symlink);
  const result = run('/bin/bash', [path.join(root, 'scripts/backup-db.sh')], {
    BACKUP_DATABASE_URL: adminUrl, BACKUP_STAGING: symlink, BACKUP_DEST: destination,
    BACKUP_ALLOW_LOCAL_DEST: '1',
  });
  assert.equal(result.status, 2);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(target), []);
});
