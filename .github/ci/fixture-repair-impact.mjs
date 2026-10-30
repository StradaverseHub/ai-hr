/** Reconstruct an impact plan from immutable Git objects using the existing pinned classifier. */
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './manifest.mjs';
const controllerDirectory = fileURLToPath(new URL('../../', import.meta.url));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = (cwd, ...args) => execFileSync('git', args, {cwd, maxBuffer: 128 * 1024 ** 2, timeout: 60000});
const text = (cwd, ...args) => git(cwd, ...args).toString('utf8').trim();
const fail = reason => {throw Error('Repair impact refused: ' + reason);};

/** Parse exactly one bounded cat-file response for every requested object, with no suffix or truncation. */
export function decodeCommittedBlobs(ids, bytes) {
  if (!Array.isArray(ids) || !ids.every(sha) || new Set(ids).size !== ids.length || !Buffer.isBuffer(bytes))
    fail('invalid blob inventory');
  const result = new Map(); let offset = 0;
  for (const id of ids) {
    const end = bytes.indexOf(10, offset);
    if (end < offset) fail('incomplete blob header');
    const fields = bytes.subarray(offset, end).toString('utf8').split(' '), size = Number(fields[2]);
    if (fields.length !== 3 || fields[0] !== id || fields[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0)
      fail('invalid blob header');
    offset = end + 1;
    if (offset + size >= bytes.length || bytes[offset + size] !== 10) fail('incomplete blob bytes');
    result.set(id, bytes.subarray(offset, offset + size).toString('utf8'));
    offset += size + 1;
  }
  if (offset !== bytes.length) fail('unexpected blob suffix');
  return result;
}

function committedTexts(cwd, ref) {
  const records = git(cwd, 'ls-tree', '-r', '-z', ref).toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (const record of records) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match) fail('unsupported Git tree entry');
    if (!/\.(?:[cm]?[jt]sx?|json|css|md)$/.test(match[4])) continue;
    if (!['100644', '100755'].includes(match[1]) || match[2] !== 'blob') fail('non-regular classifier input');
    entries.push({path: match[4], id: match[3]});
  }
  const ids = [...new Set(entries.map(entry => entry.id))];
  if (!ids.length) fail('no committed classifier inputs');
  const bytes = execFileSync('git', ['cat-file', '--batch'], {cwd, input: ids.join('\n') + '\n',
    maxBuffer: 128 * 1024 ** 2, timeout: 60000});
  const blobs = decodeCommittedBlobs(ids, bytes);
  return new Map(entries.map(entry => [entry.path, blobs.get(entry.id)]));
}

/** Requires the installed tsx loader and TypeScript parser; does not execute application/test bodies. */
export function reconstructFixtureRepairImpact({cwd, base, head, controller}) {
  cwd = resolve(cwd);
  if (![base, head, controller].every(sha) || base === head) fail('exact distinct source/candidate and controller required');
  if (text(controllerDirectory, 'rev-parse', 'HEAD') !== controller || text(controllerDirectory, 'status', '--porcelain'))
    fail('controller must be exact and clean');
  if (text(cwd, 'remote', 'get-url', 'origin').toLowerCase() !== 'https://github.com/stradaversehub/ai-hr.git')
    fail('unexpected repository origin');
  for (const ref of [base, head]) if (text(cwd, 'rev-parse', '--verify', ref + '^{commit}') !== ref) fail('not a commit');
  execFileSync('git', ['merge-base', '--is-ancestor', base, head], {cwd, stdio: 'ignore', timeout: 60000});
  const require = createRequire(import.meta.url);
  const {planImpact, IMPACT_POLICY_VERSION} = require(join(controllerDirectory, '.github/ci/fixture-impact-classifier.ts'));
  const {collectChanges} = require(join(controllerDirectory, 'scripts/gate-tier-git.ts'));
  if (IMPACT_POLICY_VERSION !== 4) fail('unexpected existing impact policy');
  const changes = collectChanges(base, head, cwd), files = committedTexts(cwd, head);
  if (!changes.length) fail('empty repair delta');
  // Historical failures are a separate independently authenticated input, still required before activation.
  const plan = planImpact(changes, files);
  const baseTree = text(cwd, 'rev-parse', base + '^{tree}'), headTree = text(cwd, 'rev-parse', head + '^{tree}');
  const context = {base, head, controller, baseTree, headTree, plan,
    sourceInputsFingerprint: hash({baseTree, headTree, controller, impactPolicy: IMPACT_POLICY_VERSION}),
    snapshotSource: 'IMMUTABLE_GIT_OBJECTS', historyIncluded: false,
    requiresLatestFailureHistoryValidation: true, releaseAuthorized: false};
  if (text(controllerDirectory, 'rev-parse', 'HEAD') !== controller || text(controllerDirectory, 'status', '--porcelain'))
    fail('controller changed while reconstructing impact');
  return context;
}
