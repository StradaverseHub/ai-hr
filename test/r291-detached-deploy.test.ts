/**
 * r291 / readiness 7.1, bullets 2 and 3 — the remote deploy is DETACHED, and a deploy that fails
 * partway is DETECTED rather than left mixed.
 *
 * THE DEFECT, as it stood on main@034d1960. `scripts/improve/release.ts:83` was
 *
 *     run('ssh', ['-p', PORT, …, `cd ${DIR} && ./deploy/deploy.sh`]);
 *
 * and `run` (release.ts:22) is `execFileSync` with `stdio: 'inherit'`. The local process therefore owned
 * the remote build. Anything that killed it killed the server build too, and the board was then left
 * saying the work had not shipped when it had. Worse, a dropped SSH connection hung the local process on
 * a dead socket forever while the server finished fine — that happened TWICE on 2026-09-16, and both
 * times the release had to be killed by hand and the board transitioned manually. A build interrupted
 * that way leaves new source on disk beside a `.next` built from the OLD source, and nothing on the
 * server detected or reported it: from outside, "running", "finished" and "died partway" all look the
 * same — no output, a URL that still answers, a service that is still up.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS PINNED HERE, AND HOW HARD
 *
 * Shell and SSH orchestration is the classic place for a test that only ever sees the clean path, so
 * almost nothing here is a source grep. Four harnesses, in increasing order of how much they prove:
 *
 * 1. THE STATE MACHINE, BY EXECUTION. `deploy/deploy.sh` is run for real in a throwaway directory
 *    against a PATH of shims that record what was invoked (the r290 technique — see
 *    test/r290-customer-deploy-path.test.ts). The `pnpm` shim writes a real `.next/BUILD_ID` on
 *    `pnpm build`, so the build-id comparison is a comparison of real files, and it can be made to
 *    FAIL, to SLEEP, or to clobber the build id — which is how the mixed state is CONSTRUCTED here
 *    rather than merely described.
 *
 * 2. DETACHMENT, BY KILLING A REAL PROCESS GROUP. A driver process launches the deploy through a shim
 *    `ssh` using the REAL `buildLaunchCommand()`, then follows it; the test kills the driver's entire
 *    process group with SIGKILL — which is what a Ctrl-C, a closed terminal, or the harness reclaiming
 *    memory actually delivers — and asserts the deploy nevertheless runs to `state=ok`. The CONTROL in
 *    the same describe runs the PRE-r291 attached form through the identical harness and asserts the
 *    group kill DOES stop it. Without that control, the detachment test would pass against a deploy
 *    that was never really in danger.
 *
 * 3. THE FOLLOWER, by injection: dropped connections, garbled replies, and every terminal state.
 *
 * 4. THE WHOLE LOCAL COMMAND, END TO END. `scripts/improve/cli.ts release` — the actual thing
 *    `pnpm improve:release` runs — is spawned as a subprocess with shims for npx / pnpm / rsync / ssh,
 *    against a real temp git worktree and a real temp "server" directory holding the real deploy.sh.
 *    A remote build that fails must make that process exit NON-ZERO and must NOT mark the item
 *    deployed; a remote build that succeeds must exit zero and must. That is the pin for the whole
 *    point of the round: a detached deploy that quietly succeeds locally while failing remotely would
 *    be strictly worse than the attached version it replaced.
 *
 * TWO THINGS ARE PINNED BY SOURCE SHAPE, DELIBERATELY, and are stated here rather than left for a
 * reader to assume laziness:
 *   • that `scripts/improve/release.ts` contains no attached `./deploy/deploy.sh` invocation. Execution
 *     proves the path exercised is detached; it cannot prove a second, differently-guarded attached
 *     call was not added somewhere the harness does not reach.
 *   • that the sentinel string in release.ts and in deploy/deploy-state.sh is the same literal. It is
 *     a wire format shared by a TypeScript file and a shell script with no common source of truth; the
 *     follow tests would pass with two different-but-self-consistent values only because the shell half
 *     is stubbed in those tests. Here the two files are compared directly.
 *
 * NOT DONE, and why: nothing here runs against 203.142.6.241. Production database access is
 * SELECT-only and a real deploy against the live box is not something a test may do.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOY_STATE_SENTINEL,
  buildFollowCommand,
  buildLaunchCommand,
  buildPendingCommand,
  describeDeployStatus,
  followDeploy,
  isSuccessState,
  isTerminalState,
  parseDeployStatus,
} from '../scripts/improve/release';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_TS = fs.readFileSync(path.join(REPO, 'scripts/improve/release.ts'), 'utf8');
const DEPLOY_STATE_SH = fs.readFileSync(path.join(REPO, 'deploy/deploy-state.sh'), 'utf8');

/** A URL that is well-formed and points at a port nothing listens on, so a connection attempt is loud. */
const DEAD_DB = 'postgresql://r291:r291@127.0.0.1:1/r291_should_not_exist';

