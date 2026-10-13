/**
 * r291 / readiness 1.5 — "An untested backup is not a backup."
 *
 * WHAT WAS TRUE BEFORE THIS ROUND, re-verified against the live box on 2026-09-16 rather than read
 * out of a document: `crontab -l`, /etc/cron.d, /etc/cron.daily and `systemctl list-timers` contain no
 * dump job; `archive_mode=off` and `wal_level=replica`, so there is no point-in-time recovery; the
 * eight dumps in /home/ubuntu are ad-hoc pre-migration artefacts on the same disk as the database;
 * deploy/DEPLOY.md mentioned backup, restore and rollback zero times; and the single restore rehearsal
 * anyone has attempted — /home/ubuntu/rehearsal-restore.log, 2026-09-11 — ends
 * `FATAL: database "ai_hr_rehearsal" does not exist`, with no verdict line anywhere in it.
 *
 * HOW THIS FILE IS BUILT, AND WHY IT IS NOT A SOURCE GREP
 * ------------------------------------------------------
 * Shell is easy to assert ABOUT and hard to assert ON, and this session has already found six guards
 * that passed against broken code. So almost everything below RUNS the two scripts, for real, against
 * a real PostgreSQL cluster, and reads their exit codes and their output.
 *
 * The rehearsal is exercised in both directions, and the negative direction is the point of the file.
 * A rehearsal that only ever passes is the exact thing readiness 1.5 exists to prevent — it is what
 * the box has had all along, an arrangement nobody has ever seen fail. So six DELIBERATELY DAMAGED
 * backups are built here and the rehearsal must reject every one:
 *
 *   truncated  · bytes cut in half                          → caught before it is restored
 *   truncated  · with the manifest re-stamped to match       → caught by pg_restore itself
 *   corrupted  · bytes overwritten mid-file, manifest re-stamped
 *   --no-privileges · restores PERFECTLY, every table and every row present, and the application role
 *                     cannot read a single one of them. This is the headline: the difference between
 *                     "restored" and "usable", and no count a superuser takes can see it.
 *   short      · rows deleted between the manifest and the dump
 *   no-RLS     · row-level security lost in the restore
 *
 * The re-stamping needs saying plainly. A damaged file normally fails the manifest's checksum, which
 * is correct and is tested first — but it would also mean every later check never ran, and "the
 * checksum catches everything" is not a claim worth having: a checksum cannot tell you a backup is
 * RESTORABLE. So each damaged dump is also offered with dump_bytes/dump_sha256 rewritten to match it,
 * which is what a backup pipeline that produced a bad dump would actually hand you, and the rehearsal
 * has to fail on its own merits with the integrity gate satisfied.
 *
 * WHERE ASSERTIONS ARE ON SOURCE SHAPE INSTEAD, AND WHY. One describe block at the end reads the
 * scripts and the docs as text. It covers two things execution cannot: that no cloud provider or
 * credential was invented anywhere in these files (a property of the whole text, not of one run), and
 * that the runbook and the readiness checklist say what was actually built. Both are labelled.
 *
 * THE FIXTURE is test/r291-backup-fixture.sql — the ai-hr schema reduced to the shape the verdict
 * depends on, not the real 465-migration chain. Its header says why.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BACKUP_SH = path.join(REPO, 'scripts/backup-db.sh');
const REHEARSAL_SH = path.join(REPO, 'scripts/restore-rehearsal.sh');
const FIXTURE_SQL = fs.readFileSync(path.join(REPO, 'test/r291-backup-fixture.sql'), 'utf8');

/** Parallel agents each get their own TEST_DB_NAMESPACE; these databases have to follow it. */
const NS = (process.env.TEST_DB_NAMESPACE ?? '').replace(/^_?/, '_').replace(/^_$/, '');
const SRC_DB = `ai_hr_r291_src${NS}`;
const SCRATCH_DB = `ai_hr_r291_rehearsal${NS}`;

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
const ADMIN_URL = withDb(process.env.TEST_MIGRATION_DATABASE_URL!, 'postgres');
const SRC_ADMIN_URL = withDb(process.env.TEST_MIGRATION_DATABASE_URL!, SRC_DB);
const SRC_APP_URL = withDb(process.env.TEST_DATABASE_URL!, SRC_DB);
const APP_ROLE = new URL(process.env.TEST_DATABASE_URL!).username;

let TMP = '';
let GOOD_DUMP = '';
let GOOD_MANIFEST = '';

type Run = { status: number | null; stdout: string; stderr: string; out: string };

