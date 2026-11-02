import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,now,time} from './resume-test-fixtures.mjs';
import {hash} from './manifest.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {verifyBrowserRecovery,validateBrowserMetadata,BROWSER_IMAGE,BROWSER_WORKFLOW_ID,requireReviewedBrowserController,validateBrowserRecoveryGrantEvidence,BROWSER_ASSERTION_RECOVERY_POLICY,ASSERTION_INCIDENT,verifyAssertionCaseInventory,originalAssertionProducer} from './browser-recovery-policy.mjs';
import {validateBrowserControllerDelta,validateBrowserHistory,validateAssertionVerifierDelta} from './browser-recovery.mjs';
import {operatorRelease} from './operator-release.mjs';
import {createInstallGrant} from './ci-install-grant.mjs';
import {installationFixture} from './staging-install-test-fixture.mjs';
const branch='codex/recovery',candidateBranch='codex/source',controller='e'.repeat(40),lock='f'.repeat(64);
function metadata(){
 const f=fixture(),run={...f.run,id:200,head_sha:controller,head_branch:branch,workflow_id:BROWSER_WORKFLOW_ID,path:'.github/workflows/alpha-staging-browser-checks.yml',display_title:`Tooling transport only · ${candidateBranch}`,conclusion:'success',created_at:time(4.5),updated_at:time(.5)};
 const jobs=['resolve','tooling','operator-transport','browser-image (firefox)'].map((name,i)=>({id:300+i,name,run_id:200,run_attempt:1,head_sha:controller,head_branch:branch,status:'completed',conclusion:i===0||i===3?'success':'skipped',started_at:time(4),completed_at:time(1),steps:[{name:'Complete original browser unit in pinned image',conclusion:'success'}]}));
 const artifacts=['browser-recovery-runtime-firefox','diagnostic-complete-image-browser-firefox'].map((name,i)=>({id:400+i,name,size_in_bytes:100,digest:'sha256:'+'f'.repeat(64),expired:false,created_at:time(2),expires_at:time(-60),workflow_run:{id:200,repository_id:1333414856,head_repository_id:1333414856,head_sha:controller,head_branch:branch}}));
 return {run,jobs,artifacts,expected:{runId:200,controller,branch,candidateBranch,after:time(5)},now};
}
function input(){
 const f=fixture(),plan=f.expectedPlan,{fingerprint,...body}={...plan,controller},freshPlan={...body,fingerprint:hash(body)},report=structuredClone(f.reports.find(r=>r.id==='browser-firefox'));
 report.fingerprint=freshPlan.fingerprint;report.healthBefore={platform:'linux',ok:true,availableDiskBytes:25*1024**3,reasons:[],at:time(3)};report.healthAfter={...report.healthBefore,at:time(2.5)};
 const failed=f.reports.find(r=>r.id==='browser-firefox');Object.assign(failed,{exitCode:1,batches:[],healthBefore:{ok:false,availableDiskBytes:8*1024**3,reasons:['Less than 20 GiB available on the worktree volume']},error:'Error: Runner disk headroom too low: diagnostic'});
 f.jobs.find(j=>j.name==='browser (firefox)').conclusion='failure';
 const assessment={...assessResumeCoverage({expectedPlan:plan,reports:f.reports,expected:f.expected}),sourceRun:{id:100},observations:[{id:'browser-firefox',conclusion:'failure'}]};for(const r of assessment.reusable)r.source={runId:100,jobId:123,artifactId:456,digest:'sha256:'+'a'.repeat(64)};
 const m=metadata(),fresh={...m,report,producer:m.jobs[3],binding:{kind:'PINNED_OFFICIAL_IMAGE_TOOLING_NOT_TEST_OR_RELEASE_PASS',releaseAuthorized:false,image:BROWSER_IMAGE,playwrightVersion:'1.62.1',nodeVersion:'22.23.3',candidate:plan.sha,controller,baseline:plan.migrationBase,engine:'firefox',runId:'200',attempt:'1',runtime:plan.runtime,lang:'en_US.UTF-8',tz:'Asia/Kuala_Lumpur',browsersPath:'/ms-playwright',lockSha256:lock}};
 return {plan,freshPlan,assessment,run:f.run,jobs:f.jobs,reports:f.reports,fresh,verificationController:controller,verificationDiagnostic:{runId:500,controller},producerDiagnostic:{runId:501,controller},lockSha256:lock};
}
test('Complete Firefox replacement preserves original failure, all retained sources and both plan fingerprints',()=>{const f=input(),before=structuredClone(f),c=verifyBrowserRecovery(f);assert.deepEqual(f,before);assert.equal(c.originalConclusion,'failure');assert.equal(c.tests,5);assert.equal(c.units.length,f.plan.units.length);assert.equal(c.units.filter(u=>u.kind==='browser-capacity-recovery').length,1);assert.notEqual(c.sourceFingerprint,c.replacementFingerprint);});
for(const [name,mutate] of [
 ['source identity',f=>f.assessment.sha='b'.repeat(40)],['missing source assessment',f=>f.assessment.sourceRun.id++],['relabelled source',f=>f.run.conclusion='success'],['second original attempt',f=>f.run.run_attempt=2],
 ['other failed area',f=>f.assessment.rerun.push({id:'browser-webkit'})],['missing retained unit',f=>f.assessment.reusable.pop()],['duplicate retained unit',f=>f.assessment.reusable[0]=f.assessment.reusable[1]],
 ['failed compiler',f=>f.jobs.find(j=>j.name==='typecheck').conclusion='failure'],['failed migrations',f=>f.jobs.find(j=>j.name==='migrations').conclusion='failure'],['failed build',f=>f.jobs.find(j=>j.name==='build').conclusion='failure'],['failed database',f=>f.jobs.find(j=>j.name.startsWith('test (db')).conclusion='failure'],
 ['executed original tests',f=>f.reports.find(r=>r.id==='browser-firefox').batches=[{}]],['other original error',f=>f.reports.find(r=>r.id==='browser-firefox').error='Test failure'],['other health error',f=>f.reports.find(r=>r.id==='browser-firefox').healthBefore.reasons.push('unknown')],['original guard not exceeded',f=>f.reports.find(r=>r.id==='browser-firefox').healthBefore.availableDiskBytes=21*1024**3],
 ['missing report',f=>f.reports.pop()],['duplicate report',f=>f.reports[0]=f.reports[1]],['tampered retained report',f=>f.reports.find(r=>r.id!=='browser-firefox').cwd='/changed'],['foreign retained provenance',f=>f.assessment.reusable[0].source.runId=3],
 ['fresh missing file',f=>f.fresh.report.files=[]],['wrong fresh engine',f=>f.fresh.report.id='browser-webkit'],['fresh missing batch',f=>f.fresh.report.batches=[]],['fresh empty cases',f=>f.fresh.report.batches[0].result.testResults[0].assertionResults=[]],['fresh skipped case',f=>f.fresh.report.batches[0].result.testResults[0].assertionResults[0].status='pending'],['fresh pending count',f=>f.fresh.report.batches[0].result.numPendingTests=1],['fresh count mismatch',f=>f.fresh.report.batches[0].result.numTotalTests++],['fresh process error',f=>f.fresh.report.error='late error'],['fresh wrong source',f=>f.fresh.report.sha='b'.repeat(40)],['fresh wrong fingerprint',f=>f.fresh.report.fingerprint='b'.repeat(64)],
 ['fresh unhealthy',f=>f.fresh.report.healthAfter.ok=false],['fresh disk below unchanged guard',f=>f.fresh.report.healthAfter.availableDiskBytes=19*1024**3],['fresh time outside producer',f=>f.fresh.report.healthBefore.at=time(20)],
 ['image drift',f=>f.fresh.binding.image='mutable:latest'],['Playwright drift',f=>f.fresh.binding.playwrightVersion='1.60.0'],['lock drift',f=>f.fresh.binding.lockSha256='b'.repeat(64)],['locale drift',f=>f.fresh.binding.lang='other'],['timezone drift',f=>f.fresh.binding.tz='UTC'],['runtime drift',f=>f.fresh.binding.runtime={node:'24',platform:'linux',arch:'x64'}],['producer drift',f=>f.fresh.binding.controller='d'.repeat(40)],['producer attempt drift',f=>f.fresh.binding.attempt='2'],['claimed tooling release authority',f=>f.fresh.binding.releaseAuthorized=true],
 ['missing diagnostic',f=>f.verificationDiagnostic=null],['other verifier diagnostic',f=>f.verificationDiagnostic.controller='d'.repeat(40)],['changed plan',f=>f.freshPlan.suite=[]],
])test('Browser recovery refuses '+name,()=>{const f=input();mutate(f);assert.throws(()=>verifyBrowserRecovery(f));});
test('Exact fresh Firefox workflow, jobs and artifact producers authenticate',()=>assert.equal(validateBrowserMetadata(metadata()).id,303));
for(const [name,mutate] of [
 ['fork',f=>f.run.head_repository.id=1],['other repository',f=>f.run.repository.id=1],['workflow drift',f=>f.run.workflow_id=1],['wrong workflow path',f=>f.run.path='other'],['wrong controller',f=>f.run.head_sha='a'.repeat(40)],['wrong branch',f=>f.run.head_branch='main'],['other event',f=>f.run.event='pull_request'],['wrong source title',f=>f.run.display_title='other'],['failed producer',f=>f.run.conclusion='failure'],['second attempt',f=>f.run.run_attempt=2],['precedes source completion',f=>f.run.created_at=time(6)],['stale producer',f=>f.now+=86400001],
 ['missing job',f=>f.jobs.pop()],['duplicate job',f=>f.jobs[1]=f.jobs[0]],['unaffected engine rerun',f=>f.jobs.push({...f.jobs[3],id:999,name:'browser-image (webkit)'})],['incomplete job',f=>f.jobs[3].status='in_progress'],['wrong job attempt',f=>f.jobs[3].run_attempt=2],['foreign job',f=>f.jobs[3].run_id=2],['missing complete unit step',f=>f.jobs[3].steps=[]],['failed full unit',f=>f.jobs[3].steps[0].conclusion='failure'],
 ['missing artifact',f=>f.artifacts.pop()],['duplicate artifact',f=>f.artifacts[0]=f.artifacts[1]],['foreign artifact',f=>f.artifacts[0].workflow_run.id=2],['wrong artifact controller',f=>f.artifacts[0].workflow_run.head_sha='a'.repeat(40)],['unknown artifact',f=>f.artifacts[0].name='other'],['artifact before producer',f=>f.artifacts[0].created_at=time(5)],['expired artifact',f=>f.artifacts[0].expired=true],['missing digest',f=>f.artifacts[0].digest=null],['oversize artifact',f=>f.artifacts[0].size_in_bytes=65*1024**2],
])test('Browser API admission refuses '+name,()=>{const f=metadata();mutate(f);assert.throws(()=>validateBrowserMetadata(f));});
const allowed=['.github/ci/browser-recovery.mjs','.github/ci/browser-recovery-policy.mjs','.github/ci/browser-recovery.test.mjs','.github/workflows/alpha-staging-browser-checks.yml'];
test('Controller delta cannot alter test runner, resource guards, application, dependencies or migrations',()=>{validateBrowserControllerDelta(allowed);for(const path of ['.github/ci/run-unit.mjs','.github/ci/host-health.mjs','.github/actions/setup-browser-image/action.yml','.github/ci/manifest.mjs','.github/ci/ai-manifest-admission.mjs','.github/ci/release-ci.mjs','app/page.tsx','pnpm-lock.yaml','drizzle/anything.sql'])assert.throws(()=>validateBrowserControllerDelta([...allowed,path]));assert.throws(()=>validateBrowserControllerDelta(allowed.slice(1)));});
function history(){const f=fixture(),m=metadata();f.run.display_title=`Alpha CI · ${candidateBranch}`;return {source:{run:f.run},rows:[m.run],candidateBranch,browserRunId:200,auxiliaryRunIds:[]};}
test('History retains exact successful replacement and refuses hidden/pending failures',()=>{assert.equal(validateBrowserHistory(history()).executions[0].id,200);for(const change of [f=>f.rows=[],f=>f.rows[0].status='queued',f=>f.rows[0].conclusion='failure',f=>f.rows[0].run_attempt=2,f=>f.rows.push({...f.rows[0],id:999}),f=>f.auxiliaryRunIds=[999]]){const f=history();change(f);assert.throws(()=>validateBrowserHistory(f));}});
test('Unreviewed recovery cannot enter installation and does not manufacture a normal gate receipt',async()=>{await assert.rejects(operatorRelease({candidatePath:'/fixture',runId:100,execute:true,browserRecovery:{}}),/exact reviewed operator controller/);const s=readFileSync(new URL('./browser-recovery.mjs',import.meta.url),'utf8');assert(!s.includes('ci-receipt.json'));assert(s.includes('installationAuthorized:false'));});

