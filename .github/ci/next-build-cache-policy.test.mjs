/** Pure untrusted context and artifact refusals. No Next/TSC/database or SDK runs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {NEXT_CACHE_REF,NEXT_CACHE_WORKFLOW,NEXT_STATE_NAME,hash,assertNextCacheInvocation,parseNextCacheOrigin,validateNextOrigin,validateNextContext,validateNextState,assertNextAncestry} from './next-build-cache-policy.mjs';
const sha='a'.repeat(40),other='b'.repeat(40),digest='c'.repeat(64);
const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:NEXT_CACHE_REF,GITHUB_JOB:'next-build-cache',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123',GITHUB_SHA:sha,AIHR_CI_HEAD:sha,AIHR_CI_CONTROL_HEAD:sha,AIHR_NEXT_BUILD_CACHE_MODE:'cold',AIHR_BUILD_DIAGNOSTIC:'transport-producer',...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
const inputs=['tsconfig.json','tsconfig.build.json','pnpm-lock.yaml','package.json','pnpm-workspace.yaml','next.config.ts','deploy/css-cache-guard.sh','cssInputs'];
const binaries=['typescript/package.json','typescript/lib/tsc.js','typescript/lib/_tsc.js','typescript/lib/typescript.js','next/dist/lib/typescript/runTypeCheckCli.js','next/dist/lib/typescript/runTypeScriptCli.js','next/dist/lib/typescript/runTypeCheck.js','next/dist/build/type-check.js'];
const context={runtime:{node:'22.23.3',abi:'127',platform:'linux',arch:'x64',glibc:'2.39',next:'16.3.8',typescript:'5.9.3'},sourcePath:'/home/runner/work/ai-hr/ai-hr/source',nodeOptions:'--max-old-space-size=6144',inputs:Object.fromEntries(inputs.map(p=>[p,digest])),compiler:Object.fromEntries(binaries.map(p=>[p,digest])),generatedTypes:[{path:'validator.ts',bytes:123,sha256:digest}]};
const bytes=Buffer.from(JSON.stringify({version:'5.9.3',fileNames:['../../app/(app)/page.tsx','../../lib/member.ts']}));
const completedAt='2026-10-26T00:00:00.000Z',now=Date.parse(completedAt)+1000;
const envelope={kind:'NEXT_APPLICATION_COMPILER_STATE_BUILD_MUST_RUN',releaseAuthorized:false,source:sha,controller:sha,runId:'123',attempt:'1',completedCommand:'canonical-build',completedCommandExit:0,bytes:bytes.length,sha256:hash(bytes),files:2,context,completedAt};
test('only explicit managed first-attempt build/cache purpose with closed URLs is admitted',()=>{
 assertNextCacheInvocation(env);assertNextCacheInvocation({...env,AIHR_NEXT_BUILD_CACHE_MODE:'warm'});
 for(const [k,v]of Object.entries({GITHUB_ACTIONS:'false',CI:'false',RUNNER_ENVIRONMENT:'self-hosted',GITHUB_REPOSITORY:'other/repo',GITHUB_REPOSITORY_ID:'1',GITHUB_EVENT_NAME:'push',GITHUB_WORKFLOW_REF:'other',GITHUB_JOB:'build',GITHUB_RUN_ATTEMPT:'2',GITHUB_RUN_ID:'0',AIHR_CI_HEAD:other,AIHR_NEXT_BUILD_CACHE_MODE:'other',DATABASE_URL:'postgres://live'}))assert.throws(()=>assertNextCacheInvocation({...env,[k]:v}),k);
});
test('origin selector refuses invented routing and additional credentials',()=>{
 const p={runId:'123',sha,artifactId:'456',digest};assert.deepEqual(parseNextCacheOrigin(JSON.stringify(p)),p);
 for(const c of [{runId:'0'},{runId:'9007199254740992'},{sha:'wrong'},{artifactId:'x'},{digest:'sha256:'+digest},{token:'not-allowed'}])assert.throws(()=>parseNextCacheOrigin(JSON.stringify({...p,...c})));
});
const origin={runId:'123',sha,artifactId:'456',digest};
const run={id:123,run_attempt:1,event:'workflow_dispatch',head_sha:sha,path:NEXT_CACHE_WORKFLOW,head_branch:'codex/test-suite-efficiency-review-20261025',repository:{full_name:'StradaverseHub/ai-hr',id:1333414856},head_repository:{id:1333414856}};
const job={name:'next-build-cache',run_id:123,run_attempt:1,head_sha:sha,status:'completed',conclusion:'success'};
const jobs={total_count:1,jobs:[job]};
const artifact={id:456,name:NEXT_STATE_NAME,expired:false,workflow_run:{id:123,head_sha:sha,repository_id:1333414856,head_repository_id:1333414856},digest:'sha256:'+digest,size_in_bytes:100};
test('successful actual first-attempt job and bounded exact artifact namespace are mandatory',()=>{
 assert.equal(validateNextOrigin(origin,run,jobs,artifact),job);
 for(const c of [{run_attempt:2},{event:'pull_request'},{head_sha:other},{repository:{...run.repository,id:9}},{head_repository:{id:9}},{path:'other.yml'}])assert.throws(()=>validateNextOrigin(origin,{...run,...c},jobs,artifact));
 for(const c of [{id:457},{name:'test-PASS'},{expired:true},{digest:'sha256:'+'d'.repeat(64)},{size_in_bytes:64*1024**2+1},{workflow_run:{...artifact.workflow_run,head_repository_id:9}}])assert.throws(()=>validateNextOrigin(origin,run,jobs,{...artifact,...c}));
 assert.throws(()=>validateNextOrigin(origin,run,{total_count:2,jobs:[job]},artifact));
 assert.throws(()=>validateNextOrigin(origin,run,{total_count:2,jobs:[job,job]},artifact));
 assert.throws(()=>validateNextOrigin(origin,run,{total_count:1,jobs:[{...job,conclusion:'failure'}]},artifact));
});
test('state bytes/version/configuration/runtime/age and full graph count stay bound, never PASS',()=>{
 assert.equal(validateNextContext(context),context);assert.equal(validateNextState(bytes,envelope,sha,context,{now}).fileNames.length,2);
 for(const c of [{releaseAuthorized:true},{source:other},{controller:'bad'},{completedCommandExit:1},{sha256:'d'.repeat(64)},{bytes:bytes.length+1},{files:1},{completedAt:'invalid'},{completedAt:'2026-10-24T00:00:00Z'}])assert.throws(()=>validateNextState(bytes,{...envelope,...c},sha,context,{now}));
 for(const c of [{...context,nodeOptions:'--max-old-space-size=8192'},{...context,runtime:{...context.runtime,node:'20.20.2'}},{...context,inputs:{...context.inputs,'tsconfig.build.json':'d'.repeat(64)}},{...context,compiler:{...context.compiler,'typescript/lib/tsc.js':'d'.repeat(64)}},{...context,generatedTypes:[]}])assert.throws(()=>validateNextState(bytes,envelope,sha,c,{now}));
 assert.throws(()=>validateNextState(Buffer.concat([bytes,Buffer.from(' ')]),envelope,sha,context,{now}));
 for(const data of [{version:'5.8.1',fileNames:['a']},{version:'5.9.3',fileNames:[]},{version:'5.9.3',fileNames:['a','a']}])assert.throws(()=>validateNextState(Buffer.from(JSON.stringify(data)),envelope,sha,context,{now}));
});
test('same source or complete bounded ancestor only; no source identity is relabelled',()=>{
 assert.deepEqual(assertNextAncestry(sha,sha,null),[]);
 const c={status:'ahead',behind_by:0,ahead_by:1,total_commits:1,base_commit:{sha},merge_base_commit:{sha},commits:[{sha:other}],files:[{filename:'lib/member.ts',status:'modified'}]};
 assert.deepEqual(assertNextAncestry(sha,other,c),['lib/member.ts']);
 for(const change of [{status:'diverged'},{behind_by:1},{ahead_by:33},{commits:[]},{files:[]},{files:[{filename:'../secret',status:'modified'}]}])assert.throws(()=>assertNextAncestry(sha,other,{...c,...change}));
 assert.throws(()=>assertNextAncestry(sha,sha,c));
});

test("compiler-only recovery remains explicit graph data and unknown or failed completion refuses",()=>{
 assertNextCacheInvocation({...env,AIHR_NEXT_BUILD_CACHE_MODE:"recover"});
 assert.equal(validateNextState(bytes,{...envelope,completedCommand:"application-compiler-recovery"},sha,context,{now}).fileNames.length,2);
 for(const change of [{completedCommand:"made-up-PASS"},{completedCommandExit:1}])assert.throws(()=>validateNextState(bytes,{...envelope,...change},sha,context,{now}));
});
