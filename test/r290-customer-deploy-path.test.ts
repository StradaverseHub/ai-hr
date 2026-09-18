/**
 * r290 / readiness 1.1 — the deploy path cannot seed demo data into a customer's database.
 *
 * THE DEFECT, as it stood on main@dbdfa8c5: `deploy/deploy.sh` hard-required `DEV_TENANT_ID` before it
 * would start, and ran `db/seed.ts` whenever that tenant row was ABSENT from the target database. On a
 * fresh customer database the row is always absent, so the seeder always ran — and `db/seed.ts` opens
 * with `TRUNCATE` over 24 tables and plants a fictional "Demo Group" tenant. `deploy/DEPLOY.md:111`
 * told the operator to leave the demo variables "as-is". Following the runbook on a customer's box
 * planted Demo Group in their production database on the first deploy.
 *
 * WHAT IS PINNED HERE, AND HOW HARD
 *
 * The shell half of this is pinned BY EXECUTION, not by grepping the script. `deploy.sh` is run for
 * real, in a throwaway directory, against a PATH of shims (`pnpm`, `node`, `psql`, `sudo`,
 * `systemctl`, `sha256sum`) that record every invocation into a trace file and exit 0. So
 * "the customer path contains no reachable call to the seeder" is not an argument about control flow:
 * the script runs end to end and `db/seed.ts` is absent from the trace of what it actually invoked.
 * The same harness proves the demo path DOES invoke it, which is the only way a test can notice that a
 * safety change has broken the deploy this box runs every round.
 *
 * Two things here are pinned by SOURCE SHAPE instead, and deliberately:
 *   • that `deploy/deploy.sh` names `db/seed.ts` exactly once. Execution can prove a call did not
 *     happen on the paths exercised; it cannot prove a second, differently-guarded call was never
 *     added somewhere the harness does not reach. The count is the thing that keeps "unreachable in
 *     customer mode" a property of one branch rather than of several.
 *   • that `deploy/deploy-customer.sh` never names it at all.
 * Both are stated rather than hidden because a reader should be able to tell the difference between a
 * shape assertion made on purpose and one made out of laziness.
 *
 * The seeder's own refusal is pinned twice over: as a pure function (`db/seed-guard.ts`, the whole
 * decision matrix) and as a real subprocess — the process is spawned under the production condition
 * and must exit non-zero BEFORE it opens a connection, and spawned under the demo condition and must
 * get PAST the guard to the database. The second half is what stops the refusal from being a blanket
 * "never seed", which would silently break `pnpm db:seed` and `./deploy/deploy.sh --reseed`.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEMO_TENANT_ID,
  DESTROY_OVERRIDE,
  demoSeedRefusal,
  foreignTenantRefusal,
  realAuthKeys,
  SYSTEM_AUTH_AUDIT_TENANT_ID,
} from '../db/seed-guard';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DEPLOY_SH = fs.readFileSync(path.join(REPO, 'deploy/deploy.sh'), 'utf8');
const DEPLOY_CUSTOMER_SH = fs.readFileSync(path.join(REPO, 'deploy/deploy-customer.sh'), 'utf8');

/**
 * Executable lines only. Both scripts DISCUSS `db/seed.ts` at length in their headers — that is the
 * point of the headers — so a naive substring count would answer a question about prose. What these
 * assertions are about is how many places can RUN it.
 */
function codeLines(script: string): string[] {
  return script.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
}

/** A URL that is well-formed and points at a port nothing listens on, so a connection attempt is loud. */
const DEAD_DB = 'postgresql://seedguard:seedguard@127.0.0.1:1/seedguard_should_not_exist';

// ─────────────────────────────────────────────────────────────────────────────
// The shim harness: a throwaway repo with deploy.sh in it and nothing real on PATH.
// ─────────────────────────────────────────────────────────────────────────────

const SHIMS = ['pnpm', 'node', 'psql', 'sudo', 'systemctl'] as const;

