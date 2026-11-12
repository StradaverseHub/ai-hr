import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,now,time} from './resume-test-fixtures.mjs';
import {hash} from './manifest.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {BROWSER_IMAGE,BROWSER_WORKFLOW_ID} from './browser-recovery-policy.mjs';
import {validateV3ControllerDelta} from './browser-recovery-v3.mjs';
import {verifySingleShotRecovery,validateSingleShotMetadata,validateSingleShotHistory,browserImpact,originalBrowserFailure,runChecks,SINGLE_SHOT_POLICY} from './browser-recovery-v3-policy.mjs';

const branch='claude/recovery-controller',candidateBranch='main',controller='e'.repeat(40),lock='f'.repeat(64),file='test/ui.browser.test.tsx';
function metadata(){
 const f=fixture(),run={...f.run,id:200,head_sha:controller,head_branch:branch,workflow_id:BROWSER_WORKFLOW_ID,path:'.github/workflows/alpha-staging-browser-checks.yml',display_title:`Tooling transport only · ${candidateBranch}`,conclusion:'success',created_at:time(4.5),updated_at:time(.5)};
 const jobs=['resolve','tooling','operator-transport','browser-image (firefox)'].map((name,i)=>({id:300+i,name,run_id:200,run_attempt:1,head_sha:controller,head_branch:branch,status:'completed',conclusion:i===0||i===3?'success':'skipped',started_at:time(4),completed_at:time(1),steps:[{name:'Complete original browser unit in pinned image',conclusion:'success'}]}));
 const artifacts=['browser-recovery-runtime-firefox','diagnostic-complete-image-browser-firefox'].map((name,i)=>({id:400+i,name,size_in_bytes:100,digest:'sha256:'+'f'.repeat(64),expired:false,created_at:time(2),expires_at:time(-60),workflow_run:{id:200,repository_id:1333414856,head_repository_id:1333414856,head_sha:controller,head_branch:branch}}));
 return {run,jobs,artifacts,expected:{runId:200,controller,branch,candidateBranch,engine:'firefox',after:time(5)},now};
}
const cased=(status)=>({exitCode:status==='passed'?0:1,result:{success:status==='passed',numTotalTests:1,numPassedTests:status==='passed'?1:0,numFailedTests:status==='passed'?0:1,numFailedTestSuites:status==='passed'?0:1,
 testResults:[{name:'/candidate/'+file,status,assertionResults:[{status,fullName:'Lifecycle keyboard Enter commits the accordion'}]}]}});
function input(){
 const f=fixture(),plan=f.expectedPlan,{fingerprint,...body}={...plan,controller},freshPlan={...body,fingerprint:hash(body)};
 const failed=f.reports.find(r=>r.id==='browser-firefox');Object.assign(failed,{exitCode:1,batches:[cased('failed')],healthBefore:{platform:'linux',ok:true,reasons:[],at:time(19)}});
 f.jobs.find(j=>j.name==='browser (firefox)').conclusion='failure';
 const report={...structuredClone(failed),fingerprint:freshPlan.fingerprint,exitCode:0,batches:[cased('passed')],healthBefore:{platform:'linux',ok:true,availableDiskBytes:25*1024**3,reasons:[],at:time(3)},healthAfter:{platform:'linux',ok:true,availableDiskBytes:25*1024**3,reasons:[],at:time(2.5)}};
 const assessment={...assessResumeCoverage({expectedPlan:plan,reports:f.reports,expected:f.expected}),sourceRun:{id:100},observations:[{id:'browser-firefox',conclusion:'failure'}]};for(const r of assessment.reusable)r.source={runId:100,jobId:123,artifactId:456,digest:'sha256:'+'a'.repeat(64)};
 const m=metadata(),fresh={...m,report,producer:m.jobs[3],binding:{kind:'PINNED_OFFICIAL_IMAGE_TOOLING_NOT_TEST_OR_RELEASE_PASS',releaseAuthorized:false,image:BROWSER_IMAGE,playwrightVersion:'1.62.1',nodeVersion:'22.23.3',candidate:plan.sha,controller,baseline:plan.migrationBase,engine:'firefox',runId:'200',attempt:'1',runtime:plan.runtime,lang:'en_US.UTF-8',tz:'Asia/Kuala_Lumpur',browsersPath:'/ms-playwright',lockSha256:lock}};
 return {plan,freshPlan,assessment,run:f.run,jobs:f.jobs,reports:f.reports,fresh,
  impact:{outside:true,reasons:[],closureFiles:4,changedFiles:2},
  executions:[{id:200,engine:'firefox',status:'completed',conclusion:'success',attempt:1,candidate:plan.sha}],
  flakeRegister:{path:'docs/FLAKY-TESTS.md',sha256:'c'.repeat(64),text:'| `'+file+'`, keyboard poll | browser (firefox) |'},
  verificationController:controller,verificationDiagnostic:{runId:500,controller},producerDiagnostic:{runId:501,controller},lockSha256:lock};
}

