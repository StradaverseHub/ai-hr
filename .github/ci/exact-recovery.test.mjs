import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {exactCanonicalRefs} from './canonical-docs-advance.mjs';
import {fixture,now,time} from './resume-test-fixtures.mjs';
import {hash,buildUnits,requiredEvidence} from './manifest.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {verifyExactRecovery,validateExactRecoveryGrantEvidence,validateExactRecoveryHistory,requireReviewedExactController} from './exact-recovery-policy.mjs';
import {validateFocusedMetadata,validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {operatorRelease} from './operator-release.mjs';
import {interruptedDatabaseProof,validateExactControllerDelta} from './exact-recovery.mjs';
import {createInstallGrant} from './ci-install-grant.mjs';
import {installationFixture} from './staging-install-test-fixture.mjs';

function input(){
 const f=fixture(),plan=f.expectedPlan,unit=plan.units.find(u=>u.kind==='nodb');
 for(const r of f.reports)for(const b of r.batches)for(const file of b.result.testResults)for(const a of file.assertionResults)a.fullName='original behavioral case: '+file.name;
 const failed=f.reports.find(r=>r.id===unit.id);failed.exitCode=1;failed.batches[0].exitCode=1;failed.batches[0].result.success=false;
 f.jobs.find(j=>j.name===`test (${unit.id})`).conclusion='failure';
 const assessment={...assessResumeCoverage({expectedPlan:plan,expected:f.expected,reports:f.reports}),sourceRun:{id:f.run.id},observations:[{id:unit.id,conclusion:'failure'}]};
 for(const r of assessment.reusable)r.source={runId:f.run.id,jobId:123,artifactId:456,digest:'sha256:'+'a'.repeat(64)};
 const run={...f.run,id:200,workflow_id:999,path:'.github/workflows/alpha-focused-checks.yml',conclusion:'success',created_at:time(4),updated_at:time(1)};
 const names=['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-swift-models','native-bundle'];
 const jobs=names.map((name,i)=>({id:300+i,name,run_id:run.id,run_attempt:1,head_sha:run.head_sha,head_branch:run.head_branch,status:'completed',conclusion:i<2?'success':'skipped',started_at:time(3),completed_at:time(2)}));
 const artifact={id:400,name:'focused-development-evidence',size_in_bytes:100,digest:'sha256:'+'b'.repeat(64),expired:false,created_at:time(2.5),expires_at:time(-60),workflow_run:{id:run.id,repository_id:1333414856,head_repository_id:1333414856,head_sha:run.head_sha,head_branch:run.head_branch}};
 const report={kind:'FOCUSED_ONLY',releaseEligible:false,schemaVersion:1,sha:plan.sha,controller:plan.controller,runId:String(run.id),attempt:'1',runtime:plan.runtime,files:unit.files,groups:{NODB:unit.files,DB:[]},manifestHash:hash(JSON.stringify(unit.files)),classifierHash:'classifier',startedAt:time(2.9),endedAt:time(2.1),exitCode:0,healthBefore:{ok:true},healthAfter:{ok:true},batches:[{kind:'NODB',files:unit.files,exitCode:0,processExitCode:0,signal:null,assertions:1}]};
 const result=structuredClone(failed.batches[0].result);result.success=true;result.testResults[0].name='/home/runner/work/ai-hr/ai-hr/source/'+unit.files[0];
 return {plan,assessment,run:f.run,jobs:f.jobs,reports:f.reports,focused:[{run,jobs,artifact,producer:jobs[1],report,result}],classifierHash:'classifier',verificationController:'e'.repeat(40)};
}
const certificate=f=>({...verifyExactRecovery(f),verificationDiagnostic:{runId:501,controller:f.verificationController},reviewedController:f.verificationController,history:{kind:'AUTHENTICATED_EXACT_SOURCE_RECOVERY_HISTORY',originalRunId:f.run.id,runIds:f.focused.map(x=>x.run.id).sort((a,b)=>a-b)}});
test('Recovery retains every successful unit and every original failure without mutating reports',()=>{
 const f=input(),before=structuredClone(f.reports),c=certificate(f);assert.deepEqual(f.reports,before);assert.equal(f.run.conclusion,'failure');assert.equal(c.units.filter(u=>u.kind==='focused-recovery').length,1);assert.equal(c.tests,5);assert.equal(c.originalConclusion,'failure');assert.equal(c.units.length,f.plan.units.length);
});
for(const [name,mutate] of [
 ['missing focused coverage',f=>f.focused=[]],['duplicate focused coverage',f=>f.focused.push(structuredClone(f.focused[0]))],
 ['foreign candidate',f=>f.focused[0].report.sha='f'.repeat(40)],['foreign controller',f=>f.focused[0].report.controller='f'.repeat(40)],
 ['failed process',f=>f.focused[0].report.batches[0].processExitCode=1],['process signal',f=>f.focused[0].report.batches[0].signal='SIGTERM'],
 ['failed result',f=>f.focused[0].result.success=false],['skipped assertion',f=>f.focused[0].result.testResults[0].assertionResults[0].status='pending'],
 ['pending test',f=>f.focused[0].result.numPendingTests=1],['pending suite',f=>f.focused[0].result.numPendingTestSuites=1],['todo test',f=>f.focused[0].result.numTodoTests=1],
 ['zero cases',f=>f.focused[0].result.testResults[0].assertionResults=[]],['changed case name',f=>f.focused[0].result.testResults[0].assertionResults[0].fullName='different case'],
 ['count mismatch',f=>f.focused[0].result.numTotalTests++],['summary mismatch',f=>f.focused[0].report.batches[0].assertions++],
 ['foreign result file',f=>f.focused[0].result.testResults[0].name='/foreign/test.js'],['duplicate original reports',f=>f.reports.push(f.reports[0])],
 ['changed retained report',f=>f.reports.find(r=>r.exitCode===0).cwd='/changed'],['changed runtime',f=>f.focused[0].report.runtime={...f.plan.runtime,node:'24.0.0'}],
 ['changed classifier',f=>f.focused[0].report.classifierHash='other'],['altered selection hash',f=>f.focused[0].report.manifestHash='other'],
 ['DB recovery',f=>f.focused[0].report.groups.DB=['test/db.test.ts']],['unhealthy runner',f=>f.focused[0].report.healthAfter.ok=false],
 ['failed build',f=>f.jobs.find(j=>j.name==='build').conclusion='failure'],['failed compiler',f=>f.jobs.find(j=>j.name==='typecheck').conclusion='failure'],
 ['relabeled original success',f=>f.run.conclusion='success'],['wrong original fingerprint',f=>f.assessment.fingerprint='x'],['source observation missing',f=>f.assessment.sourceRun.id++],
 ['failed case inventory missing',f=>f.reports.find(r=>r.exitCode===1).batches[0].result.testResults=[]],
 ['wrong focused run identity',f=>f.focused[0].report.runId='201'],['focused rerun',f=>f.focused[0].report.attempt='2'],
 ['focused execution outside producer',f=>f.focused[0].report.startedAt=time(10)],
])test('Recovery refuses '+name,()=>{const f=input();mutate(f);assert.throws(()=>verifyExactRecovery(f));});
function metadata(){const f=input(),a=f.focused[0];return {run:a.run,jobs:a.jobs,artifacts:[a.artifact],expected:{runId:a.run.id,controller:f.plan.controller,workflowId:999,after:time(5)},now};}
test('Focused metadata authenticates exact producing job and artifact',()=>assert.equal(validateFocusedMetadata(metadata()).name,'selected-tests'));
for(const [name,mutate] of [
 ['fork',f=>f.run.head_repository.id=1],['other repository',f=>f.run.repository.id=1],['other workflow',f=>f.run.workflow_id=1],
 ['other branch',f=>f.run.head_branch='feature'],['other controller',f=>f.run.head_sha='d'.repeat(40)],['PR trigger',f=>f.run.event='pull_request'],
 ['failed focused run',f=>f.run.conclusion='failure'],['focused rerun',f=>f.run.run_attempt=2],['old evidence',f=>f.run.created_at=time(60*25)],
 ['before source completed',f=>f.run.created_at=time(6)],['missing job',f=>f.jobs.pop()],['repeated job',f=>f.jobs[1]=f.jobs[0]],
 ['foreign job',f=>f.jobs[1].run_id=3],['job rerun',f=>f.jobs[1].run_attempt=2],['failed producing job',f=>f.jobs[1].conclusion='failure'],
 ['foreign artifact',f=>f.artifacts[0].workflow_run.id=1],['unknown artifact',f=>f.artifacts[0].name='other'],['duplicate artifact',f=>f.artifacts.push(f.artifacts[0])],
 ['missing digest',f=>f.artifacts[0].digest=null],['expired artifact',f=>f.artifacts[0].expired=true],['artifact outside producer',f=>f.artifacts[0].created_at=time(4)],
])test('Focused API admission refuses '+name,()=>{const f=metadata();mutate(f);assert.throws(()=>validateFocusedMetadata(f));});
test('A distinct recovery certificate authorizes the original successful build without relabelling the failed run',()=>{
 const f=input(),c=certificate(f),g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,source:c.sha,controller:c.controller,runId:c.runId}};
 const run={...g.run,id:c.runId,head_sha:c.controller,conclusion:'failure'},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 assert.equal(validateExactRecoveryGrantEvidence(e,run),true);const grant=createInstallGrant({...g,evidence:e,run,producer});assert.equal(grant.runId,c.runId);assert.equal(grant.controller,c.controller);assert.equal(grant.witnessFingerprint,hash(c));assert.equal(run.conclusion,'failure');
 delete e.recovery;assert.throws(()=>createInstallGrant({...g,evidence:e,run,producer}));
});
test('Forged/tampered recovery certificate and changed verification identity refuse a grant',()=>{
 const f=input(),c=certificate(f),e={...c,recovery:c,fingerprint:hash(c)};const run=f.run;
 for(const change of [x=>x.recovery.tests++,x=>x.verificationController='a'.repeat(40),x=>delete x.recovery.verificationDiagnostic,x=>x.recovery.originalConclusion='success']){const altered=structuredClone(e);change(altered);assert.throws(()=>validateExactRecoveryGrantEvidence(altered,run));}
});
test('The verification controller must have actual successful controller-only integrity validation',()=>{
 const f=input(),run={...f.run,id:500,head_sha:f.verificationController,conclusion:'success',display_title:'CI controller checks · verifier'};
 const names=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'];
 const jobs=names.map((name,i)=>({name,id:100+i,run_id:500,head_sha:run.head_sha,run_attempt:1,status:'completed',conclusion:['resolve','deployment-hold'].includes(name)?'success':'skipped',steps:[{name:'CI integrity regression checks',conclusion:'success'}]}));
 const x={run,jobs,controller:f.verificationController,now};assert.equal(validateRecoveryControllerDiagnostic(x).runId,500);
 for(const change of [x=>x.run.head_sha='f'.repeat(40),x=>x.run.display_title='Alpha CI · all',x=>x.jobs[0].steps=[],x=>x.jobs[1].conclusion='success',x=>x.run.run_attempt=2]){const bad=structuredClone(x);change(bad);assert.throws(()=>validateRecoveryControllerDiagnostic(bad));}
});

