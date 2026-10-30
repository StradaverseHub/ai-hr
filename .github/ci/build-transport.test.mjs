import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTransportMetadata,validateTransportProvenance,compareCjkRasters,assertTransportConsumerInvocation} from './build-transport.mjs';
import {STAGING_BUILD_RUNTIME,BUILD_CAPACITY_PROFILE} from './build-production.mjs';
const sha='a'.repeat(40),digest='b'.repeat(64);
const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_HEAD:sha,AIHR_CI_CONTROL_HEAD:sha,GITHUB_SHA:sha,AIHR_BUILD_DIAGNOSTIC:'transport-producer',RUNNER_NAME:'consumer',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025',AIHR_BUILD_ARTIFACT_ID:'456',AIHR_BUILD_ARTIFACT_DIGEST:digest};
const run={id:123,run_attempt:1,event:'workflow_dispatch',head_sha:sha,path:'.github/workflows/alpha-staging-diagnostics.yml',head_branch:'codex/test-suite-efficiency-review-20261025',repository:{id:1333414856,full_name:'StradaverseHub/ai-hr'}};
const job={name:'build-transport-producer',run_id:123,run_attempt:1,head_sha:sha,status:'completed',conclusion:'success',started_at:'2026-10-26T00:00:00Z',completed_at:'2026-10-26T00:03:00Z'};
const artifact={id:456,name:'diagnostic-build-transport-producer',expired:false,workflow_run:{id:123,head_sha:sha},digest:'sha256:'+digest,size_in_bytes:1234};
test('actual run/attempt/source/controller/job/artifact binding refuses mismatched metadata',()=>{
 assert.equal(validateTransportMetadata({run,jobs:[job],artifact},env),job);
 for(const [key,value]of Object.entries({id:2,run_attempt:2,event:'push',head_sha:'c'.repeat(40),path:'other.yml',head_branch:'alpha',repository:{id:1,full_name:'other/repo'}}))assert.throws(()=>validateTransportMetadata({run:{...run,[key]:value},jobs:[job],artifact},env));
 for(const jobs of [[],[job,job],[{...job,conclusion:'failure'}],[{...job,run_attempt:2}],[{...job,status:'in_progress'}]])assert.throws(()=>validateTransportMetadata({run,jobs,artifact},env));
 for(const [key,value]of Object.entries({id:9,name:'other',expired:true,digest:'sha256:'+'c'.repeat(64),size_in_bytes:281*1024**2,workflow_run:{id:9,head_sha:sha}}))assert.throws(()=>validateTransportMetadata({run,jobs:[job],artifact:{...artifact,[key]:value}},env));
});
const p={format:2,capacityProfile:{...BUILD_CAPACITY_PROFILE},archiveBytes:123,kind:'diagnostic-system-testing-build-not-release',releaseAuthorized:false,source:sha,controller:sha,repository:'StradaverseHub/ai-hr',repositoryId:1333414856,runId:123,runAttempt:1,workflowRef:env.GITHUB_WORKFLOW_REF,runtime:{...STAGING_BUILD_RUNTIME},buildRecordId:'00000000-0000-4000-8000-000000000001',nextBuildId:'fixture',diagnosticRunner:{name:'producer',sourcePath:'/producer/source',bootSha256:'c'.repeat(64)},...Object.fromEntries(['lockSha256','packageSha256','preparedSha256','successfulObservationSha256','manifestSha256','archiveSha256'].map(k=>[k,digest]))};
const consumer={name:'consumer',sourcePath:'/consumer/recipient',bootSha256:'d'.repeat(64)};
test('fresh VM and exact runtime/provenance are mandatory; diagnostic cannot grant release',()=>{
 assert.equal(validateTransportProvenance(p,env,{...STAGING_BUILD_RUNTIME},consumer),true);
 for(const [key,value]of Object.entries({kind:'ci-system-testing-build-candidate',releaseAuthorized:true,source:'c'.repeat(40),controller:'c'.repeat(40),runAttempt:2,runId:9,preparedSha256:'bad',diagnosticRunner:{...p.diagnosticRunner,name:consumer.name}}))assert.throws(()=>validateTransportProvenance({...p,[key]:value},env,{...STAGING_BUILD_RUNTIME},consumer));
 assert.throws(()=>validateTransportProvenance(p,env,{...STAGING_BUILD_RUNTIME,node:'22.0.0'},consumer));
 assert.throws(()=>validateTransportProvenance(p,env,{...STAGING_BUILD_RUNTIME},{...consumer,bootSha256:p.diagnosticRunner.bootSha256}));
});