test('One single-shot rerun of an executed Firefox failure keeps the original failure and every retained unit',()=>{
 const f=input(),before=structuredClone(f),c=verifySingleShotRecovery(f);
 assert.deepEqual(f,before);assert.equal(c.kind,'AUTHENTICATED_BROWSER_SINGLE_SHOT_RECOVERY');assert.equal(c.recoveryPolicy,SINGLE_SHOT_POLICY);
 assert.equal(c.originalConclusion,'failure');assert.deepEqual(c.failingFiles,[file]);assert.equal(c.installationEligible,false);assert.equal(c.releaseAuthorized,false);assert.equal(c.pendingReview,true);
 assert.equal(c.units.filter(u=>u.kind==='browser-single-shot-recovery').length,1);assert.equal(c.units.length,f.plan.units.length);
 assert.equal(c.units.find(u=>u.kind==='browser-single-shot-recovery').originalReportHash,hash(f.reports.find(r=>r.id==='browser-firefox')));
});

for(const [name,mutate] of [
 ['a second recovery execution for the candidate',f=>f.executions.push({...f.executions[0],id:201})],
 ['an earlier diagnostic execution on another ref',f=>f.executions.unshift({id:150,engine:'firefox',status:'completed',conclusion:'failure',attempt:1,candidate:f.plan.sha})],
 ['a pending execution of the engine',f=>f.executions.push({id:202,engine:'firefox',status:'in_progress',conclusion:null,attempt:1,candidate:null})],
 ['an execution whose candidate cannot be read',f=>f.executions.push({id:203,engine:'firefox',status:'completed',conclusion:'success',attempt:1,candidate:null})],
 ['a missing recovery execution in history',f=>f.executions=[]],
 ['a failed recovery execution',f=>f.executions[0].conclusion='failure'],
 ['a rerun recovery attempt',f=>f.executions[0].attempt=2],
 ['a failing file inside the impact set',f=>f.impact={outside:false,reasons:['changed dependency components/x.tsx reaches a failing file'],closureFiles:4,changedFiles:2}],
 ['a missing impact decision',f=>f.impact=undefined],
 ['an unregistered flake',f=>f.flakeRegister.text='| `test/other.browser.test.tsx` |'],
 ['a missing register',f=>f.flakeRegister.text=''],
 ['a relabelled original',f=>f.run.conclusion='success'],
 ['a second original attempt',f=>f.run.run_attempt=2],
 ['a second failed area',f=>f.assessment.rerun.push({id:'browser-webkit'})],
 ['a failed database unit',f=>f.jobs.find(j=>j.name.startsWith('test (db')).conclusion='failure'],
 ['a failed build',f=>f.jobs.find(j=>j.name==='build').conclusion='failure'],
 ['a failed typecheck',f=>f.jobs.find(j=>j.name==='typecheck').conclusion='failure'],
 ['an engine without a single-engine scope',f=>{f.assessment.rerun=[{id:'browser-webkit'}];}],
 ['a process error instead of test failures',f=>f.reports.find(r=>r.id==='browser-firefox').error='Error: runner crashed'],
 ['a capacity failure (v2 route)',f=>f.reports.find(r=>r.id==='browser-firefox').healthBefore.ok=false],
 ['an original that executed no tests',f=>f.reports.find(r=>r.id==='browser-firefox').batches=[]],
 ['an original with unnamed cases',f=>delete f.reports.find(r=>r.id==='browser-firefox').batches[0].result.testResults[0].assertionResults[0].fullName],
 ['a dropped case in the rerun',f=>f.fresh.report.batches[0].result.testResults[0].assertionResults[0].fullName='renamed'],
 ['a skipped case in the rerun',f=>f.fresh.report.batches[0].result.testResults[0].assertionResults[0].status='skipped'],
 ['a missing rerun file',f=>f.fresh.report.files=[]],
 ['a rerun of another engine',f=>f.fresh.report.id='browser-webkit'],
 ['an unhealthy rerun',f=>f.fresh.report.healthAfter.ok=false],
 ['image drift',f=>f.fresh.binding.image='mutable:latest'],
 ['lock drift',f=>f.fresh.binding.lockSha256='b'.repeat(64)],
 ['engine binding drift',f=>f.fresh.binding.engine='chromium'],
 ['a changed candidate plan',f=>f.freshPlan.suite=[]],
 ['a missing verifier diagnostic',f=>f.verificationDiagnostic=null],
 ['a changed reviewed verifier',f=>f.reviewedController='d'.repeat(40)],
 ['a changed retained report',f=>f.reports.find(r=>r.id!=='browser-firefox').cwd='/changed'],
])test('Single-shot recovery refuses '+name,()=>{const f=input();mutate(f);assert.throws(()=>{const c=verifySingleShotRecovery(f);if(c.kind!=='AUTHENTICATED_BROWSER_SINGLE_SHOT_RECOVERY')throw Error('refused');});});

