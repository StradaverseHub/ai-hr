import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,now,time} from './resume-test-fixtures.mjs';
import {hash} from './manifest.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {verifyFocusedRecovery,validateFocusedMetadata,validateRecoveryGrantEvidence,validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
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
const certificate=f=>({...verifyFocusedRecovery(f),verificationDiagnostic:{runId:501,controller:f.verificationController}});
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
])test('Recovery refuses '+name,()=>{const f=input();mutate(f);assert.throws(()=>verifyFocusedRecovery(f));});
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
 assert.equal(validateRecoveryGrantEvidence(e,run),true);const grant=createInstallGrant({...g,evidence:e,run,producer});assert.equal(grant.runId,c.runId);assert.equal(grant.controller,c.controller);assert.equal(grant.witnessFingerprint,hash(c));assert.equal(run.conclusion,'failure');
 delete e.recovery;assert.throws(()=>createInstallGrant({...g,evidence:e,run,producer}));
});
test('Forged/tampered recovery certificate and changed verification identity refuse a grant',()=>{
 const f=input(),c=certificate(f),e={...c,recovery:c,fingerprint:hash(c)};const run=f.run;
 for(const change of [x=>x.recovery.tests++,x=>x.verificationController='a'.repeat(40),x=>delete x.recovery.verificationDiagnostic,x=>x.recovery.originalConclusion='success']){const altered=structuredClone(e);change(altered);assert.throws(()=>validateRecoveryGrantEvidence(altered,run));}
});
test('The verification controller must have actual successful controller-only integrity validation',()=>{
 const f=input(),run={...f.run,id:500,head_sha:f.verificationController,conclusion:'success',display_title:'CI controller checks · verifier'};
 const names=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'];
 const jobs=names.map((name,i)=>({name,id:100+i,run_id:500,head_sha:run.head_sha,run_attempt:1,status:'completed',conclusion:['resolve','deployment-hold'].includes(name)?'success':'skipped',steps:[{name:'CI integrity regression checks',conclusion:'success'}]}));
 const x={run,jobs,controller:f.verificationController,now};assert.equal(validateRecoveryControllerDiagnostic(x).runId,500);
 for(const change of [x=>x.run.head_sha='f'.repeat(40),x=>x.run.display_title='Alpha CI · all',x=>x.jobs[0].steps=[],x=>x.jobs[1].conclusion='success',x=>x.run.run_attempt=2]){const bad=structuredClone(x);change(bad);assert.throws(()=>validateRecoveryControllerDiagnostic(bad));}
});
