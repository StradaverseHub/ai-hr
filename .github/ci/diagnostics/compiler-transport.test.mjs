/** Pure invocation/metadata boundaries only. No compiler or application is started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCompilerTransportInvocation,validateCompilerArtifact,assertIndependentCompilerVm} from './compiler-transport.mjs';
const s='a'.repeat(40),digest='b'.repeat(64);
const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',
 GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025',
 GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123',GITHUB_SHA:s,AIHR_CI_HEAD:s,AIHR_CI_CONTROL_HEAD:s,RUNNER_NAME:'consumer',AIHR_COMPILER_TRANSPORT:'producer',
 AIHR_COMPILER_ARTIFACT_ID:'456',AIHR_COMPILER_ARTIFACT_DIGEST:digest};
const run={id:123,run_attempt:1,event:'workflow_dispatch',head_sha:s,path:'.github/workflows/alpha-staging-diagnostics.yml',head_branch:'codex/test-suite-efficiency-review-20261025',repository:{full_name:'StradaverseHub/ai-hr',id:1333414856}};
const job={name:'compiler-state-producer',run_id:123,run_attempt:1,head_sha:s,status:'completed',conclusion:'success'};
const artifact={id:456,name:'diagnostic-compiler-state-producer',expired:false,workflow_run:{id:123,head_sha:s},digest:'sha256:'+digest,size_in_bytes:1000};
test('only actual hosted manual source/controller context can launch producer or consumer',()=>{
 assert.equal(assertCompilerTransportInvocation(env,'producer'),true);
 assert.equal(assertCompilerTransportInvocation({...env,AIHR_COMPILER_TRANSPORT:'consumer'},'consumer'),true);
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'false',CI:'false',RUNNER_ENVIRONMENT:'self-hosted',GITHUB_REPOSITORY:'other/repo',GITHUB_REPOSITORY_ID:'1',GITHUB_EVENT_NAME:'push',
 GITHUB_WORKFLOW_REF:env.GITHUB_WORKFLOW_REF.replace('diagnostics.yml','alpha-staging.yml'),GITHUB_RUN_ATTEMPT:'2',GITHUB_RUN_ID:'0',GITHUB_SHA:'c'.repeat(40),AIHR_CI_HEAD:'c'.repeat(40),RUNNER_NAME:''}))
  assert.throws(()=>assertCompilerTransportInvocation({...env,[key]:value},'producer'));
 assert.throws(()=>assertCompilerTransportInvocation(env,'consumer'));
});
test('consumer repair retains original cache source/controller/run separately from its actual executing controller',()=>{
 const repaired={...env,AIHR_COMPILER_TRANSPORT:'consumer',GITHUB_RUN_ID:'999',GITHUB_SHA:'c'.repeat(40),AIHR_CI_CONTROL_HEAD:'c'.repeat(40),AIHR_COMPILER_ORIGIN_RUN_ID:'123',AIHR_COMPILER_ORIGIN_CONTROLLER:s};
 assert.equal(assertCompilerTransportInvocation(repaired,'consumer'),true);
 assert.equal(validateCompilerArtifact({run,jobs:[job],artifact},repaired),job);
 for(const [key,value]of Object.entries({AIHR_COMPILER_ORIGIN_RUN_ID:'999',AIHR_COMPILER_ORIGIN_CONTROLLER:'d'.repeat(40),GITHUB_SHA:s,AIHR_CI_HEAD:'bad'}))
  assert.throws(()=>assertCompilerTransportInvocation({...repaired,[key]:value},'consumer'));
 assert.throws(()=>assertCompilerTransportInvocation({...repaired,AIHR_COMPILER_TRANSPORT:'producer'},'producer'));
});
test('artifact authentication requires exact origin, successful producer, raw upload digest and bounded bytes',()=>{
 assert.equal(validateCompilerArtifact({run,jobs:[job],artifact},env),job);
 for(const [key,value]of Object.entries({id:9,run_attempt:2,event:'push',head_sha:'c'.repeat(40),path:'wrong.yml',head_branch:'main',repository:{id:1,full_name:'other/repo'}}))
  assert.throws(()=>validateCompilerArtifact({run:{...run,[key]:value},jobs:[job],artifact},env));
 for(const jobs of [[],[job,job],[{...job,conclusion:'failure'}],[{...job,status:'in_progress'}],[{...job,run_attempt:2}]])
  assert.throws(()=>validateCompilerArtifact({run,jobs,artifact},env));
 for(const [key,value]of Object.entries({id:1,name:'other',expired:true,digest:'sha256:'+'c'.repeat(64),size_in_bytes:97*1024**2,workflow_run:{id:9,head_sha:s}}))
  assert.throws(()=>validateCompilerArtifact({run,jobs:[job],artifact:{...artifact,[key]:value}},env));
 assert.throws(()=>validateCompilerArtifact({run,jobs:[job],artifact},{...env,AIHR_COMPILER_ARTIFACT_DIGEST:'sha256:'+digest}));
});
test('state reuse must be on a fresh VM at the same compiler path, never a claimed second process on the original VM',()=>{
 const producer={name:'producer',bootSha256:'a'.repeat(64),sourcePath:'/home/runner/work/ai-hr/ai-hr/source'};
 const current={name:'consumer',bootSha256:'b'.repeat(64),sourcePath:producer.sourcePath};
 assert.equal(assertIndependentCompilerVm(producer,current),true);
 for(const change of [{name:producer.name},{bootSha256:producer.bootSha256},{sourcePath:'/other/source'}])
  assert.throws(()=>assertIndependentCompilerVm(producer,{...current,...change}));
});

test('compatible child mode binds actual new source/controller and authenticated old producer separately',()=>{
 const current='c'.repeat(40),e={...env,AIHR_COMPILER_TRANSPORT:'consumer',GITHUB_RUN_ID:'999',GITHUB_SHA:current,AIHR_CI_HEAD:current,AIHR_CI_CONTROL_HEAD:current,
 AIHR_COMPILER_ORIGIN_RUN_ID:'123',AIHR_COMPILER_ORIGIN_CONTROLLER:s,AIHR_COMPILER_COMPATIBLE_CHILD:'true'};
 assert.equal(assertCompilerTransportInvocation(e,'consumer'),true);
 assert.equal(validateCompilerArtifact({run,jobs:[job],artifact},e),job);
 for(const [key,value]of Object.entries({AIHR_COMPILER_COMPATIBLE_CHILD:'false',AIHR_CI_HEAD:s,AIHR_CI_CONTROL_HEAD:s,AIHR_COMPILER_ORIGIN_CONTROLLER:current}))
  assert.throws(()=>assertCompilerTransportInvocation({...e,[key]:value},'consumer'));
 assert.throws(()=>assertCompilerTransportInvocation({...env,AIHR_COMPILER_COMPATIBLE_CHILD:'true'},'producer'));
});
