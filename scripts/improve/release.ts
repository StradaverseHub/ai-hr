/**
 * Improvement-loop release (ADR-0045, IL-4) — the HUMAN-GATED step. Ships a built, green worktree to the
 * server and closes the feedback item. This is NEVER run by the schedule: a human reviews the preview + the
 * diff first, then invokes `improve:release` explicitly.
 *
 *   echo '{"id","tenantId","reporterEmploymentId","worktree","branch","buildRef"}' | pnpm improve:release
 *
 * Flow: final gate (the gate receipt must cover HEAD — r417, see release-gate.ts — then tsc) → announce → rsync worktree → server → DETACHED deploy.sh
 * → follow it by polling → markDeployed. Credentials never leave the server (deploy.sh sources its own
 * .env.production); the service restart still needs the user's sudo (deploy.sh declines it by design).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * r291 / READINESS 7.1 — WHY THE REMOTE DEPLOY IS DETACHED
 *
 * Until r291 step 3 was `run('ssh', [… 'cd /opt/ai-hr && ./deploy/deploy.sh'])`, and `run` is
 * execFileSync with `stdio: 'inherit'`. The local process therefore OWNED the remote build:
 *
 *   1. Anything that killed the local process killed the server build with it — Ctrl-C, the harness
 *      reclaiming memory, a closed terminal — and the board was then left saying the work had not
 *      shipped when it had.
 *   2. A dropped SSH connection hung the local process on a dead socket forever while the server
 *      finished fine. That happened TWICE on 2026-09-16: the box had built, restarted and gone healthy
 *      long before the local release was killed by hand and the board transitioned manually.
 *   3. A build interrupted that way left new source on disk beside a `.next` built from the OLD source,
 *      and nothing on the server detected or reported it.
 *
 * Now: `setsid nohup ./deploy/deploy.sh > <log> 2>&1 < /dev/null &` on the box, so the deploy runs in its
 * own session and outlives this process, this connection and this terminal. Progress is followed by
 * POLLING — one short, independent SSH round trip every few seconds that asks for the log bytes we have
 * not seen plus the state block. Each round trip standing alone is exactly what makes a dropped
 * connection survivable: there is no pipe to lose, so the follower just reconnects and asks again.
 *
 * AND IT STILL FAILS LOUDLY. A detached deploy that exits 0 locally while failing remotely would be
 * strictly worse than the attached version, so the follow loop ends only on a terminal state from
 * deploy/deploy-state.sh, and every terminal state except `ok` throws — which cli.ts turns into
 * `process.exit(1)`. Losing contact entirely also throws, because "I can no longer see it" is not
 * "it worked".
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tierFor } from '../gate-tier-git';
import { decideReleaseGate, type DeployedVerdict, type GateReceipt } from './release-gate';
import { markDeployed } from './remote';

const HOST = process.env.IMPROVE_SSH_HOST ?? '10.20.30.20';
const PORT = process.env.IMPROVE_SSH_PORT ?? '8288';
const USER = process.env.IMPROVE_SSH_USER ?? 'ubuntu';
const DIR = process.env.IMPROVE_REMOTE_DIR ?? '/opt/ai-hr';

/**
 * Where deploy/deploy-state.sh keeps its records on the server. Outside the rsynced tree on purpose —
 * see that script's header. Overridable so a test can point a whole deploy at a temp directory.
 */
export const DEPLOY_STATE_DIR = process.env.AIHR_DEPLOY_STATE_DIR ?? '/var/tmp/aihr-deploy';

/** Must match deploy/deploy-state.sh. test/r291-detached-deploy.test.ts pins that the two agree. */
export const DEPLOY_STATE_SENTINEL = '<<<AIHR-DEPLOY-STATE-9d3f41>>>';

function run(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { stdio: 'inherit', cwd, maxBuffer: 64 * 1024 * 1024 });
}