test('Diagnosis collects every refusal and is never installable',()=>{
 const f=input();f.executions.push({...f.executions[0],id:201});f.flakeRegister.text='| `other` |';
 const d=verifySingleShotRecovery(f,{collect:true});
 assert.equal(d.result,'REFUSED');assert.equal(d.installationEligible,false);assert.equal(d.releaseAuthorized,false);
 assert.deepEqual(d.checks.filter(c=>!c.ok).map(c=>c.name),['single shot','registered flake']);
 assert.match(d.checks.find(c=>c.name==='single shot').refusal,/2 executions/);
 assert.throws(()=>verifySingleShotRecovery(f),/Single-shot recovery refused/);
});

test('runChecks throws the first refusal in admission mode',()=>{
 assert.throws(()=>runChecks([['a',()=>1],['b',()=>{throw Error('b refused');}],['c',()=>3]]),/b refused/);
 assert.deepEqual(runChecks([['a',()=>1],['b',()=>{throw Error('x');}]],{collect:true}).results.map(r=>r.ok),[true,false]);
});

test('Exact single-engine producer authenticates, including a main candidate',()=>assert.equal(validateSingleShotMetadata(metadata()).id,303));
for(const [name,mutate] of [
 ['an unowned producer branch',f=>f.expected.branch='feature/x'],['a foreign candidate branch',f=>f.expected.candidateBranch='fork/x'],['an unsupported engine',f=>f.expected.engine='webkit'],
 ['a fork',f=>f.run.head_repository.id=1],['workflow drift',f=>f.run.workflow_id=1],['a wrong controller',f=>f.run.head_sha='a'.repeat(40)],['a rerun producer',f=>f.run.run_attempt=2],['a failed producer',f=>f.run.conclusion='failure'],
 ['a producer before the original finished',f=>f.expected.after=time(1)],['an extra engine job',f=>f.jobs.push({...f.jobs[3],id:999,name:'browser-image (webkit)'})],['a skipped suite step',f=>f.jobs[3].steps[0].conclusion='skipped'],
 ['a missing artifact',f=>f.artifacts.pop()],['a foreign artifact',f=>f.artifacts[0].workflow_run.id=2],['an expired artifact',f=>f.artifacts[0].expired=true],
])test('Single-shot producer admission refuses '+name,()=>{const f=metadata();mutate(f);assert.throws(()=>validateSingleShotMetadata(f));});