test('A separately validated verifier preserves the real browser producer, original build and exact grant format',()=>{
 const f=input();f.verificationController='d'.repeat(40);f.verificationDiagnostic={runId:502,controller:f.verificationController};f.reviewedController=f.verificationController;
 const c=verifyBrowserRecovery(f);assert.equal(c.browserProducerController,controller);assert.equal(c.verificationController,f.verificationController);assert.equal(c.pendingReview,false);
 const g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,source:c.sha,controller:c.controller,runId:c.runId}};
 const run={...g.run,id:c.runId,head_sha:c.controller,conclusion:'failure'},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 assert.equal(validateBrowserRecoveryGrantEvidence(e,run),true);const grant=createInstallGrant({...g,evidence:e,run,producer});assert.equal(grant.witnessFingerprint,hash(c));assert.equal(grant.runId,f.run.id);assert.equal(grant.controller,f.plan.controller);assert.equal(grant.build.nextBuildId,g.evidence.build.nextBuildId);assert.equal(run.conclusion,'failure');
 for(const change of [x=>x.recovery.pendingReview=true,x=>x.recovery.reviewedController='a'.repeat(40),x=>x.recovery.recoveryPolicy='aihr-browser-capacity-recovery/v1',x=>delete x.recovery.producerDiagnostic,x=>x.recovery.producerDiagnostic.controller='a'.repeat(40),x=>delete x.recovery.verificationDiagnostic,x=>x.recovery.originalConclusion='success',x=>x.recovery.units.find(u=>u.kind==='browser-capacity-recovery').source.controller='a'.repeat(40)]){const altered=structuredClone(e);change(altered);altered.fingerprint=hash(altered.recovery);assert.throws(()=>createInstallGrant({...g,evidence:altered,run,producer}));}
});
test('Pending source verification, mutated build and wrong reviewed operator cannot authorize installation',()=>{
 const f=input(),c=verifyBrowserRecovery(f),g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,source:c.sha,controller:c.controller,runId:c.runId}},run={...g.run,id:c.runId,head_sha:c.controller,conclusion:'failure'},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 assert.throws(()=>createInstallGrant({...g,evidence:e,run,producer}));
 requireReviewedBrowserController({execute:false,controller});assert.throws(()=>requireReviewedBrowserController({execute:true,controller}));assert.throws(()=>requireReviewedBrowserController({execute:true,controller,reviewedController:'d'.repeat(40)}));assert.doesNotThrow(()=>requireReviewedBrowserController({execute:true,controller,reviewedController:controller}));
 f.reviewedController=controller;const c2=verifyBrowserRecovery(f),e2={...e,...c2,recovery:c2,fingerprint:hash(c2),build:{...e.build,source:'d'.repeat(40)}};assert.throws(()=>createInstallGrant({...g,evidence:e2,run,producer}));
});


