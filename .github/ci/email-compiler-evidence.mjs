/** Authenticate the actual strict whole-project compiler, not a diagnostic summary or build inference. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {EMAIL} from './email-repair-source.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
export function inspectEmailCompilerSnapshot({run,jobs,artifacts},now=Date.now()){
 assert(run?.id===EMAIL.compilerRun&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.head_sha===EMAIL.compilerController&&run.head_branch==='codex/email-release-admission-20261027'&&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Exact successful email compiler run required');
 const began=Date.parse(run.created_at),ended=Date.parse(run.updated_at);assert(Number.isFinite(began)&&began<=ended&&ended<=now+60000&&now-began<=86400000,'Fresh original compiler time required');
 assert(Array.isArray(jobs)&&jobs.length===3&&new Set(jobs.map(j=>j.name)).size===3&&new Set(jobs.map(j=>j.id)).size===3,'Complete compiler-only job inventory required');
 for(const j of jobs)assert(j.run_id===run.id&&j.run_attempt===1&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.status==='completed'&&(j.name==='typecheck'?j.conclusion==='success':['verifier-controls','bonus-negative'].includes(j.name)&&j.conclusion==='skipped'),'Unexpected compiler-only execution');
 const producer=jobs.find(j=>j.name==='typecheck');assert(Date.parse(producer.started_at)>=began&&Date.parse(producer.completed_at)>=Date.parse(producer.started_at)&&Date.parse(producer.completed_at)<=ended);
 for(const name of ['Generate actual Next route types','Whole-project compiler on exact repaired candidate','Bind exact compiler outcome'])assert(producer.steps?.filter(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success').length===1,'Actual compiler step did not complete: '+name);
 assert(artifacts.length===1,'Only actual compiler evidence is expected');const artifact=artifacts[0],w=artifact.workflow_run;
 assert(artifact.name==='email-whole-compiler-evidence'&&Number.isSafeInteger(artifact.id)&&artifact.id>0&&artifact.expired===false&&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=8*1024**2&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest??'')&&w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Exact compiler archive origin required');
 assert(Date.parse(artifact.created_at)>=Date.parse(producer.started_at)&&Date.parse(artifact.created_at)<=Date.parse(producer.completed_at)&&Date.parse(artifact.expires_at)>now);return {artifact,producer};
}
export function inspectEmailCompilerReport({snapshot,report,log}){
 const origin=inspectEmailCompilerSnapshot(snapshot);
 assert(report?.kind==='ACTUAL_EMAIL_WHOLE_COMPILER_RESULT_NOT_TEST_OR_RELEASE'&&report.source===EMAIL.candidate&&report.controller===EMAIL.compilerController&&report.runId===String(EMAIL.compilerRun)&&report.attempt==='1'&&report.exitCode===0&&report.wholeProject===true&&report.sourceClean===true&&report.releaseAuthorized===false&&isDeepStrictEqual(report.runtime,{node:'22.23.3',platform:'linux',arch:'x64'}),'Exact whole compiler process outcome required');
 assert(typeof log?.text==='string'&&Buffer.byteLength(log.text)<=8*1024**2&&report.logSha256===installHash(log.text),'Original compiler output bytes required');
 assert(Date.parse(report.completedAt)>=Date.parse(origin.producer.started_at)&&Date.parse(report.completedAt)<=Date.parse(origin.producer.completed_at),'Compiler report outside producer');
 return {kind:'AUTHENTICATED_EMAIL_REPAIR_WHOLE_COMPILER',candidate:EMAIL.candidate,controller:EMAIL.compilerController,runId:EMAIL.compilerRun,jobId:origin.producer.id,conclusion:'success',runtime:report.runtime,logSha256:report.logSha256,reportSha256:installHash(installJson(report)),artifactId:origin.artifact.id,digest:origin.artifact.digest,releaseAuthorized:false};
}
