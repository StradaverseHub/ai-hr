/** Pure refusal/identity checks. These never execute a Next build or forge release evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertBuildRuntime,assertBuildInvocation,assertDiagnosticBuildInvocation,assertSuccessfulObservation,STAGING_BUILD_RUNTIME} from './build-production.mjs';
const environment={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'b'.repeat(40),GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/alpha'};
test('Only the observed staging tuple passes; public/key compile overrides refuse',()=>{
 assert.equal(assertBuildRuntime({...STAGING_BUILD_RUNTIME},{}),true);
 for(const [key,value]of Object.entries({node:'22.0.0',abi:'127',platform:'darwin',arch:'arm64',glibc:'2.35',next:'16.2.7'}))assert.throws(()=>assertBuildRuntime({...STAGING_BUILD_RUNTIME,[key]:value},{}),/runtime mismatch/);
 for(const key of ['NEXT_PUBLIC_API','NEXT_SERVER_ACTIONS_ENCRYPTION_KEY'])for(const value of ['', 'fixture'])assert.throws(()=>assertBuildRuntime({...STAGING_BUILD_RUNTIME},{[key]:value}),/compile environment/);
 assert.equal(assertBuildRuntime({...STAGING_BUILD_RUNTIME},{UNRELATED:'fixture',NEXT_PUBLIC_UNUSED:undefined}),true);
});
test('Candidate/controller/attempt/repository/workflow bindings reject unrelated contexts',()=>{
 assert.equal(assertBuildInvocation(environment),true);
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'false',GITHUB_REPOSITORY:'example/ai-hr',GITHUB_REPOSITORY_ID:'9',AIHR_CI_HEAD:'bad',AIHR_CI_CONTROL_HEAD:'bad',GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ATTEMPT:'2',GITHUB_RUN_ID:'0',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/feature'}))assert.throws(()=>assertBuildInvocation({...environment,[key]:value}));
 assert.throws(()=>assertBuildInvocation({...environment,GITHUB_RUN_ID:'9007199254740992'}));
 assert.equal(assertBuildInvocation({...environment,GITHUB_WORKFLOW_REF:environment.GITHUB_WORKFLOW_REF.replace('heads/alpha','heads/main')}),true);
});
const prepared={identity:{sourceRef:'a'.repeat(40),buildRecordId:'00000000-0000-4000-8000-000000000001',catalogueHash:'c'.repeat(64),contentHash:'d'.repeat(64)}};
const preparedBytes=Buffer.from(JSON.stringify(prepared)+'\n');
const successful={format:1,kind:'successful-system-testing-build',identity:prepared.identity,preparedRecordSha256:createHash('sha256').update(preparedBytes).digest('hex'),nextBuildId:'fixture-id',buildStartedAt:'2026-10-25T15:00:00.000Z',observedAt:'2026-10-25T15:01:00.000Z',platform:'linux',arch:'x64',activeServiceVerified:false,manualExecutionVerified:false};
const start=Date.parse(successful.buildStartedAt),end=Date.parse(successful.observedAt);
const check=observation=>assertSuccessfulObservation(observation,prepared,preparedBytes,'fixture-id',start,end);
test('Matching actual-observation structure binds source identity, preparation bytes and build ID',()=>{
 assert.equal(check(successful),true);
 for(const [key,value]of Object.entries({format:2,kind:'generic-build',identity:{...prepared.identity,buildRecordId:'00000000-0000-4000-8000-000000000002'},preparedRecordSha256:'e'.repeat(64),nextBuildId:'other-id',platform:'darwin',arch:'arm64',activeServiceVerified:true,manualExecutionVerified:true}))assert.throws(()=>check({...successful,[key]:value}));
 assert.throws(()=>assertSuccessfulObservation(successful,prepared,Buffer.from('changed'),'fixture-id',start,end));
});
test('Stale, future, reversed and invalid observation times refuse',()=>{
 for(const [key,value]of [['buildStartedAt',new Date(start-1).toISOString()],['observedAt',new Date(end+1).toISOString()],['observedAt',new Date(start-1).toISOString()],['observedAt','invalid'],['buildStartedAt','invalid']])assert.throws(()=>check({...successful,[key]:value}),/observation time/);
});

test('diagnostic producer uses its actual manual workflow identity and cannot satisfy managed release invocation',()=>{
 const e={...environment,AIHR_CI_HEAD:environment.AIHR_CI_CONTROL_HEAD,CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_EVENT_NAME:'workflow_dispatch',AIHR_BUILD_DIAGNOSTIC:'transport-producer',RUNNER_NAME:'GitHub Actions fixture',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025'};
 assert.equal(assertDiagnosticBuildInvocation(e),true);assert.throws(()=>assertBuildInvocation(e));assert.throws(()=>assertDiagnosticBuildInvocation(environment));
 for(const [key,value]of Object.entries({CI:'false',RUNNER_ENVIRONMENT:'self-hosted',GITHUB_EVENT_NAME:'push',AIHR_CI_HEAD:'c'.repeat(40),AIHR_BUILD_DIAGNOSTIC:'other',RUNNER_NAME:'',GITHUB_WORKFLOW_REF:e.GITHUB_WORKFLOW_REF.replace('review-20261025','other')}))assert.throws(()=>assertDiagnosticBuildInvocation({...e,[key]:value}));
});

test('new canonical-build diagnostic cannot satisfy release or unrelated diagnostic contexts',()=>{
 const e={...environment,AIHR_CI_HEAD:environment.AIHR_CI_CONTROL_HEAD,CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_EVENT_NAME:'workflow_dispatch',AIHR_BUILD_DIAGNOSTIC:'transport-producer',RUNNER_NAME:'GitHub Actions fixture',
 GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-build-cache-diagnostic.yml@refs/heads/codex/test-suite-efficiency-review-20261025',GITHUB_JOB:'next-build-cache',AIHR_NEXT_BUILD_CACHE_MODE:'cold'};
 for(const mode of ['cold','warm'])assert.equal(assertDiagnosticBuildInvocation({...e,AIHR_NEXT_BUILD_CACHE_MODE:mode}),true);
 assert.throws(()=>assertBuildInvocation(e));
 for(const changes of [{GITHUB_JOB:'build'},{AIHR_NEXT_BUILD_CACHE_MODE:'unknown'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_EVENT_NAME:'push'}])assert.throws(()=>assertDiagnosticBuildInvocation({...e,...changes}));
});
