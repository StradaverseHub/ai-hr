import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,put,now,time} from './resume-test-fixtures.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {hash} from './manifest.mjs';
import {createInstallGrant} from './ci-install-grant.mjs';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {NEXT_APPLICATION_FAILURE} from './next-application-cache-protocol.mjs';
import {verifyBuildRecovery,validateBuildRecoveryHistory,validateBuildRecoveryGrantEvidence,validateMemoryFloorFailure,MEMORY_FLOOR_ERROR,BUILD_RECOVERY_POLICY,BUILD_STEP,BUILD_DIAGNOSTIC_STEP,VERIFY_GUARD_STEP} from './build-recovery-policy.mjs';
import {buildRecoveryOptions} from './operator-release.mjs';
const BRANCH='claude/candidate-fixture';
const PEAK=10799396,TYPEGEN_PEAK=169160;
const buildLog=(extra='')=>`✓ Compiled successfully in 2.4min\n  Finished TypeScript in 3.1min ...\n${extra}\tMaximum resident set size (kbytes): ${PEAK}\n\tExit status: 0\n`;
const typegenLog=`\tMaximum resident set size (kbytes): ${TYPEGEN_PEAK}\n\tExit status: 0\n`;
// Real job step shapes: the failed step, earlier successes, later skips; post-failure bookkeeping still runs.
const steps=(names,failed,alwaysRun=[])=>{const at=names.indexOf(failed);return names.map((name,i)=>({number:i+1,name,conclusion:i===at?'failure':i<at||name==='Complete job'||alwaysRun.includes(name)?'success':'skipped'}));};
const BUILD_STEPS=['Set up job','Run actions/checkout','Run actions/checkout','Run ./automation/.github/actions/setup-alpha','Require both frozen AI source manifests before building','Bind compiler cache to CI build context','Restore optional Turbopack compiler cache','Admit bounded next build heap',BUILD_STEP,'Publish mandatory canonical build packet','Publish optional application compiler graph',BUILD_DIAGNOSTIC_STEP,'Bound optional compiler cache upload','Save optional Turbopack compiler cache','Complete job'];
const VERIFY_STEPS=['Set up job',VERIFY_GUARD_STEP,'Run actions/checkout','Run actions/checkout','Run actions/setup-node','Run actions/download-artifact','Run node ../automation/.github/ci/verify-shards.mjs','Run actions/upload-artifact','Complete job'];
function failureReport(e){
 const canonical={name:'canonical-build',startedAt:time(15),code:0,signal:null,timedOut:false,elapsedMs:400856,endedAt:time(11),peakRssKiB:PEAK};
 return {kind:'CANONICAL_CI_APPLICATION_COMPILER_STATE_NOT_RELEASE',releaseAuthorized:false,source:e.candidate,controller:e.controller,runId:String(e.runId),attempt:'1',exitCode:1,
  capacityProfile:'bounded-canonical-build',error:MEMORY_FLOOR_ERROR,cacheHit:false,
  memory:{nodeOptions:'--max-old-space-size=8192',heapMb:8192,heapProfile:'hosted-linux-16g-8192',rssBudgetKiB:{warn:10485760,fail:13107200},minMemAvailableBudgetKiB:1572864,availableMemoryVerdict:'fail',minMemAvailableKiB:1154660,peakRssKiB:PEAK,verdict:'fail',rssVerdict:'warn'},
  phases:[{name:'application-typegen',startedAt:time(16),code:0,signal:null,timedOut:false,elapsedMs:944,endedAt:time(15.9),peakRssKiB:TYPEGEN_PEAK},canonical],actualCanonicalBuild:{...canonical},
  diskSamples:[{label:'before',at:time(16),volumes:[{path:'/home/runner/work/ai-hr/ai-hr/source',availableBytes:90524176384}]}],
  ownedRecordsRemoved:true,workingStateRemoved:true,sourceRestored:true,controllerRestored:true,endedAt:time(11)};
}
function input(){
 const f=fixture(),e=f.expected;
 f.run.display_title='Alpha CI · '+BRANCH;
 for(const j of f.jobs){if(j.name==='build'){j.conclusion='failure';j.steps=steps(BUILD_STEPS,BUILD_STEP,[BUILD_DIAGNOSTIC_STEP]);}
  if(j.name==='verify')j.steps=steps(VERIFY_STEPS,VERIFY_GUARD_STEP);}
 f.jobs.push({id:1999,name:'runner-diagnostics',run_id:100,run_attempt:1,head_sha:e.controller,head_branch:'main',status:'completed',conclusion:'skipped'});
 const report=failureReport(e);
 put(f,NEXT_APPLICATION_FAILURE,'comparison.json',report,{'canonical-build.log':buildLog(),'application-typegen.log':typegenLog});
 const assessed=f.artifacts.filter(a=>a.name!==NEXT_APPLICATION_FAILURE),archives=new Map([...f.archives].filter(([n])=>n!==NEXT_APPLICATION_FAILURE));
 const assessment=assessResumeSource({expectedPlan:f.expectedPlan,expected:e,run:f.run,jobs:f.jobs,artifacts:assessed,archives,now});
 const buildRun={...f.run,id:500,conclusion:'success',created_at:time(4),updated_at:time(1),display_title:'Canonical build only · '+BRANCH,html_url:'https://example.invalid/500'};
 const buildJobs=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'].map((name,i)=>({id:600+i,name,run_id:500,head_sha:buildRun.head_sha,head_branch:buildRun.head_branch,run_attempt:1,status:'completed',conclusion:['resolve','build','deployment-hold'].includes(name)?'success':'skipped',started_at:time(3.5),completed_at:time(1.5)}));
 const rows=[{id:500,workflow_id:buildRun.workflow_id,display_title:buildRun.display_title,head_sha:e.controller,status:'completed',conclusion:'success',run_attempt:1,created_at:time(4),updated_at:time(1)},
  {id:50,workflow_id:buildRun.workflow_id,display_title:'Alpha CI · '+BRANCH,head_sha:e.controller,status:'completed',conclusion:'failure',run_attempt:1,created_at:time(80),updated_at:time(40)},
  {id:501,workflow_id:buildRun.workflow_id,display_title:'Alpha CI · another-branch',head_sha:e.controller,status:'in_progress',conclusion:null,run_attempt:1,created_at:time(2),updated_at:time(1)},
  {...f.run,display_title:f.run.display_title}];
 return {expectedPlan:f.expectedPlan,p:{...e},plan:f.expectedPlan,sourceRun:f.run,sourceJobs:f.jobs,sourceArtifacts:f.artifacts,reports:f.reports,assessment,
  failure:{report,buildLog:buildLog(),typegenLog},buildRun,buildJobs,build:{canonicalCandidateInputsVerified:true,source:e.candidate,controller:e.controller,runId:500},
  rows,candidateBranch:BRANCH,verificationController:e.controller,now};
}
function compose(f){const history=validateBuildRecoveryHistory({source:{run:f.sourceRun},rows:f.rows,candidateBranch:f.candidateBranch,buildRunId:f.buildRun.id});return verifyBuildRecovery({...f,history});}
test('A memory-floor-only build failure is replaced by one exact build-only run while every original witness is retained',()=>{
 const f=input(),reports=structuredClone(f.reports),c=compose(f);
 assert.equal(c.kind,'AUTHENTICATED_BUILD_CAPACITY_RECOVERY');assert.equal(c.recoveryPolicy,BUILD_RECOVERY_POLICY);assert.equal(c.runId,500);assert.equal(c.originalRunId,100);
 assert.equal(c.sha,f.p.candidate);assert.equal(c.controller,f.p.controller);assert.equal(c.verificationController,f.p.controller);assert.equal(c.originalConclusion,'failure');
 assert.equal(c.originalBuild.conclusion,'failure');assert.equal(c.memoryFloor.proven,true);assert.equal(c.memoryFloor.minMemAvailableKiB,1154660);assert.equal(c.memoryFloor.rssVerdict,'warn');
 assert.equal(c.units.length,f.plan.units.length);assert(c.units.every(u=>u.kind==='retained'&&u.source.runId===100));assert.equal(c.tests,f.plan.units.length);
 assert.deepEqual(c.history.executions.map(x=>x.id),[500]);assert.deepEqual(f.reports,reports);assert.equal(c.releaseAuthorized,false);
});
const refusals=[
 // Not the memory floor.
 ['compile error',f=>{f.failure.report.error='AssertionError [ERR_ASSERTION]: Actual canonical-build failed';f.failure.report.phases[1].code=1;f.failure.report.actualCanonicalBuild.code=1;}],
 ['TypeScript error in log with floor message',f=>f.failure.buildLog=buildLog('app/page.tsx(1,1): error TS2322: Type mismatch\n')],
 ['compiler never finished',f=>f.failure.buildLog=f.failure.buildLog.replace('Finished TypeScript','Started TypeScript')],
 ['skipped type validation',f=>f.failure.buildLog=buildLog('Skipping validation of types\n')],
 ['build process exit',f=>f.failure.buildLog=f.failure.buildLog.replace('Exit status: 0','Exit status: 1')],
 ['typegen process exit',f=>f.failure.typegenLog=typegenLog.replace('Exit status: 0','Exit status: 2')],
 ['peak RSS budget breach',f=>{const m=f.failure.report.memory;m.peakRssKiB=13200000;m.rssVerdict='fail';f.failure.report.phases[1].peakRssKiB=13200000;f.failure.report.actualCanonicalBuild.peakRssKiB=13200000;f.failure.buildLog=f.failure.buildLog.replace(String(PEAK),'13200000');}],
 ['available memory actually above floor',f=>f.failure.report.memory.minMemAvailableKiB=2000000],
 ['forged verdict',f=>f.failure.report.memory.rssVerdict='within'],
 ['log peak differs',f=>f.failure.buildLog=f.failure.buildLog.replace(String(PEAK),'1234')],
 ['default heap profile',f=>f.failure.report.memory.heapMb=6144],
 ['timed-out build command',f=>{f.failure.report.phases[1].timedOut=true;f.failure.report.actualCanonicalBuild.timedOut=true;}],
 ['disk headroom breach',f=>f.failure.report.diskSamples[0].volumes[0].availableBytes=1024],
 ['cleanup failure',f=>f.failure.report.cleanupError='Error: owned cleanup'],
 ['diagnostic from another candidate',f=>f.failure.report.source='d'.repeat(40)],
 ['diagnostic from another run',f=>f.failure.report.runId='99'],
 ['diagnostic from a rerun',f=>f.failure.report.attempt='2'],
 ['diagnostic relabelled release',f=>f.failure.report.releaseAuthorized=true],
 // Changed source.
 ['changed candidate source',f=>{const body={...f.expectedPlan,sha:'d'.repeat(40)};delete body.fingerprint;f.expectedPlan={...body,fingerprint:hash(body)};f.p.candidate='d'.repeat(40);f.build.source='d'.repeat(40);}],
 ['replacement build of another candidate',f=>f.build.source='d'.repeat(40)],
 ['archived plan altered',f=>{f.plan=structuredClone(f.plan);f.plan.suite=[...f.plan.suite];f.plan.migrationBase='e'.repeat(40);}],
 // Rerun attempts.
 ['original rerun attempt',f=>f.sourceRun.run_attempt=2],
 ['original job rerun',f=>f.sourceJobs.find(j=>j.name==='typecheck').run_attempt=2],
 ['replacement rerun attempt',f=>f.buildRun.run_attempt=2],
 ['replacement job rerun',f=>f.buildJobs.find(j=>j.name==='build').run_attempt=2],
 // Any other failed job.
 ['typecheck failure',f=>f.sourceJobs.find(j=>j.name==='typecheck').conclusion='failure'],
 ['migrations failure',f=>f.sourceJobs.find(j=>j.name==='migrations').conclusion='failure'],
 ['controller-tests failure',f=>f.sourceJobs.find(j=>j.name==='controller-tests').conclusion='failure'],
 ['test unit failure',f=>f.sourceJobs.find(j=>j.name.startsWith('test (')).conclusion='failure'],
 ['browser failure',f=>f.sourceJobs.find(j=>j.name.startsWith('browser (')).conclusion='failure'],
 ['deployment-hold failure',f=>f.sourceJobs.find(j=>j.name==='deployment-hold').conclusion='failure'],
 ['cancelled plan',f=>f.sourceJobs.find(j=>j.name==='plan').conclusion='cancelled'],
 ['executed runner diagnostics',f=>f.sourceJobs.find(j=>j.name==='runner-diagnostics').conclusion='success'],
 ['omitted job',f=>f.sourceJobs=f.sourceJobs.filter(j=>j.name!=='migrations')],
 ['verify failed beyond its guard',f=>{const s=f.sourceJobs.find(j=>j.name==='verify').steps;s.find(x=>x.name===VERIFY_GUARD_STEP).conclusion='success';s.find(x=>x.name.includes('verify-shards')).conclusion='failure';}],
 ['verify ran shards after guard',f=>f.sourceJobs.find(j=>j.name==='verify').steps.find(x=>x.name.includes('verify-shards')).conclusion='success'],
 ['different build step failed',f=>{const s=f.sourceJobs.find(j=>j.name==='build').steps;s.find(x=>x.name===BUILD_STEP).conclusion='success';s.find(x=>x.name==='Admit bounded next build heap').conclusion='failure';}],
 ['diagnostics not preserved',f=>f.sourceJobs.find(j=>j.name==='build').steps.find(x=>x.name===BUILD_DIAGNOSTIC_STEP).conclusion='skipped'],
 ['failed unit report retained',f=>f.assessment={...f.assessment,rerun:[{id:f.plan.units[0].id}],reusable:f.assessment.reusable.slice(1)}],
 ['tampered retained report',f=>f.reports[0].cwd='/changed'],
 // Original artifacts.
 ['original already has a build packet',f=>f.sourceArtifacts.push({...f.sourceArtifacts[0],id:7777,name:'production-build-v1'})],
 ['original has a receipt',f=>f.sourceArtifacts.push({...f.sourceArtifacts[0],id:7778,name:'gate-evidence'})],
 ['missing failure diagnostic',f=>f.sourceArtifacts=f.sourceArtifacts.filter(a=>a.name!==NEXT_APPLICATION_FAILURE)],
 ['foreign failure diagnostic',f=>f.sourceArtifacts.find(a=>a.name===NEXT_APPLICATION_FAILURE).workflow_run.id=99],
 ['expired failure diagnostic',f=>f.sourceArtifacts.find(a=>a.name===NEXT_APPLICATION_FAILURE).expired=true],
 ['failure diagnostic outside build job',f=>f.sourceArtifacts.find(a=>a.name===NEXT_APPLICATION_FAILURE).created_at=time(1)],
 // Replacement controller/candidate/run shape.
 ['replacement on a different controller',f=>{const x='e'.repeat(40);f.buildRun.head_sha=x;for(const j of f.buildJobs)j.head_sha=x;f.build.controller=x;f.rows[0].head_sha=x;}],
 ['packet from a different controller',f=>f.build.controller='e'.repeat(40)],
 ['replacement on another controller branch',f=>{f.buildRun.head_branch='alpha';for(const j of f.buildJobs)j.head_branch='alpha';}],
 ['verifier controller differs from original',f=>f.verificationController='e'.repeat(40)],
 ['packet from another run',f=>f.build.runId=100],
 ['replacement built before original completed',f=>f.buildRun.created_at=time(6)],
 ['replacement for another branch',f=>f.buildRun.display_title='Canonical build only · other'],
 ['full gate as replacement',f=>f.buildRun.display_title='Alpha CI · '+BRANCH],
 ['replacement executed tests',f=>f.buildJobs.find(j=>j.name==='test').conclusion='success'],
 ['failed replacement',f=>{f.buildRun.conclusion='failure';f.buildJobs.find(j=>j.name==='build').conclusion='failure';}],
 ['unverified packet',f=>f.build.canonicalCandidateInputsVerified=false],
 ['original belongs to another branch',f=>f.sourceRun.display_title='Alpha CI · other'],
 // History.
 ['superseding full gate',f=>f.rows.push({...f.rows[0],id:502,display_title:'Alpha CI · '+BRANCH,conclusion:'success'})],
 ['pending full gate',f=>f.rows.push({...f.rows[0],id:503,display_title:'Alpha CI · '+BRANCH,status:'queued',conclusion:null})],
 ['second unaccounted build-only run',f=>f.rows.push({...f.rows[0],id:504})],
 ['overlapping failed build-only run',f=>f.rows.push({...f.rows[0],id:505,conclusion:'failure',created_at:time(19),updated_at:time(12)})],
 ['later focused run',f=>f.rows.push({...f.rows[0],id:506,display_title:'Focused only · '+BRANCH})],
 ['active browser tooling run',f=>f.rows.push({...f.rows[0],id:507,display_title:'Tooling transport only · '+BRANCH,status:'in_progress',conclusion:null})],
 ['replacement absent from history',f=>f.rows.shift()],
 ['conflicting history snapshot',f=>f.rows.push({...f.rows[0],updated_at:time(0.5)})],
];
for(const [name,change] of refusals)test('Build recovery refuses '+name,()=>{const f=input();change(f);assert.throws(()=>compose(f));});
test('Fixture refusals mutate only an otherwise admissible input',()=>{for(let i=0;i<3;i++)assert.doesNotThrow(()=>compose(input()));});
test('The memory floor is proven from the diagnostic, independent of the rest of the gate',()=>{
 const f=input(),proof=validateMemoryFloorFailure({...f.failure,expected:{candidate:f.p.candidate,controller:f.p.controller,runId:100}});
 assert.equal(proof.error,MEMORY_FLOOR_ERROR);assert.equal(proof.floorKiB,1572864);assert.equal(proof.peakRssKiB,PEAK);assert.match(proof.buildLogSha256,/^[a-f0-9]{64}$/);
 const missing=structuredClone(f.failure);missing.report.memory.minMemAvailableKiB=null;
 assert.equal(validateMemoryFloorFailure({...missing,expected:{candidate:f.p.candidate,controller:f.p.controller,runId:100}}).minMemAvailableKiB,null,'Missing sampled memory is the same reviewed floor failure');
});
test('Grant binds the replacement build run and the certificate keeps the original failed gate',()=>{
 const f=input(),c=compose(f),g=installationFixture(),e={...g.evidence,...c,recovery:c,fingerprint:hash(c),build:{...g.evidence.build,...f.build}};
 const run={...g.run,id:c.runId,head_sha:c.controller},producer={...g.producer,run_id:c.runId,head_sha:c.controller};
 assert.equal(validateBuildRecoveryGrantEvidence(e,run),true);
 const grant=createInstallGrant({...g,evidence:e,run,producer});assert.equal(grant.runId,500);assert.equal(grant.source,c.sha);assert.equal(grant.controller,c.controller);assert.equal(grant.witnessFingerprint,hash(c));
 assert.throws(()=>createInstallGrant({...g,evidence:e,run:{...run,conclusion:'failure'},producer}),'The replacement build run must be successful');
 for(const change of [x=>x.recovery.originalConclusion='success',x=>x.recovery.tests++,x=>x.verificationController='e'.repeat(40),x=>x.recovery.memoryFloor.proven=false,x=>x.recovery.memoryFloor.error='other',
  x=>x.recovery.originalRunId=x.recovery.runId,x=>x.recovery.units[0].kind='focused-recovery',x=>x.recovery.history.executions=[],x=>x.recovery.recoveryPolicy='aihr-build-capacity-recovery/v0',x=>x.recovery.releaseAuthorized=true]){
  const bad=structuredClone(e);change(bad);bad.fingerprint=hash(bad.recovery);assert.throws(()=>createInstallGrant({...g,evidence:bad,run,producer}));
 }
 const unsigned=structuredClone(e);unsigned.recovery.tests++;assert.throws(()=>validateBuildRecoveryGrantEvidence(unsigned,run),/certificate/);
});
test('Operator options are exactly the replacement build run and candidate branch',()=>{
 assert.deepEqual(buildRecoveryOptions({buildRunId:5,candidateBranch:BRANCH}),{buildRunId:5,candidateBranch:BRANCH});
 for(const bad of [null,[],{buildRunId:5},{buildRunId:'5',candidateBranch:BRANCH},{buildRunId:0,candidateBranch:BRANCH},{buildRunId:5,candidateBranch:BRANCH,focusedRunIds:[1]}])assert.throws(()=>buildRecoveryOptions(bad));
});
test('The original failure diagnostic namespace is extracted exactly and nothing else',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-build-failure-extract-')),extractor=fileURLToPath(new URL('./build-failure-extract.py',import.meta.url));
 const zip=(name,entries)=>{const path=join(root,name+'.zip');writeFileSync(path,execFileSync('python3',['-c','import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,v)) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:JSON.stringify(entries)}));return path;};
 const good={'comparison.json':'{}','canonical-build.log':buildLog(),'application-typegen.log':typegenLog};
 try{
  execFileSync('python3',[extractor,zip('good',good),join(root,'good')],{stdio:'pipe'});assert.deepEqual(readdirSync(join(root,'good')).sort(),['application-typegen.log','canonical-build.log','comparison.json']);
  for(const [name,entries] of [['missing',{'comparison.json':'{}','canonical-build.log':'x'}],['extra',{...good,'other.log':'x'}],['nested',{'comparison.json':'{}','canonical-build.log':'x','sub/application-typegen.log':'x'}],['renamed',{'comparison.json':'{}','canonical-build.log':'x','application-typegen.txt':'x'}]])
   assert.throws(()=>execFileSync('python3',[extractor,zip(name,entries),join(root,name)],{stdio:'pipe'}),name);
 }finally{rmSync(root,{recursive:true,force:true});}
});
