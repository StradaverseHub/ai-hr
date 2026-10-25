import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTransportMetadata,validateTransportProvenance,compareCjkRasters} from './build-transport.mjs';
import {STAGING_BUILD_RUNTIME} from './build-production.mjs';
const sha='a'.repeat(40),digest='b'.repeat(64);
const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_HEAD:sha,AIHR_CI_CONTROL_HEAD:sha,GITHUB_SHA:sha,AIHR_BUILD_DIAGNOSTIC:'transport-producer',RUNNER_NAME:'consumer',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025',AIHR_BUILD_ARTIFACT_ID:'456',AIHR_BUILD_ARTIFACT_DIGEST:'sha256:'+digest};
const run={id:123,run_attempt:1,event:'workflow_dispatch',head_sha:sha,path:'.github/workflows/alpha-staging-diagnostics.yml',head_branch:'codex/test-suite-efficiency-review-20261025',repository:{id:1333414856,full_name:'StradaverseHub/ai-hr'}};
const job={name:'build-transport-producer',run_id:123,run_attempt:1,head_sha:sha,status:'completed',conclusion:'success',started_at:'2026-10-26T00:00:00Z',completed_at:'2026-10-26T00:03:00Z'};
const artifact={id:456,name:'diagnostic-build-transport-producer',expired:false,workflow_run:{id:123,head_sha:sha},digest:env.AIHR_BUILD_ARTIFACT_DIGEST,size_in_bytes:1234};
test('actual run/attempt/source/controller/job/artifact binding refuses mismatched metadata',()=>{
 assert.equal(validateTransportMetadata({run,jobs:[job],artifact},env),job);
 for(const [key,value]of Object.entries({id:2,run_attempt:2,event:'push',head_sha:'c'.repeat(40),path:'other.yml',head_branch:'alpha',repository:{id:1,full_name:'other/repo'}}))assert.throws(()=>validateTransportMetadata({run:{...run,[key]:value},jobs:[job],artifact},env));
 for(const jobs of [[],[job,job],[{...job,conclusion:'failure'}],[{...job,run_attempt:2}],[{...job,status:'in_progress'}]])assert.throws(()=>validateTransportMetadata({run,jobs,artifact},env));
 for(const [key,value]of Object.entries({id:9,name:'other',expired:true,digest:'sha256:'+'c'.repeat(64),size_in_bytes:281*1024**2,workflow_run:{id:9,head_sha:sha}}))assert.throws(()=>validateTransportMetadata({run,jobs:[job],artifact:{...artifact,[key]:value}},env));
});
const p={format:1,kind:'diagnostic-system-testing-build-not-release',releaseAuthorized:false,source:sha,controller:sha,repository:'StradaverseHub/ai-hr',repositoryId:1333414856,runId:123,runAttempt:1,workflowRef:env.GITHUB_WORKFLOW_REF,runtime:{...STAGING_BUILD_RUNTIME},buildRecordId:'00000000-0000-4000-8000-000000000001',nextBuildId:'fixture',diagnosticRunner:{name:'producer',sourcePath:'/producer/source',bootSha256:'c'.repeat(64)},...Object.fromEntries(['lockSha256','packageSha256','preparedSha256','successfulObservationSha256','manifestSha256','archiveSha256'].map(k=>[k,digest]))};
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
