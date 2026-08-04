/**
 * Improvement-loop release (ADR-0045, IL-4) — the HUMAN-GATED step. Ships a built, green worktree to the
 * server and closes the feedback item. This is NEVER run by the schedule: a human reviews the preview + the
 * diff first, then invokes `improve:release` explicitly.
 *
 *   echo '{"id","tenantId","reporterEmploymentId","worktree","branch","buildRef"}' | pnpm improve:release
 *
 * Flow: final gate (tsc + vitest in the worktree) → rsync worktree → server → deploy.sh → markDeployed.
 * Credentials never leave the server (deploy.sh sources its own .env.production); the service restart still
 * needs the user's sudo (deploy.sh declines it by design).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markDeployed } from './remote';

const HOST = process.env.IMPROVE_SSH_HOST ?? '10.20.30.20';
const PORT = process.env.IMPROVE_SSH_PORT ?? '8288';
const USER = process.env.IMPROVE_SSH_USER ?? 'ubuntu';
const DIR = process.env.IMPROVE_REMOTE_DIR ?? '/opt/ai-hr';

function run(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { stdio: 'inherit', cwd, maxBuffer: 64 * 1024 * 1024 });
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

  // 1. FINAL GATE — re-verify green in the worktree before anything leaves this machine.
  //
  // tsc always runs (seconds). The full suite only runs when we can't prove it already passed on THIS exact
  // commit: cleanroom-verify.sh writes .gate-receipt.json with the sha it validated. Without that check the
  // suite ran twice per round on an identical tree — ~13 minutes for zero extra information. A missing,
  // stale, or unreadable receipt falls through to running it, so the safe path is the default.
  console.log('→ final gate: npx tsc --noEmit');
  run('npx', ['tsc', '--noEmit'], p.worktree);

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.worktree, encoding: 'utf8' }).trim();
  let receiptSha: string | null = null;
  try {
    const receipt = JSON.parse(readFileSync(join(p.worktree, '.gate-receipt.json'), 'utf8')) as {
      sha?: string;
      result?: string;
    };
    if (receipt.result === 'PASS' && receipt.sha) receiptSha = receipt.sha;
  } catch {
    // no receipt (or unreadable) → fall through and run the suite
  }

  if (receiptSha === head) {
    console.log(`→ final gate: vitest SKIPPED — clean-room receipt already covers ${head.slice(0, 7)}`);
  } else {
    const why = receiptSha ? `receipt is for ${receiptSha.slice(0, 7)}, HEAD is ${head.slice(0, 7)}` : 'no receipt';
    console.log(`→ final gate: pnpm vitest run (${why})`);
    run('pnpm', ['vitest', 'run'], p.worktree);
  }

  // 2. rsync the worktree → server (same excludes as deploy; .env.production preserved on the box).
  const src = p.worktree.replace(/\/?$/, '/');
  console.log(`→ rsync ${src} → ${USER}@${HOST}:${DIR}/`);
  run('rsync', [
    '-az', '--delete',
    '-e', `ssh -p ${PORT} -o BatchMode=yes -o ConnectTimeout=12`,
    '--exclude', 'node_modules', '--exclude', '.next', '--exclude', '.git', '--exclude', '.env*',
    '--exclude', '.turbo', '--exclude', 'coverage', '--exclude', '.claude', '--exclude', 'graphify-out',
    src, `${USER}@${HOST}:${DIR}/`,
  ]);

  // 3. deploy.sh on the server (build + migrate; the restart still needs the user's sudo, by design).
  console.log('→ deploy.sh on the server');
  run('ssh', ['-p', PORT, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', `${USER}@${HOST}`, `cd ${DIR} && ./deploy/deploy.sh`]);

  // 4. close the loop: status → deployed + a feedback.deployed event.
  markDeployed({ id: p.id, tenantId: p.tenantId, reporterEmploymentId: p.reporterEmploymentId, buildRef: p.buildRef });

  console.log(`\n✓ released ${p.id} (ref=${p.buildRef}) — status → deployed.`);
  console.log('  Remaining manual steps:');
  console.log('   • on the server:  sudo systemctl restart aihr   (loads the new build)');
  if (p.branch) console.log(`   • in the repo:    git checkout main && git merge --no-ff ${p.branch}   (fold the shipped branch into main)`);
}
