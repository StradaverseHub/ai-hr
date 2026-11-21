import { createPrivateKey } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { REPO_ROOT } from '../teras/output';
import { LEAVE_RECEIPT_INPUT_LIMIT, signPairedLeaveEvaluation, verifyPairedLeaveEvaluations } from '../../lib/ai/assistant-leave-evaluation-receipt';

function outside(path: string) {
  const location = relative(realpathSync(REPO_ROOT), path);
  if (!isAbsolute(location) && !location.startsWith('..' + sep)) throw Error('Use evaluator files outside the checkout.');
  return path;
}
function read(filename: string, privateKey = false) {
  const path = outside(realpathSync(filename));
  const info = statSync(path);
  if (!info.isFile() || info.size < 1 || info.size > LEAVE_RECEIPT_INPUT_LIMIT ||
      (privateKey && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())))
    throw Error('Use bounded files and an owner-only signing key.');
  const bytes = readFileSync(path);
  if (!bytes.length || bytes.length > LEAVE_RECEIPT_INPUT_LIMIT) throw Error('Evaluator file exceeds the limit.');
  return bytes;
}
const json = (path: string): unknown => JSON.parse(read(path).toString('utf8'));

function main() {
  const [op, planPath, planDigest, ...args] = process.argv.slice(2);
  if (!planPath || !/^[a-f0-9]{64}$/.test(planDigest ?? '') ||
      !(op === 'sign' && args.length === 4 || op === 'verify' && args.length === 2))
    throw Error('Supply a frozen plan, its pinned digest and evaluator files.');
  const plan = read(planPath);
  if (op === 'sign') {
    const [evaluatorId, reportPath, keyPath, receiptPath] = args;
    const output = outside(join(realpathSync(dirname(receiptPath)), basename(receiptPath)));
    const receipt = signPairedLeaveEvaluation(plan, planDigest, evaluatorId, json(reportPath), createPrivateKey(read(keyPath, true)));
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return;
  }
  console.log(JSON.stringify(verifyPairedLeaveEvaluations(plan, planDigest, args.map(json))));
}

try { main(); }
catch { console.error('Paired leave evidence refused. Check the frozen plan, evaluator files and signing key.'); process.exitCode = 1; }
