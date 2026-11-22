import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { REPO_ROOT } from '../teras/output';
import {
  compareLeavePredecessor, prepareLeavePredecessorHoldout, scoreLeavePredecessorTrial,
  scoreLeaveRoutingSuccessor, scoreProtectedLeaveRoutingHoldout,
} from './protected-leave-routing-holdout';
import { PROTECTED_HOLDOUT_LIMIT_BYTES } from './protected-work-summary-holdout';

function outsideCheckout(path: string) {
  const location = relative(realpathSync(REPO_ROOT), path);
  if (!isAbsolute(location) && !location.startsWith('..' + sep))
    throw Error('Use evaluator files outside the checkout.');
  return path;
}

function readEvaluatorFile(filename: string) {
  const path = outsideCheckout(realpathSync(filename));
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > PROTECTED_HOLDOUT_LIMIT_BYTES) throw Error('Use a bounded evaluator file.');
  const bytes = readFileSync(path);
  if (bytes.length > PROTECTED_HOLDOUT_LIMIT_BYTES) throw Error('Use a bounded evaluator file.');
  return bytes;
}

function main() {
  const [filename, digest, mode = '', ...extra] = process.argv.slice(2);
  const argumentCounts = new Map([['', 0], ['--compare-successor', 0], ['--score-predecessor', 0], ['--prepare-predecessor', 2], ['--compare-predecessor', 2]]);
  if (!filename || !/^[a-f0-9]{64}$/.test(digest ?? '') || extra.length !== argumentCounts.get(mode))
    throw Error('Supply the frozen suite, its digest and any comparison arguments.');
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const clean = () => !git('status', '--porcelain', '--untracked-files=no');
  if (!clean()) throw Error('Use the clean frozen candidate checkout.');
  const candidateSha = git('rev-parse', 'HEAD');
  const verifyCheckout = () => {
    if (git('rev-parse', 'HEAD') !== candidateSha || !clean())
      throw Error('The candidate checkout changed during scoring.');
  };
  const bytes = readEvaluatorFile(filename);
  const [predecessorSha, otherPath] = extra;
  if (extra.length) {
    if (!/^[a-f0-9]{40}$/.test(predecessorSha ?? '') || predecessorSha === candidateSha)
      throw Error('Supply a distinct frozen predecessor commit.');
    git('merge-base', '--is-ancestor', predecessorSha, candidateSha);
  }
  if (mode === '--prepare-predecessor') {
    const prepared = prepareLeavePredecessorHoldout(bytes, digest, candidateSha, predecessorSha);
    const output = outsideCheckout(join(realpathSync(dirname(otherPath)), basename(otherPath)));
    verifyCheckout();
    writeFileSync(output, prepared.bytes, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ predecessorSha, predecessorHoldoutDigest: prepared.digest }));
    return;
  }
  const report = mode === '--compare-predecessor'
    ? compareLeavePredecessor(bytes, digest, candidateSha, predecessorSha, JSON.parse(readEvaluatorFile(otherPath).toString('utf8')))
    : mode === '--compare-successor'
      ? scoreLeaveRoutingSuccessor(bytes, digest, candidateSha)
      : mode === '--score-predecessor'
        ? scoreLeavePredecessorTrial(bytes, digest, candidateSha)
        : scoreProtectedLeaveRoutingHoldout(bytes, digest, candidateSha);
  verifyCheckout();
  console.log(JSON.stringify(report));
  if (mode !== '--score-predecessor' && !report.meetsThreshold) process.exitCode = 2;
}

try { main(); }
catch { console.error('Leave routing evaluation refused. Check the frozen checkouts, digests and evaluator files.'); process.exitCode = 1; }