function dbInput(){
 const f=input(),old=f.plan.units.find(u=>u.kind==='nodb'),unit=f.plan.units.find(u=>u.kind==='db');
 const plain=f.reports.find(r=>r.id===old.id);plain.exitCode=0;plain.batches[0].exitCode=0;plain.batches[0].result.success=true;
 f.jobs.find(j=>j.name===`test (${old.id})`).conclusion='success';
 const original=f.reports.find(r=>r.id===unit.id);original.exitCode=1;original.batches[0].exitCode=1;original.batches[0].result.success=false;
 f.jobs.find(j=>j.name===`test (${unit.id})`).conclusion='failure';
 f.assessment={...assessResumeCoverage({expectedPlan:f.plan,expected:{candidate:f.plan.sha,controller:f.plan.controller,baseline:f.plan.migrationBase},reports:f.reports}),sourceRun:{id:f.run.id},observations:[{id:unit.id,conclusion:'failure'}]};
 for(const r of f.assessment.reusable)r.source={runId:f.run.id,jobId:123,artifactId:456,digest:'sha256:'+'a'.repeat(64)};
 const p=f.focused[0];p.report.files=unit.files.slice().sort();p.report.groups={NODB:[],DB:p.report.files};p.report.manifestHash=hash(JSON.stringify(p.report.files));p.report.batches[0]={...p.report.batches[0],kind:'DB',files:p.report.files,startedAt:time(2.9),endedAt:time(2.4)};
 p.report.databaseTerminalEvidence={...structuredClone(original.databaseTerminalEvidence),name:'aihr-ci-200-1-db-1',capturedAt:time(2.2)};
 p.result=structuredClone(original.batches[0].result);p.result.success=true;p.result.testResults[0].name='/home/runner/work/ai-hr/ai-hr/source/'+unit.files[0];return f;
}
test('v4 admits entire unchanged-source DB process with fresh owned PG16, preserving producer and failure',()=>{
 const f=dbInput(),before=structuredClone(f.reports),c=certificate(f);assert.deepEqual(f.reports,before);assert.equal(c.tests,5);assert.equal(c.controller,'c'.repeat(40));assert.notEqual(c.controller,c.sha);assert.equal(f.run.conclusion,'failure');
});
for(const [name,mutate] of [
 ['missing database evidence',f=>delete f.focused[0].report.databaseTerminalEvidence],['wrong database owner',f=>f.focused[0].report.databaseTerminalEvidence.name='foreign'],['OOM',f=>f.focused[0].report.databaseTerminalEvidence.memoryEvents.oom_kill=1],['resource budget drift',f=>f.focused[0].report.databaseTerminalEvidence.memoryMax=1073741824],['JIT drift',f=>f.focused[0].report.databaseTerminalEvidence.settings.jit='off'],['PG patch drift',f=>f.focused[0].report.databaseTerminalEvidence.settings.serverVersionNum='160099'],['early DB capture',f=>f.focused[0].report.databaseTerminalEvidence.capturedAt=time(10)],['late DB capture',f=>f.focused[0].report.databaseTerminalEvidence.capturedAt=time(-1)],['mixed selection',f=>f.focused[0].report.groups.NODB=f.focused[0].report.files],['wrong batch kind',f=>f.focused[0].report.batches[0].kind='NODB'],['wrong assertions',f=>f.focused[0].result.testResults[0].assertionResults[0].fullName='changed'],['missing start',f=>delete f.focused[0].report.batches[0].startedAt],['missing batch end',f=>delete f.focused[0].report.batches[0].endedAt],['capture during batch',f=>f.focused[0].report.databaseTerminalEvidence.capturedAt=time(2.6)],['capture after report',f=>f.focused[0].report.databaseTerminalEvidence.capturedAt=time(2.05)],['batch end before start',f=>f.focused[0].report.batches[0].endedAt=time(3)]
])test('v4 DB recovery refuses '+name,()=>{const f=dbInput();mutate(f);assert.throws(()=>verifyExactRecovery(f));});
test('v4 grant binds original successful build and explicit independent review',()=>{
 const f=dbInput(),c=certificate(f),g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,source:c.sha,controller:c.controller,runId:c.runId}};
 const run={...g.run,id:c.runId,head_sha:c.controller,conclusion:'failure'},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 assert.equal(createInstallGrant({...g,evidence:e,run,producer}).witnessFingerprint,hash(c));
 delete e.recovery.reviewedController;e.fingerprint=hash(e.recovery);assert.throws(()=>createInstallGrant({...g,evidence:e,run,producer}));
});
test('operator import and independent controller pin remain explicit',()=>{assert.equal(typeof operatorRelease,'function');assert.throws(()=>requireReviewedExactController({controller:'a'.repeat(40)}));assert.doesNotThrow(()=>requireReviewedExactController({controller:'a'.repeat(40),reviewedController:'a'.repeat(40)}));});
function historyInput(){const f=input();f.run.display_title='Alpha CI · owned';return {sourceRun:f.run,candidateBranch:'owned',focusedRunIds:[200],rows:[{...f.focused[0].run,display_title:'Focused only · owned'}]};}
test('v4 authenticates exact complete latest history',()=>assert.deepEqual(validateExactRecoveryHistory(historyInput()).runIds,[200]));
for(const [name,change] of [
 ['later failure',f=>f.rows.push({...f.rows[0],id:201,conclusion:'failure'})],['active older execution',f=>f.rows.push({...f.rows[0],id:201,status:'in_progress',created_at:time(60),updated_at:time(59)})],['superseding success',f=>f.rows.push({...f.rows[0],id:201})],['missing known run',f=>f.rows=[]],['conflicting snapshots',f=>f.rows.push({...f.rows[0],conclusion:'failure'})],['rerun',f=>f.rows[0].run_attempt=2],['overlapping failure',f=>f.rows.push({...f.rows[0],id:201,created_at:time(30),conclusion:'failure'})]
])test('v4 history refuses '+name,()=>{const f=historyInput();change(f);assert.throws(()=>validateExactRecoveryHistory(f));});

