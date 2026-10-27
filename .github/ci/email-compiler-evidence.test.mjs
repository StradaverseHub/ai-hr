import test from 'node:test';import assert from 'node:assert/strict';
import {EMAIL} from './email-repair-source.mjs';
import {inspectEmailCompilerSnapshot,inspectEmailCompilerReport} from './email-compiler-evidence.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
import {installHash} from './ci-install-grant.mjs';
function fixture(){
 const now=Date.now(),start=new Date(now-2000).toISOString(),end=new Date(now-500).toISOString();
 const run={id:EMAIL.compilerRun,repository:{id:REPOSITORY_ID,full_name:REPOSITORY},head_repository:{id:REPOSITORY_ID},workflow_id:WORKFLOW_ID,path:WORKFLOW_PATH,head_sha:EMAIL.compilerController,head_branch:'codex/email-release-admission-20261027',event:'workflow_dispatch',run_attempt:1,status:'completed',conclusion:'success',created_at:start,updated_at:end};
 const jobs=['verifier-controls','typecheck','bonus-negative'].map((name,i)=>({id:i+1,name,run_id:run.id,head_sha:run.head_sha,head_branch:run.head_branch,run_attempt:1,status:'completed',conclusion:name==='typecheck'?'success':'skipped',started_at:start,completed_at:end,steps:name==='typecheck'?['Generate actual Next route types','Whole-project compiler on exact repaired candidate','Bind exact compiler outcome'].map(name=>({name,status:'completed',conclusion:'success'})):[]}));
 const artifacts=[{id:10,name:'email-whole-compiler-evidence',expired:false,size_in_bytes:100,digest:'sha256:'+'f'.repeat(64),created_at:end,expires_at:new Date(now+86400000).toISOString(),workflow_run:{id:run.id,repository_id:REPOSITORY_ID,head_repository_id:REPOSITORY_ID,head_sha:run.head_sha,head_branch:run.head_branch}}];
 const log={text:'Actual strict whole compiler output'},report={kind:'ACTUAL_EMAIL_WHOLE_COMPILER_RESULT_NOT_TEST_OR_RELEASE',source:EMAIL.candidate,controller:EMAIL.compilerController,runId:String(EMAIL.compilerRun),attempt:'1',exitCode:0,wholeProject:true,sourceClean:true,releaseAuthorized:false,runtime:{node:'22.23.3',platform:'linux',arch:'x64'},logSha256:installHash(log.text),completedAt:end};
 return {snapshot:{run,jobs,artifacts},report,log};
}
test('authenticates actual compiler steps, current runtime, checkout and raw log without claiming test coverage',()=>{const f=fixture(),r=inspectEmailCompilerReport(f);assert.equal(r.candidate,EMAIL.candidate);assert.equal(r.releaseAuthorized,false);});
for(const [name,change] of [['old candidate',f=>f.report.source=EMAIL.original],['wrong runtime',f=>f.report.runtime.node='22.23.4'],['missing actual compiler step',f=>f.snapshot.jobs[1].steps.pop()],['altered raw output',f=>f.log.text+=' altered'],['unexpected test execution',f=>f.snapshot.jobs[0].conclusion='success'],['foreign artifact',f=>f.snapshot.artifacts[0].workflow_run.head_sha=EMAIL.controller],['rerun',f=>f.snapshot.run.run_attempt=2],['failed compiler',f=>f.snapshot.jobs[1].conclusion='failure'],['dirty candidate',f=>f.report.sourceClean=false]])test('refuses '+name,()=>{const f=fixture();change(f);assert.throws(()=>inspectEmailCompilerReport(f));});
test('compiler API metadata must be fresh',()=>{const f=fixture();assert.throws(()=>inspectEmailCompilerSnapshot(f.snapshot,Date.now()+86400001));});
