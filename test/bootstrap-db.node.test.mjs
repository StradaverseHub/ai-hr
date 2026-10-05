/**
 * Run: node --test test/bootstrap-db.node.test.mjs
 * Needs PostgreSQL 16+ binaries (PG_BIN can select them). Uses a disposable cluster on a unique
 * Unix socket, with TCP disabled; never touches the shared integration-test or production cluster.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'deploy/bootstrap-db.sh');
const sqlFile = path.join(root, 'deploy/bootstrap-db.sql');
const temp = mkdtempSync(path.join(tmpdir(), 'aihr-bootstrap-'));
const capture = path.join(temp, 'capture.json');
const mock = path.join(temp, 'mock-psql');
const names = ['AIHR_BOOTSTRAP_OWNER_PW', 'AIHR_BOOTSTRAP_APP_PW', 'AIHR_BOOTSTRAP_PLATFORM_PW'];
const passwords = ["owner-secret'\\literal", 'app-$(unexecuted)-secret', 'platform-secret-雪'];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG') && !names.includes(key)));
const pgBin = process.env.PG_BIN ?? [
  '/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin',
].find(dir => existsSync(path.join(dir, 'initdb')));
let started = false;

function run(cmd, args, { env = {}, input, ...options } = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { ...baseEnv, ...env }, input, ...options });
}
function success(result) {
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
function wrapper(input, env = {}, args = ['--stdin'], tracing = false) {
  rmSync(capture, { force: true });
  return run('/bin/bash', [...(tracing ? ['-x'] : []), script, ...args], {
    input, env: { AIHR_PSQL_BIN: mock, CAPTURE: capture, ...env },
  });
}
function dbEnv(extra = {}) {
  return { PGHOST: temp, PGUSER: 'postgres', PGDATABASE: 'postgres', ...extra };
}
function query(sql) {
  return success(run(path.join(pgBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, env: dbEnv(),
  }));
}
function bootstrap(env) {
  return run(path.join(pgBin, 'psql'), ['-X', '--no-password', '--dbname=postgres', `--file=${sqlFile}`], {
    env: dbEnv(env),
  });
}
function noObjects() {
  assert.equal(query("SELECT count(*) FROM pg_roles WHERE rolname IN ('ai_hr_owner','ai_hr_app','ai_hr_platform');"), '0');
  assert.equal(query("SELECT count(*) FROM pg_database WHERE datname='ai_hr';"), '0');
}

before(() => {
  writeFileSync(mock, `#!${process.execPath}\nimport fs from 'node:fs';\n` +
    `if (process.argv[2] === '--version') { console.log('psql (PostgreSQL) ' + (process.env.MOCK_VERSION ?? '16.14')); }\n` +
    `else { fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), passwords: ${JSON.stringify(names)}.map(n => process.env[n]) })); process.exit(Number(process.env.MOCK_EXIT ?? 0)); }\n`, { mode: 0o700 });
});
after(() => {
  if (started) success(run(path.join(pgBin, 'pg_ctl'), ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop']));
  rmSync(temp, { recursive: true, force: true });
});

test('wrapper gives psql exact secrets only through environment; tracing cannot print them', () => {
  const result = wrapper(passwords.join('\n') + '\n', {}, ['--stdin'], true);
  success(result);
  const actual = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual(actual.passwords, passwords);
  assert.deepEqual(actual.args, ['-X', '--no-password', '--dbname=postgres', `--file=${sqlFile}`]);
  for (const secret of passwords) {
    assert.ok(!JSON.stringify(actual.args).includes(secret));
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
});

test('wrapper rejects missing, empty, incomplete, and excess input before database commands', () => {
  for (const input of ['', 'owner\n', 'owner\napp\n', '\napp\nplatform\n', 'owner\n\nplatform\n',
    'owner\napp\n\n', 'owner\napp\nplatform', 'owner\napp\nplatform\nextra\n', 'owner\napp\nplatform\nextra']) {
    const result = wrapper(input, Object.fromEntries(names.map(n => [n, 'inherited-must-not-rescue'])));
    assert.equal(result.status, 2, `accepted malformed stdin ${JSON.stringify(input)}`);
    assert.ok(!existsSync(capture), 'psql database command ran for invalid input');
  }
});

test('wrapper refuses unsupported clients, noninteractive prompts, and password arguments', () => {
  for (const [env, args] of [[{ MOCK_VERSION: '14.20' }, ['--stdin']], [{}, []], [{}, ['--stdin', 'secret']]]) {
    assert.equal(wrapper(passwords.join('\n') + '\n', env, args).status, 2);
    assert.ok(!existsSync(capture));
  }
});

test('wrapper preserves a database failure exit status', () => {
  assert.equal(wrapper(passwords.join('\n') + '\n', { MOCK_EXIT: '3' }).status, 3);
});

test('real psql refuses every omitted/empty password before creating any roles or database', () => {
  assert.ok(pgBin, 'Install PostgreSQL 16+ binaries or set PG_BIN to their directory.');
  const data = path.join(temp, 'data');
  mkdirSync(data);
  success(run(path.join(pgBin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=scram-sha-256', '--no-locale']));
  writeFileSync(path.join(data, 'postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${temp.replaceAll("'", "''")}'\nshared_buffers = '16MB'\nmax_connections = 10\n`);
  success(run(path.join(pgBin, 'pg_ctl'), ['-D', data, '-l', path.join(temp, 'postgres.log'), '-w', 'start']));
  started = true;
  const all = Object.fromEntries(names.map((n, i) => [n, passwords[i]]));
  for (const key of names) {
    for (const absent of [true, false]) {
      const env = { ...all };
      if (absent) delete env[key]; else env[key] = '';
      const result = bootstrap(env);
      assert.equal(result.status, 3, `accepted ${absent ? 'absent' : 'empty'} ${key}`);
      assert.match(result.stderr, /All three bootstrap passwords are required/);
      noObjects();
      for (const secret of passwords) assert.ok(!(result.stdout + result.stderr).includes(secret));
    }
  }
});

test('real bootstrap creates least-privilege roles, SCRAM verifiers and grants; reruns preserve credentials', () => {
  success(bootstrap(Object.fromEntries(names.map((n, i) => [n, passwords[i]]))));
  const roles = query("SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname IN ('ai_hr_owner','ai_hr_app','ai_hr_platform') ORDER BY rolname;");
  assert.equal(roles, 'ai_hr_app|f|f|f|f|t\nai_hr_owner|f|f|f|f|t\nai_hr_platform|f|f|f|t|t');
  assert.equal(query("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='ai_hr';"), 'ai_hr_owner');
  const original = query("SELECT rolname, rolpassword FROM pg_authid WHERE rolname IN ('ai_hr_owner','ai_hr_app','ai_hr_platform') ORDER BY rolname;");
  // Force real SCRAM authentication for these roles, proving quoting preserves exact passwords.
  writeFileSync(path.join(temp, 'data/pg_hba.conf'), 'local ai_hr ai_hr_owner,ai_hr_app,ai_hr_platform scram-sha-256\nlocal all postgres trust\n');
  success(run(path.join(pgBin, 'pg_ctl'), ['-D', path.join(temp, 'data'), 'reload']));
  for (const [i, role] of ['ai_hr_owner', 'ai_hr_app', 'ai_hr_platform'].entries()) {
    const authenticated = success(run(path.join(pgBin, 'psql'), ['-X', '--no-password', '-qAt', '--dbname=ai_hr', `--username=${role}`], {
      input: 'SELECT current_user;', env: dbEnv({ PGPASSWORD: passwords[i] }),
    }));
    assert.equal(authenticated, role);
  }
  success(bootstrap(Object.fromEntries(names.map(n => [n, 'changed-but-not-rotated']))));
  assert.equal(query("SELECT rolname, rolpassword FROM pg_authid WHERE rolname IN ('ai_hr_owner','ai_hr_app','ai_hr_platform') ORDER BY rolname;"), original);
  const sql = "SET ROLE ai_hr_owner; CREATE TABLE bootstrap_probe (id integer); RESET ROLE; SELECT has_table_privilege('ai_hr_app','bootstrap_probe','SELECT,INSERT,UPDATE,DELETE'), has_table_privilege('ai_hr_platform','bootstrap_probe','SELECT');";
  const grants = success(run(path.join(pgBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, env: dbEnv({ PGDATABASE: 'ai_hr' }) }));
  assert.equal(grants, 't|f');
});
