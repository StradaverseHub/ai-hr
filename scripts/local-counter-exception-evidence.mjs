/** Independent read-only collection. No receipt writes, network, application or deployment. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {platform,arch} from 'node:os';
import {openSync, closeSync, fstatSync, readFileSync, realpathSync, lstatSync} from 'node:fs';
import {resolve, join, basename} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {COUNTER_EXCEPTION as P, sha256, plainReport, reviewPassingReport, reviewCounterController, reviewComposedControllers} from './local-counter-exception.mjs';
const requireEvidence = (ok, why) => assert(ok, 'Counter exception collection refused: ' + why);
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024}).trim();
export function boundedReader(root, group, artifacts, {maxFileBytes=64*1024*1024,maxTotalBytes=512*1024*1024}={}) {
  root = resolve(root); requireEvidence(realpathSync(root) === root && lstatSync(root).isDirectory(), 'noncanonical archive root');
  let total = 0;
  return relative => {
    requireEvidence(typeof relative === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(relative)
      && !relative.split('/').some(x => x === '.' || x === '..'), 'unsafe artifact path');
    const path = join(root, relative), stat = lstatSync(path);
    requireEvidence(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path, 'nonregular artifact');
    requireEvidence(stat.size <= maxFileBytes && (total += stat.size) <= maxTotalBytes, 'artifact budget');
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
export const COUNTER_REPAIR = Object.freeze({
  source: '29ee93b38c3647d2c066e53189f15e106bd5049c',
  files: Object.freeze({
    'scripts/gate-chunked.sh': '8f7e564816175e2f6eec1065ac117196c798ab41d7ee575b657dd69bf563103e',
    'scripts/gate-counted-output.test.mjs': 'f4ada427793f069d820383d4962d2e2b3d72d9b8acb8705ec0a04088e9e60d3d',
  }),
});
export function counterSourceBoundary(candidatePath) {
  const head = git(candidatePath, 'rev-parse', 'HEAD');
  requireEvidence(!git(candidatePath, 'status', '--porcelain'), 'dirty candidate');
  if (head === P.candidate) return {original: P.candidate, final: head, counterRepairApplied: false};
  requireEvidence(git(candidatePath, 'show', '-s', '--format=%P', head) === P.candidate, 'repair must be the single normal child of the observed candidate');
  const paths = git(candidatePath, 'diff', '--name-only', P.candidate, head).split('\n').sort();
  requireEvidence(equal(paths, Object.keys(COUNTER_REPAIR.files).sort()), 'repair changed unrelated source');
  for (const [path, hash] of Object.entries(COUNTER_REPAIR.files)) requireEvidence(sha256(readFileSync(join(candidatePath, path))) === hash, 'counter repair bytes differ');
  return {original: P.candidate, final: head, counterRepairApplied: true, repairSource: COUNTER_REPAIR.source, changedPaths: paths};
}
const list = text => {requireEvidence(text.endsWith('\n'), 'unterminated inventory'); return text.slice(0, -1).split('\n');};
export async function collectCounterException({candidatePath, runDirectory, now = Date.now()}) {
  candidatePath = resolve(candidatePath); runDirectory = resolve(runDirectory);
  requireEvidence(basename(runDirectory) === P.run, 'different run');
  const artifacts = [], read = boundedReader(runDirectory, 'run', artifacts, {maxFileBytes:128*1024*1024,maxTotalBytes:2*1024*1024*1024}), json = path => JSON.parse(read(path));
  // Refuse active/incomplete runs before any source classification or report scan.
  const cleanup = json('cleanup.json'), composed = cleanup.interrupted === 15;
  let resumeDirectory, resumeRead, resumeJson;
  if (composed) {
    requireEvidence(cleanup.gateExit === -15 && cleanup.sharedRestoredAndContentsVerified === false && cleanup.privateDirectoryRemoved === false
      && cleanup.errors?.length === 1 && cleanup.errors[0].includes('pg_ctl') && cleanup.errors[0].includes("'stop'"), 'unexpected original cancellation/cleanup failure');
    const followup=json('recovery-followup.json');
    requireEvidence(followup.passed===true&&followup.originalCleanupFailureRetained===true&&followup.pinnedRecoveryExit===0&&followup.sharedRestoredAndContentsVerified===true&&followup.privateDirectoryRemoved===true,'cancelled run recovery retry incomplete');
    const failure=json('failure.json');requireEvidence(failure.source===P.candidate&&failure.gateExit===-15&&failure.interrupted===15,'original interruption not preserved');
    resumeDirectory=join(candidatePath,'scratchpad',P.resume);
    resumeRead=boundedReader(resumeDirectory,'resume',artifacts,{maxFileBytes:128*1024*1024,maxTotalBytes:2*1024*1024*1024});
    resumeJson=path=>JSON.parse(resumeRead(path));
    const resumeCleanup=resumeJson('cleanup.json');
    requireEvidence(resumeCleanup.sharedRestoredAndContentsVerified===true&&resumeCleanup.privateDirectoryRemoved===true&&resumeCleanup.gateExit===1&&resumeCleanup.interrupted===0&&equal(resumeCleanup.errors,[]),'remaining slice active/interrupted/unrestored');
  } else requireEvidence(cleanup.sharedRestoredAndContentsVerified === true && cleanup.privateDirectoryRemoved === true && cleanup.gateExit === 1 && cleanup.interrupted === 0 && equal(cleanup.errors, []), 'run incomplete, interrupted or restoration failed');
  requireEvidence(realpathSync(candidatePath) === candidatePath, 'noncanonical candidate');
  const sourceBoundary = counterSourceBoundary(candidatePath);
  requireEvidence(git(candidatePath, 'remote', 'get-url', 'origin').toLowerCase() === 'https://github.com/stradaversehub/ai-hr.git', 'wrong repository');
  execFileSync('git', ['merge-base', '--is-ancestor', P.baseline, P.candidate], {cwd: candidatePath, stdio: 'ignore'});
  const source = boundedReader(candidatePath, 'source', artifacts);
  const receiptText=source('.gate-receipt.json'),receipt=JSON.parse(receiptText);
  let learning;
  if(composed) {
    requireEvidence(sha256(receiptText)===P.cancelledReceiptSha256&&receipt.sha===P.candidate&&receipt.result==='FAIL'&&receipt.tier==='impact'&&receipt.reason==='Verification in progress','original incomplete receipt changed or relabelled');
    const boundary=resumeJson('slice-only-boundary.json');
    requireEvidence(boundary.kind==='SLICE_ONLY_NO_RELEASE_AUTHORITY'&&boundary.source===P.candidate&&boundary.chunks===16&&boundary.from===9&&boundary.to===16&&boundary.fullGate===false&&boundary.receiptReadForbiddenForAcceptance===true&&boundary.rawReportsAndRestorationRequired===true&&equal(boundary.existingReceipt,receipt)&&boundary.existingReceiptSha256===sha256(receiptText),'slice authority/source boundary differs');
    learning=json('fullgate/plan.json');
    requireEvidence(learning.sha===P.candidate&&learning.base===P.baseline&&learning.deployed===P.baseline&&learning.plan?.tier==='full'&&learning.plan.policyVersion===3,'cancelled full plan differs');
  } else {
    requireEvidence(receipt.sha === P.candidate && receipt.result === 'FAIL' && receipt.tier === 'full', 'original failure relabelled or changed');
    learning=json('fullgate/learning.json');
    requireEvidence(learning.sha===P.candidate && learning.base===P.baseline && learning.result==='FAIL' && learning.tier==='full'&&equal(learning.fullReceipt,receipt),'original learning/receipt provenance differs');
  }
  const envHash=createHash('sha256').update(JSON.stringify([process.versions.node,platform(),arch()]));
  for(const path of ['.env.local','pnpm-lock.yaml','tsconfig.json','tsconfig.build.json','next.config.ts','vitest.config.ts','vitest.nodb.config.ts','vitest.browser.config.ts','test/env.ts','test/global-setup.ts','test/dom-setup.ts','test/db-names.ts']) {
    envHash.update(path);envHash.update(source(path));
  }
  requireEvidence(learning.environmentHash===envHash.digest('hex'),'runtime/configuration environment changed');
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
  if(composed) {
    const bound=resumeJson('controller-source.json');
    requireEvidence(bound.source===P.candidate&&bound.sha256===P.resumeWrapperSha256&&sha256(resumeRead('frozen-controller.py'))===P.resumeWrapperSha256,'resume wrapper differs');
    const start=resumeJson('shared-before.json'),end=resumeJson('shared-restored.json'),recovery=resumeJson('recovery-complete.json'),plan=resumeJson('recovery-plan.json');
    requireEvidence(equal(start,before)&&end.sameLogicalContentsConfigOptionsAndIdentity===true&&end.sharedDatabaseSqlWrites===0&&equal(end.snapshot,start),'remaining slice original shared state differs');
    requireEvidence(recovery.passed===true&&recovery.systemIdentifier===before.systemIdentifier&&recovery.originalContentsAndConfigurationVerified===true&&recovery.ownedGateGroupTerminal===true&&recovery.ownedPrivateClusterStopped===true,'remaining slice recovery incomplete');
    requireEvidence(plan.helperSha256===recoveryPlan.helperSha256&&plan.recoverySha256===recoveryPlan.recoverySha256&&sha256(resumeRead('pinned-recovery-code/local-fixture-preservation.py'))===plan.helperSha256&&sha256(resumeRead('pinned-recovery-code/local-fixture-recovery.py'))===plan.recoverySha256,'remaining preservation code differs');
  }
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
  if(composed) {
    const again={all:list(resumeRead('fullgate/all-files.txt')),db:list(resumeRead('fullgate/db-files.txt')),nodb:list(resumeRead('fullgate/nodb-files.txt'))};
    requireEvidence(equal(again,inventory)&&resumeRead('fullgate/classify.tsv')===read('fullgate/classify.tsv'),'remaining inventory/classification changed');
    const partial=plainReport(read('fullgate/chunk9.log'));
    requireEvidence(!/^\s*Test Files\s/m.test(partial)&&!/^\s*Duration\s/m.test(partial),'discarded original ninth batch unexpectedly terminal');
    read('fullgate/rebuild9.log');read('fullgate/migrate9.log');
  }
  const controller = composed?reviewComposedControllers(read('fullgate/full-controller.log'),resumeRead('gate-entry.log'),inventory):reviewCounterController(read('fullgate/full-controller.log'), inventory);
  const phases = [{name: 'nodb', origin:P.run, ...reviewPassingReport(read('fullgate/nodb.log'), nodb)}];
  for (let i = 0; i < P.chunks; i++) {
    const phaseRead=composed&&i>=8?resumeRead:read;
    phaseRead('fullgate/rebuild' + (i + 1) + '.log'); phaseRead('fullgate/migrate' + (i + 1) + '.log');
    phases.push({name: 'db-' + (i + 1), origin:composed&&i>=8?P.resume:P.run,...reviewPassingReport(phaseRead('fullgate/chunk' + (i + 1) + '.log'), db.filter((_, n) => n % P.chunks === i), {database:true})});
  }
  requireEvidence(equal(counterSourceBoundary(candidatePath), sourceBoundary), 'source changed during collection');
  return {kind: P.kind, policyVersion: P.version, candidate: sourceBoundary.final, originalCandidate: P.candidate, sourceBoundary, baseline: P.baseline, candidatePath, runDirectory,
    ownerAuthorization: {thread: P.authorizationThread, turn: P.authorizationTurn, text: P.authorization},
    canonicalResult: composed?'INCOMPLETE_CANCELLED':'FAIL', composedFromCancelledPrefix:composed, ...(composed?{resumeDirectory}:{}), rawVitestExit: 'UNKNOWN_NOT_SEPARATELY_RECORDED', controller, phases,
    filesWithPassingReports: phases.reduce((n, p) => n + p.files, 0), casesWithPassingReports: phases.reduce((n, p) => n + p.cases, 0),
    restoredOriginalContentsAndConfiguration: true, counterRepairVerificationRequired: true,
    compilerBuildBrowserArrivalVerifiedByThisCollector: false, releaseAuthorized: false, artifacts};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidatePath, runDirectory] = process.argv.slice(2);
  requireEvidence(process.argv.length === 4 && candidatePath && runDirectory, 'usage: node --import <candidate-tsx-loader> local-counter-exception-evidence.mjs <candidate> <terminal-run-directory>');
  collectCounterException({candidatePath, runDirectory}).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {console.error(error.message); process.exitCode = 1;});
}