const DEMO_ENV = [
  'NODE_ENV=production',
  `MIGRATION_DATABASE_URL=${DEAD_DB}`,
  `DATABASE_URL=${DEAD_DB}`,
  'SHARE_PASSWORD=fixture-not-a-real-secret',
  'ALLOW_DEMO_SESSION=true',
  'DEV_TENANT_ID=11111111-1111-1111-1111-111111111111',
  '',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Harness 1 — a throwaway "server": the real deploy scripts, nothing real on PATH.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Box = { dir: string; stateDir: string; bin: string; trace: string };

/**
 * `setsid(1)` does not exist on macOS, so the shim is a REAL implementation of it — perl's
 * POSIX::setsid() genuinely puts the child in a new session before exec. A shim that merely exec'd its
 * arguments would make the detachment test vacuous: the process would stay in the caller's group and
 * the group kill would stop it, which is precisely the condition the test claims does not hold.
 */
const SETSID_SHIM = `#!/usr/bin/perl
use strict; use warnings; use POSIX ();
POSIX::setsid();
exec @ARGV or die "setsid shim: exec failed: \$!\\n";
`;

/**
 * `pnpm build` writes a real `.next/BUILD_ID`, because the whole stale-build signal is a comparison of
 * that file against what the last clean deploy recorded. Three switches turn the clean path into the
 * broken ones this round is about:
 *   AIHR_TEST_BUILD_FAIL=1     the build exits non-zero (the box's real OOM failure — readiness 7.1
 *                              measured 105 MiB available during its own deploy typecheck)
 *   AIHR_TEST_BUILD_SLEEP=<s>  the build takes time, so it can be interrupted mid-flight
 *   AIHR_TEST_BUILD_CLOBBER=1  the build rewrites BUILD_ID and THEN fails, which is what a half-written
 *                              `.next` looks like
 */
const PNPM_SHIM = `#!/bin/sh
printf '%s\\n' "pnpm $*" >> "$DEPLOY_TRACE"
if [ "$1" = "build" ]; then
  if [ -n "\${AIHR_TEST_BUILD_SLEEP:-}" ]; then sleep "$AIHR_TEST_BUILD_SLEEP"; fi
  if [ "\${AIHR_TEST_BUILD_CLOBBER:-0}" = "1" ]; then
    mkdir -p .next && head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \\n' > .next/BUILD_ID
    exit 1
  fi
  if [ "\${AIHR_TEST_BUILD_FAIL:-0}" = "1" ]; then exit 1; fi
  mkdir -p .next && head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \\n' > .next/BUILD_ID
fi
exit 0
`;

function makeBox(envProduction = DEMO_ENV): Box {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r291-box-'));
  const bin = path.join(dir, 'bin');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, 'deploy'));
  fs.mkdirSync(path.join(dir, 'node_modules')); // must exist but stay empty (the install branch)
  fs.mkdirSync(bin);
  fs.mkdirSync(stateDir);
  for (const f of ['deploy.sh', 'deploy-customer.sh', 'deploy-state.sh']) {
    fs.copyFileSync(path.join(REPO, 'deploy', f), path.join(dir, 'deploy', f));
    fs.chmodSync(path.join(dir, 'deploy', f), 0o755);
  }
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfile: not a real one\n');
  fs.writeFileSync(path.join(dir, '.env.production'), envProduction);

  const trace = path.join(dir, 'trace.log');
  for (const cmd of ['node', 'psql', 'sudo', 'systemctl', 'npx', 'rsync']) {
    const p = path.join(bin, cmd);
    fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${cmd} $*" >> "$DEPLOY_TRACE"\nexit 0\n`);
    fs.chmodSync(p, 0o755);
  }
  // sha256sum has to produce something `cut -d' ' -f1` can read, and macOS has no sha256sum at all.
  fs.writeFileSync(
    path.join(bin, 'sha256sum'),
    `#!/bin/sh\nprintf '%s\\n' "sha256sum $*" >> "$DEPLOY_TRACE"\nprintf 'deadbeefdeadbeef  %s\\n' "$1"\nexit 0\n`,
  );
  fs.chmodSync(path.join(bin, 'sha256sum'), 0o755);
  fs.writeFileSync(path.join(bin, 'pnpm'), PNPM_SHIM);
  fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
  fs.writeFileSync(path.join(bin, 'setsid'), SETSID_SHIM);
  fs.chmodSync(path.join(bin, 'setsid'), 0o755);
  // A shim `ssh` that just runs the command it was given, locally. Options and user@host are dropped;
  // the LAST argument is the remote command, which is exactly how real ssh treats it.
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    `#!/bin/sh\nwhile [ $# -gt 1 ]; do case "$1" in -p|-o|-i) shift 2 ;; *) shift ;; esac; done\nexec /bin/bash -c "$1"\n`,
  );
  fs.chmodSync(path.join(bin, 'ssh'), 0o755);
  return { dir, stateDir, bin, trace };
}