function assertionCases(){
 const paths=[ASSERTION_INCIDENT.file,'test/tailwind-width-order.browser.test.tsx',...Array.from({length:33},(_,i)=>'test/fictional-firefox-'+i+'.browser.test.tsx')];
 const unit={id:'browser-firefox',kind:'browser',engine:'firefox',files:paths},cwd='/fixture/source';
 const testResults=paths.map((path,i)=>({name:cwd+'/'+path,status:i===0?'failed':'passed',
  assertionResults:Array.from({length:i===0?40:14},(_,j)=>{
   const title=i===0&&j===0?ASSERTION_INCIDENT.name:i===1&&j===0?'SHOULD let a later width utility win over the w-full inside inputCls':'Fictional case '+i+'/'+j;
   const ancestorTitles=i===1&&j===0?['Tailwind width utilities in a real engine']:[],failed=i===0&&j===0;
   return {title,ancestorTitles,fullName:[...ancestorTitles,title].join(' '),status:failed?'failed':'passed',failureMessages:failed?['__VITEST_POLL_CHAIN__ fixture']:[]};
  })}));
 const original={cwd,batches:[{exitCode:1,databaseEvidence:null,databaseResourceSnapshot:null,
  result:{success:false,numTotalTests:516,numPassedTests:515,numFailedTests:1,numTotalTestSuites:35,numPassedTestSuites:34,numFailedTestSuites:1,numPendingTests:0,numPendingTestSuites:0,numTodoTests:0,testResults}}]};
 const replacement=structuredClone(original),batch=replacement.batches[0],result=batch.result;
 batch.exitCode=0;Object.assign(result,{success:true,numPassedTests:516,numFailedTests:0,numPassedTestSuites:35,numFailedTestSuites:0});
 result.testResults[0].status='passed';Object.assign(result.testResults[0].assertionResults[0],{status:'passed',failureMessages:[]});
 return {unit,original,replacement};
}
test('Executed Firefox inventory preserves all cases, including repeated names and the recorded expected failure',()=>{
 const f=assertionCases();
 // Multiplicity, not just name uniqueness: a legitimate identical name may appear twice.
 for(const report of [f.original,f.replacement]){
  const cases=report.batches[0].result.testResults[2].assertionResults;
  cases[1]=structuredClone(cases[0]);
 }
 f.replacement.batches[0].result.testResults.reverse();
 const before=structuredClone(f),witness=verifyAssertionCaseInventory(f);
 assert.equal(witness.files,35);assert.equal(witness.cases,516);assert.equal(witness.fullName,ASSERTION_INCIDENT.name);assert.deepEqual(f,before);
});
for(const [name,mutate] of [
 ['missing case',r=>r.testResults[2].assertionResults.pop()],
 ['added case',r=>r.testResults[2].assertionResults.push(structuredClone(r.testResults[2].assertionResults[0]))],
 ['changed name',r=>r.testResults[2].assertionResults[0].fullName+=' changed'],
 ['changed ancestor',r=>r.testResults[2].assertionResults[0].ancestorTitles=['Different group']],
 ['replaced by duplicate',r=>r.testResults[2].assertionResults[1]=structuredClone(r.testResults[2].assertionResults[0])],
 ['foreign file',r=>r.testResults[2].name='/foreign/test/fixture.browser.test.tsx'],
 ['missing expected failure fixture',r=>r.testResults[1].assertionResults[0].fullName='Changed expected failure'],
 ['skip',r=>r.testResults[2].assertionResults[0].status='skipped'],
 ['failure',r=>r.testResults[0].assertionResults[0].status='failed'],
 ['pending counter',r=>r.numPendingTests=1],
])test('Executed assertion recovery rejects '+name,()=>{
 const f=assertionCases();mutate(f.replacement.batches[0].result);assert.throws(()=>verifyAssertionCaseInventory(f));
});
test('The original incident must retain its actual failed assertion and all other executed passes',()=>{
 for(const change of [
  r=>r.testResults[0].assertionResults[0].status='passed',
  r=>r.testResults[0].assertionResults[0].fullName='Another failure',
  r=>r.testResults[0].assertionResults[0].failureMessages=['Unrelated error'],
  r=>r.testResults[2].assertionResults[0].status='failed',
 ]){const f=assertionCases();change(f.original.batches[0].result);assert.throws(()=>verifyAssertionCaseInventory(f));}
 const legacy=input();legacy.reports.find(r=>r.id==='browser-firefox').batches=assertionCases().original.batches;
 assert.throws(()=>verifyBrowserRecovery(legacy),/Capacity recovery cannot replace any executed test failure/);
});
function assertionMetadata(){
 const m=metadata(),{source, replayRunId}=ASSERTION_INCIDENT;
 Object.assign(m.expected,{runId:replayRunId,controller:source,branch:'main',candidateBranch:'codex/board-nine-final-repair-20261103',recoveryPolicy:BROWSER_ASSERTION_RECOVERY_POLICY});
 Object.assign(m.run,{id:replayRunId,head_sha:source,head_branch:'main',display_title:'Tooling transport only · '+m.expected.candidateBranch});
 for(const job of m.jobs)Object.assign(job,{run_id:replayRunId,head_sha:source,head_branch:'main'});
 for(const artifact of m.artifacts)Object.assign(artifact.workflow_run,{id:replayRunId,head_sha:source,head_branch:'main'});
 return m;
}
test('Only the stock MAIN replay can use assertion v1, with the same authenticated artifact and step guards',()=>{
 assert.equal(validateBrowserMetadata(assertionMetadata()).id,303);
 for(const change of [
  m=>m.expected.recoveryPolicy=undefined,
  m=>m.expected.runId++,
  m=>m.run.head_sha='a'.repeat(40),
  m=>m.run.head_branch='codex/instrumented-copy',
  m=>m.run.head_repository.id=1,
  m=>m.run.workflow_id++,
  m=>m.run.conclusion='failure',
  m=>m.run.run_attempt=2,
  m=>m.jobs[3].steps[0].conclusion='skipped',
  m=>m.artifacts[0].workflow_run.head_sha='a'.repeat(40),
  m=>m.artifacts[0].digest=null,
 ]){const m=assertionMetadata();change(m);assert.throws(()=>validateBrowserMetadata(m));}
});
test('An assertion verifier delta may change only the five review files',()=>{
 const files=['.github/ci/browser-recovery.mjs','.github/ci/browser-recovery-policy.mjs','.github/ci/browser-recovery.test.mjs','.github/ci/ci-install-grant.mjs','docs/BROWSER-CAPACITY-RECOVERY.md'];
 assert.doesNotThrow(()=>validateAssertionVerifierDelta(files));
 for(const path of ['.github/workflows/alpha-staging-browser-checks.yml','.github/ci/run-unit.mjs','pnpm-lock.yaml','test/lifecycle-v9-html-gaps.browser.test.tsx'])assert.throws(()=>validateAssertionVerifierDelta([...files,path]));
 assert.throws(()=>validateAssertionVerifierDelta(files.slice(1)));
});
test('The stock producer proof is the successful original controller job plus the original execution and prerequisite stop',()=>{
 const p=ASSERTION_INCIDENT,run={id:p.runId,head_sha:p.source,head_branch:'main'};
 const job=(name,id,conclusion,steps)=>({name,id,conclusion,run_id:p.runId,run_attempt:1,head_sha:p.source,head_branch:'main',status:'completed',steps:steps.map(([name,conclusion])=>({name,conclusion}))});
 const jobs=[
  job('controller-tests',p.controllerJobId,'success',[['Owned Linux install cleanup and immutable byte inventory controls','success'],['Exercise actual official detached-deploy helpers with shim transport','success']]),
  job('browser (firefox)',p.firefoxJobId,'failure',[['Run ./automation/.github/actions/setup-browser-image','success'],['Run node ../automation/.github/ci/run-unit.mjs "browser-$ENGINE" "$RUNNER_TEMP/aihr-ci"','failure'],['Run actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02','success']]),
  job('verify',p.verifyJobId,'failure',[['Every prerequisite succeeded','failure'],['Run node ../automation/.github/ci/verify-shards.mjs "$RUNNER_TEMP/aihr-ci" "$RUNNER_TEMP/ci-receipt.json"','skipped']]),
 ];
 assert.deepEqual(originalAssertionProducer(run,jobs),{kind:'original-full-controller-tests',controller:p.source,runId:p.runId,jobId:p.controllerJobId});
 for(const change of [j=>j[0].id++,j=>j[0].steps.pop(),j=>j[1].steps[1].conclusion='success',j=>j[2].steps[1].conclusion='failure']){
  const copy=structuredClone(jobs);change(copy);assert.throws(()=>originalAssertionProducer(run,copy));
 }
});


