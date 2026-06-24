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
import { existsSync } from 'node:fs';
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
  console.log('→ final gate: npx tsc --noEmit');
  run('npx', ['tsc', '--noEmit'], p.worktree);
  console.log('→ final gate: pnpm vitest run');
  run('pnpm', ['vitest', 'run'], p.worktree);

  // 2. rsync the worktree → server (same excludes as deploy; .env.production preserved on the box).
  const src = p.worktree.replace(/\/?$/, '/');
  console.log(`→ rsync ${src} → ${USER}@${HOST}:${DIR}/`);
  run('rsync', [
    '-az', '--delete',
    '-e', `ssh -p ${PORT} -o BatchMode=yes -o ConnectTimeout=12`,
    '--exclude', 'node_modules', '--exclude', '.next', '--exclude', '.git', '--exclude', '.env*',
    '--exclude', '.turbo', '--exclude', 'coverage', '--exclude', '.claude',
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
