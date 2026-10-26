/** Pure managed cache/authority/refusal probes. No application compiler/build/DB or SDK deletion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {NEXT_APPLICATION_STATE,NEXT_APPLICATION_SEED,NEXT_APPLICATION_CODE,assertManagedNextInvocation,validateManagedNextOrigin,verifyNextPublisherTree,inspectNextStatePacket} from './next-application-cache-protocol.mjs';
import {capacityDecision,validateCapacityScope,compilerSwapFloorKiB} from './runner-capacity.mjs';
import {applicationStateFixture} from './next-application-test-fixtures.mjs';
import {buildUnits,requiredEvidence} from './manifest.mjs';
import {validateArtifacts} from './release-policy.mjs';
const source='a'.repeat(40),controller='c'.repeat(40);
const e={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',
 GITHUB_SHA:controller,AIHR_CI_HEAD:source,AIHR_CI_CONTROL_HEAD:controller,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'build',GITHUB_EVENT_NAME:'workflow_dispatch',
 GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/main',AIHR_CI_CAPACITY_PROFILE:'bounded-canonical-build',NODE_OPTIONS:'--max-old-space-size=6144',
 ...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
test('normal managed build keeps closed URLs and first-attempt identity; ready same-repo PR consumes but never publishes',()=>{
 assert.deepEqual(assertManagedNextInvocation(e),{publish:true});
 const pr={pull_request:{draft:false,base:{ref:'alpha'},head:{repo:{full_name:'StradaverseHub/ai-hr'}}}};
 assert.deepEqual(assertManagedNextInvocation({...e,GITHUB_EVENT_NAME:'pull_request',GITHUB_WORKFLOW_REF:e.GITHUB_WORKFLOW_REF.replace('heads/main','pull/7/merge')},pr),{publish:false});
 for(const patch of [{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_JOB:'test'},{RUNNER_ENVIRONMENT:'self-hosted'},{AIHR_CI_CAPACITY_PROFILE:'legacy'},{NODE_OPTIONS:'--max-old-space-size=8192'},{DATABASE_URL:'postgres://live'},{GITHUB_REPOSITORY_ID:'1'}])
  assert.throws(()=>assertManagedNextInvocation({...e,...patch}));
 assert.throws(()=>assertManagedNextInvocation({...e,GITHUB_EVENT_NAME:'pull_request'},{}));
 assert.throws(()=>assertManagedNextInvocation({...e,GITHUB_EVENT_NAME:'pull_request'},{pull_request:{...pr.pull_request,draft:true}}));
});
function metadata(){
 const f=applicationStateFixture(),origin={kind:'normal',runId:123},run={id:123,head_sha:controller,head_branch:'main',run_attempt:1,event:'workflow_dispatch',path:'.github/workflows/alpha-staging.yml',repository:{full_name:'StradaverseHub/ai-hr',id:1333414856},head_repository:{id:1333414856}};
 const job={...f.job,name:'build',run_id:123,run_attempt:1,head_sha:controller,status:'completed',conclusion:'success'};
 const jobs={total_count:1,jobs:[job]},artifact={id:999,name:NEXT_APPLICATION_STATE,expired:false,size_in_bytes:100,digest:'sha256:'+'d'.repeat(64),created_at:f.job.completed_at,
 workflow_run:{id:123,head_sha:controller,repository_id:1333414856,head_repository_id:1333414856}};
 return {origin,run,job,jobs,artifact};
}
test('actual completed non-PR publisher job, full API inventory and fixed namespace are required',()=>{
 const f=metadata();assert.equal(validateManagedNextOrigin(f.origin,f.run,f.jobs,f.artifact),f.job);
 for(const patch of [{event:'pull_request'},{run_attempt:2},{path:'other.yml'},{repository:{full_name:'other/repo',id:1}}])
  assert.throws(()=>validateManagedNextOrigin(f.origin,{...f.run,...patch},f.jobs,f.artifact));
 for(const patch of [{name:'gate-evidence'},{expired:true},{size_in_bytes:64*1024**2+1},{created_at:'2020-01-01'},{workflow_run:{...f.artifact.workflow_run,head_sha:source}}])
  assert.throws(()=>validateManagedNextOrigin(f.origin,f.run,f.jobs,{...f.artifact,...patch}));
 assert.throws(()=>validateManagedNextOrigin(f.origin,f.run,{...f.jobs,total_count:2},f.artifact));
 assert.throws(()=>validateManagedNextOrigin(f.origin,f.run,{total_count:1,jobs:[{...f.job,conclusion:'failure'}]},f.artifact));
});
test('bootstrap cannot be retargeted to a different controller/run/artifact/state tuple',()=>{
 const f=metadata();
 for(const patch of [{runId:125},{controller:source},{artifactId:1000},{digest:'sha256:'+'e'.repeat(64)},{stateSha256:'f'.repeat(64)}])
  assert.throws(()=>validateManagedNextOrigin({...NEXT_APPLICATION_SEED,...patch},f.run,f.jobs,f.artifact),/immutable application seed/);
});
test('managed publishers bind actual complete controller Git blobs, not self-reported implementation names',()=>{
 const expected=Object.fromEntries(NEXT_APPLICATION_CODE.map(path=>[path,controller])),tree={truncated:false,tree:NEXT_APPLICATION_CODE.map(path=>({type:'blob',path,sha:controller}))};
 assert.equal(verifyNextPublisherTree(tree,expected),true);
 assert.throws(()=>verifyNextPublisherTree({...tree,truncated:true},expected));
 assert.throws(()=>verifyNextPublisherTree({...tree,tree:tree.tree.slice(1)},expected));
 assert.throws(()=>verifyNextPublisherTree({...tree,tree:[...tree.tree,tree.tree[0]]},expected));
 assert.throws(()=>verifyNextPublisherTree(tree,{...expected,[NEXT_APPLICATION_CODE[0]]:source}));
});
test('state packet binds actual canonical compiler log/exit/source/context/age/cleanup and never supplies PASS',()=>{
 const f=applicationStateFixture(),check=files=>inspectNextStatePacket({...f,files,currentContext:f.context});
 assert.equal(check(f.files).bytes.length,f.files.get('state.json').length);
 for(const [name,patch]of [
  ['producer.json',{exitCode:1}],['producer.json',{workingStateRemoved:false}],['producer.json',{cachePublishPermitted:false}],['producer.json',{kind:'RECOVERED_NEXT_APPLICATION_COMPILER_STATE_NOT_BUILD_OR_RELEASE'}],
  ['envelope.json',{completedCommand:'application-compiler-recovery'}],['envelope.json',{sha256:'f'.repeat(64)}],['envelope.json',{completedAt:'2020-01-01'}],
  ['build-provenance.json',{source:'f'.repeat(40)}],['successful-build.json',{nextBuildId:'other'}],['build-log.json',{text:'Skipping validation of types'}]
 ]){
  const files=new Map(f.files);files.set(name,Buffer.from(JSON.stringify({...JSON.parse(files.get(name)),...patch})));assert.throws(()=>check(files),undefined,name);
 }
 const files=new Map(f.files);files.set('state.json',Buffer.concat([files.get('state.json'),Buffer.from(' ')]));assert.throws(()=>check(files));
 assert.throws(()=>inspectNextStatePacket({...f,currentContext:{...f.context,nodeOptions:'--max-old-space-size=8192'}}));
 assert.throws(()=>inspectNextStatePacket({...f,now:f.now+86400000}));
});
test('normal build capacity uses measured12GiB setup headroom; it cannot lower compiler swap or admit tests',()=>{
 assert.equal(capacityDecision('bounded-canonical-build',12*1024**2-1).decision,'clean');
 assert.equal(capacityDecision('bounded-canonical-build',12*1024**2).decision,'enough');
 assert.equal(validateCapacityScope('bounded-canonical-build',e),true);
 for(const patch of [{GITHUB_JOB:'test'},{GITHUB_RUN_ATTEMPT:'2'},{DATABASE_URL:'postgres://live'}])assert.throws(()=>validateCapacityScope('bounded-canonical-build',{...e,...patch}));
 assert.throws(()=>compilerSwapFloorKiB('bounded-canonical-build',e));
 assert.equal(compilerSwapFloorKiB('legacy',{}),20*1024**2);
});
test('two supplemental graphs are allowed but cannot replace mandatory build or test evidence',()=>{
 const suite=['test/db.test.ts','test/plain.test.ts'],plan={suite,units:buildUnits(suite,{db:[suite[0]],nodb:[suite[1]]},['test/ui.browser.test.tsx'])};
 const p={runId:123,controller,controllerBranch:'main'},names=[...requiredEvidence(plan).artifacts,'whole-compiler-state-v1',NEXT_APPLICATION_STATE];
 const artifacts=names.map((name,n)=>({id:n+1,name,size_in_bytes:10,digest:'sha256:'+'a'.repeat(64),expired:false,workflow_run:{id:123,repository_id:1333414856,head_repository_id:1333414856,head_sha:controller,head_branch:'main'}}));
 assert.equal(validateArtifacts(artifacts,p,plan),true);
 assert.throws(()=>validateArtifacts(artifacts.filter(a=>a.name!=='production-build-v1'),p,plan));
 assert.throws(()=>validateArtifacts(artifacts.filter(a=>!a.name.startsWith('unit-db-')),p,plan));
 assert.throws(()=>validateArtifacts([...artifacts,{...artifacts.at(-1),id:999}],p,plan));
});