/** SSH options shared by every remote call here: no prompts, and a connect that fails rather than hangs. */
const SSH_OPTS = ['-p', PORT, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12'];

/** App source ships through one filter. Internal decision/history records remain local and
 * existing server copies are protected from --delete; they are not deployment dependencies. */
export function deploymentRsyncArgs(source: string, destination = `${USER}@${HOST}:${DIR}/`): string[] {
  return [
    '-az', '--delete',
    '-e', `ssh -p ${PORT} -o BatchMode=yes -o ConnectTimeout=12`,
    '--exclude', 'node_modules', '--exclude', '.next', '--exclude', '.git', '--exclude', '.env*',
    '--exclude', '.turbo', '--exclude', 'coverage', '--exclude', '.claude', '--exclude', 'graphify-out',
    '--exclude', '.vitest-attachments',
    '--exclude', '/docs/HANDOFF-HISTORY.md', '--exclude', '/docs/adr/',
    source.replace(/\/?$/, '/'), destination,
  ];
}

/** The argv for one remote command. Exported so the tests can drive the REAL command through a shim ssh. */
export function sshArgs(remoteCommand: string, opts?: { host?: string; user?: string }): string[] {
  return [...SSH_OPTS, `${opts?.user ?? USER}@${opts?.host ?? HOST}`, remoteCommand];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The three remote commands
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Announce a release BEFORE the rsync starts.
 *
 * This is what closes the one window the deploy itself cannot: if this process dies between "rsync has
 * begun overwriting /opt/ai-hr" and "deploy.sh has started", the box holds source nobody ever built and
 * nothing would otherwise know. deploy.sh clears the marker the instant it begins, so a marker that is
 * still there means exactly that. `[ -x … ] || true` because on the FIRST release of r291 the script does
 * not exist on the box yet — the rsync two steps later is what puts it there.
 */
export function buildPendingCommand(ref: string, dir = DIR, stateDir = DEPLOY_STATE_DIR): string {
  return [
    `cd ${dir}`,
    `AIHR_DEPLOY_STATE_DIR='${stateDir}' sh -c '[ -x deploy/deploy-state.sh ] && deploy/deploy-state.sh pending "$1" || true' _ '${ref}'`,
  ].join(' && ');
}

/**
 * Launch the deploy DETACHED and return immediately.
 *
 * `setsid` is the load-bearing word: it puts deploy.sh in a NEW SESSION and a new process group, so a
 * signal delivered to this process's group — which is what a Ctrl-C, a `kill -TERM -<pgid>`, or the
 * harness reclaiming memory actually sends — cannot reach it. `nohup` covers the SIGHUP that arrives when
 * the SSH session's pty goes away, and `< /dev/null` stops the child from holding the connection open
 * waiting on a stdin that will never produce anything (an ssh that never returns is how the old attached
 * form hung). The redirect to a file, not to the socket, is what lets the build keep writing output after
 * the connection is gone.
 *
 * REFUSING when setsid is absent is deliberate. Falling back to a bare `nohup … &` would look like it
 * worked and would still die to a group signal — the exact failure this round exists to remove.
 */
export function buildLaunchCommand(ref: string, dir = DIR, stateDir = DEPLOY_STATE_DIR): string {
  return [
    'set -e',
    `cd ${dir}`,
    `command -v setsid >/dev/null 2>&1 || { echo "aihr-deploy-error: setsid not found on the server; refusing to launch an attached deploy" >&2; exit 97; }`,
    `mkdir -p '${stateDir}'`,
    `LOG='${stateDir}'/deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$.log`,
    `: > "$LOG"`,
    `AIHR_DEPLOY_STATE_DIR='${stateDir}' AIHR_DEPLOY_REF='${ref}' AIHR_DEPLOY_LOG="$LOG" ` +
      `setsid nohup ./deploy/deploy.sh > "$LOG" 2>&1 < /dev/null &`,
    `echo "aihr-deploy-log=$LOG"`,
  ].join('\n');
}

/** One poll: the log bytes after `offset`, the sentinel, then the state block. */
export function buildFollowCommand(offset: number, dir = DIR, stateDir = DEPLOY_STATE_DIR): string {
  return `cd ${dir} && AIHR_DEPLOY_STATE_DIR='${stateDir}' deploy/deploy-state.sh follow ${Math.max(0, Math.floor(offset))}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The state block
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type DeployStatus = Record<string, string>;

export function parseDeployStatus(text: string): DeployStatus {
  const out: DeployStatus = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * The state machine, as this side of the wire sees it. `running` is the only state we keep waiting on
 * indefinitely. `incomplete` and `unknown` mean deploy.sh has not begun — normal for the first seconds
 * after the launch, and a failure if it is still true once the startup grace has passed.
 */
export const STARTUP_STATES = new Set(['incomplete', 'unknown']);
export function isTerminalState(state: string): boolean {
  return state !== 'running' && !STARTUP_STATES.has(state);
}
/** Exactly one state is a success. Anything else — including one we do not recognise — is not. */
export function isSuccessState(state: string): boolean {
  return state === 'ok';
}

/**
 * The human-readable verdict, and the mixed-tree facts alongside it.
 *
 * `stale_build=1` on a non-`ok` state IS readiness 7.1's third bullet: the source on disk is `ref`, the
 * `.next` beside it was built from `built_ref`, and they disagree. Printing both refs is the difference
 * between "the deploy failed" and "the deploy failed AND the box now holds a mixed tree", which is what
 * decides whether the operator can walk away.
 */
export function describeDeployStatus(st: DeployStatus): string {
  const lines: string[] = [];
  const state = st.state ?? 'unknown';
  lines.push(`deploy state: ${state}${st.phase && st.phase !== '-' ? ` (phase: ${st.phase})` : ''}`);
  if (st.exit_code && st.exit_code !== '-') lines.push(`  deploy.sh exit code: ${st.exit_code}`);
  if (st.log && st.log !== '-') lines.push(`  server log: ${st.log}`);
  if (st.stale_build === '1') {
    lines.push('  MIXED TREE: the source on the box is not what its .next was built from.');
    lines.push(`    source on disk    ref=${st.ref ?? '-'}`);
    lines.push(`    .next built from  ref=${st.built_ref ?? '-'}  build_id=${st.built_build_id ?? '-'}`);
    lines.push(`    .next on disk     build_id=${st.build_id ?? '-'}`);
    lines.push('    The service is still serving the OLD build until it is restarted, so this is');
    lines.push('    recoverable: fix the cause and re-run the deploy. Do NOT restart aihr first.');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The follower
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FollowDeps {
  /** One poll round trip. Returns the raw remote stdout; THROWS when the transport fails. */
  run: (offset: number) => Buffer;
  write?: (chunk: Buffer) => void;
  notice?: (msg: string) => void;
  sleep?: (ms: number) => void;
  now?: () => number;
  pollMs?: number;
  reconnectMs?: number;
  /** Consecutive transport failures tolerated before we admit we have lost the deploy. */
  maxConsecutiveFailures?: number;
  /** How long `incomplete`/`unknown` is allowed to persist after the launch before it is a failure. */
  startupGraceMs?: number;
  deadlineMs?: number;
}

/** Block the thread without a busy loop. Injected in tests so they do not actually wait. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Follow a detached deploy to a terminal state, streaming its output.
 *
 * Returns the terminal status — it does NOT decide success; `releaseBuiltItem` does, so that the same
 * loop can be driven by a test that asserts on every terminal state without needing a throw each time.
 * Throws only when the deploy can no longer be observed at all.
 */
export function followDeploy(deps: FollowDeps): DeployStatus {
  const write = deps.write ?? ((c: Buffer) => process.stdout.write(c));
  const notice = deps.notice ?? ((m: string) => console.log(m));
  const sleep = deps.sleep ?? sleepSync;
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? 5_000;
  const reconnectMs = deps.reconnectMs ?? 10_000;
  const maxFails = deps.maxConsecutiveFailures ?? 30;
  const startupGraceMs = deps.startupGraceMs ?? 120_000;
  const deadlineMs = deps.deadlineMs ?? 60 * 60_000;

  const started = now();
  let offset = 0;
  let currentLog = '';
  let fails = 0;
  let last: DeployStatus = { state: 'unknown' };

  for (;;) {
    let out: Buffer | null = null;
    try {
      out = deps.run(offset);
    } catch (e) {
      out = null;
      fails += 1;
      if (fails >= maxFails) {
        throw new Error(
          `lost contact with ${USER}@${HOST} after ${fails} consecutive attempts. The remote deploy is ` +
            `DETACHED and may well have finished — this release cannot say, so it is failing rather than ` +
            `reporting a success it did not observe.\n` +
            `  check it directly:  ssh -p ${PORT} ${USER}@${HOST} "cd ${DIR} && deploy/deploy-state.sh status"\n` +
            `  last error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      notice(
        `… connection to the server failed (${fails}/${maxFails}) — the detached deploy is unaffected; ` +
          `reconnecting in ${Math.round(reconnectMs / 1000)}s`,
      );
      sleep(reconnectMs);
      continue;
    }

    // A reply with no sentinel is a broken round trip (a truncated read, an ssh banner, a shell error),
    // not a state. Treat it exactly like a dropped connection: retry, never guess.
    const i = out.lastIndexOf(DEPLOY_STATE_SENTINEL);
    if (i < 0) {
      fails += 1;
      if (fails >= maxFails) {
        throw new Error(
          `the server stopped returning a readable deploy state after ${fails} attempts. ` +
            `Check:  ssh -p ${PORT} ${USER}@${HOST} "cd ${DIR} && deploy/deploy-state.sh status"`,
        );
      }
      notice(`… unreadable reply from the server (${fails}/${maxFails}); retrying`);
      sleep(reconnectMs);
      continue;
    }
    fails = 0;

    const chunk = out.subarray(0, i);
    const st = parseDeployStatus(out.subarray(i + DEPLOY_STATE_SENTINEL.length).toString('utf8'));
    last = st;

    const log = st.log ?? '-';
    if (currentLog === '' && log !== '-') currentLog = log;
    if (log !== '-' && log !== currentLog) {
      // deploy.sh opened a new log; everything we have counted belongs to the old one.
      currentLog = log;
      offset = 0;
    } else {
      if (chunk.length > 0) write(chunk);
      const size = Number(st.log_size);
      if (Number.isFinite(size) && size >= 0) offset = size;
    }

    const state = st.state ?? 'unknown';
    if (isTerminalState(state)) return st;

    if (STARTUP_STATES.has(state) && now() - started > startupGraceMs) {
      return { ...st, state: state === 'unknown' ? 'never-started' : state };
    }
    if (now() - started > deadlineMs) {
      throw new Error(
        `the remote deploy has been ${state} for over ${Math.round(deadlineMs / 60_000)} minutes. It is ` +
          `detached and still running; this release is giving up watching it rather than claiming a result.\n` +
          `  ssh -p ${PORT} ${USER}@${HOST} "cd ${DIR} && deploy/deploy-state.sh status"`,
      );
    }
    sleep(pollMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * r417 — the tier classifier's verdict on the diff from the commit PRODUCTION RUNS (`built_ref` from the
 * box's own deploy-state.sh, read-only) to HEAD. Only consulted for an affected-tier receipt. Any failure
 * to answer is returned as an error, which refuses the release: "could not check" is not "presentational".
 */
export function deployedVerdict(worktree: string): DeployedVerdict {
  let deployedRef: string | undefined;
  try {
    const out = execFileSync('ssh', sshArgs(`cd ${DIR} && deploy/deploy-state.sh status`), {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    deployedRef = parseDeployStatus(out).built_ref;
  } catch (e) {
    return { error: `could not read the deployed ref from ${USER}@${HOST}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
  if (!deployedRef || deployedRef === '-') return { error: `the box reports no built_ref (got '${deployedRef ?? ''}')` };
  try {
    return { deployedRef, verdict: tierFor(deployedRef, 'HEAD', worktree).verdict };
  } catch (e) {
    return {
      error: `could not diff ${deployedRef.slice(0, 7)}...HEAD in ${worktree} (is the deployed commit in this repo?): ${
        e instanceof Error ? e.message.split('\n')[0] : String(e)
      }`,
    };
  }
}

/**
 * SHIP THE WORKTREE, AND NOTHING ELSE. Steps 1-4 of a release, with no board write.
 *
 * r357 — SPLIT OUT BECAUSE A ROUND THAT CLOSES NO BOARD ITEM IS A REAL CASE AND HAD NO COMMAND. r356
 * fixed three defects found by reading rather than reported, so there was no item to hand
 * `releaseBuiltItem`, and it was shipped by hand-rolling the rsync and the detached launch over ssh.
 * That worked and still cost something: the ANNOUNCE step was forgotten, so the box recorded
 * `built_ref=unknown` and its own `stale_build` check lost the sha it compares against. It is also the
 * exact shape this file exists to prevent — `rsync --delete` against production typed fresh each time,
 * where one mistyped `--exclude` deletes files on the server.
 *
 * `releaseBuiltItem` is now this plus the board write, so the two cannot drift.
 */
export async function deployWorktree(p: { worktree: string }): Promise<void> {
  if (!p.worktree || !existsSync(p.worktree)) {
    throw new Error(`worktree not found: ${p.worktree}`);
  }
  // 1. FINAL GATE — prove a gate already covered THIS commit before anything leaves this machine.
  //
  // r417 (ADR-0094): the release NEVER runs the test suite any more. Until r417 a missing or stale
  // receipt fell through to a bare `pnpm vitest run`, which is the one command this machine cannot take
  // (CLAUDE.md §4). Now the receipt decides — see scripts/improve/release-gate.ts — and its tier is printed:
  //   • full      → shipped on the receipt alone;
  //   • affected  → the diff from the commit PRODUCTION RUNS to HEAD is re-judged with the gate's own
  //                 classifier, and a verdict of FULL refuses the release;
  //   • missing, unreadable, non-PASS or for another sha → refused, with the gate command to run.
  // tsc still always runs (seconds).
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.worktree, encoding: 'utf8' }).trim();
  let receipt: GateReceipt | null = null;
  let receiptError: string | undefined;
  try {
    receipt = JSON.parse(readFileSync(join(p.worktree, '.gate-receipt.json'), 'utf8')) as GateReceipt;
  } catch (e) {
    receiptError = existsSync(join(p.worktree, '.gate-receipt.json'))
      ? `unreadable: ${e instanceof Error ? e.message : String(e)}`
      : `missing in ${p.worktree}`;
  }
  const decision = decideReleaseGate({
    receipt,
    receiptError,
    head,
    deployedVerdict: () => deployedVerdict(p.worktree),
  });
  for (const line of decision.lines) console.log(line);
  if (!decision.ok) {
    throw new Error(`release refused by the gate check — nothing was shipped.\n${decision.lines.join('\n')}`);
  }

  console.log('→ final gate: npx tsc --noEmit');
  run('npx', ['tsc', '--noEmit'], p.worktree);

  // 2. Announce the release on the box BEFORE a single byte of source moves. See buildPendingCommand.
  console.log(`→ announcing ${head.slice(0, 7)} on the server (so an interrupted rsync is detectable)`);
  try {
    execFileSync('ssh', sshArgs(buildPendingCommand(head)), { stdio: 'inherit', maxBuffer: 1024 * 1024 });
  } catch {
    // Not fatal: the box may predate r291, and the deploy itself still records its own outcome. The
    // only thing lost is detection of an rsync interrupted before deploy.sh starts.
    console.log('  (could not announce — continuing; the server may predate r291)');
  }

  // 3. rsync the worktree → server (same excludes as deploy; .env.production preserved on the box).
  const src = p.worktree.replace(/\/?$/, '/');
  console.log(`→ rsync ${src} → ${USER}@${HOST}:${DIR}/`);
  run('rsync', deploymentRsyncArgs(src));

  // 4. deploy.sh on the server, DETACHED (build + migrate; the restart still needs the user's sudo,
  //    by design), then followed by polling. See the header for why.
  console.log('→ deploy.sh on the server — detached (setsid nohup); following by polling');
  const launch = execFileSync('ssh', sshArgs(buildLaunchCommand(head)), {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const logLine = /aihr-deploy-log=(\S+)/.exec(launch);
  console.log(`  launched; server log: ${logLine ? logLine[1] : '(unknown)'}`);
  console.log('  a Ctrl-C or a dropped connection from here on stops the WATCHING, not the deploy.');

  const status = followDeploy({
    run: (offset) =>
      execFileSync('ssh', sshArgs(buildFollowCommand(offset)), {
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
  });

  console.log('');
  console.log(describeDeployStatus(status));

  if (!isSuccessState(status.state ?? 'unknown')) {
    // THE POINT OF THE WHOLE ROUND. A detached deploy that failed on the server must fail HERE too, or
    // it is worse than the attached version it replaced: cli.ts turns this into process.exit(1), the
    // item is NOT marked deployed, and the operator is told where to look.
    throw new Error(
      `the remote deploy did not finish cleanly (state=${status.state ?? 'unknown'}). ` +
        `Nothing has been marked deployed.\n` +
        (status.log && status.log !== '-'
          ? `  full output:  ssh -p ${PORT} ${USER}@${HOST} "cat ${status.log}"\n`
          : '') +
        `  current state: ssh -p ${PORT} ${USER}@${HOST} "cd ${DIR} && deploy/deploy-state.sh status"`,
    );
  }
}

export async function releaseBuiltItem(p: {
  id: string;
  tenantId: string;
  reporterEmploymentId: string;
  worktree: string;
  branch?: string;
  buildRef: string;
}): Promise<void> {
  if (!p.worktree || !existsSync(p.worktree)) {
    throw new Error(`worktree not found: ${p.worktree} — build the item first`);
  }
  await deployWorktree({ worktree: p.worktree });

  // 5. close the loop: status → deployed + a feedback.deployed event.
  markDeployed({ id: p.id, tenantId: p.tenantId, reporterEmploymentId: p.reporterEmploymentId, buildRef: p.buildRef });

  console.log(`\n✓ released ${p.id} (ref=${p.buildRef}) — status → deployed.`);
  console.log('  Remaining manual steps:');
  console.log('   • on the server:  sudo systemctl restart aihr   (loads the new build)');
  if (p.branch) console.log(`   • in the repo:    git checkout main && git merge --no-ff ${p.branch}   (fold the shipped branch into main)`);
}
