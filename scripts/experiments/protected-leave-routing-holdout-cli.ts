import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { REPO_ROOT } from '../teras/output';
import { scoreProtectedLeaveRoutingHoldout } from './protected-leave-routing-holdout';
import { PROTECTED_HOLDOUT_LIMIT_BYTES } from './protected-work-summary-holdout';

function main() {
  const [filename, digest, ...extra] = process.argv.slice(2);
  if (!filename || !/^[a-f0-9]{64}$/.test(digest ?? '') || extra.length)
    throw Error('Supply evaluator-owned CASE_FILE SHA256.');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--untracked-files=no')) throw Error('Use the clean frozen candidate checkout.');
  const candidateSha = git('rev-parse', 'HEAD');
  let bytes: Buffer;
  try {
    const path = realpathSync(filename);
    const location = relative(realpathSync(REPO_ROOT), path);
    const stat = statSync(path);
    if ((!isAbsolute(location) && !location.startsWith('..' + sep)) ||
        !stat.isFile() || stat.size > PROTECTED_HOLDOUT_LIMIT_BYTES) throw Error();
    bytes = readFileSync(path);
  } catch { throw Error('Use a bounded evaluator file outside the checkout.'); }
  const report = scoreProtectedLeaveRoutingHoldout(bytes, digest, candidateSha);
  if (git('rev-parse', 'HEAD') !== candidateSha || git('status', '--porcelain', '--untracked-files=no'))
    throw Error('The candidate checkout changed during scoring.');
  console.log(JSON.stringify(report));
  if (!report.meetsThreshold) process.exitCode = 2;
}

try { main(); }
catch { console.error('Leave routing evaluation refused. Check the frozen checkout and evaluator file.'); process.exitCode = 1; }
