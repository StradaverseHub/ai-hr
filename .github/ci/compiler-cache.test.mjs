/** Pure managed-cache metadata and controller-tree checks; no application process or compiler. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertManagedCompilerInvocation,validateCompilerOrigin,verifyCompilerPublisherTree,COMPILER_SEED,COMPILER_CODE_PATHS} from './compiler-cache.mjs';
const s='a'.repeat(40),c='b'.repeat(40),d='c'.repeat(64),repo='StradaverseHub/ai-hr',rid=1333414856;
const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:repo,GITHUB_REPOSITORY_ID:String(rid),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',
 GITHUB_SHA:c,AIHR_CI_HEAD:s,AIHR_CI_CONTROL_HEAD:c,AIHR_COMPILER_CACHE_MODE:'whole',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_JOB:'typecheck',
 GITHUB_WORKFLOW_REF:repo+'/.github/workflows/alpha-staging.yml@refs/heads/main',
 ...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
test('normal managed source/controller can differ; every cache path still requires the whole compiler',()=>{
 assert.deepEqual(assertManagedCompilerInvocation(env),{pilot:false,publish:true});
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'false',CI:'false',RUNNER_ENVIRONMENT:'self-hosted',GITHUB_REPOSITORY_ID:'9',GITHUB_RUN_ATTEMPT:'2',AIHR_CI_HEAD:'bad',GITHUB_JOB:'other',GITHUB_WORKFLOW_REF:'foreign',DATABASE_URL:'postgres://live',AIHR_COMPILER_CACHE_FORCE_INVALID:'true'}))assert.throws(()=>assertManagedCompilerInvocation({...env,[key]:value}));
});
test('ready same-repository PRs may consume state but cannot publish a cache for future candidates',()=>{
 const e={...env,GITHUB_EVENT_NAME:'pull_request'};
 assert.deepEqual(assertManagedCompilerInvocation(e,{pull_request:{draft:false,base:{ref:'alpha'},head:{repo:{full_name:repo}}}}),{pilot:false,publish:false});
 for(const event of [{},{pull_request:{draft:true}},{pull_request:{draft:false,base:{ref:'main'},head:{repo:{full_name:repo}}}},{pull_request:{draft:false,base:{ref:'alpha'},head:{repo:{full_name:'fork/ai-hr'}}}}])assert.throws(()=>assertManagedCompilerInvocation(e,event));
});
test('only the explicit actual diagnostic pilot may exercise forced corrupt-state fallback',()=>{
 const pilot={...env,AIHR_CI_HEAD:c,AIHR_COMPILER_CACHE_PILOT:'true',AIHR_COMPILER_CACHE_FORCE_INVALID:'true',GITHUB_JOB:'compiler-cache-pilot',
 GITHUB_WORKFLOW_REF:repo+'/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025'};
 assert.deepEqual(assertManagedCompilerInvocation(pilot),{pilot:true,publish:true});
 for(const change of [{GITHUB_JOB:'typecheck'},{GITHUB_EVENT_NAME:'push'},{AIHR_CI_HEAD:s},{GITHUB_WORKFLOW_REF:env.GITHUB_WORKFLOW_REF}])assert.throws(()=>assertManagedCompilerInvocation({...pilot,...change}));
});
const desc={kind:'normal',runId:100};
const run={id:100,run_attempt:1,event:'workflow_dispatch',head_sha:c,head_branch:'main',path:'.github/workflows/alpha-staging.yml',repository:{id:rid,full_name:repo},head_repository:{id:rid}};
const job={name:'typecheck',status:'completed',conclusion:'success',run_id:100,run_attempt:1,head_sha:c,head_branch:'main'};
const jobs={total_count:1,jobs:[job]};
const artifact={id:10,name:'whole-compiler-state-v1',expired:false,digest:'sha256:'+d,size_in_bytes:1000,workflow_run:{id:100,repository_id:rid,head_repository_id:rid,head_sha:c}};
test('only a completed exact non-PR compiler job can publish authenticated bounded graph bytes',()=>{
 assert.equal(validateCompilerOrigin(desc,run,jobs,artifact),job);
 for(const change of [{event:'pull_request'},{run_attempt:2},{repository:{id:9,full_name:repo}},{head_repository:{id:9}},{path:'foreign.yml'}])assert.throws(()=>validateCompilerOrigin(desc,{...run,...change},jobs,artifact));
 for(const change of [{total_count:2},{jobs:[job,job],total_count:2},{jobs:[{...job,conclusion:'failure'}]},{jobs:[{...job,head_sha:s}]}])assert.throws(()=>validateCompilerOrigin(desc,run,{...jobs,...change},artifact));
 for(const change of [{expired:true},{name:'gate-evidence'},{digest:null},{size_in_bytes:65*1024**2},{workflow_run:{id:100,repository_id:9,head_repository_id:rid,head_sha:c}}])assert.throws(()=>validateCompilerOrigin(desc,run,jobs,{...artifact,...change}));
});
test('bootstrap is limited to the exact independently authenticated original seed',()=>{
 const sd=COMPILER_SEED,rs={...run,id:sd.runId,head_sha:sd.controller,head_branch:'codex/test-suite-efficiency-review-20261025',path:'.github/workflows/alpha-staging-diagnostics.yml'};
 const js={total_count:1,jobs:[{...job,name:'compiler-state-producer',run_id:sd.runId,head_sha:sd.controller,head_branch:rs.head_branch}]};
 const a={...artifact,id:sd.artifactId,name:'diagnostic-compiler-state-producer',digest:sd.digest,workflow_run:{...artifact.workflow_run,id:sd.runId,head_sha:sd.controller}};
 assert(validateCompilerOrigin(sd,rs,js,a));
 assert.throws(()=>validateCompilerOrigin(sd,rs,js,{...a,id:a.id+1}));assert.throws(()=>validateCompilerOrigin(sd,rs,js,{...a,digest:'sha256:'+d}));
});
test('authenticated actual controller tree must match every critical compiler/installation/workflow blob',()=>{
 const expected=Object.fromEntries([...COMPILER_CODE_PATHS,'.github/workflows/alpha-staging.yml'].map(path=>[path,s]));
 const tree={truncated:false,tree:Object.keys(expected).map(path=>({path,sha:s,type:'blob'}))};
 assert(verifyCompilerPublisherTree(tree,expected));
 assert.throws(()=>verifyCompilerPublisherTree({...tree,truncated:true},expected));
 assert.throws(()=>verifyCompilerPublisherTree({...tree,tree:tree.tree.slice(1)},expected));
 const changed=structuredClone(tree);changed.tree[0].sha=c;assert.throws(()=>verifyCompilerPublisherTree(changed,expected));
 assert.throws(()=>verifyCompilerPublisherTree({...tree,tree:[...tree.tree,tree.tree[0]]},expected));
});