function shimRepo(envProduction: string): { dir: string; trace: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r290-deploy-'));
  fs.mkdirSync(path.join(dir, 'deploy'));
  // Must EXIST (deploy.sh's lockfile-marker branch writes into it) but stay empty, so the install
  // branch is the one a first deploy takes.
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const f of ['deploy.sh', 'deploy-customer.sh']) {
    fs.copyFileSync(path.join(REPO, 'deploy', f), path.join(dir, 'deploy', f));
    fs.chmodSync(path.join(dir, 'deploy', f), 0o755);
  }
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfile: not a real one\n');
  fs.writeFileSync(path.join(dir, '.env.production'), envProduction);

  const trace = path.join(dir, 'trace.log');
  for (const cmd of SHIMS) {
    const p = path.join(dir, 'bin', cmd);
    fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${cmd} $*" >> "$DEPLOY_TRACE"\nexit 0\n`);
    fs.chmodSync(p, 0o755);
  }
  // sha256sum has to produce something `cut -d' ' -f1` can read, and macOS has no sha256sum at all.
  const sha = path.join(dir, 'bin', 'sha256sum');
  fs.writeFileSync(
    sha,
    `#!/bin/sh\nprintf '%s\\n' "sha256sum $*" >> "$DEPLOY_TRACE"\nprintf 'deadbeefdeadbeef  %s\\n' "$1"\nexit 0\n`,
  );
  fs.chmodSync(sha, 0o755);
  return { dir, trace };
}

type DeployRun = { status: number | null; stdout: string; stderr: string; trace: string };