/** The environment the box's scripts see. Nothing is inherited: deploy.sh sources its own env file. */
function boxEnv(box: Box, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${box.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: box.dir,
    DEPLOY_TRACE: box.trace,
    AIHR_DEPLOY_STATE_DIR: box.stateDir,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

type Run = { status: number | null; stdout: string; stderr: string; trace: string };

function deployOnce(box: Box, ref: string, extra: Record<string, string> = {}, args: string[] = []): Run {
  const r = spawnSync('/bin/bash', [path.join(box.dir, 'deploy', 'deploy.sh'), ...args], {
    cwd: box.dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: boxEnv(box, { AIHR_DEPLOY_REF: ref, ...extra }),
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    trace: fs.existsSync(box.trace) ? fs.readFileSync(box.trace, 'utf8') : '',
  };
}

/** Ask the box about itself — the same command an operator would type over SSH. */
function askState(box: Box): Record<string, string> {
  const r = spawnSync('/bin/bash', [path.join(box.dir, 'deploy', 'deploy-state.sh'), 'status'], {
    cwd: box.dir,
    encoding: 'utf8',
    env: boxEnv(box),
  });
  return parseDeployStatus(r.stdout ?? '');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms: number, label: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms}ms waiting for: ${label}`);
}

describe('r291 harness preconditions', () => {
  it('no real /opt/node20/bin on this machine, so the shims are what deploy.sh finds', () => {
    // deploy.sh prepends /opt/node20/bin to PATH when it exists. On the server that is the point;
    // here it would shadow the `node` and `pnpm` shims and every assertion below would be vacuous.
    expect(fs.existsSync('/opt/node20/bin')).toBe(false);
  });

  it('the setsid shim really detaches the child, it does not just exec it', () => {
    const box = makeBox();
    // The process GROUP id, because that is what a group signal is addressed to and therefore what
    // the detachment claim is about. (`ps -o sess=` prints 0 for everything on macOS, so it cannot
    // tell the two cases apart — a precondition that silently passes is how a vacuous guard starts.)
    const r = spawnSync(
      '/bin/bash',
      ['-c', 'mine=$(ps -o pgid= -p $$); theirs=$(setsid /bin/sh -c \'ps -o pgid= -p $$\'); echo "$mine|$theirs"'],
      { encoding: 'utf8', env: boxEnv(box) },
    );
    const [mine, theirs] = (r.stdout ?? '').trim().split('|');
    expect(mine?.trim()).toBeTruthy();
    expect(theirs?.trim()).toBeTruthy();
    expect(theirs?.trim()).not.toBe(mine?.trim());
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. The three states, constructed for real on a throwaway box.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the box can say which of the three things happened to it', () => {
  it('FINISHED CLEANLY: state=ok, and the .next on disk is the one this deploy built', () => {
    const box = makeBox();
    const r = deployOnce(box, 'aaaaaaa');
    expect(r.status).toBe(0);
    const st = askState(box);
    expect(st.state).toBe('ok');
    expect(st.phase).toBe('restart');
    expect(st.ref).toBe('aaaaaaa');
    expect(st.exit_code).toBe('0');
    // The clean-path invariant the mixed-state detection is defined against.
    expect(st.stale_build).toBe('0');
    expect(st.build_id).toBe(st.built_build_id);
    expect(st.built_ref).toBe('aaaaaaa');
    expect(st.build_id).not.toBe('-');
  });

  it('DIED PARTWAY: SIGKILL mid-build ⇒ state=died, and the mixed tree is reported', async () => {
    const box = makeBox();
    // A clean deploy of ref A first, so there IS a previous build to be left stale beside.
    expect(deployOnce(box, 'aaaaaaa').status).toBe(0);
    const builtA = askState(box).build_id;

    // Then ref B, whose build hangs. This is the mixed state CONSTRUCTED: source B on disk, .next from A.
    const child: ChildProcess = spawn('/bin/bash', [path.join(box.dir, 'deploy', 'deploy.sh')], {
      cwd: box.dir,
      env: boxEnv(box, { AIHR_DEPLOY_REF: 'bbbbbbb', AIHR_TEST_BUILD_SLEEP: '30' }),
      stdio: 'ignore',
    });
    try {
      await waitFor(() => askState(box).phase === 'build', 30_000, 'the deploy to reach phase=build');
      const running = askState(box);
      expect(running.state).toBe('running');
      expect(running.ref).toBe('bbbbbbb');
      expect(String(child.pid)).toBe(running.pid);

      // What the OOM killer, a `kill -9`, or a reboot does: no trap runs, nothing is finalized.
      process.kill(child.pid!, 'SIGKILL');
      await waitFor(() => askState(box).state === 'died', 15_000, 'the state to become died');
    } finally {
      try {
        if (child.pid) process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }

    const st = askState(box);
    expect(st.state).toBe('died');
    expect(st.phase).toBe('build');
    // Not "failed": nothing recorded an exit code, because nothing got the chance to.
    expect(st.exit_code).toBe('-');
    // THE MIXED TREE, stated in full: the source is B, the .next beside it was built from A.
    expect(st.stale_build).toBe('1');
    expect(st.ref).toBe('bbbbbbb');
    expect(st.built_ref).toBe('aaaaaaa');
    expect(st.build_id).toBe(builtA);
    expect(st.built_build_id).toBe(builtA);
    // And it is not merely a flag: the operator-facing text names both refs.
    const text = describeDeployStatus(st);
    expect(text).toContain('MIXED TREE');
    expect(text).toContain('ref=bbbbbbb');
    expect(text).toContain('ref=aaaaaaa');
  }, 90_000);

  it('FAILED: a build that exits non-zero ⇒ state=failed with the exit code and the mixed tree', () => {
    const box = makeBox();
    expect(deployOnce(box, 'aaaaaaa').status).toBe(0);
    const builtA = askState(box).build_id;

    const r = deployOnce(box, 'bbbbbbb', { AIHR_TEST_BUILD_FAIL: '1' });
    expect(r.status).not.toBe(0);

    const st = askState(box);
    expect(st.state).toBe('failed');
    expect(st.phase).toBe('build');
    expect(st.exit_code).toBe('1');
    expect(st.stale_build).toBe('1');
    expect(st.ref).toBe('bbbbbbb');
    expect(st.built_ref).toBe('aaaaaaa');
    expect(st.build_id).toBe(builtA);
  });

  it('a build that rewrites BUILD_ID and THEN fails is still caught — by the build id, not the ref', () => {
    // The other flavour of half-built `.next`, and the one a ref comparison alone would miss if the
    // refs happened to match (a re-run of the same commit). Here the id on disk is one no clean deploy
    // ever recorded.
    const box = makeBox();
    expect(deployOnce(box, 'aaaaaaa').status).toBe(0);
    const builtA = askState(box).build_id;

    expect(deployOnce(box, 'aaaaaaa', { AIHR_TEST_BUILD_CLOBBER: '1' }).status).not.toBe(0);
    const st = askState(box);
    expect(st.state).toBe('failed');
    expect(st.ref).toBe(st.built_ref); // same commit re-deployed — the refs agree
    expect(st.build_id).not.toBe(builtA); // but the .next on disk is nobody's certified build
    expect(st.stale_build).toBe('1');
  });

  it('a REFUSED preflight is a failure too — the trap sits above every check, on purpose', () => {
    // By the time deploy.sh runs, improve:release has already rsynced new source over the box. A
    // refusal at the SHARE_PASSWORD line is therefore not a no-op: it leaves new source beside an old
    // .next. A trap installed after the preflights would record nothing for any of them.
    const box = makeBox();
    expect(deployOnce(box, 'aaaaaaa').status).toBe(0);

    fs.writeFileSync(
      path.join(box.dir, '.env.production'),
      DEMO_ENV.split('\n').filter((l) => !l.startsWith('SHARE_PASSWORD')).join('\n'),
    );
    const r = deployOnce(box, 'bbbbbbb');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SHARE_PASSWORD');

    const st = askState(box);
    expect(st.state).toBe('failed');
    expect(st.phase).toBe('preflight');
    expect(st.ref).toBe('bbbbbbb');
    expect(st.built_ref).toBe('aaaaaaa');
    expect(st.stale_build).toBe('1');
  });

  it('INCOMPLETE: a release announced and never started (an interrupted rsync) is not silence', () => {
    const box = makeBox();
    expect(deployOnce(box, 'aaaaaaa').status).toBe(0);
    expect(askState(box).state).toBe('ok');

    // What improve:release does before it rsyncs a byte.
    const r = spawnSync('/bin/bash', ['-c', buildPendingCommand('ccccccc', box.dir, box.stateDir)], {
      cwd: box.dir,
      encoding: 'utf8',
      env: boxEnv(box),
    });
    expect(r.status).toBe(0);

    const st = askState(box);
    expect(st.state).toBe('incomplete');
    expect(st.ref).toBe('ccccccc'); // the ref that was shipped, not the one that was built
    expect(st.built_ref).toBe('aaaaaaa');
    expect(st.stale_build).toBe('1');
  });

  it('…and deploy.sh clears that marker the moment it begins, so a normal release never sees it', () => {
    const box = makeBox();
    spawnSync('/bin/bash', ['-c', buildPendingCommand('ccccccc', box.dir, box.stateDir)], {
      cwd: box.dir,
      env: boxEnv(box),
    });
    expect(askState(box).state).toBe('incomplete');
    expect(deployOnce(box, 'ccccccc').status).toBe(0);
    expect(fs.existsSync(path.join(box.stateDir, 'pending'))).toBe(false);
    expect(askState(box).state).toBe('ok');
  });

  it('UNKNOWN, never "ok": a box with no record does not get the benefit of the doubt', () => {
    const box = makeBox();
    const st = askState(box);
    expect(st.state).toBe('unknown');
    expect(isSuccessState(st.state!)).toBe(false);
    expect(st.stale_build).toBe('1');
  });

  it('a recycled pid does not keep a dead deploy alive forever', () => {
    // `kill -0` alone would report pid 1 as a running deploy for as long as the box is up. The command
    // line has to still be a deploy.sh, and anything else counts as dead — the conservative direction.
    const box = makeBox();
    fs.writeFileSync(
      path.join(box.stateDir, 'current'),
      ['ref=ddddddd', 'pid=1', 'log=', 'started_at=1', 'phase=build', 'result=', 'exit_code=', 'build_id=', ''].join('\n'),
    );
    expect(askState(box).state).toBe('died');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 1b. EVERY refusal still exits non-zero — the regression the EXIT trap nearly introduced.
//
// This describe exists because the first version of r291 broke it. Merely INSTALLING an EXIT trap makes
// bash (3.2.57, measured) report 0 after a `${VAR:?message}` expansion error:
//
//     bash -c 'set -euo pipefail; : "${X:?nope}"'                    → 1
//     bash -c 'set -euo pipefail; trap "true" EXIT; : "${X:?nope}"'  → 0
//
// Every preflight in deploy.sh is that construct, including readiness 1.4's SHARE_PASSWORD line — the
// one whose whole job is to refuse to publish an ungated, wide-open HRIS. A deploy instrumented with a
// naive trap would have "succeeded" through all of them. These run the real script and read the real
// exit code, which is the only thing that would have caught it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a refused deploy still exits non-zero (the trap must not eat the status)', () => {
  function withoutLine(prefix: string): string {
    return DEMO_ENV.split('\n').filter((l) => !l.startsWith(prefix)).join('\n');
  }

  it('SHARE_PASSWORD missing — readiness 1.4\u2019s refusal to publish an open app', () => {
    const box = makeBox(withoutLine('SHARE_PASSWORD'));
    const r = deployOnce(box, 'bbbbbbb');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SHARE_PASSWORD');
    expect(r.trace).not.toContain('pnpm build'); // refused before anything was built
    expect(askState(box).state).toBe('failed');
  });

  // r390 — real WorkOS sign-in is the other thing that can guard a deployment. The preflight demands ONE of
  // the two, never neither, and half a WorkOS configuration still refuses before anything is built.
  const WORKOS_ENV = [
    'WORKOS_API_KEY=sk_test_fixture_not_a_real_key',
    'WORKOS_CLIENT_ID=client_fixture',
    'WORKOS_COOKIE_PASSWORD=fixture-cookie-password-of-thirty-two-plus-chars',
    'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://aihr.example.test/callback',
  ];
  const realAuthEnv = (drop: string[] = [], extra: string[] = []) =>
    [...DEMO_ENV.split('\n').filter((l) => !l.startsWith('SHARE_PASSWORD') && !l.startsWith('ALLOW_DEMO_SESSION')),
      ...WORKOS_ENV.filter((l) => !drop.some((d) => l.startsWith(d))), ...extra, ''].join('\n');

  it('r390: no SHARE_PASSWORD but real sign-in fully configured gets PAST the gate (it reaches the build)', () => {
    const box = makeBox(realAuthEnv());
    const r = deployOnce(box, 'bbbbbbb');
    expect(r.stdout).toContain('real WorkOS sign-in is configured');
    expect(r.trace).toContain('pnpm build');
  });

  it.each([
    ['WORKOS_COOKIE_PASSWORD missing', realAuthEnv(['WORKOS_COOKIE_PASSWORD'])],
    ['the redirect URI missing', realAuthEnv(['NEXT_PUBLIC_WORKOS_REDIRECT_URI'])],
    ['ALLOW_DEMO_SESSION=true (the switcher would still decide who you are)', realAuthEnv([], ['ALLOW_DEMO_SESSION=true'])],
  ])('r390: no SHARE_PASSWORD and %s — refuses, nothing built', (_label, env) => {
    const box = makeBox(env);
    const r = deployOnce(box, 'bbbbbbb');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SHARE_PASSWORD');
    expect(r.stderr).toContain('WORKOS_COOKIE_PASSWORD');
    expect(r.trace).not.toContain('pnpm build');
    expect(askState(box).state).toBe('failed');
  });

  it('MIGRATION_DATABASE_URL missing', () => {
    const box = makeBox('NODE_ENV=production\n');
    const r = deployOnce(box, 'bbbbbbb');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MIGRATION_DATABASE_URL');
    expect(askState(box).state).toBe('failed');
  });

  it('DEV_TENANT_ID missing on a demo deployment', () => {
    const box = makeBox(withoutLine('DEV_TENANT_ID'));
    const r = deployOnce(box, 'bbbbbbb');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DEV_TENANT_ID');
    expect(askState(box).state).toBe('failed');
  });

  it('.env.production missing entirely', () => {
    const box = makeBox();
    fs.rmSync(path.join(box.dir, '.env.production'));
    const r = deployOnce(box, 'bbbbbbb');
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('Missing .env.production');
  });

  it('an unknown argument, and --customer/--demo together', () => {
    // The plain `exit 1` class, which the trap reports correctly — included so the describe covers
    // both kinds of refusal rather than only the one that broke.
    const box = makeBox();
    expect(deployOnce(box, 'b', {}, ['--nonsense']).status).toBe(1);
    expect(deployOnce(box, 'b', {}, ['--customer', '--demo']).status).toBe(1);
  });

  it('--reseed on a non-demo deployment is still refused (r290), and now recorded as failed', () => {
    const box = makeBox(withoutLine('ALLOW_DEMO_SESSION'));
    const r = deployOnce(box, 'bbbbbbb', {}, ['--reseed']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('not in demo mode');
    expect(r.trace).not.toContain('db/seed.ts');
    expect(askState(box).state).toBe('failed');
  });

  it('--migrate-only is NOT a failure: it is one of the two places the script legitimately ends', () => {
    const box = makeBox();
    const r = deployOnce(box, 'aaaaaaa', {}, ['--migrate-only']);
    expect(r.status).toBe(0);
    expect(r.trace).toContain('pnpm db:migrate');
    expect(r.trace).not.toContain('systemctl restart');
    const st = askState(box);
    expect(st.state).toBe('ok');
    expect(st.phase).toBe('migrate-only');
    // It really did build, so the .next beside the source is this source's.
    expect(st.stale_build).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Detachment — proved by killing a real process group, with the pre-r291 form as the control.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A driver that does exactly what release.ts step 4 does: launch, then follow. Spawned `detached`, so
 * it leads its own process group and the test can signal the whole group the way a terminal does.
 *
 * `mode=attached` is the PRE-r291 command, reconstructed here as the control. It is the only place in
 * this repo that still contains it, and it exists so the harness can be shown to detect the difference.
 */
function driverSource(): string {
  return `
import { execFileSync } from 'node:child_process';
import { buildFollowCommand, buildLaunchCommand, followDeploy, sshArgs } from ${JSON.stringify(path.join(REPO, 'scripts/improve/release'))};
const [dir, stateDir, ref, mode] = process.argv.slice(2);
const cmd =
  mode === 'attached'
    ? \`cd \${dir} && AIHR_DEPLOY_STATE_DIR='\${stateDir}' AIHR_DEPLOY_REF='\${ref}' ./deploy/deploy.sh\`
    : buildLaunchCommand(ref, dir, stateDir);
execFileSync('ssh', sshArgs(cmd), { stdio: 'inherit', maxBuffer: 1 << 24 });
if (mode !== 'attached') {
  followDeploy({
    run: (o) => execFileSync('ssh', sshArgs(buildFollowCommand(o, dir, stateDir)), { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'inherit'] }),
    pollMs: 250,
  });
}
`;
}

describe('the remote deploy outlives the local process that started it', () => {
  let driver: string;
  beforeAll(() => {
    driver = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r291-driver-')), 'driver.ts');
    fs.writeFileSync(driver, driverSource());
  });

  async function killGroupMidDeploy(mode: 'detached' | 'attached'): Promise<Box> {
    const box = makeBox();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', driver, box.dir, box.stateDir, 'eeeeeee', mode],
      {
        // cwd is the REPO, not the box: `node --import tsx` resolves `tsx` from the cwd, and a temp
        // directory has no node_modules. Where the deploy runs is decided by the `cd` inside the
        // launch command, not by this.
        cwd: REPO,
        // Its OWN process group, so `kill(-pid)` is a group signal and not a signal to this test run.
        detached: true,
        stdio: 'ignore',
        env: boxEnv(box, { AIHR_TEST_BUILD_SLEEP: '8' }),
      },
    );
    try {
      await waitFor(() => askState(box).phase === 'build', 60_000, `${mode}: the deploy to reach phase=build`);
      // A group SIGKILL: what a closed terminal, a Ctrl-C, or the harness reclaiming memory delivers.
      process.kill(-child.pid!, 'SIGKILL');
      await sleep(400);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    return box;
  }

  it('DETACHED: killing the local process group leaves the server build RUNNING, and it finishes', async () => {
    const box = await killGroupMidDeploy('detached');
    // The whole claim of bullet 2, as an observation of the box after the local side is dead.
    await waitFor(() => askState(box).state === 'ok', 40_000, 'the orphaned deploy to finish cleanly');
    const st = askState(box);
    expect(st.state).toBe('ok');
    expect(st.phase).toBe('restart');
    expect(st.ref).toBe('eeeeeee');
    expect(st.stale_build).toBe('0');
    expect(fs.readFileSync(box.trace, 'utf8')).toContain('systemctl restart aihr');
  }, 120_000);

  it('CONTROL — the pre-r291 attached form dies with it, which is how we know the test above means something', async () => {
    const box = await killGroupMidDeploy('attached');
    // Give it more than enough time to have finished if it had survived.
    await sleep(12_000);
    const st = askState(box);
    expect(st.state).not.toBe('ok');
    expect(st.state).toBe('died');
    expect(st.phase).toBe('build');
    expect(fs.readFileSync(box.trace, 'utf8')).not.toContain('systemctl restart aihr');
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. The follower: it reconnects, and it never turns a failure into a success.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function reply(state: string, extra: Record<string, string> = {}, log = ''): Buffer {
  const kv = { state, phase: 'build', ref: 'r', log: '/tmp/x.log', log_size: String(Buffer.byteLength(log)), stale_build: '1', ...extra };
  return Buffer.from(
    log + DEPLOY_STATE_SENTINEL + '\n' + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
    'utf8',
  );
}

describe('followDeploy', () => {
  it('reconnects across dropped connections instead of giving up', () => {
    const script: (Error | Buffer)[] = [
      reply('running', {}, 'one\n'),
      new Error('ssh: connect to host … Connection timed out'),
      new Error('ssh_exchange_identification: Connection closed by remote host'),
      new Error('client_loop: send disconnect: Broken pipe'),
      reply('running', { log_size: '8' }, 'two\n'),
      reply('ok', { log_size: '8', stale_build: '0' }),
    ];
    let i = 0;
    const notices: string[] = [];
    const out: Buffer[] = [];
    const st = followDeploy({
      run: () => {
        const next = script[i++];
        if (next instanceof Error) throw next;
        return next!;
      },
      write: (c) => out.push(c),
      notice: (m) => notices.push(m),
      sleep: () => {},
      pollMs: 0,
      reconnectMs: 0,
    });
    expect(st.state).toBe('ok');
    expect(i).toBe(script.length);
    // Three drops, three reconnect notices, and the deploy was still followed to its end.
    expect(notices.filter((n) => n.includes('reconnecting')).length).toBe(3);
    expect(notices.join('\n')).toContain('the detached deploy is unaffected');
    expect(Buffer.concat(out).toString()).toBe('one\ntwo\n');
  });

  it('gives up NON-SILENTLY once the connection is gone for good, and says where to look', () => {
    expect(() =>
      followDeploy({
        run: () => {
          throw new Error('Connection refused');
        },
        write: () => {},
        notice: () => {},
        sleep: () => {},
        maxConsecutiveFailures: 4,
      }),
    ).toThrow(/lost contact/);
    // …and it explicitly refuses to call that a success.
    try {
      followDeploy({
        run: () => {
          throw new Error('Connection refused');
        },
        write: () => {},
        notice: () => {},
        sleep: () => {},
        maxConsecutiveFailures: 2,
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('deploy-state.sh status');
      expect((e as Error).message).toMatch(/may well have finished/);
    }
  });

  it('treats a reply with no sentinel as a broken round trip, not as a state', () => {
    const script = [Buffer.from('garbage with no state block\n'), reply('ok', { stale_build: '0' })];
    let i = 0;
    const st = followDeploy({
      run: () => script[i++]!,
      write: () => {},
      notice: () => {},
      sleep: () => {},
    });
    expect(st.state).toBe('ok');
    expect(i).toBe(2);
  });

  it('returns each terminal state rather than waiting on it', () => {
    for (const state of ['failed', 'died', 'stale-build', 'ok']) {
      const st = followDeploy({ run: () => reply(state), write: () => {}, notice: () => {}, sleep: () => {} });
      expect(st.state).toBe(state);
    }
  });

  it('waits out the startup window, then fails rather than waiting forever on a deploy that never began', () => {
    let t = 0;
    let polls = 0;
    const st = followDeploy({
      run: () => {
        polls++;
        return reply('incomplete');
      },
      write: () => {},
      notice: () => {},
      sleep: () => {
        t += 10_000;
      },
      now: () => t,
      startupGraceMs: 30_000,
    });
    expect(st.state).toBe('incomplete');
    expect(polls).toBeGreaterThan(1); // it did NOT give up on the first poll — deploy.sh takes a moment
    expect(isSuccessState(st.state!)).toBe(false);
  });

  it('only "ok" is a success — an unrecognised state is not', () => {
    expect(isSuccessState('ok')).toBe(true);
    for (const s of ['failed', 'died', 'incomplete', 'unknown', 'stale-build', 'never-started', '']) {
      expect(isSuccessState(s), s).toBe(false);
    }
    expect(isTerminalState('running')).toBe(false);
    expect(isTerminalState('incomplete')).toBe(false); // deploy.sh may not have started yet
    expect(isTerminalState('failed')).toBe(true);
  });

  it('advances by the byte count the SERVER reports, so a reconnect never replays or skips output', () => {
    const offsets: number[] = [];
    const script = [reply('running', { log_size: '11' }, 'hello world'), reply('ok', { log_size: '11', stale_build: '0' })];
    let i = 0;
    followDeploy({
      run: (o) => {
        offsets.push(o);
        return script[i++]!;
      },
      write: () => {},
      notice: () => {},
      sleep: () => {},
    });
    expect(offsets).toEqual([0, 11]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 4. The whole local command, end to end: `improve:release` against a shim server.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const UUID_ITEM = '22222222-2222-2222-2222-222222222222';
const UUID_TENANT = '33333333-3333-3333-3333-333333333333';
const UUID_EMP = '44444444-4444-4444-4444-444444444444';

type CliRun = { status: number | null; out: string; trace: string };

function runReleaseCli(box: Box, extra: Record<string, string> = {}): CliRun {
  // A real git worktree, because release.ts reads HEAD out of it with real git.
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'r291-wt-'));
  fs.writeFileSync(path.join(wt, 'README.md'), 'r291\n');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: wt, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'r291@example.invalid');
  git('config', 'user.name', 'r291');
  git('add', '-A');
  git('commit', '-qm', 'r291 fixture');
  // r417 (ADR-0094): release.ts no longer runs the suite on a missing receipt — it refuses. This fixture is
  // about the DEPLOY path, so it carries a full-tier receipt for its own HEAD, exactly what a green
  // scripts/gate-chunked.sh writes. test/r417-release-gate.test.ts pins the refusals.
  const head = git('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(wt, '.gate-receipt.json'), JSON.stringify({ sha: head, result: 'PASS', tier: 'full' }));

  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(REPO, 'scripts/improve/cli.ts'), 'release'],
    {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 180_000,
      input: JSON.stringify({
        id: UUID_ITEM,
        tenantId: UUID_TENANT,
        reporterEmploymentId: UUID_EMP,
        worktree: wt,
        branch: 'build/r291-detach',
        buildRef: 'r291-fixture',
      }),
      env: {
        // The shims come FIRST: npx (tsc), pnpm, rsync and ssh are all stubbed. `git` is NOT
        // stubbed — release.ts must read a real HEAD.
        PATH: `${box.bin}:${process.env.PATH ?? ''}`,
        HOME: box.dir,
        DEPLOY_TRACE: box.trace,
        AIHR_DEPLOY_STATE_DIR: box.stateDir,
        IMPROVE_SSH_HOST: 'shim.invalid',
        IMPROVE_SSH_PORT: '8288',
        IMPROVE_SSH_USER: 'ubuntu',
        IMPROVE_REMOTE_DIR: box.dir,
        ...extra,
      } as unknown as NodeJS.ProcessEnv,
    },
  );
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    trace: fs.existsSync(box.trace) ? fs.readFileSync(box.trace, 'utf8') : '',
  };
}

describe('pnpm improve:release, end to end against a shim server', () => {
  it('a remote build that FAILS makes the local command exit NON-ZERO and marks nothing deployed', () => {
    const box = makeBox();
    const r = runReleaseCli(box, { AIHR_TEST_BUILD_FAIL: '1' });

    // THE POINT OF THE ROUND. Detaching the deploy must not cost the failure signal.
    expect(r.status).not.toBe(0);
    expect(r.status).toBe(1);
    expect(r.out).toContain('state=failed');
    expect(r.out).toContain('MIXED TREE');
    // markDeployed is the only thing here that runs psql. It must not have.
    expect(r.trace).not.toContain('psql');
    expect(r.out).not.toContain('status → deployed');
    // …and the box agrees with what the local command reported.
    expect(askState(box).state).toBe('failed');
  }, 180_000);

  it('a remote build that SUCCEEDS exits zero and does mark the item deployed', () => {
    const box = makeBox();
    const r = runReleaseCli(box);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('status → deployed');
    expect(r.trace).toContain('psql'); // markDeployed reached the server
    expect(r.trace).toContain('pnpm build');
    expect(r.trace).toContain('systemctl restart aihr');
    expect(askState(box).state).toBe('ok');
  }, 180_000);

  it('a deploy that DIES partway makes the local command exit non-zero and name the mixed tree', async () => {
    // The state the readiness item is about, driven all the way through the real CLI: the release is
    // watching, the server-side deploy is killed underneath it, and the command must not report
    // success just because it was still connected.
    const box = makeBox();
    expect(deployOnce(box, 'aaaaaaa').status).toBe(0);
    fs.writeFileSync(box.trace, ''); // forget the priming deploy

    // The killer has to be an OUTSIDE process, not a promise: runReleaseCli is spawnSync, so while the
    // CLI is running this thread's event loop is blocked and no timer of ours would ever fire.
    const killer = path.join(box.dir, 'kill-at-build.sh');
    fs.writeFileSync(
      killer,
      `#!/bin/sh\nfor i in $(seq 1 900); do\n  p=$(sed -n 's/^phase=//p' '${box.stateDir}/current' 2>/dev/null)\n  if [ "$p" = "build" ]; then\n    pid=$(sed -n 's/^pid=//p' '${box.stateDir}/current')\n    kill -9 "$pid" 2>/dev/null\n    exit 0\n  fi\n  sleep 0.2\ndone\n`,
    );
    fs.chmodSync(killer, 0o755);
    const killerProc = spawn('/bin/sh', [killer], { detached: true, stdio: 'ignore' });
    killerProc.unref();

    const r = runReleaseCli(box, { AIHR_TEST_BUILD_SLEEP: '30' });
    try {
      if (killerProc.pid) process.kill(killerProc.pid, 'SIGKILL');
    } catch {
      /* already exited, which is the normal case */
    }

    expect(r.status).toBe(1);
    expect(r.out).toContain('state=died');
    expect(r.out).toContain('MIXED TREE');
    expect(r.out).toContain('built from');
    expect(r.trace).not.toContain('psql');
    expect(askState(box).state).toBe('died');
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 5. Source shape — stated as such. See the file header for why exactly these two are not executable.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('source shape (not executable — see file header)', () => {
  it('release.ts has no attached `./deploy/deploy.sh` invocation left anywhere', () => {
    const attached = RELEASE_TS.split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => l.includes('./deploy/deploy.sh'))
      .filter(([, l]) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
    // Exactly one executable mention, and it is the detached launch.
    expect(attached.length, JSON.stringify(attached)).toBe(1);
    expect(attached[0]![1]).toContain('setsid nohup');
    // The shape of what is actually sent, asserted on the generated string rather than on the source
    // line (which ends in a template-literal backtick, not in the `&`).
    const launched = buildLaunchCommand('deadbee').split('\n').find((l) => l.includes('./deploy/deploy.sh'))!;
    expect(launched).toMatch(/^AIHR_DEPLOY_STATE_DIR=.*setsid nohup \.\/deploy\/deploy\.sh > "\$LOG" 2>&1 < \/dev\/null &$/);
  });

  it('the follow sentinel is the SAME literal in release.ts and in deploy/deploy-state.sh', () => {
    // A wire format shared by a .ts file and a .sh file with no common source of truth. The follower
    // tests above stub the shell half, so two different-but-self-consistent values would pass them.
    expect(DEPLOY_STATE_SH).toContain(`SENTINEL='${DEPLOY_STATE_SENTINEL}'`);
    expect(RELEASE_TS).toContain(`DEPLOY_STATE_SENTINEL = '${DEPLOY_STATE_SENTINEL}'`);
  });

  it('a board release and a no-item deploy are ONE code path (r357)', () => {
    // r356 closed no board item — it fixed three defects found by reading — so there was nothing to
    // hand `releaseBuiltItem`, and it was shipped by typing the rsync and the detached launch out by
    // hand over ssh. That worked and cost something: the ANNOUNCE step was forgotten, the box recorded
    // `built_ref=unknown`, and its own stale_build check lost the sha it compares against. Worse, it is
    // `rsync --delete` against production retyped from memory, where one mistyped --exclude removes
    // files on the server. `improve:deploy` exists so the next such round has a command.
    //
    // WHAT THIS PINS is that the command is not a SECOND copy of the shipping steps. releaseBuiltItem
    // must ship THROUGH deployWorktree and keep none of it: two copies of an rsync --delete is how the
    // board path and the no-board path come to differ in which excludes they carry.
    const fn = (name: string) => {
      const at = RELEASE_TS.indexOf(`export async function ${name}(`);
      expect(at, `${name} must exist`).toBeGreaterThan(-1);
      const after = RELEASE_TS.slice(at + 1);
      const next = after.indexOf('\nexport ');
      return next === -1 ? after : after.slice(0, next);
    };
    const release = fn('releaseBuiltItem');
    const deploy = fn('deployWorktree');

    expect(release, 'release ships through the shared path').toContain('await deployWorktree(');
    expect(release, 'and keeps no rsync of its own').not.toContain("run('rsync'");
    expect(release, 'nor a launch of its own').not.toContain('buildLaunchCommand(');
    expect(release, 'nor a follow of its own').not.toContain('followDeploy(');
    // …and the shared path still does all four steps, so the split did not drop one on the way.
    expect(deploy).toContain("run('npx', ['tsc', '--noEmit']");
    expect(deploy).toContain('buildPendingCommand(');
    expect(deploy).toContain("run('rsync'");
    expect(deploy).toContain('buildLaunchCommand(');
    expect(deploy).toContain('followDeploy(');
    // The ANNOUNCE is the step the hand-rolled deploy forgot; it is inside the shared path now, so a
    // no-item deploy cannot forget it.
    expect(deploy.indexOf('buildPendingCommand('), 'announce comes BEFORE the rsync').toBeLessThan(
      deploy.indexOf("run('rsync'"),
    );

    const CLI = fs.readFileSync(path.join(REPO, 'scripts/improve/cli.ts'), 'utf8');
    expect(CLI, 'the CLI exposes it').toContain("case 'deploy': {");
    expect(CLI).toContain('await deployWorktree({ worktree });');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['improve:deploy']).toBe('node --import tsx scripts/improve/cli.ts deploy');
  });

  it('buildFollowCommand and buildLaunchCommand point at the same state directory', () => {
    expect(buildFollowCommand(0, '/opt/ai-hr', '/var/tmp/aihr-deploy')).toContain("AIHR_DEPLOY_STATE_DIR='/var/tmp/aihr-deploy'");
    expect(buildLaunchCommand('x', '/opt/ai-hr', '/var/tmp/aihr-deploy')).toContain("AIHR_DEPLOY_STATE_DIR='/var/tmp/aihr-deploy'");
    // And the launch refuses rather than silently degrading to an attached deploy.
    expect(buildLaunchCommand('x')).toContain('command -v setsid');
    expect(buildLaunchCommand('x')).toContain('exit 97');
  });
});
