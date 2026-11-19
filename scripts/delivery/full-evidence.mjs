/** Per-check adoption from original complete v17 units; the original workflow keeps its result. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {POLICY,REPOSITORY_ID,hash} from './protocol.mjs';
import {api} from './github.mjs';
import {unchangedInputs} from './legacy-evidence.mjs';
import {downloadCiArchives,readCiArchive} from '../../.github/ci/archive-downloads.mjs';
import {verifyUnitReport} from '../../.github/ci/verify-shards.mjs';
import {CI_POLICY} from '../../.github/ci/policy-version.mjs';
export async function readArtifactJson(artifact,name,directory){
 assert(artifact&&!artifact.expired&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest));
 mkdirSync(directory,{recursive:true,mode:0o700});await downloadCiArchives([artifact],directory);const path=join(directory,artifact.name+'.zip');readCiArchive(artifact,path);
 const out=join(directory,artifact.name);execFileSync('python3',[new URL('../../.github/ci/extract-artifact.py',import.meta.url).pathname,path,out],{stdio:'pipe',timeout:20000});return JSON.parse(readFileSync(join(out,name)));
}
export function admittedFullRun(run,{now=Date.now()}={}){
 assert(run.repository?.id===REPOSITORY_ID&&run.head_repository?.id===REPOSITORY_ID&&run.workflow_id===395777276&&run.path==='.github/workflows/alpha-staging.yml'&&run.head_branch==='main'&&run.event==='workflow_dispatch');
 assert(run.status==='completed'&&['success','failure'].includes(run.conclusion)&&run.run_attempt===1,'Original completed first attempt required; a failed run is never relabelled');
 const age=now-Date.parse(run.created_at);assert(Number.isFinite(age)&&age>=-60000&&age<=86400000);return run;
}
export async function authenticateFullUnit(request,plan,{candidatePath,directory,policyDigestAt,readApi=api,now=Date.now()}){
 const run=admittedFullRun(readApi(`actions/runs/${request.runId}`),{now});assert(await policyDigestAt(run.head_sha)===plan.policyDigest,'Original policy inputs differ');
 const job=readApi(`actions/jobs/${request.jobId}`),artifact=readApi(`actions/artifacts/${request.artifactId}`),manifest=readApi(`actions/artifacts/${request.planArtifactId}`);
 assert(job.run_id===run.id&&job.run_attempt===1&&job.head_sha===run.head_sha&&job.status==='completed'&&job.conclusion==='success');
 for(const a of [artifact,manifest])assert(a.workflow_run?.id===run.id&&a.workflow_run?.repository_id===REPOSITORY_ID&&a.workflow_run?.head_sha===run.head_sha);
 assert(manifest.name==='gate-plan'&&/^unit-(?:db-|nodb-|browser-)[a-f0-9a-z-]+$/.test(artifact.name));
 const dir=join(directory,String(run.id)+'-'+String(artifact.id));
 const original=await readArtifactJson(manifest,'ci-plan.json',dir);assert(original.controller===run.head_sha&&original.policyVersion===CI_POLICY&&original.runtime?.platform==='linux'&&original.runtime?.arch==='x64'&&original.runtime?.node==='22.23.3');
 const report=await readArtifactJson(artifact,artifact.name+'.json',dir);const unit=original.units.find(u=>u.id===report.id);assert(unit);
 assert(job.name===(unit.kind==='browser'?`browser (${unit.engine})`:`test (${unit.id})`),'Actual producing job differs');verifyUnitReport(original,report);
 const results=[];
 for(const b of report.batches)for(const suite of b.result.testResults){
  const file=relative(report.cwd,suite.name).split('\\').join('/');
  const kind=unit.kind==='browser'?'browser-'+unit.engine:'test';const check=plan.checks.find(c=>c.kind===kind&&c.files.length===1&&c.files[0]===file);
  if(!check||!unchangedInputs(plan,check,original.sha,candidatePath)||(check.reuse==='never'&&original.sha!==plan.candidate))continue;
  results.push({report:{policy:POLICY,candidate:original.sha,controller:run.head_sha,policyDigest:plan.policyDigest,check:check.id,key:check.key,inputDigest:check.inputs,result:'passed',files:check.files,assertions:suite.assertionResults.length,skipped:0},verifiedAt:now,producer:{runId:run.id,jobId:job.id,artifactId:artifact.id,archiveDigest:artifact.digest,planArtifactId:manifest.id,planArchiveDigest:manifest.digest,originalRunConclusion:run.conclusion}});
 }
 return results;
}