function run(script: string, args: string[], env: Record<string, string>, timeout = 120_000): Run {
  const r = spawnSync('/bin/bash', [script, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { status: r.status, stdout, stderr, out: stdout + stderr };
}

/** The line every run ends on, whatever happened. Parsed rather than grepped so a missing one is loud. */
function verdict(r: Run, key: 'BACKUP_RESULT' | 'RESTORE_REHEARSAL_RESULT'): string {
  const line = r.out.split('\n').find((l) => l.startsWith(`${key}=`));
  expect(line, `no ${key}= line in:\n${r.out}`).toBeTruthy();
  return line!;
}

function backup(env: Record<string, string>): Run {
  return run(BACKUP_SH, [], {
    BACKUP_DATABASE_URL: SRC_ADMIN_URL,
    BACKUP_APP_DATABASE_URL: SRC_APP_URL,
    ...env,
  });
}

function rehearse(dump: string, env: Record<string, string> = {}, args: string[] = []): Run {
  return run(REHEARSAL_SH, ['--dump', dump, '--scratch', SCRATCH_DB, ...args], {
    REHEARSAL_DATABASE_URL: ADMIN_URL,
    REHEARSAL_APP_DATABASE_URL: withDb(process.env.TEST_DATABASE_URL!, 'postgres'),
    REHEARSAL_LOG: path.join(TMP, 'rehearsal.log'),
    ...env,
  });
}

const sha256 = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/**
 * Rewrite the integrity fields so a damaged dump gets PAST the checksum gate — see the file header.
 * Everything else in the manifest is left describing the database as it was.
 */
function restamp(manifestSrc: string, dump: string, out: string): string {
  const text = fs
    .readFileSync(manifestSrc, 'utf8')
    .replace(/^dump_bytes\t.*$/m, `dump_bytes\t${fs.statSync(dump).size}`)
    .replace(/^dump_sha256\t.*$/m, `dump_sha256\t${sha256(dump)}`);
  fs.writeFileSync(out, text);
  return out;
}

/** A pg_dump/pg_restore that claims to be an ancient major, for the version-refusal tests. */
function fakeOldClientBin(major: number): string {
  const dir = fs.mkdtempSync(path.join(TMP, 'oldpg-'));
  for (const bin of ['pg_dump', 'pg_restore']) {
    const p = path.join(dir, bin);
    fs.writeFileSync(p, `#!/bin/sh\n[ "$1" = "--version" ] && { echo "${bin} (PostgreSQL) ${major}.1"; exit 0; }\nexit 1\n`);
    fs.chmodSync(p, 0o755);
  }
  // psql has to be real: the scripts read the SERVER's version through it before they judge the client.
  const realPsql = spawnSync('/bin/bash', ['-c', `. ${REPO}/scripts/backup-lib.sh; blib_any_psql`], { encoding: 'utf8' })
    .stdout.trim();
  fs.symlinkSync(realPsql, path.join(dir, 'psql'));
  return dir;
}

async function rebuildSource(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SRC_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${SRC_DB}"`);
    await admin.unsafe(`GRANT CONNECT ON DATABASE "${SRC_DB}" TO "${APP_ROLE}"`);
  } finally {
    await admin.end();
  }
  const src = postgres(SRC_ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await src.unsafe(FIXTURE_SQL);
  } finally {
    await src.end();
  }
}

/** A dump of the source taken with extra pg_dump flags — how the damaged-but-valid archives are made. */
function pgDumpSource(outFile: string, extraFlags: string[]): void {
  const pgbin = spawnSync('/bin/bash', ['-c', `. ${REPO}/scripts/backup-lib.sh; blib_pg_bin_for_major 16`], {
    encoding: 'utf8',
  }).stdout.trim();
  expect(pgbin, 'no PostgreSQL 16+ client on this machine').toBeTruthy();
  const r = spawnSync(path.join(pgbin, 'pg_dump'), ['-Fc', ...extraFlags, '-f', outFile, SRC_ADMIN_URL], {
    encoding: 'utf8',
  });
  expect(r.status, `pg_dump ${extraFlags.join(' ')} failed: ${r.stderr}`).toBe(0);
}

beforeAll(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r291-backup-'));
  await rebuildSource();
  const dest = path.join(TMP, 'dest');
  const r = backup({
    BACKUP_DEST: dest,
    BACKUP_ALLOW_LOCAL_DEST: '1',
    BACKUP_STAGING: path.join(TMP, 'stage'),
  });
  expect(r.status, `the baseline backup failed:\n${r.out}`).toBe(0);
  GOOD_DUMP = path.join(dest, fs.readdirSync(dest).find((f) => f.endsWith('.dump'))!);
  GOOD_MANIFEST = `${GOOD_DUMP.slice(0, -'.dump'.length)}.manifest`;
}, 180_000);

afterAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SRC_DB}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    // Including the truncated-name one the connectivity test leaves behind.
    const strays = await admin.unsafe(
      "SELECT datname FROM pg_database WHERE datname LIKE 'ai_hr_r291_rehearsal_truncated%'",
    );
    for (const { datname } of strays) await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. The destination. An unset or unreachable destination is a LOUD failure, never a quiet success.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('backup-db.sh — the destination is the owner\'s decision, and its absence is fatal', () => {
  it('refuses with no BACKUP_DEST, and takes no dump at all', () => {
    const staging = path.join(TMP, 'nodest');
    const r = backup({ BACKUP_STAGING: staging });
    expect(r.status).toBe(3);
    expect(r.out).toContain('BACKUP_DEST is not set');
    expect(verdict(r, 'BACKUP_RESULT')).toContain('BACKUP_RESULT=FAIL stage=destination exit=3');
    // Refused BEFORE it did any work: no dump file anywhere.
    expect(fs.readdirSync(staging).filter((f) => f.endsWith('.dump'))).toEqual([]);
  });

  it('names no cloud provider and invents no credential in the refusal', () => {
    // The refusal has to leave the decision with the owner. A message that said "set AWS_ACCESS_KEY_ID"
    // would be this script choosing a vendor on their behalf.
    const r = backup({ BACKUP_STAGING: path.join(TMP, 'nodest2') });
    for (const vendor of ['AWS_', 'aws s3', 'gs://', 'AZURE', 'DigitalOcean', 'Backblaze']) {
      expect(r.out, vendor).not.toContain(vendor);
    }
  });

  it('refuses a LOCAL destination unless it is explicitly allowed — today\'s arrangement is the bug', () => {
    const r = backup({ BACKUP_DEST: path.join(TMP, 'beside'), BACKUP_STAGING: path.join(TMP, 'local1') });
    expect(r.status).toBe(3);
    expect(r.out).toContain('is a local path on this machine');
    expect(r.out).toContain('BACKUP_ALLOW_LOCAL_DEST=1');
    expect(fs.existsSync(path.join(TMP, 'beside'))).toBe(false);
  });

  it('refuses a URL scheme it has no uploader for, rather than pretending', () => {
    const r = backup({ BACKUP_DEST: 's3://a-bucket/ai-hr', BACKUP_STAGING: path.join(TMP, 'scheme') });
    expect(r.status).toBe(3);
    expect(r.out).toContain('BACKUP_SHIP_CMD');
  });

  it('an UNREACHABLE destination fails loudly after the dump, and leaves a FAIL status file', () => {
    const staging = path.join(TMP, 'unreachable');
    const r = backup({
      BACKUP_DEST: 'no-such-host.invalid:/srv/ai-hr-backups',
      BACKUP_SSH_OPTS: '-o BatchMode=yes -o ConnectTimeout=5',
      BACKUP_STAGING: staging,
    });
    expect(r.status).toBe(8);
    expect(verdict(r, 'BACKUP_RESULT')).toContain('BACKUP_RESULT=FAIL stage=ship exit=8');
    const status = fs.readFileSync(path.join(staging, 'backup-status.txt'), 'utf8');
    expect(status).toContain('result\tFAIL');
    expect(status).toContain('stage\tship');
    expect(status).toContain('exit_code\t8');
    // One line per field: readiness 1.6 has to be able to parse this.
    expect(status.trimEnd().split('\n').length).toBe(8);
  }, 90_000);

  it('a ship that fails means retention does NOT run — an empty destination must not be pruned into', () => {
    // A custom shipper that fails, and a pruner that would leave a footprint if it were ever reached.
    const marker = path.join(TMP, 'prune-ran');
    const r = backup({
      BACKUP_DEST: 'somewhere-of-the-owners-choosing',
      BACKUP_SHIP_CMD: 'exit 1',
      BACKUP_PRUNE_CMD: `touch '${marker}'`,
      BACKUP_STAGING: path.join(TMP, 'shipfail'),
    });
    expect(r.status).toBe(8);
    expect(fs.existsSync(marker), 'retention ran after a failed ship').toBe(false);
  });

  it('a custom shipper is handed the file and the destination, and the pruner the policy', () => {
    const trace = path.join(TMP, 'ship-trace');
    const r = backup({
      BACKUP_DEST: 'owner-chosen://bucket/prefix',
      BACKUP_SHIP_CMD: `printf 'ship %s %s\\n' "$(basename "$1")" "$2" >> '${trace}'`,
      BACKUP_PRUNE_CMD: `printf 'prune %s %s %s %s\\n' "$1" "$2" "$3" "$4" >> '${trace}'`,
      BACKUP_RETAIN_DAYS: '30',
      BACKUP_RETAIN_MIN: '9',
      BACKUP_STAGING: path.join(TMP, 'custom'),
    });
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n');
    expect(lines.filter((l) => l.startsWith('ship ')).length).toBe(2); // the dump AND its manifest
    expect(lines.some((l) => /^ship ai_hr-.*\.dump owner-chosen:\/\/bucket\/prefix$/.test(l))).toBe(true);
    expect(lines.some((l) => /^ship ai_hr-.*\.manifest owner-chosen:\/\/bucket\/prefix$/.test(l))).toBe(true);
    const prune = lines.find((l) => l.startsWith('prune '))!;
    expect(prune).toMatch(/^prune owner-chosen:\/\/bucket\/prefix \d{8}T\d{6}Z 9 ai_hr-/);
  }, 90_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Concurrency, overwriting, and the postgres client version.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('backup-db.sh — safe to run repeatedly and beside a deploy', () => {
  it('a second copy refuses while the first holds the lock, and dumps nothing', () => {
    const staging = path.join(TMP, 'locked');
    fs.mkdirSync(path.join(staging, '.lock'), { recursive: true });
    fs.chmodSync(staging, 0o700); // Meet the private-staging contract before exercising lock refusal.
    fs.writeFileSync(path.join(staging, '.lock/pid'), '424242');
    const r = backup({
      BACKUP_DEST: path.join(TMP, 'lockdest'),
      BACKUP_ALLOW_LOCAL_DEST: '1',
      BACKUP_STAGING: staging,
    });
    expect(r.status).toBe(4);
    expect(r.out).toContain('another backup is running');
    expect(r.out).toContain('424242');
    expect(fs.readdirSync(staging).filter((f) => f.endsWith('.dump'))).toEqual([]);
  });

  it('REFUSES rather than overwriting a dump that already carries this second\'s name', () => {
    const staging = path.join(TMP, 'clash');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    // The name is ai_hr-<db>-<UTC stamp>.dump. Occupy every second the script could be about to use,
    // so this is a refusal being tested and not a race being won.
    const now = Date.now();
    for (let s = 0; s < 20; s += 1) {
      const t = new Date(now + s * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      fs.writeFileSync(path.join(staging, `ai_hr-${SRC_DB}-${t}.dump`), 'not to be overwritten');
    }
    // The dumps only: the run also writes backup-status.txt into staging, which is the point of the
    // status file and not a file this assertion is about.
    const snapshot = (d: string) =>
      fs.readdirSync(d)
        .filter((f) => f.endsWith('.dump'))
        .map((f) => [f, fs.readFileSync(path.join(d, f), 'utf8')]);
    const before = snapshot(staging);
    const r = backup({
      BACKUP_DEST: path.join(TMP, 'clashdest'),
      BACKUP_ALLOW_LOCAL_DEST: '1',
      BACKUP_STAGING: staging,
    });
    expect(r.status).toBe(4);
    expect(r.out).toContain('Refusing to overwrite a backup');
    expect(snapshot(staging)).toEqual(before);
  });

  it('REFUSES a pg_dump older than the server instead of writing an archive nothing can read', () => {
    // PG14 shadows psql on PATH on this machine and the cluster is 16; a dump taken with the wrong
    // client is a restore failure deferred to the worst possible day. The fake client makes the
    // refusal testable without depending on which postgres versions happen to be installed.
    const r = backup({
      BACKUP_DEST: path.join(TMP, 'vdest'),
      BACKUP_ALLOW_LOCAL_DEST: '1',
      BACKUP_STAGING: path.join(TMP, 'version'),
      PG_BIN: fakeOldClientBin(11),
    });
    expect(r.status).toBe(5);
    expect(r.out).toMatch(/holds pg_dump 11, but the server is PostgreSQL \d+/);
    expect(verdict(r, 'BACKUP_RESULT')).toContain('stage=client exit=5');
  });

  it('the dump it DID take was written by a client at least as new as the server', () => {
    const m = fs.readFileSync(GOOD_MANIFEST, 'utf8');
    const clientMajor = Number(/^dump_client_major\t(\d+)$/m.exec(m)![1]);
    const serverMajor = Number(/^server_major\t(\d+)$/m.exec(m)![1]);
    expect(clientMajor).toBeGreaterThanOrEqual(serverMajor);
    // …and it did NOT simply take whatever `pg_dump` on PATH is, which here is older than the server.
    const onPath = spawnSync('/bin/bash', ['-c', 'pg_dump --version'], { encoding: 'utf8' }).stdout;
    const pathMajor = Number(/\(PostgreSQL\) (\d+)/.exec(onPath)?.[1] ?? '0');
    if (pathMajor > 0 && pathMajor < serverMajor) {
      expect(clientMajor, 'the script inherited the too-old pg_dump from PATH').not.toBe(pathMajor);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. Retention: it deletes the right things and keeps the right things.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function seedDest(dir: string, stamps: string[], extras: string[] = []): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of stamps) {
    fs.writeFileSync(path.join(dir, `ai_hr-${SRC_DB}-${s}.dump`), 'old');
    fs.writeFileSync(path.join(dir, `ai_hr-${SRC_DB}-${s}.manifest`), 'old');
  }
  for (const e of extras) fs.writeFileSync(path.join(dir, e), 'not ours');
}
const stamp = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

describe('backup-db.sh — retention', () => {
  it('deletes what is outside the window and keeps what is inside it, manifests included', () => {
    const dest = path.join(TMP, 'ret1');
    const old = [stamp(40), stamp(30), stamp(21), stamp(16)];
    const recent = [stamp(10), stamp(6), stamp(3), stamp(1)];
    const decoys = ['README.txt', `ai_hr-${SRC_DB}-notastamp.dump`, 'ai_hr-someotherdb-20260101T010000Z.dump'];
    seedDest(dest, [...old, ...recent], decoys);
    const r = backup({
      BACKUP_DEST: dest,
      BACKUP_ALLOW_LOCAL_DEST: '1',
      BACKUP_STAGING: path.join(TMP, 'ret1stage'),
      BACKUP_RETAIN_DAYS: '14',
      BACKUP_RETAIN_MIN: '3',
    });
    expect(r.status).toBe(0);
    const left = new Set(fs.readdirSync(dest));
    // Four inside the window, plus the one just taken, and their manifests.
    for (const s of recent) {
      expect(left.has(`ai_hr-${SRC_DB}-${s}.dump`), `${s} was inside the window`).toBe(true);
      expect(left.has(`ai_hr-${SRC_DB}-${s}.manifest`), `${s}.manifest`).toBe(true);
    }
    for (const s of old) {
      expect(left.has(`ai_hr-${SRC_DB}-${s}.dump`), `${s} was outside the window`).toBe(false);
      expect(left.has(`ai_hr-${SRC_DB}-${s}.manifest`), `${s}.manifest should have gone too`).toBe(false);
    }
    for (const d of decoys) expect(left.has(d), `${d} is not this script's file`).toBe(true);
    expect([...left].filter((f) => /^ai_hr-.*\.dump$/.test(f) && !decoys.includes(f)).length).toBe(recent.length + 1);
  }, 90_000);

  it('the floor holds: when EVERYTHING is older than the window it still keeps the newest N', () => {
    // `find -mtime +14 -delete` on a machine that has been off for a month deletes every backup it
    // has and reports success. This is the case that rule fails and this one does not.
    const dest = path.join(TMP, 'ret2');
    // ONE clock reading. `stamp(50)` called twice a second apart returns two different names, and the
    // assertion would then compare a file against a name nothing ever wrote.
    const ancient = [100, 90, 80, 70, 60, 50].map(stamp);
    seedDest(dest, ancient);
    const r = backup({
      BACKUP_DEST: dest,
      BACKUP_ALLOW_LOCAL_DEST: '1',
      BACKUP_STAGING: path.join(TMP, 'ret2stage'),
      BACKUP_RETAIN_DAYS: '14',
      BACKUP_RETAIN_MIN: '4',
    });
    expect(r.status).toBe(0);
    const dumps = fs.readdirSync(dest).filter((f) => f.endsWith('.dump')).sort().reverse();
    // The new one, plus the three newest ancient ones = the floor of 4.
    expect(dumps.length).toBe(4);
    expect(dumps.slice(1)).toEqual(
      [ancient[5], ancient[4], ancient[3]].map((s) => `ai_hr-${SRC_DB}-${s}.dump`),
    );
  }, 90_000);

  it('a retention floor of zero is refused rather than obeyed', () => {
    const r = backup({
      BACKUP_DEST: path.join(TMP, 'ret3'),
      BACKUP_ALLOW_LOCAL_DEST: '1',
      BACKUP_STAGING: path.join(TMP, 'ret3stage'),
      BACKUP_RETAIN_MIN: '0',
    });
    expect(r.status).toBe(2);
    expect(r.out).toContain('is not a retention policy');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4. The manifest — what the rehearsal is given to check against.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('backup-db.sh — the manifest describes the database, not the file', () => {
  it('records exact per-table row counts, RLS flags and policy counts', () => {
    const m = fs.readFileSync(GOOD_MANIFEST, 'utf8');
    const tables = m.split('\n').filter((l) => l.startsWith('table\t')).sort();
    expect(tables).toEqual([
      'table\tdrizzle\t__drizzle_migrations\t465\tf\t0',
      'table\tpublic\tcompany\t5\tt\t1',
      'table\tpublic\temployment\t60\tt\t2',
      'table\tpublic\tpayslip\t120\tt\t1',
      // RLS deliberately OFF on this one in the fixture: a manifest that always printed 't' would pass
      // every other assertion here.
      'table\tpublic\tplatform_note\t4\tf\t0',
      'table\tpublic\ttenant\t2\tt\t1',
    ]);
    expect(m).toContain('migrations\t465');
  });

  it('records what the APPLICATION role can see through RLS, with and without a tenant context', () => {
    const m = fs.readFileSync(GOOD_MANIFEST, 'utf8');
    expect(m).toContain('probe_status\tok');
    expect(m).toContain(`app_role\t${APP_ROLE}`);
    const probe = m.split('\n').filter((l) => /^probe_(ctx|noctx)\t/.test(l)).sort();
    expect(probe).toEqual([
      // Tenant One's share only — 3 of 5 companies, 40 of 60 employments, 80 of 120 payslips.
      'probe_ctx\tpublic\tcompany\t3',
      'probe_ctx\tpublic\temployment\t40',
      'probe_ctx\tpublic\tpayslip\t80',
      'probe_noctx\tpublic\tcompany\t0',
      'probe_noctx\tpublic\temployment\t0',
      'probe_noctx\tpublic\tpayslip\t0',
    ]);
  });

  it('records the checksum and the client that wrote the archive', () => {
    const m = fs.readFileSync(GOOD_MANIFEST, 'utf8');
    expect(m).toContain(`dump_sha256\t${sha256(GOOD_DUMP)}`);
    expect(m).toContain(`dump_bytes\t${fs.statSync(GOOD_DUMP).size}`);
    expect(m).toMatch(/^dump_client_version\t\d+\./m);
  });

  it('says so, loudly, when it could not probe as the application role', () => {
    const dest = path.join(TMP, 'noprobe');
    const r = run(BACKUP_SH, [], {
      BACKUP_DATABASE_URL: SRC_ADMIN_URL, // and no BACKUP_APP_DATABASE_URL / DATABASE_URL
      BACKUP_DEST: dest,
      BACKUP_ALLOW_LOCAL_DEST: '1',
      BACKUP_STAGING: path.join(TMP, 'noprobestage'),
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain('PASS-WEAK-PROBE');
    const manifest = path.join(dest, fs.readdirSync(dest).find((f) => f.endsWith('.manifest'))!);
    expect(fs.readFileSync(manifest, 'utf8')).toContain('probe_status\tskipped');
  }, 90_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5. THE REHEARSAL PASSES on a good backup…
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('restore-rehearsal.sh — a good backup', () => {
  it('restores it, verifies it, times it and writes the outcome down', () => {
    const r = rehearse(GOOD_DUMP);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('schema and row counts identical to the manifest');
    expect(r.out).toContain(`the application role '${APP_ROLE}' sees exactly what it saw at backup time`);
    expect(r.out).toContain('isolation survived the restore');
    const v = verdict(r, 'RESTORE_REHEARSAL_RESULT');
    expect(v).toContain('RESTORE_REHEARSAL_RESULT=PASS');
    expect(v).toContain('failed_checks=0');
    // TIMED, and the number is real rather than a placeholder.
    const secs = Number(/restore_seconds=([\d.]+)/.exec(v)![1]);
    expect(secs).toBeGreaterThan(0);
    // WRITTEN DOWN — the 2026-09-11 rehearsal left a log with no verdict in it at all.
    const log = fs.readFileSync(path.join(TMP, 'rehearsal.log'), 'utf8').trim().split('\n');
    const last = log[log.length - 1];
    expect(last).toContain('result=PASS');
    expect(last).toMatch(/total_seconds=[\d.]+/);
    expect(last.split('\n').length).toBe(1);
  }, 180_000);

  it('drops its scratch database after a pass', async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      const rows = await admin.unsafe(`SELECT 1 FROM pg_database WHERE datname = '${SCRATCH_DB}'`);
      expect(rows.length).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('keeps it with --keep, and the restored database is the source database', async () => {
    const r = rehearse(GOOD_DUMP, {}, ['--keep']);
    expect(r.status, r.out).toBe(0);
    const scratch = postgres(withDb(ADMIN_URL, SCRATCH_DB), { max: 1, onnotice: () => {} });
    try {
      const [{ count }] = await scratch.unsafe('SELECT count(*)::int AS count FROM public.employment');
      expect(count).toBe(60);
    } finally {
      await scratch.end();
    }
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 6. …AND FAILS ON A DAMAGED ONE. This is the half the box has never had.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('restore-rehearsal.sh — a rehearsal that cannot fail is not a rehearsal', () => {
  it('a TRUNCATED dump is rejected before it is restored', () => {
    const bad = path.join(TMP, 'trunc.dump');
    const whole = fs.readFileSync(GOOD_DUMP);
    fs.writeFileSync(bad, whole.subarray(0, Math.floor(whole.length / 2)));
    fs.copyFileSync(GOOD_MANIFEST, path.join(TMP, 'trunc.manifest'));
    const r = rehearse(bad);
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/the dump is \d+ bytes; the manifest says \d+/);
    expect(verdict(r, 'RESTORE_REHEARSAL_RESULT')).toContain('RESTORE_REHEARSAL_RESULT=FAIL stage=integrity');
  }, 60_000);

  it('a dump whose bytes were altered is rejected on its checksum', () => {
    const bad = path.join(TMP, 'corrupt.dump');
    const whole = Buffer.from(fs.readFileSync(GOOD_DUMP));
    whole.fill(0x58, Math.floor((whole.length * 3) / 4), Math.floor((whole.length * 3) / 4) + 64);
    fs.writeFileSync(bad, whole);
    fs.copyFileSync(GOOD_MANIFEST, path.join(TMP, 'corrupt.manifest'));
    const r = rehearse(bad);
    expect(r.status).toBe(3);
    expect(r.out).toContain('sha256 mismatch');
    // Named explicitly because it is the reason the checksum exists: `pg_restore --list` reads only
    // the header and succeeds on this file unchanged, so a "does it parse" check would pass it.
    expect(r.out).not.toContain('pg_restore completed');
  }, 60_000);

  it('a TRUNCATED dump with the manifest re-stamped to match is caught by pg_restore itself', () => {
    const bad = path.join(TMP, 'trunc2.dump');
    const whole = fs.readFileSync(GOOD_DUMP);
    fs.writeFileSync(bad, whole.subarray(0, Math.floor(whole.length / 2)));
    restamp(GOOD_MANIFEST, bad, path.join(TMP, 'trunc2.manifest'));
    const r = rehearse(bad);
    expect(r.status).toBe(7);
    expect(r.out).toContain('pg_restore exited');
    expect(verdict(r, 'RESTORE_REHEARSAL_RESULT')).toContain('stage=restore exit=7');
    // Kept for inspection, and said so, rather than tidied away.
    expect(r.out).toContain('kept for inspection');
  }, 90_000);

  it('A DUMP THAT RESTORES PERFECTLY AND CANNOT BE USED IS REJECTED', async () => {
    // THE HEADLINE. --no-privileges produces an archive that restores with no errors, in which every
    // table and every row is present and correct — and on which the application role holds nothing.
    // Every count a superuser takes agrees with the manifest. The product could not read one row of it.
    const bad = path.join(TMP, 'nopriv.dump');
    pgDumpSource(bad, ['--no-privileges']);
    restamp(GOOD_MANIFEST, bad, path.join(TMP, 'nopriv.manifest'));
    const r = rehearse(bad, {}, ['--keep']);
    expect(r.status).toBe(8);
    // It really did restore, and the owner-side verification really did pass. Without these two the
    // test would not be showing the difference it claims to show.
    expect(r.out).toContain('pg_restore completed in');
    expect(r.out).toContain('schema and row counts identical to the manifest');
    // And it failed anyway.
    expect(r.out).toContain('what the application role can read has CHANGED');
    expect(r.out).toContain('THE RESTORE IS NOT USABLE');
    expect(verdict(r, 'RESTORE_REHEARSAL_RESULT')).toContain('stage=verify exit=8');
    // Independently confirm the claim this test is making about the restored database: rows are there,
    // and the application role cannot see them.
    const owner = postgres(withDb(ADMIN_URL, SCRATCH_DB), { max: 1, onnotice: () => {} });
    try {
      const [{ count }] = await owner.unsafe('SELECT count(*)::int AS count FROM public.employment');
      expect(count).toBe(60);
      const [{ ok }] = await owner.unsafe(
        `SELECT has_table_privilege('${APP_ROLE}', 'public.employment', 'SELECT') AS ok`,
      );
      expect(ok).toBe(false);
    } finally {
      await owner.end();
    }
  }, 180_000);

  it('a dump missing rows is rejected, with the table and both counts named', async () => {
    const src = postgres(SRC_ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await src.unsafe('DELETE FROM public.payslip WHERE net > 1100');
    } finally {
      await src.end();
    }
    const bad = path.join(TMP, 'short.dump');
    pgDumpSource(bad, []);
    restamp(GOOD_MANIFEST, bad, path.join(TMP, 'short.manifest'));
    await rebuildSource(); // put the source back before anything else uses it
    const r = rehearse(bad);
    expect(r.status).toBe(8);
    expect(r.out).toContain('the restored database does not match the manifest');
    expect(r.out).toContain('-table\tpublic\tpayslip\t120\tt\t1');
    expect(r.out).toContain('+table\tpublic\tpayslip\t100\tt\t1');
  }, 180_000);

  it('a restore that lost ROW-LEVEL SECURITY is rejected', async () => {
    const src = postgres(SRC_ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await src.unsafe('ALTER TABLE public.company DISABLE ROW LEVEL SECURITY');
      await src.unsafe('ALTER TABLE public.payslip DISABLE ROW LEVEL SECURITY');
    } finally {
      await src.end();
    }
    const bad = path.join(TMP, 'norls.dump');
    pgDumpSource(bad, []);
    restamp(GOOD_MANIFEST, bad, path.join(TMP, 'norls.manifest'));
    await rebuildSource();
    const r = rehearse(bad);
    expect(r.status).toBe(8);
    expect(r.out).toContain('-table\tpublic\tcompany\t5\tt\t1');
    expect(r.out).toContain('+table\tpublic\tcompany\t5\tf\t1');
    expect(r.out).toContain('what the application role can read has CHANGED');
  }, 180_000);

  it('does not claim isolation for a database the application role cannot read at all', () => {
    // The trap this check sets for itself. "Zero rows with no tenant context" is trivially true when
    // the role has no privileges, which is the --no-privileges case above — so a rehearsal that
    // reported "isolation survived" there would be handing out a green tick on the broken database.
    const bad = path.join(TMP, 'nopriv.dump');
    const r = rehearse(bad);
    expect(r.out).not.toContain('isolation survived the restore');
    expect(r.out).toContain('Isolation cannot be');
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 7. The failure that actually happened here, and the ones adjacent to it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('restore-rehearsal.sh — the 2026-09-11 failure class', () => {
  it('an unreachable target cluster is a named stage and a verdict line, not a buried pg_restore error', () => {
    const r = rehearse(GOOD_DUMP, {
      REHEARSAL_DATABASE_URL: withDb(ADMIN_URL, 'postgres').replace(/:\d+\//, ':1/'),
      REHEARSAL_APP_DATABASE_URL: withDb(process.env.TEST_DATABASE_URL!, 'postgres').replace(/:\d+\//, ':1/'),
    });
    expect(r.status).toBe(6);
    expect(r.out).toContain('cannot reach the rehearsal cluster');
    const v = verdict(r, 'RESTORE_REHEARSAL_RESULT');
    expect(v).toContain('RESTORE_REHEARSAL_RESULT=FAIL');
    // The whole point: the outcome log gets a line saying it FAILED. On 2026-09-11 it got nothing, so
    // "the rehearsal failed" and "the rehearsal was never run" were indistinguishable afterwards.
    const log = fs.readFileSync(path.join(TMP, 'rehearsal.log'), 'utf8').trim().split('\n');
    expect(log[log.length - 1]).toContain('result=FAIL');
  }, 90_000);

  it('creates the target itself — it does not need to pre-exist', async () => {
    // The 2026-09-11 run was `pg_restore -d ai_hr_rehearsal` against a database nobody had created.
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
    const r = rehearse(GOOD_DUMP);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('created and reachable');
    expect(r.out.indexOf('created and reachable')).toBeLessThan(r.out.indexOf('pg_restore completed'));
  }, 180_000);

  it('refuses a scratch name that could address a different database than the one it created', () => {
    // THIS TEST EXISTS BECAUSE THE ONE BEFORE IT WAS VACUOUS, and finding that out found a real bug.
    //
    // The first version of this block tried to induce "created but unreachable" and asserted only on
    // the "created and reachable" line, which prints either way — deleting the connectivity check from
    // the script left it green. Probing for a way to induce the failure turned up the actual defect:
    // blib_url_with_db was a sed substitution using `#` as its delimiter, so a database name
    // containing `#` made sed fail and the function return an EMPTY string — and psql handed an empty
    // -d falls back to the local socket and the user's own database, silently. The rehearsal would
    // have inspected a different server and reported on it without a word.
    //
    // Both halves are now pinned: the URL builder (below) and this refusal. The connectivity probe in
    // the script stays as belt-and-braces; it is NOT claimed to be pinned here, because a superuser
    // connecting to a database it has just created cannot be made to fail without contrivance, and a
    // contrived guard is the thing this file is trying not to be. (It is not decorative either: when
    // the sed version was put back to check this test could fail, the probe fired for real and the run
    // ended `stage=target exit=6 … created "…" but cannot connect to it`, before pg_restore.)
    for (const bad of ['ai_hr_r291#rehearsal', 'ai_hr rehearsal', 'ai_hr_rehearsal/x', 'ai_hr_rehearsal?x']) {
      const r = run(REHEARSAL_SH, ['--dump', GOOD_DUMP, '--scratch', bad], {
        REHEARSAL_DATABASE_URL: ADMIN_URL,
      });
      expect(r.status, bad).toBe(2);
      expect(r.out, bad).toContain('is not a plain identifier');
    }
  }, 60_000);

  it('the URL builder keeps credentials and parameters and never returns nothing', () => {
    const call = (url: string, db: string) =>
      spawnSync('/bin/bash', ['-c', `. ${REPO}/scripts/backup-lib.sh; blib_url_with_db '${url}' '${db}'`], {
        encoding: 'utf8',
      });
    const a = call('postgres://u:p@h:5433/postgres?sslmode=require', 'ai_hr_rehearsal');
    expect(a.stdout.trim()).toBe('postgres://u:p@h:5433/ai_hr_rehearsal?sslmode=require');
    const b = call('postgres://u@h/db', 'a#b');
    // The delimiter that used to break it. It must produce something, or refuse — never empty at exit 0.
    expect(b.stdout.trim()).not.toBe('');
    const c = call('not-a-url', 'x');
    expect(c.status, 'a URL it cannot parse must FAIL, not return an empty string').not.toBe(0);
  });

  it('refuses a dump with no manifest — which is every dump on the production box', () => {
    const orphan = path.join(TMP, 'orphan.dump');
    fs.copyFileSync(GOOD_DUMP, orphan);
    const r = rehearse(orphan);
    expect(r.status).toBe(3);
    expect(r.out).toContain('cannot be VERIFIED');
    expect(r.out).toContain('Every dump currently on the production box is in this category');
  });

  it('refuses a scratch name that does not announce itself, and one that is the source database', () => {
    const a = run(REHEARSAL_SH, ['--dump', GOOD_DUMP, '--scratch', 'ai_hr'], {
      REHEARSAL_DATABASE_URL: ADMIN_URL,
    });
    expect(a.status).toBe(2);
    expect(a.out).toContain("does not contain 'rehearsal'");
    const b = run(REHEARSAL_SH, ['--dump', GOOD_DUMP, '--scratch', SRC_DB, 'REHEARSAL_ALLOW_ANY_NAME=1'], {
      REHEARSAL_DATABASE_URL: ADMIN_URL,
    });
    expect(b.status).toBe(2);
  });

  it('refuses a pg_restore too old for the archive rather than half-restoring', () => {
    const r = rehearse(GOOD_DUMP, { PG_BIN: fakeOldClientBin(9) });
    expect(r.status).toBe(4);
    expect(r.out).toContain('cannot read an archive written by pg_dump');
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 8. Source and documentation shape — stated as such. See the file header for why these two are not
//    executable: one is a property of the whole text rather than of any run, and the other is prose.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('source shape (not executable — see file header)', () => {
  const backupSrc = fs.readFileSync(BACKUP_SH, 'utf8');
  const rehearsalSrc = fs.readFileSync(REHEARSAL_SH, 'utf8');
  const libSrc = fs.readFileSync(path.join(REPO, 'scripts/backup-lib.sh'), 'utf8');

  /**
   * Executable lines only. All three files DISCUSS object storage at length in their headers — naming
   * rclone and restic as examples of what BACKUP_SHIP_CMD is FOR is the opposite of choosing one for
   * the owner, and a substring search over the whole text would answer a question about prose. What
   * these assertions are about is what the scripts can RUN.
   */
  const codeLines = (src: string) =>
    src.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));

  it('no credential of any provider is read anywhere in these files', () => {
    // Whole text, comments included: a credential named even in a comment is a credential this repo
    // has an opinion about, and it should not.
    const all = `${backupSrc}\n${rehearsalSrc}\n${libSrc}`;
    for (const token of [
      'AWS_ACCESS_KEY', 'AWS_SECRET', 'AWS_SESSION', 'AZURE_STORAGE', 'GOOGLE_APPLICATION_CREDENTIALS',
      'B2_APPLICATION_KEY', 'RESTIC_PASSWORD', 'SECRET_ACCESS', 'ACCESS_KEY_ID',
    ]) {
      expect(all, token).not.toContain(token);
    }
  });

  it('the shipper can only be rsync, a local copy, or the owner\'s own command', () => {
    // The refusal message names S3, B2 and rclone as examples of what BACKUP_SHIP_CMD is FOR, which is
    // the opposite of choosing one — so the scan is over the code that actually MOVES the file, not
    // over prose. Anything else reaching a provider would have to be here.
    const from = backupSrc.indexOf('ship_one() {');
    expect(from).toBeGreaterThan(-1);
    const shipOne = backupSrc.slice(from, backupSrc.indexOf('\n}', from));
    expect(shipOne).toContain('rsync -a');
    expect(shipOne).toContain('$BACKUP_SHIP_CMD');
    for (const v of ['aws', 's3', 'gsutil', 'gcloud', 'az ', 'b2 ', 'rclone', 'restic', 'curl', 'wget']) {
      expect(shipOne.toLowerCase(), v).not.toContain(v);
    }
  });

  it('BACKUP_DEST has no default value anywhere', () => {
    // `${BACKUP_DEST:-something}` would reintroduce exactly the silent local write this item is about.
    expect(codeLines(backupSrc)).toContain('DEST="${BACKUP_DEST:-}"');
    // `[^}]`, not `\\S`: `${BACKUP_DEST:-}` itself ends in `}` and the looser pattern matched the one
    // line the assertion is supposed to accept.
    expect(codeLines(backupSrc).filter((l) => /BACKUP_DEST:-[^}]/.test(l))).toEqual([]);
  });

  it('neither script is wired into the deploy path or into cron by this round', () => {
    // Deliberate: scheduling is an owner decision (readiness 1.6 owns "who hears about a failure"),
    // and a pre-deploy dump that silently could not ship would block every deploy. DEPLOY.md documents
    // both, and the readiness item stays unticked for the parts that are installation.
    const deploy = fs.readFileSync(path.join(REPO, 'deploy/deploy.sh'), 'utf8');
    const customer = fs.readFileSync(path.join(REPO, 'deploy/deploy-customer.sh'), 'utf8');
    expect(deploy).not.toContain('backup-db.sh');
    expect(customer).not.toContain('backup-db.sh');
  });

  it('DEPLOY.md documents backup, restore and rollback — it mentioned none of the three before', () => {
    const md = fs.readFileSync(path.join(REPO, 'deploy/DEPLOY.md'), 'utf8');
    expect(md).toContain('scripts/backup-db.sh');
    expect(md).toContain('scripts/restore-rehearsal.sh');
    expect(md).toMatch(/^## Backups, restore and rollback/m);
    expect(md).toContain('BACKUP_DEST');
  });

  it('the readiness checklist records what was built and what is still the owner\'s to decide', () => {
    const md = fs.readFileSync(path.join(REPO, 'docs/CUSTOMER-DEPLOYMENT-READINESS.md'), 'utf8');
    const section = md.slice(md.indexOf('### 1.5'), md.indexOf('### 1.6'));
    expect(section).toContain('scripts/backup-db.sh');
    expect(section).toContain('scripts/restore-rehearsal.sh');
    // The two boxes that cannot be ticked from inside the repo are still unticked.
    expect(section).toMatch(/- \[ \] .*off-box/);
    expect(section).toMatch(/- \[ \] .*point-in-time/i);
  });
});
