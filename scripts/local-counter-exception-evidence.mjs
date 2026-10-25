/** Independent read-only collection. No receipt writes, network, application or deployment. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {openSync, closeSync, fstatSync, readFileSync, realpathSync, lstatSync} from 'node:fs';
import {resolve, join, basename} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {COUNTER_EXCEPTION as P, sha256, reviewPassingReport, reviewCounterController} from './local-counter-exception.mjs';
const requireEvidence = (ok, why) => assert(ok, 'Counter exception collection refused: ' + why);
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024}).trim();
export function boundedReader(root, group, artifacts) {
  root = resolve(root); requireEvidence(realpathSync(root) === root && lstatSync(root).isDirectory(), 'noncanonical archive root');
  let total = 0;
  return relative => {
    requireEvidence(typeof relative === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(relative)
      && !relative.split('/').some(x => x === '.' || x === '..'), 'unsafe artifact path');
    const path = join(root, relative), stat = lstatSync(path);
    requireEvidence(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path, 'nonregular artifact');
    requireEvidence(stat.size <= 64 * 1024 * 1024 && (total += stat.size) <= 512 * 1024 * 1024, 'artifact budget');
    const fd = openSync(path, 'r'); let bytes;
    try {
      const before = fstatSync(fd); requireEvidence(before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size, 'artifact replaced before read');
      bytes = readFileSync(fd); const after = fstatSync(fd);
      requireEvidence(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && bytes.length === after.size, 'artifact changed during read');
      const current = lstatSync(path); requireEvidence(current.dev === after.dev && current.ino === after.ino && current.size === after.size && realpathSync(path) === path, 'artifact path changed');
    } finally { closeSync(fd); }
    artifacts.push({group, path: relative, bytes: bytes.length, sha256: sha256(bytes)}); return bytes.toString('utf8');
  };
}
const list = text => {requireEvidence(text.endsWith('\n'), 'unterminated inventory'); return text.slice(0, -1).split('\n');};
export async function collectCounterException({candidatePath, runDirectory, now = Date.now()}) {
  candidatePath = resolve(candidatePath); runDirectory = resolve(runDirectory);
  requireEvidence(basename(runDirectory) === P.run, 'different run');
  const artifacts = [], read = boundedReader(runDirectory, 'run', artifacts), json = path => JSON.parse(read(path));
  // Refuse active/incomplete runs before any source classification or report scan.
  const cleanup = json('cleanup.json');
  requireEvidence(cleanup.sharedRestoredAndContentsVerified === true && cleanup.privateDirectoryRemoved === true && cleanup.gateExit === 1 && cleanup.interrupted === 0 && equal(cleanup.errors, []), 'run incomplete, interrupted or restoration failed');
  requireEvidence(realpathSync(candidatePath) === candidatePath && git(candidatePath, 'rev-parse', 'HEAD') === P.candidate && !git(candidatePath, 'status', '--porcelain'), 'wrong or dirty candidate');
  requireEvidence(git(candidatePath, 'remote', 'get-url', 'origin').toLowerCase() === 'https://github.com/stradaversehub/ai-hr.git', 'wrong repository');
  execFileSync('git', ['merge-base', '--is-ancestor', P.baseline, P.candidate], {cwd: candidatePath, stdio: 'ignore'});
  const source = boundedReader(candidatePath, 'source', artifacts);
  const receipt = JSON.parse(source('.gate-receipt.json'));
  requireEvidence(receipt.sha === P.candidate && receipt.result === 'FAIL' && receipt.tier === 'full', 'original failure relabelled or changed');
  const at = Date.parse(receipt.at);
  requireEvidence(Number.isFinite(at) && at <= now + 60000 && now - at <= 24 * 60 * 60 * 1000, 'receipt outside one-day exception window');
  const sourceRecord = json('controller-source.json');
  requireEvidence(sourceRecord.source === P.candidate && sourceRecord.sha256 === P.wrapperSha256 && sha256(read('frozen-controller.py')) === P.wrapperSha256, 'wrapper source changed');
  const before = json('shared-before.json'), restored = json('shared-restored.json'), recovered = json('recovery-complete.json');
  requireEvidence(restored.sameLogicalContentsConfigOptionsAndIdentity === true && restored.sharedDatabaseSqlWrites === 0 && equal(restored.snapshot, before), 'retained fixture content/config/identity changed');
  requireEvidence(before.systemIdentifier === '7700576020832388449' && before.otherClients === 0 && before.externalTablespaces === 0, 'unexpected shared cluster');
  requireEvidence(recovered.passed === true && recovered.systemIdentifier === before.systemIdentifier && recovered.originalContentsAndConfigurationVerified === true && recovered.ownedGateGroupTerminal === true && recovered.ownedPrivateClusterStopped === true, 'recovery incomplete');
  const recoveryPlan = json('recovery-plan.json');
  requireEvidence(sha256(read('pinned-recovery-code/local-fixture-preservation.py')) === recoveryPlan.helperSha256 && sha256(read('pinned-recovery-code/local-fixture-recovery.py')) === recoveryPlan.recoverySha256, 'recovery helper changed');
  const recorded = {all: list(read('fullgate/all-files.txt')), db: list(read('fullgate/db-files.txt')), nodb: list(read('fullgate/nodb-files.txt'))};
  const tracked = git(candidatePath, 'ls-files', '-z').split('\0').filter(Boolean);
  const all = tracked.filter(p => /^test\/.+\.(?:test\.ts|dom\.test\.tsx)$/.test(p)).sort();
  const trackedSet = new Set(tracked), cache = new Map();
  const readSource = path => {
    if (!trackedSet.has(path)) return null;
    if (!cache.has(path)) cache.set(path, source(path)); return cache.get(path);
  };
  source('scripts/gate-db-classify.ts'); source('scripts/gate-chunked.sh');
  // This frozen classifier only reads supplied text. It imports no application or DB module.
  const rawModule = await import(pathToFileURL(join(candidatePath, 'scripts/gate-db-classify.ts')).href);
  const classify = rawModule.classifyTestFiles ?? rawModule.default?.classifyTestFiles;
  requireEvidence(typeof classify === 'function', 'classifier missing');
  const {db, nodb} = classify(all, readSource), inventory = {all, db, nodb};
  requireEvidence(equal(recorded, inventory), 'source-derived inventory differs');
  const classifyLines = list(read('fullgate/classify.tsv')).map(l => l.split('\t').slice(0, 2).join('\t')).sort();
  requireEvidence(equal(classifyLines, [...db.map(p => 'DB\t' + p), ...nodb.map(p => 'NODB\t' + p)].sort()), 'classifier metadata differs');
  const controller = reviewCounterController(read('fullgate/full-controller.log'), inventory);
  const phases = [{name: 'nodb', ...reviewPassingReport(read('fullgate/nodb.log'), nodb)}];
  for (let i = 0; i < P.chunks; i++) {
    read('fullgate/rebuild' + (i + 1) + '.log'); read('fullgate/migrate' + (i + 1) + '.log');
    phases.push({name: 'db-' + (i + 1), ...reviewPassingReport(read('fullgate/chunk' + (i + 1) + '.log'), db.filter((_, n) => n % P.chunks === i))});
  }
  requireEvidence(git(candidatePath, 'rev-parse', 'HEAD') === P.candidate && !git(candidatePath, 'status', '--porcelain'), 'source changed during collection');
  return {kind: P.kind, policyVersion: P.version, candidate: P.candidate, baseline: P.baseline, candidatePath, runDirectory,
    ownerAuthorization: {thread: P.authorizationThread, turn: P.authorizationTurn, text: P.authorization},
    canonicalResult: 'FAIL', rawVitestExit: 'UNKNOWN_NOT_SEPARATELY_RECORDED', controller, phases,
    filesWithPassingReports: phases.reduce((n, p) => n + p.files, 0), casesWithPassingReports: phases.reduce((n, p) => n + p.cases, 0),
    restoredOriginalContentsAndConfiguration: true, counterRepairVerificationRequired: true,
    compilerBuildBrowserArrivalVerifiedByThisCollector: false, releaseAuthorized: false, artifacts};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidatePath, runDirectory] = process.argv.slice(2);
  requireEvidence(process.argv.length === 4 && candidatePath && runDirectory, 'usage: node --import <candidate-tsx-loader> local-counter-exception-evidence.mjs <candidate> <terminal-run-directory>');
  collectCounterException({candidatePath, runDirectory}).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {console.error(error.message); process.exitCode = 1;});
}