test('Assertion admission refuses an unreviewed verifier, changed plan identity, and a relabelled legacy certificate',()=>{
 const p=ASSERTION_INCIDENT,f=input();
 f.recoveryPolicy=BROWSER_ASSERTION_RECOVERY_POLICY;
 Object.assign(f.plan,{sha:p.source,controller:p.source,migrationBase:p.baseline,units:Array(75).fill({})});
 f.freshPlan.fingerprint=f.plan.fingerprint;
 Object.assign(f.fresh.run,{id:p.replayRunId,head_branch:'main'});
 f.jobs=Array(84).fill({});
 assert.throws(()=>verifyBrowserRecovery(f),/Separately reviewed assertion verifier required/);
 for(const change of [x=>x.plan.sha='b'.repeat(40),x=>x.plan.migrationBase='b'.repeat(40),x=>x.freshPlan.fingerprint='b'.repeat(64)]){
  const altered=structuredClone(f);change(altered);assert.throws(()=>verifyBrowserRecovery(altered),/Assertion replay source, baseline or complete plan differs/);
 }
 const legacy=verifyBrowserRecovery(input());
 const relabelled={...legacy,recoveryPolicy:BROWSER_ASSERTION_RECOVERY_POLICY};
 assert.throws(()=>validateBrowserRecoveryGrantEvidence({recovery:relabelled,fingerprint:hash(relabelled)},f.run),/Authenticated assertion recovery certificate required/);
});
