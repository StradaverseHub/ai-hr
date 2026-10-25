/** One owner-approved staging acceptance. It does not relabel the failed full receipt. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {isDeepStrictEqual as equal} from 'node:util';
import {COUNTER_EXCEPTION as P, sha256} from './local-counter-exception.mjs';
import {collectCounterException, boundedReader, COUNTER_REPAIR} from './local-counter-exception-evidence.mjs';
export const ACCEPTANCE_TIER = 'owner-counter-exception-v1';
const requireProof = (v, why) => assert(v, 'Owner counter exception refused: ' + why);
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8', timeout:30000, maxBuffer:16*1024*1024}).trim();
const BUILD_SOURCE = 'fdc1e59866328280a16bb19d7e26da097a49ddf2';
const BROWSER_SOURCE = 'a3a2a5a7d4a207045079c00c69123e4cb24c2d21';
const BUILD_ID = 'GfqOhcLCVZVMLEwPRih3X';
const MANIFEST = '2989a83648dc113cf323528ddaffa0c5573005900bc1725ebb420d3ddea2021c';
const RAW_NODB = '3bbd19cb0bd5f3124f12507668b167292d3b725778d9bef8f0916b2cd9ed08ea';
export function validateCounterRepairProof(proof, log, {candidatePath, runDirectory, counterRoot}) {
  const result = {kind:'PURE_COUNTER_REGRESSIONS_ONLY',checks:21,passed:true,rawLogIncluded:true,originalRedIncluded:true,applicationTestsRun:0,databaseCommands:0};
  requireProof(proof.kind === 'PURE_COUNTER_REPAIR_VERIFICATION_NOT_RELEASE_RECEIPT' && proof.source === COUNTER_REPAIR.source && proof.exitCode === 0, 'wrong repair execution');
  requireProof(equal(proof.result,result) && equal(JSON.parse(log.trim()),result), 'repair regression results differ');
  requireProof(equal(proof.command,['node',join(counterRoot,'scripts/gate-counted-output.test.mjs'),join(runDirectory,'fullgate/nodb.log'),join(candidatePath,'scripts/gate-chunked.sh')]), 'repair command differs');
  requireProof(equal(proof.sourceHashes,COUNTER_REPAIR.files) && proof.rawLogSha256 === RAW_NODB
    && proof.originalScriptSha256 === '8b6285c7e933fce064e87a73f056f4a8ced71a3f63f54a9f09a14d9b7d92e6ca'
    && proof.checksLogSha256 === sha256(log) && proof.originalVitestExitRemainsUnknown === true && proof.noApplicationOrDatabaseRuntime === true, 'repair bytes or exit limitations differ');
  return {source:proof.source,checks:21,exitCode:0,originalRawVitestExit:'UNKNOWN_NOT_SEPARATELY_RECORDED'};
}
function retainedSource(candidatePath, origin) {
  const paths = git(candidatePath,'diff','--name-only',origin,P.candidate).split('\n');
  requireProof(equal(paths,['test/attendance-policy-storage.test.ts']), 'retained product/build/browser inputs changed');
  return {observedSource:origin, originalCandidate:P.candidate, changedOnly:'test/attendance-policy-storage.test.ts', interpretation:'Retained observations; not newly executed on final source'};
}
export function validateBrowserResult(result, expected) {
  requireProof(result.success === true && result.numTotalTests === 251 && result.numPassedTests === 251
    && result.numFailedTests === 0 && result.numPendingTests === 0 && result.numTodoTests === 0, 'browser case totals differ');
  requireProof(result.testResults?.length === expected.length, 'browser files missing');
  let count = 0;
  const names = result.testResults.map(suite => {
    requireProof(suite.status === 'passed' && suite.assertionResults?.length > 0 && suite.assertionResults.every(a => a.status === 'passed'), 'browser failed or pending assertion');
    count += suite.assertionResults.length; return suite.name;
  }).sort();
  requireProof(equal(names,[...expected].sort()) && count === 251, 'browser file/case membership differs');
  return {files:expected.length,cases:251};
}
export function validateWalkthrough(report, journey) {
  requireProof(report.kind === 'LOCAL_PRODUCTION_RENDERER_DEVELOPMENT_ONLY' && report.releaseEligible === false && report.terminal === true && report.exitCode === 0
    && report.sha === BUILD_SOURCE && report.controller === 'acb01a1a18c9a3e494781cabe971213bdd27d045' && report.buildId === BUILD_ID && report.journey === journey
    && report.databaseEvidenceValid === true && report.databaseEvidenceKind === 'LOCAL_NATIVE_NO_CGROUP_CAP_CLAIM' && report.ownedDatabaseDropped === true
    && !report.error && !report.progressError && !report.serverShutdownError && !report.serverLogError, 'walkthrough incomplete');
  requireProof(equal(report.browserErrors,[]) && equal(report.consoleErrors,[]) && equal(report.serverErrors,[]) && report.modelRunsBefore === 0 && report.modelRunsAfter === 0, 'walkthrough errors or model admissions');
  if (journey === 'queue') {
    const expected = [];
    for (const actor of ['group-admin','Empty-hr','A-hr','B-hr','A-employee','B-employee'])
      for (const locale of (['group-admin','Empty-hr'].includes(actor)?['en','ms','zh','vi','th','ta']:['en']))
        for (const viewport of ['desktop','mobile']) for (const route of ['/control-tower','/control-tower/agents']) expected.push(JSON.stringify([actor,locale,viewport,route]));
    requireProof(report.visits.length === 64 && report.plannedVisits === 64 && equal(report.visits.map(v=>JSON.stringify([v.actor,v.locale,v.viewport,v.route])).sort(),expected.sort()), 'queue matrix differs');
    requireProof(equal(report.scenarios.map(s=>s.scenario).sort(),['current','failed','legacy','malformed','unsupported']), 'receipt states missing');
    for (const state of report.scenarios) {
      const unknown=['legacy','malformed'].includes(state.scenario), failed=state.scenario==='failed', unsupported=state.scenario==='unsupported';
      requireProof(state.outcome===(unknown||unsupported?'unknown':failed?'failed':'succeeded')
        && equal(state.steps,unknown?Array(4).fill('unknown'):failed?['succeeded','succeeded','failed','succeeded']:Array(4).fill('succeeded'))
        && state.incomplete===(unknown||unsupported), 'receipt state outcome differs');
    }
  } else {
    const c=report.correction;
    requireProof(report.visits.length === 0 && report.plannedVisits === 0 && c?.complete === true
      && c.before.id === c.closed.id && c.before.id === c.reopened.id && c.before.employmentId === c.closed.employmentId && c.before.employmentId === c.reopened.employmentId
      && c.before.companyId === c.closed.companyId && c.before.companyId === c.reopened.companyId
      && c.before.paymentMethod === null && c.before.state === 'needs_input' && c.before.verifiedAt === null
      && c.closed.paymentMethod === 'cash' && c.closed.state === 'verified' && Number.isFinite(Date.parse(c.closed.verifiedAt))
      && c.reopened.paymentMethod === null && c.reopened.state === c.before.state && c.reopened.verifiedAt === null
      && c.closed.reopenCount === c.before.reopenCount && c.reopened.reopenCount === c.before.reopenCount+1, 'actual correction/reopen differs');
    requireProof(equal(c.audit.map(a=>a.event_type),['employment.payment-method.changed','orchestrator.case-verified','employment.payment-method.changed','orchestrator.case-reopened'])
      && c.audit.every(a=>a.actor_type === 'user' && a.actor_id === report.fixture.actors.find(a=>a.key==='A-hr')?.userId)
      && equal(c.audit[0].payload,{before:null,after:'cash'}) && equal(c.audit[2].payload,{before:'cash',after:null})
      && c.writes === 'ACTUAL_HR_FORM_AND_REFRESH_ACTIONS_ONLY' && c.images.length === 5, 'actual correction audit differs');
  }
  return {journey,observedSource:BUILD_SOURCE,exitCode:0,localOnly:true};
}
export async function collectOwnerCounterAcceptance({candidatePath,runDirectory,counterRoot,now=Date.now()}) {
  candidatePath=resolve(candidatePath);runDirectory=resolve(runDirectory);counterRoot=resolve(counterRoot);
  const report=await collectCounterException({candidatePath,runDirectory,now}),artifacts=[...report.artifacts];
  requireProof(report.sourceBoundary.counterRepairApplied === true, 'reviewed counter repair not applied');
  requireProof(git(counterRoot,'rev-parse','HEAD') === COUNTER_REPAIR.source && !git(counterRoot,'status','--porcelain')
    && git(counterRoot,'remote','get-url','origin').toLowerCase() === 'https://github.com/stradaversehub/ai-hr.git','wrong or dirty counter source');
  const counter=boundedReader(counterRoot,'counter',artifacts);
  for(const [path,hash] of Object.entries(COUNTER_REPAIR.files))requireProof(sha256(counter(path))===hash,'counter source differs');
  const adapterBoundary=JSON.parse(counter('scratchpad/ai-local-controller-20261026/source-boundary-attempt01.json'));
  const originalAdapterSource=counter('.github/ci/orchestrator-browser.mjs');
  const adapterSource=counter('scratchpad/ai-local-controller-20261026/orchestrator-browser-local-attempt01.mjs');
  requireProof(sha256(originalAdapterSource)==='6fa2c51fabed7b6c2b907d322a8a3727e9f4ef429576ee1d788ad70cb98a5e8b'
    &&sha256(adapterSource)==='b32ea9000d8892614ce7e75b6e23f6b07eec4c56a9111358bda13d24086ffca4'
    &&adapterBoundary.sourceController==='acb01a1a18c9a3e494781cabe971213bdd27d045'
    &&adapterBoundary.originalControllerSha256===sha256(originalAdapterSource)&&adapterBoundary.localAdapterSha256===sha256(adapterSource)
    &&adapterBoundary.browserAndAssertionRegionByteIdentical===true&&adapterBoundary.localOnly===true&&adapterBoundary.cloudSourceModified===false,'walkthrough adapter source differs');
  const browserRegion=text=>text.slice(text.indexOf('    const fd = openSync'),text.indexOf('    if (databaseStarted) {',text.indexOf("  finally {\n    checkpoint('cleanup-start')")));
  requireProof(browserRegion(originalAdapterSource)===browserRegion(adapterSource)&&sha256(browserRegion(adapterSource))==='552e97fde13e5fd8b40d630b59c3986c759958cc7300366e01d539db3bd99f9d','browser assertions changed');
  const proofReader=boundedReader(join(counterRoot,'scratchpad/ai-counter-repair-20261026'),'counterProof',artifacts);
  const counterProof=validateCounterRepairProof(JSON.parse(proofReader('proof.json')),proofReader('checks.log'),{candidatePath,runDirectory,counterRoot});
  requireProof(report.phases[0].rawSha256===RAW_NODB,'different repaired report');
  const read=boundedReader(join(candidatePath,'scratchpad'),'runtime',artifacts),json=p=>JSON.parse(read(p));
  const sourceEquivalence=[retainedSource(candidatePath,BUILD_SOURCE),retainedSource(candidatePath,BROWSER_SOURCE)];
  const typecheck=json('ai-local-20261026-clock-typecheck/result.json');
  requireProof(typecheck.source===P.candidate&&typecheck.wholeRepositoryTypecheck===true&&typecheck.exitCode===0&&typecheck.databaseConnectionsAllowed===false&&typecheck.seconds>0,'whole compiler evidence differs');
  requireProof(!read('ai-local-20261026-clock-typecheck/tsc.log').trim(),'whole compiler emitted diagnostics');
  const build=json('ai-local-20261026-build/completed.json');
  requireProof(build.source===BUILD_SOURCE&&build.kind==='LOCAL_PRODUCTION_BUILD_NOT_RELEASE_GATE'&&build.passed===true&&build.exitCode===0&&build.buildId===BUILD_ID&&build.appPathsHash===MANIFEST,'build evidence differs');
  const buildLog=read('ai-local-20261026-build/production-build.log');
  requireProof(buildLog.includes('next build')&&buildLog.includes('Compiled successfully')&&buildLog.includes('Running TypeScript'),'production build log incomplete');
  const buildRead=boundedReader(candidatePath,'source',artifacts);
  requireProof(buildRead('.next/BUILD_ID').trim()===BUILD_ID&&sha256(buildRead('.next/server/app-paths-manifest.json'))===MANIFEST,'retained local build changed');
  const browsers=json('ai-local-20261026-browser-gate/completed.json');
  const browserPaths=git(candidatePath,'ls-files','test').split('\n').filter(p=>p.endsWith('.browser.test.tsx')).sort();
  requireProof(browserPaths.length===16&&browsers.source===BROWSER_SOURCE&&browsers.passed===true&&equal([...browsers.browserFiles].sort(),browserPaths)
    &&equal(browsers.engines,['chromium','firefox','webkit'])&&equal(browsers.phases.map(p=>p.phase),['whole-typecheck','browser-chromium','browser-firefox','browser-webkit'])&&browsers.phases.every(p=>p.exitCode===0),'browser phase provenance differs');
  const browserEvidence={};
  for(const engine of ['chromium','firefox','webkit']) {
    browserEvidence[engine]=validateBrowserResult(json('ai-local-20261026-browser-gate/'+engine+'.json'),browserPaths.map(p=>join(candidatePath,p)));
    read('ai-local-20261026-browser-gate/browser-'+engine+'.log');
  }
  const walkthroughs=[];
  for(const journey of ['queue','correction']) {
    const prefix='ai-local-20261026-'+journey+'/',record=json(prefix+'walkthrough.json');
    walkthroughs.push(validateWalkthrough(record,journey));
    requireProof(sha256(read(prefix+'server.log'))===record.serverLogHash,'walkthrough server log changed');
    const pg=json(prefix+'postgres-evidence.json');requireProof(pg.systemIdentifier==='7700576020832388449'&&pg.database==='ai_hr_orchestrator_browser'&&pg.version==='160014'&&pg.jit==='on'&&pg.localNative===true&&pg.memoryCapBytes===null,'local database witness differs');
    for(const image of journey==='queue'?[...record.visits.map(v=>v.image),...['legacy','malformed','unsupported','failed','current'].map(state=>'receipt-'+state+'.png')]:record.correction.images)read(prefix+image);
  }
  const provenance=json('ai-local-20261026-provenance/collection.json');
  requireProof(provenance.kind==='POST_RUN_CONTROLLER_SOURCE_COLLECTION_NOT_NEW_EXECUTION','provenance collection mislabelled');
  const runners={
    'aihr-local-clock-typecheck-20261026.py':'5011394edde185a3a287d3bcae5a560a935d3832356f8dae17accb995b7a6466',
    'aihr-local-h-browser-checks-20261026.py':'c58e0cd44ef09068267d7a2c48c78c871692e4aad6be83dc86d0ea0348ecc5c4',
    'aihr-local-h-build-walk-20261026.py':'d22367d898e4474ca0d86b2c003a93a41e30215ec2e7e4689519faaeee65fd56',
  };
  for(const [file,hash] of Object.entries(runners))requireProof(sha256(read('ai-local-20261026-provenance/'+file))===hash,'retained controller source differs');
  return {...report,tier:ACCEPTANCE_TIER,result:'ACCEPTED_WITH_OWNER_EXCEPTION',stagingBuildAuthorized:true,releaseAuthorized:false,arrivalVerified:false,
    counterRoot,counterProof,sourceEquivalence,requiredClaims:{wholeTypecheck:{observedSource:P.candidate,exitCode:0},localBuild:{observedSource:BUILD_SOURCE,buildId:BUILD_ID,exitCode:0},browserEvidence,walkthroughs},
    provenanceLimitation:'Controller copies collected after execution; not new execution or a contemporaneous source-hash claim',artifacts};
}
