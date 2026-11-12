/** Pure hostile metadata controls only. No API, build, DB, process or deployment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCiTransportInvocation,validateCiTransportRefs,validateCiTransportConsumerRun,validateCiTransportMetadata as metadataAtTime,validateCiTransportProvenance as provenanceWithJob,CI_TRANSPORT_WORKFLOW} from './ci-build-transport-policy.mjs';
import {STAGING_BUILD_RUNTIME,BUILD_CAPACITY_PROFILE} from './build-production.mjs';
const now=Date.parse('2026-10-31T00:04:00Z');
const validateCiTransportMetadata=(value,e,options={})=>metadataAtTime(value,e,{now,...options});
const source='a'.repeat(40),origin='b'.repeat(40),control='c'.repeat(40),digest='d'.repeat(64);
const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',ImageOS:'ubuntu24',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'build-consumer',GITHUB_RUN_ID:'999',GITHUB_SHA:control,GITHUB_WORKFLOW_SHA:control,GITHUB_REF_NAME:'codex/consumer-frozen',GITHUB_REF:'refs/heads/codex/consumer-frozen',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/'+CI_TRANSPORT_WORKFLOW+'@refs/heads/codex/consumer-frozen',RUNNER_NAME:'consumer fixture',AIHR_CI_BUILD_TRANSPORT:'consumer',AIHR_CI_HEAD:source,AIHR_CI_CONTROL_HEAD:control,AIHR_BUILD_PRODUCER_CONTROL_HEAD:origin,AIHR_BUILD_SOURCE_BRANCH:'codex/source-frozen',AIHR_BUILD_PRODUCER_BRANCH:'codex/producer-frozen',AIHR_BUILD_PRODUCER_RUN_ID:'123',AIHR_BUILD_ARTIFACT_ID:'456',AIHR_BUILD_ARTIFACT_DIGEST:digest,...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
const repository={id:1333414856,full_name:'StradaverseHub/ai-hr'};
const run={id:123,workflow_id:395777276,run_attempt:1,event:'workflow_dispatch',head_sha:origin,path:'.github/workflows/alpha-staging.yml',head_branch:'codex/producer-frozen',repository,head_repository:repository,run_started_at:'2026-10-31T00:00:00Z'};
const job={id:124365556166,runner_id:100000001,runner_name:'producer fixture',head_branch:'codex/producer-frozen',name:'build',run_id:123,run_attempt:1,head_sha:origin,status:'completed',conclusion:'success',started_at:'2026-10-31T00:00:05Z',completed_at:'2026-10-31T00:03:00Z'};
const artifact={id:456,name:'production-build-v1',expired:false,workflow_run:{id:123,head_sha:origin,repository_id:1333414856,head_repository_id:1333414856,head_branch:'codex/producer-frozen'},created_at:'2026-10-31T00:02:59Z',expires_at:'2026-11-02T00:02:58Z',digest:'sha256:'+digest,size_in_bytes:1234};
const metadata={run,jobs:[job],artifact,artifacts:[artifact]};
const validateCiTransportProvenance=(value,e,runtime,localRunner,actualProducerJob=job,actualProducerRun=run)=>provenanceWithJob(value,e,runtime,localRunner,actualProducerJob,actualProducerRun);
const ref=(name,sha)=>({ref:'refs/heads/'+name,object:{type:'commit',sha}});
const refs={source:ref(env.AIHR_BUILD_SOURCE_BRANCH,source),producer:ref(env.AIHR_BUILD_PRODUCER_BRANCH,origin),consumer:ref(env.GITHUB_REF_NAME,control)};
const consumerRun={id:999,run_attempt:1,event:'workflow_dispatch',head_sha:control,path:CI_TRANSPORT_WORKFLOW,head_branch:env.GITHUB_REF_NAME,repository,head_repository:repository};
const producerRunner={name:'producer fixture',sourcePath:'/producer/source',bootSha256:'e'.repeat(64)},consumer={name:env.RUNNER_NAME,sourcePath:'/consumer/recipient',bootSha256:'f'.repeat(64)};
const p={format:2,capacityProfile:{...BUILD_CAPACITY_PROFILE},kind:'ci-system-testing-build-candidate',releaseAuthorized:false,source,controller:origin,runId:123,runAttempt:1,repository:repository.full_name,repositoryId:repository.id,workflowRef:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/codex/producer-frozen',runtime:{...STAGING_BUILD_RUNTIME},buildRecordId:'00000000-0000-4000-8000-000000000001',nextBuildId:'fixture',archiveBytes:123,producerRunner,producerEvent:'workflow_dispatch',producerRef:'refs/heads/codex/producer-frozen',buildSourcePath:producerRunner.sourcePath,...Object.fromEntries(['lockSha256','packageSha256','preparedSha256','successfulObservationSha256','manifestSha256','archiveSha256'].map(k=>[k,digest]))};
test('explicit owned CI consumer supports distinct actual source, original controller and current controller',()=>{
 assert.equal(assertCiTransportInvocation(env),true);assert.equal(validateCiTransportRefs(refs,env),true);
 assert.equal(validateCiTransportConsumerRun(consumerRun,env),true);assert.equal(validateCiTransportMetadata(metadata,env),job);
 assert.equal(validateCiTransportProvenance(p,env,{...STAGING_BUILD_RUNTIME},consumer),true);
 assert.equal(p.releaseAuthorized,false);assert.notEqual(source,origin);assert.notEqual(origin,control);
});
test('foreign workflow, runner, ref, retry, spoofed controller and diagnostic invocation refuse',()=>{
 for(const [key,value]of Object.entries({AIHR_CI_BUILD_TRANSPORT:'diagnostic',GITHUB_ACTIONS:'false',CI:'false',RUNNER_ENVIRONMENT:'self-hosted',RUNNER_OS:'macOS',RUNNER_ARCH:'ARM64',ImageOS:'ubuntu22',GITHUB_REPOSITORY_ID:'1',GITHUB_EVENT_NAME:'push',GITHUB_RUN_ATTEMPT:'2',GITHUB_JOB:'test',GITHUB_SHA:source,GITHUB_WORKFLOW_SHA:source,AIHR_CI_HEAD:'bad',AIHR_BUILD_PRODUCER_CONTROL_HEAD:'bad',GITHUB_REF:'refs/heads/alpha',GITHUB_WORKFLOW_REF:env.GITHUB_WORKFLOW_REF.replace(CI_TRANSPORT_WORKFLOW,'.github/workflows/alpha-staging.yml'),GITHUB_RUN_ID:'9007199254740992',AIHR_BUILD_PRODUCER_RUN_ID:'999',AIHR_BUILD_ARTIFACT_ID:'0',AIHR_BUILD_ARTIFACT_DIGEST:'sha256:'+digest,AIHR_BUILD_DIAGNOSTIC:'transport-consumer-repair',RUNNER_NAME:''}))assert.throws(()=>assertCiTransportInvocation({...env,[key]:value}),undefined,key);
 for(const key of ['AIHR_BUILD_SOURCE_BRANCH','AIHR_BUILD_PRODUCER_BRANCH'])for(const value of [...(key==='AIHR_BUILD_SOURCE_BRANCH'?['main','alpha']:[]),'codex/../bad','codex/a//b','codex/','codex/a\nb'])assert.throws(()=>assertCiTransportInvocation({...env,[key]:value}));
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])for(const value of [undefined,'postgres://actual'])assert.throws(()=>assertCiTransportInvocation({...env,[key]:value}));
});
test('all three API refs must still identify the frozen commits without following a moved branch',()=>{
 for(const key of ['source','producer','consumer'])for(const replacement of [undefined,{...refs[key],ref:'refs/heads/main'},{...refs[key],object:{type:'tag',sha:refs[key].object.sha}},{...refs[key],object:{type:'commit',sha:'0'.repeat(40)}}])assert.throws(()=>validateCiTransportRefs({...refs,[key]:replacement},env));
});
test('consumer API identity must bind its actual workflow and head repository',()=>{
 for(const [key,value]of Object.entries({id:123,run_attempt:2,event:'push',head_sha:origin,path:'.github/workflows/alpha-staging.yml',head_branch:'alpha',repository:{...repository,id:1},head_repository:{...repository,full_name:'fork/ai-hr'}}))assert.throws(()=>validateCiTransportConsumerRun({...consumerRun,[key]:value},env));
});
test('CI producer metadata refuses old diagnostics, wrong workflow ID, source substitution and foreign repository',()=>{
 for(const [key,value]of Object.entries({id:999,workflow_id:1,run_attempt:2,event:'push',head_sha:source,path:'.github/workflows/alpha-staging-diagnostics.yml',head_branch:'alpha',repository:{...repository,id:1},head_repository:{...repository,full_name:'fork/ai-hr'},run_started_at:'invalid'}))assert.throws(()=>validateCiTransportMetadata({...metadata,run:{...run,[key]:value}},env));
 for(const jobs of [[],[job,job],[{...job,name:'build-transport-producer'}],[{...job,conclusion:'failure'}],[{...job,status:'in_progress'}],[{...job,run_attempt:2}],[{...job,head_sha:source}],[{...job,run_id:999}],[{...job,started_at:'2026-10-30T23:59:00Z'}],[{...job,completed_at:'2026-10-31T00:00:01Z'}]])assert.throws(()=>validateCiTransportMetadata({...metadata,jobs},env));
});
test('artifact selector, complete unique inventory, API digest and actual ZIP cap remain independent',()=>{
 for(const [key,value]of Object.entries({id:457,name:'diagnostic-build-transport-producer',expired:true,workflow_run:{id:999,head_sha:origin},digest:'sha256:'+'e'.repeat(64),size_in_bytes:BUILD_CAPACITY_PROFILE.zipMaxBytes+1}))assert.throws(()=>validateCiTransportMetadata({...metadata,artifact:{...artifact,[key]:value},artifacts:[{...artifact,[key]:value}]},env));
 for(const artifacts of [[],[artifact,artifact],[{...artifact,id:457}],Array(100).fill(artifact)])assert.throws(()=>validateCiTransportMetadata({...metadata,artifacts},env));
 const boundary={...artifact,size_in_bytes:BUILD_CAPACITY_PROFILE.zipMaxBytes};assert.equal(validateCiTransportMetadata({...metadata,artifact:boundary,artifacts:[boundary]},env),job);
});
test('current CI provenance cannot relabel diagnostics, incomplete old packets, different source or old capacity',()=>{
 for(const [key,value]of Object.entries({kind:'diagnostic-system-testing-build-not-release',releaseAuthorized:true,source:origin,controller:control,runId:999,runAttempt:2,workflowRef:env.GITHUB_WORKFLOW_REF,runtime:{...STAGING_BUILD_RUNTIME,node:'20.20.2'},buildRecordId:'not-uuid',nextBuildId:'../bad',archiveBytes:BUILD_CAPACITY_PROFILE.archiveMaxBytes+1,preparedSha256:'bad',producerEvent:'push',producerRef:'refs/heads/alpha',producerRunner:undefined,diagnosticRunner:producerRunner,diagnosticDurations:{},buildSourcePath:'/another/path',capacityProfile:{...BUILD_CAPACITY_PROFILE,profileVersion:1}}))assert.throws(()=>validateCiTransportProvenance({...p,[key]:value},env,{...STAGING_BUILD_RUNTIME},consumer),undefined,key);
});
test('actual different VM name, boot and source path are each mandatory; unsafe origin paths refuse',()=>{
 for(const changed of [{...producerRunner,name:consumer.name},{...producerRunner,bootSha256:consumer.bootSha256},{...producerRunner,sourcePath:consumer.sourcePath},{...producerRunner,sourcePath:'/a/../b'},{...producerRunner,sourcePath:'/a\nb'},{...producerRunner,bootSha256:'bad'},{...producerRunner,extra:true}])assert.throws(()=>validateCiTransportProvenance({...p,producerRunner:changed,buildSourcePath:changed.sourcePath},env,{...STAGING_BUILD_RUNTIME},consumer));
 assert.throws(()=>validateCiTransportProvenance(p,env,{...STAGING_BUILD_RUNTIME},{...consumer,name:'substituted'}));
 assert.throws(()=>validateCiTransportProvenance(p,{...env,NEXT_PUBLIC_UNREVIEWED:'compile override'},{...STAGING_BUILD_RUNTIME},consumer));
});


test('actual final alpha-push producer is separately admitted without relabelling its event or weakening source equality',()=>{
 const pushEnv={...env,AIHR_CI_HEAD:origin,AIHR_BUILD_PRODUCER_BRANCH:'alpha'};
 const pushRun={...run,event:'push',head_branch:'alpha'};
 const pushJob={...job,head_branch:'alpha'};
 const pushArtifact={...artifact,workflow_run:{...artifact.workflow_run,head_branch:'alpha'}};
 const pushMetadata={...metadata,run:pushRun,jobs:[pushJob],artifact:pushArtifact,artifacts:[pushArtifact]};
 const pushProvenance={...p,source:origin,producerEvent:'push',producerRef:'refs/heads/alpha',workflowRef:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/alpha'};
 assert.equal(assertCiTransportInvocation(pushEnv),true);
 assert.equal(validateCiTransportMetadata(pushMetadata,pushEnv),pushJob);
 assert.equal(validateCiTransportProvenance(pushProvenance,pushEnv,{...STAGING_BUILD_RUNTIME},consumer,pushJob,pushRun),true);
 assert.equal(validateCiTransportRefs({...refs,source:ref(pushEnv.AIHR_BUILD_SOURCE_BRANCH,origin),producer:ref('alpha',origin)},pushEnv),true);
 for(const changed of [{...pushRun,event:'workflow_dispatch'},{...pushRun,event:'pull_request'},{...pushRun,head_branch:'main'},{...pushRun,head_sha:source}])assert.throws(()=>validateCiTransportMetadata({...pushMetadata,run:changed},pushEnv));
 for(const changes of [{AIHR_CI_HEAD:source},{AIHR_BUILD_PRODUCER_CONTROL_HEAD:control},{AIHR_BUILD_PRODUCER_BRANCH:'main'},{AIHR_BUILD_PRODUCER_BRANCH:'codex/producer-frozen'}])assert.throws(()=>validateCiTransportMetadata(pushMetadata,{...pushEnv,...changes}));
 for(const changes of [{source},{producerEvent:'workflow_dispatch'},{producerRef:'refs/heads/main'},{workflowRef:p.workflowRef},{controller:control}])assert.throws(()=>validateCiTransportProvenance({...pushProvenance,...changes},pushEnv,{...STAGING_BUILD_RUNTIME},consumer,pushJob,pushRun));
 assert.throws(()=>validateCiTransportMetadata({...metadata,run:{...run,event:'push'}},env),undefined,'Owned codex branch cannot impersonate the alpha push path');
});


test('both producer events require actual job ID/branch and complete artifact origin/timing',()=>{
 const pushEnv={...env,AIHR_CI_HEAD:origin,AIHR_BUILD_PRODUCER_BRANCH:'alpha'};
 const pushJob={...job,head_branch:'alpha'};
 const pushArtifact={...artifact,workflow_run:{...artifact.workflow_run,head_branch:'alpha'}};
 const pushMetadata={...metadata,run:{...run,event:'push',head_branch:'alpha'},jobs:[pushJob],artifact:pushArtifact,artifacts:[pushArtifact]};
 for(const [current,e]of [[metadata,env],[pushMetadata,pushEnv]]){
  const actualJob=current.jobs[0],actualArtifact=current.artifact;
  for(const runner_name of [undefined,'','x'.repeat(201),'line\nbreak'])assert.throws(()=>validateCiTransportMetadata({...current,jobs:[{...actualJob,runner_name}]},e));
  assert.equal(validateCiTransportMetadata(current,e),actualJob);
  for(const id of [undefined,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'124365556166'])assert.throws(()=>validateCiTransportMetadata({...current,jobs:[{...actualJob,id}]},e));
  const wrongBranch=e.AIHR_BUILD_PRODUCER_BRANCH==='alpha'?'codex/foreign':'alpha';
  for(const head_branch of [undefined,wrongBranch,'main'])assert.throws(()=>validateCiTransportMetadata({...current,jobs:[{...actualJob,head_branch}]},e));
  for(const change of [{repository_id:undefined},{repository_id:1},{head_repository_id:undefined},{head_repository_id:1},{head_branch:undefined},{head_branch:wrongBranch}]){
   const value={...actualArtifact,workflow_run:{...actualArtifact.workflow_run,...change}};
   assert.throws(()=>validateCiTransportMetadata({...current,artifact:value,artifacts:[value]},e));
  }
  for(const change of [{created_at:undefined},{created_at:'invalid'},{created_at:'2026-10-31T00:00:04Z'},{created_at:'2026-10-31T00:03:01Z'},{expires_at:undefined},{expires_at:'invalid'},{expires_at:'2026-10-31T00:02:58Z'},{expires_at:'2026-10-31T00:04:00Z'}]){
   const value={...actualArtifact,...change};assert.throws(()=>validateCiTransportMetadata({...current,artifact:value,artifacts:[value]},e));
  }
  for(const observedNow of [NaN,Infinity,0,-1,1.5,8640000000000001])assert.throws(()=>validateCiTransportMetadata(current,e,{now:observedNow}));
  assert.throws(()=>validateCiTransportMetadata(current,e,{now:Date.parse('2026-10-31T00:02:59Z')}),undefined,'Completed build job cannot be in the future');
  // An old immutable packet is allowed while actually unexpired; no arbitrary 24-hour policy.
  assert.equal(validateCiTransportMetadata(current,e,{now:Date.parse('2026-11-01T01:00:00Z')}),actualJob);
  for(const created_at of [actualJob.started_at,actualJob.completed_at]){
   const value={...actualArtifact,created_at};assert.equal(validateCiTransportMetadata({...current,artifact:value,artifacts:[value]},e),actualJob);
  }
 }
});


test('packet producer runner name must equal the authenticated successful build job runner name',()=>{
 assert.equal(validateCiTransportProvenance(p,env,{...STAGING_BUILD_RUNTIME},consumer,job),true);
 const forged={...p,producerRunner:{...producerRunner,name:'another purported producer'}};
 assert.throws(()=>validateCiTransportProvenance(forged,env,{...STAGING_BUILD_RUNTIME},consumer,job));
 for(const actualProducerJob of [null,{}, {...job,runner_name:undefined},{...job,runner_name:'another actual runner'}])
  assert.throws(()=>validateCiTransportProvenance(p,env,{...STAGING_BUILD_RUNTIME},consumer,actualProducerJob));
});

function publishedFixture(head_branch='alpha'){
 const e={...env,AIHR_BUILD_PRODUCER_BRANCH:head_branch};
 const actualRun={...run,head_branch,status:'completed',conclusion:'success',
  display_title:'Canonical build only · '+env.AIHR_BUILD_SOURCE_BRANCH,
  created_at:'2026-10-31T00:00:00Z',updated_at:'2026-10-31T00:03:15Z'};
 const names=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'];
 const jobs=names.map((name,index)=>({...job,id:job.id+index,name,head_branch,
  conclusion:['resolve','build','deployment-hold'].includes(name)?'success':'skipped',
  started_at:name==='resolve'?'2026-10-31T00:00:01Z':name==='deployment-hold'?'2026-10-31T00:03:01Z':job.started_at,
  completed_at:name==='resolve'?'2026-10-31T00:00:04Z':name==='deployment-hold'?'2026-10-31T00:03:10Z':job.completed_at}));
 const actualArtifact={...artifact,workflow_run:{...artifact.workflow_run,head_branch}};
 const value={run:actualRun,jobs,artifact:actualArtifact,artifacts:[actualArtifact]};
 const packet={...p,producerEvent:'workflow_dispatch',producerRef:'refs/heads/'+head_branch,
  workflowRef:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/'+head_branch};
 return {e,value,packet,actualRun,actualJob:jobs.find(j=>j.name==='build')};
}
test('published main and alpha canonical build-only dispatches preserve actual dispatch provenance and distinct repaired source',()=>{
 for(const branch of ['main','alpha']){
  const f=publishedFixture(branch);
  assert.equal(assertCiTransportInvocation(f.e),true);
  assert.equal(validateCiTransportRefs({...refs,producer:ref(branch,origin)},f.e),true);
  assert.equal(validateCiTransportMetadata(f.value,f.e),f.actualJob);
  assert.equal(validateCiTransportProvenance(f.packet,f.e,{...STAGING_BUILD_RUNTIME},consumer,f.actualJob,f.actualRun),true);
  assert.notEqual(f.packet.source,f.packet.controller);assert.equal(f.packet.producerEvent,'workflow_dispatch');
 }
});
test('published dispatch refuses incomplete, noncanonical, failed, repeated or future run/job topology',()=>{
 for(const branch of ['main','alpha']){
  const f=publishedFixture(branch);
  for(const [key,value]of Object.entries({status:'in_progress',conclusion:'failure',run_attempt:2,event:'pull_request',
   display_title:'Alpha CI · '+branch,created_at:'invalid',updated_at:'invalid',run_started_at:'2026-10-31T00:03:16Z'}))
   assert.throws(()=>validateCiTransportMetadata({...f.value,run:{...f.actualRun,[key]:value}},f.e),undefined,key);
  for(const updated_at of ['2026-10-31T00:02:59Z','2026-10-31T00:04:01Z'])
   assert.throws(()=>validateCiTransportMetadata({...f.value,run:{...f.actualRun,updated_at}},f.e));
  for(const jobs of [f.value.jobs.slice(1),[...f.value.jobs,f.value.jobs[0]],
   f.value.jobs.map(j=>j.name==='typecheck'?{...j,conclusion:'success'}:j),
   f.value.jobs.map(j=>j.name==='resolve'?{...j,conclusion:'skipped'}:j),
   f.value.jobs.map(j=>j.name==='verify'?{...j,name:'foreign'}:j),
   f.value.jobs.map(j=>j.name==='verify'?{...j,id:f.value.jobs[0].id}:j)])
   assert.throws(()=>validateCiTransportMetadata({...f.value,jobs},f.e));
  for(const change of [{id:0},{run_id:999},{run_attempt:2},{head_sha:source},{head_branch:'codex/foreign'},
   {status:'in_progress'},{conclusion:'failure'},{started_at:'invalid'},{completed_at:'invalid'},
   {started_at:'2026-10-30T23:59:59Z'},{completed_at:'2026-10-31T00:03:16Z'}])
   assert.throws(()=>validateCiTransportMetadata({...f.value,jobs:f.value.jobs.map(j=>j.name==='resolve'?{...j,...change}:j)},f.e));
 }
});
test('published lane cannot bypass artifact, runner, runtime, immutable refs or closed source and consumer branches',()=>{
 const f=publishedFixture();
 for(const change of [{digest:'sha256:'+'e'.repeat(64)},{expired:true},{created_at:'2026-10-31T00:03:01Z'},
  {workflow_run:{...f.value.artifact.workflow_run,head_sha:source}},{size_in_bytes:BUILD_CAPACITY_PROFILE.zipMaxBytes+1}]){
  const altered={...f.value.artifact,...change};assert.throws(()=>validateCiTransportMetadata({...f.value,artifact:altered,artifacts:[altered]},f.e));
 }
 assert.throws(()=>validateCiTransportProvenance({...f.packet,producerRunner:{...producerRunner,name:'forged'}},f.e,{...STAGING_BUILD_RUNTIME},consumer,f.actualJob,f.actualRun));
 assert.throws(()=>validateCiTransportProvenance(f.packet,f.e,{...STAGING_BUILD_RUNTIME,node:'20.20.2'},consumer,f.actualJob,f.actualRun));
 assert.throws(()=>validateCiTransportRefs({...refs,producer:ref('alpha',source)},f.e));
 for(const branch of ['main','alpha']){
  assert.throws(()=>assertCiTransportInvocation({...f.e,AIHR_BUILD_SOURCE_BRANCH:branch}));
  assert.throws(()=>assertCiTransportInvocation({...f.e,GITHUB_REF_NAME:branch,GITHUB_REF:'refs/heads/'+branch,
   GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/'+CI_TRANSPORT_WORKFLOW+'@refs/heads/'+branch}));
 }
});
test('provenance requires actual authenticated producer event and ref without branch-name inference or fallback',()=>{
 for(const branch of ['main','alpha']){
  const f=publishedFixture(branch);
  for(const change of [{producerEvent:'push'},{producerEvent:undefined},{producerRef:'refs/heads/codex/foreign'}])
   assert.throws(()=>validateCiTransportProvenance({...f.packet,...change},f.e,{...STAGING_BUILD_RUNTIME},consumer,f.actualJob,f.actualRun));
  for(const actualRun of [undefined,null,{}, {...f.actualRun,id:999},{...f.actualRun,event:'schedule'},
   {...f.actualRun,event:'push'},{...f.actualRun,head_branch:'codex/foreign'},{...f.actualRun,head_sha:source}])
   assert.throws(()=>provenanceWithJob(f.packet,f.e,{...STAGING_BUILD_RUNTIME},consumer,f.actualJob,actualRun));
 }
});