test('Chinese raster comparison refuses blank, substituted or differently sized glyph output',()=>{
 const raster={info:{width:50,height:50,channels:3},data:Buffer.alloc(7500,255)};
 raster.data.fill(0,0,1500);assert.equal(compareCjkRasters(raster,raster).inkChannels,1500);
 const white={...raster,data:Buffer.alloc(7500,255)};assert.throws(()=>compareCjkRasters(white,white));
 assert.throws(()=>compareCjkRasters(raster,white));
 assert.throws(()=>compareCjkRasters(raster,{...raster,info:{...raster.info,width:51}}));
});

test('different VM with unchanged source path is not relocation proof',()=>{
 assert.throws(()=>validateTransportProvenance(p,env,{...STAGING_BUILD_RUNTIME},{...consumer,sourcePath:p.diagnosticRunner.sourcePath}));
 assert.throws(()=>validateTransportProvenance({...p,diagnosticRunner:{...p.diagnosticRunner,sourcePath:undefined}},env,{...STAGING_BUILD_RUNTIME},consumer));
});

test('actual first failed consumer metadata now binds raw upload hex to canonical API digest',()=>{
 const f=JSON.parse(readFileSync(new URL('./fixtures/build-transport-metadata-original.json',import.meta.url)));
 const actualEnv={...env,GITHUB_RUN_ID:String(f.run.id),AIHR_CI_HEAD:f.run.head_sha,AIHR_CI_CONTROL_HEAD:f.run.head_sha,GITHUB_SHA:f.run.head_sha,AIHR_BUILD_ARTIFACT_ID:String(f.artifact.id),AIHR_BUILD_ARTIFACT_DIGEST:f.uploadActionDigest};
 assert.equal(validateTransportMetadata(f,actualEnv),f.jobs[0]);
 for(const value of ['sha256:'+f.uploadActionDigest,'c'.repeat(64),'',f.uploadActionDigest.toUpperCase()])assert.throws(()=>validateTransportMetadata(f,{...actualEnv,AIHR_BUILD_ARTIFACT_DIGEST:value}));
});
test('consumer-only repair binds retained origin separately from actual current controller and run',()=>{
 const repair={...env,GITHUB_RUN_ID:'999',GITHUB_SHA:'e'.repeat(40),AIHR_CI_CONTROL_HEAD:'e'.repeat(40),AIHR_BUILD_DIAGNOSTIC:'transport-consumer-repair',AIHR_BUILD_PRODUCER_RUN_ID:'123',AIHR_BUILD_PRODUCER_CONTROL_HEAD:sha};
 assert.equal(assertTransportConsumerInvocation(repair),true);
 assert.equal(validateTransportMetadata({run,jobs:[job],artifact},repair),job);
 assert.equal(validateTransportProvenance(p,repair,{...STAGING_BUILD_RUNTIME},consumer),true);
 for(const [key,value]of Object.entries({GITHUB_SHA:'f'.repeat(40),AIHR_BUILD_PRODUCER_RUN_ID:'999',AIHR_BUILD_PRODUCER_CONTROL_HEAD:'b'.repeat(40),GITHUB_RUN_ATTEMPT:'2',GITHUB_REPOSITORY:'other/repo',AIHR_CI_HEAD:'bad'}))assert.throws(()=>assertTransportConsumerInvocation({...repair,[key]:value}));
 assert.throws(()=>validateTransportProvenance({...p,runId:999},repair,{...STAGING_BUILD_RUNTIME},consumer));
 assert.throws(()=>validateTransportProvenance({...p,controller:repair.AIHR_CI_CONTROL_HEAD},repair,{...STAGING_BUILD_RUNTIME},consumer));
});


test('diagnostic transport keeps the unchanged outer ZIP bound and strict current capacity identity',()=>{
 assert.equal(validateTransportMetadata({run,jobs:[job],artifact:{...artifact,size_in_bytes:293601280}},env),job);
 assert.throws(()=>validateTransportMetadata({run,jobs:[job],artifact:{...artifact,size_in_bytes:293601281}},env));
 for(const changed of [{...p,format:1},{...p,capacityProfile:undefined},{...p,capacityProfile:{...BUILD_CAPACITY_PROFILE,profileVersion:1}},
  {...p,capacityProfile:{...BUILD_CAPACITY_PROFILE,archiveMaxBytes:268435456}},{...p,capacityProfile:{...BUILD_CAPACITY_PROFILE,zipMaxBytes:293601281}},
  {...p,capacityProfile:{...BUILD_CAPACITY_PROFILE,extra:true}},{...p,archiveBytes:276824065}])
  assert.throws(()=>validateTransportProvenance(changed,env,{...STAGING_BUILD_RUNTIME},consumer));
});