test('Impact keeps any changed dependency, global input, unresolved load or unknown graph inside the impact set',()=>{
 const edges=new Map([[file,new Set(['components/a.tsx'])],['components/a.tsx',new Set(['lib/b.ts'])],['lib/b.ts',new Set()],['lib/c.ts',new Set()]]);
 assert.equal(browserImpact({changed:['lib/c.ts','db/migrations/2000_x.sql'],edges,failing:[file]}).outside,true);
 assert.deepEqual(browserImpact({changed:['lib/b.ts'],edges,failing:[file]}).reasons,['changed dependency lib/b.ts reaches a failing file']);
 assert.equal(browserImpact({changed:[file],edges,failing:[file]}).outside,false);
 for(const g of ['package.json','pnpm-lock.yaml','vitest.config.ts','playwright.config.ts','app/globals.css','test/setup-browser.ts','public/fonts/x.woff2'])assert.equal(browserImpact({changed:[g],edges,failing:[file]}).outside,false,g);
 assert.equal(browserImpact({changed:['lib/c.ts'],edges,failing:[file],uncertain:new Set(['components/a.tsx'])}).outside,false);
 assert.equal(browserImpact({changed:['lib/c.ts'],edges:new Map(),failing:[file]}).outside,false);
});

test('History ignores other engines but refuses unreadable or pending executions of this engine',()=>{
 const base={id:200,engine:'firefox',status:'completed',conclusion:'success',attempt:1,candidate:'a'.repeat(40)};
 assert.equal(validateSingleShotHistory({executions:[base,{...base,id:9,engine:'webkit',candidate:null,status:'in_progress'}],browserRunId:200,candidate:'a'.repeat(40),engine:'firefox'}).executions.length,1);
 assert.equal(validateSingleShotHistory({executions:[base,{...base,id:7,candidate:'b'.repeat(40),conclusion:'failure'}],browserRunId:200,candidate:'a'.repeat(40),engine:'firefox'}).executions.length,2);
});

test('Original failure identifies exactly the failing files from the executed case inventory',()=>{
 const f=input(),o=originalBrowserFailure(f);assert.equal(o.unit.id,'browser-firefox');assert.deepEqual(o.failing,[file]);
});

test('v3 has no installation route: the grant and operator controls do not accept its certificate',()=>{
 const grant=readFileSync(new URL('./ci-install-grant.mjs',import.meta.url),'utf8'),operator=readFileSync(new URL('./operator-release.mjs',import.meta.url),'utf8');
 assert.ok(!grant.includes('AUTHENTICATED_BROWSER_SINGLE_SHOT_RECOVERY')&&!grant.includes('browser-recovery-v3'));
 assert.ok(!operator.includes('browser-recovery-v3'));
});

test('The v3 controller may differ from the original gate controller only in its recovery files and register',()=>{
 const own=['.github/ci/browser-recovery-v3.mjs','.github/ci/browser-recovery-v3-policy.mjs','.github/ci/browser-recovery-v3.test.mjs'];
 validateV3ControllerDelta([...own,'.github/workflows/alpha-staging.yml','docs/FLAKY-TESTS.md','docs/BROWSER-RECOVERY-V3.md']);
 for(const path of ['.github/ci/run-unit.mjs','.github/ci/host-health.mjs','.github/actions/setup-browser-image/action.yml','.github/workflows/alpha-staging-browser-checks.yml','.github/ci/ci-install-grant.mjs','.github/ci/operator-release.mjs','app/page.tsx','package.json','db/migrations/meta/_journal.json'])assert.throws(()=>validateV3ControllerDelta([...own,path]),/changed application|unrelated controls/,path);
 assert.throws(()=>validateV3ControllerDelta(['docs/FLAKY-TESTS.md']),/Incomplete v3/);
});