function runDeploy(script: 'deploy.sh' | 'deploy-customer.sh', args: string[], envProduction: string): DeployRun {
  const { dir, trace } = shimRepo(envProduction);
  const r = spawnSync('/bin/bash', [path.join(dir, 'deploy', script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    // The shim directory FIRST, and nothing from this process's environment: deploy.sh sources
    // .env.production itself, and an inherited DEV_TENANT_ID would make the "not required" tests lie.
    // (Cast because this repo augments NodeJS.ProcessEnv with required keys; the child gets exactly
    // these three and no more, which is the point.)
    env: {
      PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: dir,
      DEPLOY_TRACE: trace,
    } as unknown as NodeJS.ProcessEnv,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '',
  };
}

// r290 INTEGRATION FIX. Both fixtures carry SHARE_PASSWORD because readiness 1.4 — landed in the same
// round, on a different branch — made it a hard `: "${SHARE_PASSWORD:?…}"` preflight in deploy/deploy.sh,
// ABOVE everything these tests exercise. Without it the script exits 1 before it reaches any seeder
// decision, and every assertion below fails as `expected 1 to be +0` while saying nothing about seeding.
//
// These fixtures stand in for deploy/.env.customer.example and deploy/.env.production.example, and BOTH
// of those templates set SHARE_PASSWORD — so including it here makes the fixture match the thing it is
// modelling rather than weakening the test. The refusal itself is pinned separately, in
// test/share-gate.test.ts; do not re-pin it here by deleting this line.
const CUSTOMER_ENV = [
  'NODE_ENV=production',
  `MIGRATION_DATABASE_URL=${DEAD_DB}`,
  `DATABASE_URL=${DEAD_DB}`,
  'SHARE_PASSWORD=fixture-not-a-real-secret',
  '',
].join('\n');

const DEMO_ENV = [
  'NODE_ENV=production',
  `MIGRATION_DATABASE_URL=${DEAD_DB}`,
  `DATABASE_URL=${DEAD_DB}`,
  'SHARE_PASSWORD=fixture-not-a-real-secret',
  'ALLOW_DEMO_SESSION=true',
  `DEV_TENANT_ID=${DEMO_TENANT_ID}`,
  '',
].join('\n');

describe('r290 harness precondition', () => {
  it('no real /opt/node20/bin on this machine, so the shims are what deploy.sh finds', () => {
    // deploy.sh line ~28 prepends /opt/node20/bin to PATH when it exists. On the server that is the
    // point; here it would shadow the `node` shim and every trace assertion below would be vacuous.
    expect(fs.existsSync('/opt/node20/bin')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The customer deploy path: no reachable seeder, no DEV_TENANT_ID.
// ─────────────────────────────────────────────────────────────────────────────

describe('the customer deploy path cannot reach the demo seeder', () => {
  it('deploy.sh --customer runs to the end and NEVER invokes db/seed.ts', () => {
    const r = runDeploy('deploy.sh', ['--customer'], CUSTOMER_ENV);
    expect(r.status).toBe(0);
    expect(r.trace).not.toContain('db/seed.ts');
    // and it really did deploy — otherwise "no seed" would be trivially true of a script that died.
    expect(r.trace).toContain('pnpm build');
    expect(r.trace).toContain('pnpm db:migrate');
    expect(r.trace).toContain('scripts/seed-catalogs.ts');
    expect(r.stdout).toContain('the demo seeder was not run');
  });

  it('deploy-customer.sh runs to the end and NEVER invokes db/seed.ts', () => {
    const r = runDeploy('deploy-customer.sh', [], CUSTOMER_ENV);
    expect(r.status).toBe(0);
    expect(r.trace).not.toContain('db/seed.ts');
    expect(r.trace).toContain('pnpm db:migrate');
  });

  it('the customer path does not even probe the tenant table for the demo tenant', () => {
    // The pre-r290 probe was `psql … SELECT 1 FROM tenant WHERE id='$DEV_TENANT_ID'`, and its ABSENCE
    // is what proves the whole branch was skipped rather than merely taking its else.
    const r = runDeploy('deploy-customer.sh', [], CUSTOMER_ENV);
    expect(r.status).toBe(0);
    expect(r.trace).not.toContain('psql');
  });

  it('a customer .env.production needs no DEV_TENANT_ID (it was hard-required before r290)', () => {
    expect(CUSTOMER_ENV).not.toContain('DEV_TENANT_ID');
    const r = runDeploy('deploy-customer.sh', [], CUSTOMER_ENV);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('DEV_TENANT_ID');
  });

  it('--migrate-only still works on the customer path', () => {
    const r = runDeploy('deploy-customer.sh', ['--migrate-only'], CUSTOMER_ENV);
    expect(r.status).toBe(0);
    expect(r.trace).toContain('pnpm db:migrate');
    expect(r.trace).not.toContain('db/seed.ts');
    expect(r.trace).not.toContain('systemctl restart');
  });

  it('--reseed is REFUSED rather than ignored when this is not a demo deployment', () => {
    const r = runDeploy('deploy-customer.sh', ['--reseed'], CUSTOMER_ENV);
    expect(r.status).not.toBe(0);
    // The demo-mode refusal specifically, not merely "some non-zero exit": a script that rejected
    // --customer as an unknown argument would also exit non-zero, and would prove nothing.
    expect(r.stdout + r.stderr).toContain('not in demo mode');
    expect(r.trace).not.toContain('db/seed.ts');
    // Refused BEFORE anything was built or migrated.
    expect(r.trace).not.toContain('pnpm build');
  });

  it('--customer and --demo together are refused rather than silently resolved', () => {
    const r = runDeploy('deploy.sh', ['--customer', '--demo'], CUSTOMER_ENV);
    expect(r.status).not.toBe(0);
    expect(r.trace).not.toContain('db/seed.ts');
  });

  it('a .env.production with no ALLOW_DEMO_SESSION skips the seed even on a plain ./deploy/deploy.sh', () => {
    // The operator who copies deploy/.env.customer.example and then types the command they have always
    // typed. This is the case the readiness item was actually about.
    const r = runDeploy('deploy.sh', [], CUSTOMER_ENV);
    expect(r.status).toBe(0);
    expect(r.trace).not.toContain('db/seed.ts');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The demo deploy is UNCHANGED. If this describe goes red the box's deploy is broken.
// ─────────────────────────────────────────────────────────────────────────────

describe('the gated demo deploy still seeds, exactly as before', () => {
  it('a plain ./deploy/deploy.sh on a demo env DOES invoke db/seed.ts when the tenant is absent', () => {
    // The psql shim prints nothing, so `grep -q 1` fails — the same "demo tenant not found" condition
    // a first deploy hits. This is the assertion that fails if a safety change goes too far.
    const r = runDeploy('deploy.sh', [], DEMO_ENV);
    expect(r.status).toBe(0);
    expect(r.trace).toContain('db/seed.ts');
    expect(r.stdout).toContain('Seeding demo data');
  });

  it('--reseed on a demo env invokes db/seed.ts', () => {
    const r = runDeploy('deploy.sh', ['--reseed'], DEMO_ENV);
    expect(r.status).toBe(0);
    expect(r.trace).toContain('db/seed.ts');
  });

  it('DEV_TENANT_ID is still hard-required on the demo path', () => {
    const noTenant = DEMO_ENV.split('\n').filter((l) => !l.startsWith('DEV_TENANT_ID')).join('\n');
    const r = runDeploy('deploy.sh', [], noTenant);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('DEV_TENANT_ID');
    expect(r.trace).not.toContain('pnpm build');
  });

  it('MIGRATION_DATABASE_URL is still hard-required on both paths', () => {
    for (const script of ['deploy.sh', 'deploy-customer.sh'] as const) {
      const r = runDeploy(script, [], 'NODE_ENV=production\n');
      expect(r.status, script).not.toBe(0);
      expect(r.stderr, script).toContain('MIGRATION_DATABASE_URL');
    }
  });

  it('the full demo spine is unchanged: install, chain gate, build, migrate, catalogs, restart', () => {
    const r = runDeploy('deploy.sh', [], DEMO_ENV);
    const order = [
      'pnpm install',
      'scripts/check-audit-chain-gate.ts',
      'pnpm build',
      'pnpm db:migrate',
      'scripts/seed-catalogs.ts',
      'scripts/backfill-plan-history.ts',
      'scripts/backfill-country-modules.ts',
      'db/seed.ts',
      'systemctl restart aihr',
    ];
    let at = -1;
    for (const step of order) {
      const next = r.trace.indexOf(step, at + 1);
      expect(next, `${step} missing or out of order in:\n${r.trace}`).toBeGreaterThan(at);
      at = next;
    }
  });

  it('an unknown argument is still rejected', () => {
    const r = runDeploy('deploy.sh', ['--nonsense'], DEMO_ENV);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('Unknown argument');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Source shape — stated as such. See the header for why these two are not executable.
// ─────────────────────────────────────────────────────────────────────────────

describe('source shape (not executable — see file header)', () => {
  it('exactly ONE executable line in deploy/deploy.sh can run db/seed.ts', () => {
    // `echo` lines are excluded as well as comments: the --reseed refusal message names the file so an
    // operator understands what they are being refused, and that is prose too.
    const calls = codeLines(DEPLOY_SH)
      .filter((l) => l.includes('db/seed.ts'))
      .filter((l) => !l.trim().startsWith('echo '));
    expect(calls).toEqual(['    node --env-file=.env.production --import tsx db/seed.ts']);
  });

  it('that line sits inside the `$DEMO` branch, not beside it', () => {
    const call = DEPLOY_SH.indexOf('node --env-file=.env.production --import tsx db/seed.ts');
    const branch = DEPLOY_SH.indexOf('if [ "$DEMO" = "1" ]; then\n  # Seed only if the demo tenant');
    const closes = DEPLOY_SH.indexOf('Customer deployment — the demo seeder was not run');
    expect(branch).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(branch);
    expect(closes).toBeGreaterThan(call);
  });

  it('no executable line in deploy/deploy-customer.sh can run any seeder', () => {
    expect(codeLines(DEPLOY_CUSTOMER_SH).filter((l) => l.includes('seed'))).toEqual([]);
    expect(codeLines(DEPLOY_CUSTOMER_SH).some((l) => l.includes('--customer'))).toBe(true);
  });

  it('the customer env template carries none of the three demo variables', () => {
    const tpl = fs.readFileSync(path.join(REPO, 'deploy/.env.customer.example'), 'utf8');
    // Only inside the trailing "DELIBERATELY ABSENT" note, never as a setting.
    for (const v of ['ALLOW_DEMO_SESSION', 'DEV_TENANT_ID', 'DEV_USER_ID']) {
      expect(tpl, v).not.toMatch(new RegExp(`^\\s*${v}\\s*=`, 'm'));
    }
    expect(tpl).toMatch(/^NODE_ENV=production$/m);
  });

  it('DEPLOY.md no longer tells the operator to keep the demo variables unqualified', () => {
    const md = fs.readFileSync(path.join(REPO, 'deploy/DEPLOY.md'), 'utf8');
    expect(md).not.toContain('leave `ALLOW_DEMO_SESSION`, `DEV_TENANT_ID`, `DEV_USER_ID`, `PORT` as-is');
    expect(md).toContain('Deploying for a customer');
    expect(md).toContain('deploy/.env.customer.example');
    expect(md).toContain('./deploy/deploy-customer.sh');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The seeder's own refusal — the decision matrix.
// ─────────────────────────────────────────────────────────────────────────────

describe('db/seed-guard — which signal says "this is somebody\'s real database"', () => {
  it('a developer workstation is untouched (no NODE_ENV, no WorkOS)', () => {
    expect(demoSeedRefusal({})).toBeNull();
    expect(demoSeedRefusal({ NODE_ENV: 'development', DEV_TENANT_ID: DEMO_TENANT_ID })).toBeNull();
    expect(demoSeedRefusal({ NODE_ENV: 'test' })).toBeNull();
  });

  it('the gated demo box is untouched (production + ALLOW_DEMO_SESSION=true)', () => {
    expect(demoSeedRefusal({ NODE_ENV: 'production', ALLOW_DEMO_SESSION: 'true', DEV_TENANT_ID: DEMO_TENANT_ID }))
      .toBeNull();
  });

  it('R2 refuses a production deployment that has not declared itself a demo', () => {
    const msg = demoSeedRefusal({ NODE_ENV: 'production' });
    expect(msg).toContain('REFUSING TO SEED');
    expect(msg).toContain('ALLOW_DEMO_SESSION');
  });

  it('R2 tests ALLOW_DEMO_SESSION for the exact string true, not truthiness', () => {
    // The AUDIT_HASH_CHAIN_ENABLED bug (ADR-0077 slice 3) was a truthiness test on the string 'false'.
    for (const v of ['false', '1', 'yes', 'TRUE', 'true ', '']) {
      expect(demoSeedRefusal({ NODE_ENV: 'production', ALLOW_DEMO_SESSION: v }), v).toContain('REFUSING TO SEED');
    }
  });

  it('R1 refuses whenever real authentication is configured, and the demo flag cannot override it', () => {
    expect(realAuthKeys({ WORKOS_CLIENT_ID: 'client_x', WORKOS_API_KEY: '' })).toEqual(['WORKOS_CLIENT_ID']);
    const msg = demoSeedRefusal({ ALLOW_DEMO_SESSION: 'true', WORKOS_API_KEY: 'sk_live_x' });
    expect(msg).toContain('REFUSING TO SEED');
    expect(msg).toContain('WORKOS_API_KEY');
    // …and with no NODE_ENV at all, so it is not R2 wearing a different hat.
    expect(demoSeedRefusal({ WORKOS_COOKIE_PASSWORD: 'x'.repeat(40) })).toContain('REFUSING TO SEED');
  });

  it('R3 refuses a DEV_TENANT_ID that disagrees with the tenant the seeder writes', () => {
    // deploy.sh looks DEV_TENANT_ID up in `tenant` to decide "already seeded?". While these disagree
    // the lookup can never succeed, so the seeder — and its TRUNCATE — would run on EVERY deploy.
    const msg = demoSeedRefusal({ ALLOW_DEMO_SESSION: 'true', DEV_TENANT_ID: '99999999-9999-9999-9999-999999999999' });
    expect(msg).toContain('REFUSING TO SEED');
    expect(msg).toContain(DEMO_TENANT_ID);
  });

  it('R4 refuses a database that already holds a tenant the seeder did not create', () => {
    expect(foreignTenantRefusal([], {})).toBeNull();
    expect(foreignTenantRefusal([{ id: DEMO_TENANT_ID, name: 'Demo Group' }], {})).toBeNull();
    const msg = foreignTenantRefusal(
      [{ id: DEMO_TENANT_ID, name: 'Demo Group' }, { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Real Sdn Bhd' }],
      {},
    );
    expect(msg).toContain('REFUSING TO SEED');
    expect(msg).toContain('Real Sdn Bhd');
    expect(msg).toContain(DESTROY_OVERRIDE);
  });

  it('R4 is the layer that survives a customer copying the demo env template', () => {
    // Env-wise this deployment IS the demo box — same NODE_ENV, same flag, same DEV_TENANT_ID. R1-R3
    // all pass. Only the data says otherwise, which is the whole reason R4 exists.
    const demoEnv = { NODE_ENV: 'production', ALLOW_DEMO_SESSION: 'true', DEV_TENANT_ID: DEMO_TENANT_ID };
    expect(demoSeedRefusal(demoEnv)).toBeNull();
    expect(foreignTenantRefusal([{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Real Sdn Bhd' }], demoEnv))
      .toContain('REFUSING TO SEED');
  });

  it('R4 ignores the reserved auth-audit tenant, so a migrated dev DB seeds without the destroy flag', () => {
    // 0151 inserts this row into every migrated database. While R4 counted it, `pnpm db:seed` refused
    // on a correctly-migrated developer machine and the printed way out was DESTROY_OVERRIDE — the
    // flag then becomes routine, including on the run where the database does hold real data.
    const system = { id: SYSTEM_AUTH_AUDIT_TENANT_ID, name: 'System (auth audit)' };
    expect(foreignTenantRefusal([system], {})).toBeNull();
    expect(foreignTenantRefusal([system, { id: DEMO_TENANT_ID, name: 'Demo Group' }], {})).toBeNull();
    // and it buys a real tenant nothing: that still refuses, and the message names only the real one.
    const msg = foreignTenantRefusal([system, { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Real Sdn Bhd' }], {});
    expect(msg).toContain('1 tenant(s)');
    expect(msg).toContain('Real Sdn Bhd');
    expect(msg).not.toContain('System (auth audit)');
  });

  it('R4 has an explicit override, and it is in no template or runbook', () => {
    const foreign = [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Real Sdn Bhd' }];
    expect(foreignTenantRefusal(foreign, { [DESTROY_OVERRIDE]: '1' })).toBeNull();
    expect(foreignTenantRefusal(foreign, { [DESTROY_OVERRIDE]: 'true' })).toContain('REFUSING TO SEED');
    for (const f of ['deploy/.env.customer.example', 'deploy/.env.production.example', 'deploy/DEPLOY.md', '.env.example']) {
      expect(fs.readFileSync(path.join(REPO, f), 'utf8'), f).not.toContain(DESTROY_OVERRIDE);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The refusal as the operator meets it: a real process, a real exit code.
// ─────────────────────────────────────────────────────────────────────────────

function runSeeder(extra: Record<string, string>): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'db/seed.ts'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    // MIGRATION_DATABASE_URL / DATABASE_URL are well-formed and pointed at a dead port: if the guard
    // ever failed open, this is what it would try to TRUNCATE — nothing.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MIGRATION_DATABASE_URL: DEAD_DB,
      DATABASE_URL: DEAD_DB,
      AI_CONFIG_SECRET: '0123456789abcdef0123456789abcdef',
      ...extra,
    } as unknown as NodeJS.ProcessEnv,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('db/seed.ts as a process', () => {
  it('REFUSES under the production condition, exits non-zero, and never opens a connection', () => {
    const r = runSeeder({ NODE_ENV: 'production' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('✗ REFUSING TO SEED');
    expect(r.out).toContain('ALLOW_DEMO_SESSION');
    // The proof that it refused rather than merely failing: it never got as far as the database.
    expect(r.out).not.toContain('ECONNREFUSED');
    expect(r.out).not.toContain('Resetting dev database');
  }, 60_000);

  it('gets PAST the guard under the demo condition and proceeds to the database', () => {
    // Inverse of the test above, and the one that would catch a refusal that is really a blanket
    // "never seed". The connection error IS the pass: execution reached the query that immediately
    // precedes the TRUNCATE.
    const r = runSeeder({
      NODE_ENV: 'production',
      ALLOW_DEMO_SESSION: 'true',
      DEV_TENANT_ID: DEMO_TENANT_ID,
    });
    expect(r.out).not.toContain('REFUSING TO SEED');
    expect(r.out).toContain('ECONNREFUSED');
    expect(r.status).not.toBe(0);
  }, 60_000);
});