// Actual unchanged receiver code, not a rewritten or mocked grant validator.
test('The original 9bdf receiver accepts the unchanged format-2 grant from a distinct reviewed v4 DB certificate',async()=>{
 const f=dbInput(),c=certificate(f),g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,source:c.sha,controller:c.controller,runId:c.runId}};
 const run={...g.run,id:c.runId,head_sha:c.controller,conclusion:'failure'},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 const grant=createInstallGrant({...g,evidence:e,run,producer});
 const root=mkdtempSync(join(tmpdir(),'original-grant-receiver-'));
 try{const baseline='9bdfb45969c4bff81a9b9830b52403a95e82bdc6';try{execFileSync('git',['cat-file','-e',baseline+'^{commit}'],{stdio:'ignore'});}catch{execFileSync('git',['fetch','--no-tags','--depth=1','https://github.com/StradaverseHub/ai-hr.git',baseline],{stdio:'pipe',timeout:60000});}const archive=execFileSync('git',['archive',baseline,'.github/ci'],{maxBuffer:128*1024**2});execFileSync('tar',['-x','-C',root],{input:archive});
  const original=await import(pathToFileURL(join(root,'.github/ci/ci-install-grant.mjs')).href);
  assert.deepEqual(original.validateInstallGrant(grant,{now:g.now}),grant);assert.equal(grant.kind,'OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL');assert.equal(grant.format,2);
  assert.equal(original.validateInstallGrant.toString(),(await import('./ci-install-grant.mjs')).validateInstallGrant.toString());
  assert.throws(()=>original.validateInstallGrant({...grant,target:'production'},{now:g.now}));
  assert.equal(run.conclusion,'failure');assert.equal(c.recoveryPolicy,'aihr-exact-source-recovery/v5');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Focused evidence cannot silently replace the original producing controller',()=>{const f=dbInput();f.focused[0].run.head_sha='d'.repeat(40);f.focused[0].report.controller='d'.repeat(40);assert.throws(()=>verifyExactRecovery(f));});
test('Canonical source/build context cannot be rehashed onto another source',()=>{const f=dbInput();f.canonicalAdvance=exactCanonicalRefs({originalController:f.plan.controller,baseline:f.plan.migrationBase,candidate:'d'.repeat(40)});assert.throws(()=>verifyExactRecovery(f));});

test('Recovery controller scope refuses application, receiver-runtime or coverage-policy edits',()=>{
 const paths=['.github/ci/exact-recovery-policy.mjs','.github/ci/exact-recovery.mjs','.github/ci/exact-recovery.test.mjs','.github/ci/exact-recovery-adapter.test.mjs','.github/ci/exact-recovery-extract.py','.github/ci/exact-recovery-extract.test.py','.github/ci/canonical-docs-advance.mjs','.github/ci/canonical-docs-advance.test.mjs','.github/ci/focused-recovery.mjs','.github/ci/ci-install-grant.mjs','.github/ci/staging-preflight.test.mjs','.github/ci/operator-release.mjs','.github/workflows/alpha-staging.yml','docs/CI-EXACT-SOURCE-RECOVERY-V5.md'];
 assert.equal(validateExactControllerDelta(paths),true);
 for(const extra of ['core/analytics.ts','.github/ci/postgres-evidence.mjs','.github/ci/policy-version.mjs','test/analytics-carry-searched-native-scale.test.ts'])assert.throws(()=>validateExactControllerDelta([...paths,extra]));
 assert.throws(()=>validateExactControllerDelta(paths.slice(1)));assert.throws(()=>validateExactControllerDelta([...paths,paths[0]]));
});


function interruptedInput(){
 const f=dbInput(),template=f.reports.find(r=>r.databaseTerminalEvidence),plain=f.plan.units.find(u=>u.kind==='nodb').files;
 const db=Array.from({length:47},(_,i)=>`test/interrupted-${i}.test.ts`),suite=[...plain,...db].sort(),units=buildUnits(suite,{db,nodb:plain},f.plan.units.find(u=>u.kind==='browser').files);
 const {fingerprint,...body}={...f.plan,suite,units};f.plan={...body,fingerprint:hash(body)};
 const missing=units.find(u=>u.kind==='db'),originals=f.reports;
 const makeResult=files=>({success:true,numTotalTests:files.length,numPassedTests:files.length,numFailedTests:0,numFailedTestSuites:0,testResults:files.map(path=>({name:'/candidate/'+path,status:'passed',assertionResults:[{fullName:'unchanged behavior: '+path,status:'passed'}]}))});
 const all=units.map(unit=>{
  const source=unit.kind==='db'?template:originals.find(r=>r.id===unit.id);
  return {...structuredClone(source),id:unit.id,sha:f.plan.sha,fingerprint:f.plan.fingerprint,files:unit.files,exitCode:0,batches:[{...structuredClone(source.batches[0]),exitCode:0,result:makeResult(unit.files)}]};
 });
 const jobTemplate=f.jobs[0];f.jobs=requiredEvidence(f.plan).jobs.map((name,i)=>({...jobTemplate,id:1000+i,name,conclusion:['verify',`test (${missing.id})`].includes(name)?'failure':'success'}));
 const job=f.jobs.find(j=>j.name===`test (${missing.id})`);job.steps=[{name:'Run node ../automation/.github/ci/run-unit.mjs "$UNIT" "$RUNNER_TEMP/aihr-ci"',conclusion:'cancelled'},{name:'Run actions/upload-artifact@pinned',conclusion:'skipped'}];
 f.reports=all.map(r=>r.id===missing.id?undefined:r);
 f.assessment={...assessResumeCoverage({expectedPlan:f.plan,expected:{candidate:f.plan.sha,controller:f.plan.controller,baseline:f.plan.migrationBase},reports:f.reports.filter(Boolean)}),sourceRun:{id:f.run.id},observations:[{id:missing.id,jobId:job.id,conclusion:'failure',artifact:null}]};
 for(const r of f.assessment.reusable)r.source={runId:f.run.id,jobId:123,artifactId:456,digest:'sha256:'+'a'.repeat(64)};
 const focused=f.focused[0];focused.report.files=missing.files.slice().sort();focused.report.groups={NODB:[],DB:focused.report.files};focused.report.manifestHash=hash(JSON.stringify(focused.report.files));focused.report.batches[0].files=focused.report.files;focused.report.batches[0].assertions=missing.files.length;
 focused.result=makeResult(missing.files);for(const result of focused.result.testResults)result.name=result.name.replace('/candidate/','/home/runner/work/ai-hr/ai-hr/source/');
 const log=Buffer.from(time(6.5)+' ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.\n');
 f.interrupted=[interruptedDatabaseProof({unit:missing,job,observation:f.assessment.observations[0],run:f.run,candidate:f.plan.sha,controller:f.plan.controller,log})];
 return f;
}
test('v5 recovers a whole unchanged-source interrupted DB unit without inventing an original report or cases',()=>{
 const f=interruptedInput(),before=structuredClone(f.reports),c=certificate(f),unit=c.units.find(u=>u.originalReportMissing);
 assert.equal(unit.files.length,24);assert.equal(unit.interruption.runnerShutdown,true);assert.equal(unit.expectedFilesHash,hash(f.focused[0].report.files));assert.deepEqual(f.reports,before);assert.equal(f.run.conclusion,'failure');
});
for(const [name,mutate] of [
 ['missing shutdown proof',f=>f.interrupted=[]],['wrong original job',f=>f.interrupted[0].jobId++],['wrong source',f=>f.interrupted[0].sha='d'.repeat(40)],['wrong producer',f=>f.interrupted[0].controller='d'.repeat(40)],['unhashed log',f=>f.interrupted[0].logSha256='bad'],['oversized log',f=>f.interrupted[0].logBytes=33*1024**2],['missing shutdown',f=>f.interrupted[0].runnerShutdown=false],['existing artifact',f=>f.assessment.observations[0].artifact={id:1,digest:'sha256:'+'a'.repeat(64)}],['missing interrupted step',f=>f.jobs.find(j=>j.id===f.interrupted[0].jobId).steps=[]],['partial fresh files',f=>f.focused[0].report.files=f.focused[0].report.files.slice(1)],['skipped fresh case',f=>f.focused[0].result.testResults[0].assertionResults[0].status='pending'],['different PG patch',f=>f.focused[0].report.databaseTerminalEvidence.settings.serverVersionNum='160099'],['second absent report',f=>f.reports[f.reports.findIndex(r=>r?.databaseTerminalEvidence)]=undefined],
])test('v5 interrupted recovery refuses '+name,()=>{const f=interruptedInput();mutate(f);assert.throws(()=>verifyExactRecovery(f));});
test('v5 interruption proof requires the authenticated job and an in-window real shutdown marker',()=>{
 const f=interruptedInput(),unit=f.plan.units.find(u=>u.id===f.interrupted[0].id),job=f.jobs.find(j=>j.id===f.interrupted[0].jobId),base={unit,job,observation:f.assessment.observations[0],run:f.run,candidate:f.plan.sha,controller:f.plan.controller};
 assert.throws(()=>interruptedDatabaseProof({...base,log:Buffer.from('echo ##[error]The runner has received a shutdown signal.')}));
 assert.throws(()=>interruptedDatabaseProof({...base,log:Buffer.from(time(30)+' ##[error]The runner has received a shutdown signal.')}));
 assert.throws(()=>interruptedDatabaseProof({...base,job:{...job,run_id:999},log:Buffer.from(time(6.5)+' ##[error]The runner has received a shutdown signal.')}));
});
