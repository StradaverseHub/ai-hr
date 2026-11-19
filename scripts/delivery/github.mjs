/** Authenticated GitHub producer and archive identities, separate from dependency download caches. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {POLICY,REPOSITORY,REPOSITORY_ID,hash,sha,verifyReport} from './protocol.mjs';
export const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:60000,maxBuffer:32*1024**2}));
export function validateProducer({run,job,artifact},{runId,artifactId,controller,workflowId,workflowPath,now=Date.now()}){
 assert(Number.isSafeInteger(runId)&&runId>0&&Number.isSafeInteger(artifactId)&&artifactId>0&&sha(controller));
 assert(run.id===runId&&run.repository?.id===REPOSITORY_ID&&run.head_repository?.id===REPOSITORY_ID&&run.repository?.full_name===REPOSITORY,'Foreign producer repository');
 assert(run.workflow_id===workflowId&&run.path===workflowPath&&run.head_sha===controller&&run.head_branch==='main'&&['workflow_dispatch','push','schedule'].includes(run.event),'Untrusted workflow/controller');
 assert(run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Failed, incomplete or rerun producer');
 assert(Number.isFinite(Date.parse(run.created_at))&&now-Date.parse(run.created_at)>=-60000&&now-Date.parse(run.created_at)<=86400000,'Expired producer');
 assert(job.run_id===runId&&job.run_attempt===1&&job.head_sha===controller&&job.status==='completed'&&job.conclusion==='success','Missing actual successful producing job');
 assert(artifact.id===artifactId&&artifact.name==='delivery-evidence'&&!artifact.expired&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=32*1024**2&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest),'Invalid artifact identity');
 assert(artifact.workflow_run?.id===runId&&artifact.workflow_run?.head_sha===controller&&artifact.workflow_run?.repository_id===REPOSITORY_ID,'Foreign artifact');
 return true;
}
function decodeArchive(bytes){
 const script=`import sys,zipfile,io,json,stat\nb=sys.stdin.buffer.read(33554433)\nassert len(b)<=33554432\nwith zipfile.ZipFile(io.BytesIO(b)) as z:\n m=z.infolist()\n assert len(m)==1 and m[0].filename=='delivery-report.json' and m[0].file_size<=33554432 and not stat.S_ISLNK(m[0].external_attr>>16)\n data=z.read(m[0]); assert len(data)==m[0].file_size\n sys.stdout.buffer.write(data)\n`;
 return JSON.parse(execFileSync('python3',['-c',script],{input:bytes,maxBuffer:32*1024**2,timeout:20000}));
}
export function authenticateEvidence(request,expectedPlan,{readApi=api,readArchive=id=>execFileSync('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${id}/zip`],{timeout:60000,maxBuffer:32*1024**2}),decode=decodeArchive,now=Date.now()}={}){
 const run=readApi(`actions/runs/${request.runId}`),artifact=readApi(`actions/artifacts/${request.artifactId}`);
 const job=readApi(`actions/jobs/${request.jobId}`);validateProducer({run,job,artifact},{...request,now});
 const bytes=readArchive(artifact.id);assert('sha256:'+hash(bytes)===artifact.digest,'Artifact ZIP bytes differ from GitHub digest');
 const packet=decode(bytes);assert(packet.policy===POLICY&&packet.controller===request.controller&&packet.policyDigest===expectedPlan.policyDigest&&packet.producerJobId===job.id&&Array.isArray(packet.reports)&&packet.reports.length>0&&packet.reports.length<=10000);
 const seen=new Set();
 return packet.reports.map(report=>{
  const check=expectedPlan.checks.find(c=>c.id===report.check);assert(check&&!seen.has(check.id),'Foreign or duplicated check report');seen.add(check.id);verifyReport(check,report);
  assert(report.controller===request.controller&&report.policyDigest===expectedPlan.policyDigest&&report.candidate===packet.candidate,'Report/producer input identity differs');
  return {report,verifiedAt:now,producer:{runId:run.id,jobId:job.id,artifactId:artifact.id,archiveDigest:artifact.digest,controller:request.controller,workflowId:run.workflow_id}};
 });
}
