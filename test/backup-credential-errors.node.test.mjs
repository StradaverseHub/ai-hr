/** Native no-database regressions: node --test test/backup-credential-errors.node.test.mjs */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihr-backup-errors-'));
const helper = path.join(root, 'scripts/backup-connection.py');
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('unreachable colon-free keyword conninfo never appears in diagnostics or status', () => {
  const secret = 'TOPSECRET_no_colon';
  const connection = `dbname=ai_hr user=owner password=${secret} host=127.0.0.1 port=1 connect_timeout=1`;
  const staging = path.join(temp, 'staging');
  const result = spawnSync('/bin/bash', [path.join(root, 'scripts/backup-db.sh')], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...baseEnv, BACKUP_DATABASE_URL: connection, BACKUP_STAGING: staging,
      BACKUP_DEST: path.join(temp, 'destination'), BACKUP_ALLOW_LOCAL_DEST: '1' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /BACKUP_RESULT=FAIL stage=client exit=2/);
  const status = fs.readFileSync(path.join(staging, 'backup-status.txt'), 'utf8');
  for (const output of [result.stdout, result.stderr, status]) {
    assert.ok(!output.includes(secret), 'password leaked in backup failure diagnostics');
    assert.ok(!output.includes(connection), 'connection string leaked in backup failure diagnostics');
  }
});

test('inherited verified TLS and passfile survive; explicit URL options override their defaults', () => {
  const passfile = path.join(temp, 'private passfile');
  const capture = path.join(temp, 'capture.json');
  const executable = path.join(temp, 'capture.mjs');
  fs.writeFileSync(passfile, '', { mode: 0o600 });
  fs.writeFileSync(executable, `import fs from 'node:fs';\n` +
    `fs.writeFileSync(process.env.CAPTURE, JSON.stringify(Object.fromEntries(['PGSSLMODE','PGSSLROOTCERT','PGPASSFILE','PGPASSWORD','PGDATABASE','PGSERVICE','PGSERVICEFILE'].map(k=>[k,process.env[k]]))));\n`);
  function read(connection) {
    const result = spawnSync('python3', [helper, '--', process.execPath, executable], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...baseEnv, CAPTURE: capture, AIHR_CONNECTION_URL: connection,
        PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/trusted/customer-ca.pem',
        PGPASSFILE: passfile, PGPASSWORD: 'inherited-password',
        PGSERVICE: 'must-not-override', PGSERVICEFILE: '/unrelated/service-file' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(capture, 'utf8'));
  }
  const inherited = read('postgresql://backup@db.private/customer');
  assert.equal(inherited.PGSSLMODE, 'verify-full');
  assert.equal(inherited.PGSSLROOTCERT, '/trusted/customer-ca.pem');
  assert.equal(inherited.PGPASSFILE, passfile);
  assert.equal(inherited.PGPASSWORD, 'inherited-password');
  assert.equal(inherited.PGSERVICE, undefined);
  assert.equal(inherited.PGSERVICEFILE, undefined);
  const explicit = read('postgresql://backup:explicit%20password@db.private/customer?sslmode=verify-ca&sslrootcert=%2Fexplicit%2Fca.pem');
  assert.equal(explicit.PGSSLMODE, 'verify-ca');
  assert.equal(explicit.PGSSLROOTCERT, '/explicit/ca.pem');
  assert.equal(explicit.PGPASSWORD, 'explicit password');
  assert.equal(explicit.PGPASSFILE, passfile);
});
