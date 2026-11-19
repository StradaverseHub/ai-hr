/** Adopt authentic existing hosted producers without weakening their disposable DB guard. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {POLICY,REPOSITORY_ID,sha,hash} from './protocol.mjs';
import {api} from './github.mjs';
import {downloadCiArchives,readCiArchive} from '../../.github/ci/archive-downloads.mjs';
import {verifyFocusedResult} from '../../.github/ci/focused-checks.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2}).trim();
export function unchangedInputs(plan,check,original,cwd){
 assert(sha(original));if(original===plan.candidate)return true;
 const changed=git(cwd,'diff','--name-only','--no-renames',original,plan.candidate).split('\n').filter(Boolean);
 const paths=plan.inputSets[check.inputSet];return paths==='*'?changed.length===0:changed.every(p=>!paths.includes(p));
}
export function validateFocusedProducer(run,jobs,artifact,request,{now=Date.now()}={}){
 assert(run.id===request.runId&&run.repository?.id===REPOSITORY_ID&&run.head_repository?.id===REPOSITORY_ID&&run.head_branch==='main'&&sha(run.head_sha));
 assert(run.workflow_id===395862645&&run.path==='.github/workflows/alpha-focused-checks.yml'&&run.event==='workflow_dispatch'&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1);
 const age=now-Date.parse(run.created_at);assert(Number.isFinite(age)&&age>=-60000&&age<=86400000);
 const selected=jobs.filter(j=>j.name==='selected-tests');assert(selected.length===1&&selected[0].run_id===run.id&&selected[0].head_sha===run.head_sha&&selected[0].run_attempt===1&&selected[0].status==='completed'&&selected[0].conclusion==='success');
 assert(artifact.id===request.artifactId&&artifact.name==='focused-development-evidence'&&!artifact.expired&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest));
 assert(artifact.workflow_run?.id===run.id&&artifact.workflow_run?.repository_id===REPOSITORY_ID&&artifact.workflow_run?.head_sha===run.head_sha);return selected[0];
}
export async function authenticateFocused(request,plan,{candidatePath,directory,policyDigestAt,readApi=api,now=Date.now()}){
 const run=readApi(`actions/runs/${request.runId}`);const data=readApi(`actions/runs/${request.runId}/jobs?per_page=100&filter=all`);assert(data.total_count===data.jobs.length,'Complete job inventory required');
 const artifact=readApi(`actions/artifacts/${request.artifactId}`),job=validateFocusedProducer(run,data.jobs,artifact,request,{now});
 assert(await policyDigestAt(run.head_sha)===plan.policyDigest,'Producing controller policy changed');
 const dir=join(directory,String(run.id));mkdirSync(dir,{recursive:true,mode:0o700});await downloadCiArchives([artifact],dir);
 const zip=join(dir,artifact.name+'.zip'),bytes=readCiArchive(artifact,zip);
 const script=`import sys,zipfile,io,json,stat,posixpath
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read(67108865))) as z:
 infos=z.infolist(); assert len(infos)<=10000 and sum(i.file_size for i in infos)<=134217728
 names=[i.filename for i in infos]; assert len(names)==len(set(names))
 for i in infos:
  assert not i.filename.startswith('/') and '..' not in i.filename.split('/') and not stat.S_ISLNK(i.external_attr>>16)
 keep=['focused.json','nodb.vitest.json','db.vitest.json']
 result={name:json.loads(z.read(name)) for name in keep if name in names}
 assert 'focused.json' in result
 sys.stdout.write(json.dumps(result))
`;
 const packet=JSON.parse(execFileSync('python3',['-c',script],{input:bytes,maxBuffer:64*1024**2,timeout:20000}));
 const summary=packet['focused.json'];assert(summary.kind==='FOCUSED_ONLY'&&summary.releaseEligible===false&&summary.exitCode===0&&summary.controller===run.head_sha&&Number(summary.runId)===run.id&&summary.attempt==='1','Actual complete focused execution required');
 assert(summary.runtime?.node==='22.23.3'&&summary.runtime?.platform==='linux'&&summary.runtime?.arch==='x64'&&summary.execution?.workers===2,'Original runtime/profile differs');
 const original=summary.plan?.sha??summary.sha;assert(sha(original));
 const reports=[];const files=[];
 for(const name of ['nodb.vitest.json','db.vitest.json']){
  const raw=packet[name];if(!raw)continue;const result={...raw,testResults:raw.testResults.map(s=>({...s,name:s.name.replace(/^.*\/source\//,'')}))};
  const selected=result.testResults.map(s=>s.name);verifyFocusedResult(result,selected,'/not-a-runner-path');
  for(const suite of result.testResults){
   const file=suite.name.replace(/^.*\/source\//,'');files.push(file);const check=plan.checks.find(c=>c.kind==='test'&&c.files.length===1&&c.files[0]===file);
   if(!check||!unchangedInputs(plan,check,original,candidatePath)||(check.reuse==='never'&&original!==plan.candidate))continue;
   reports.push({report:{policy:POLICY,candidate:original,controller:run.head_sha,policyDigest:plan.policyDigest,check:check.id,key:check.key,inputDigest:check.inputs,result:'passed',files:check.files,assertions:suite.assertionResults.length,skipped:0},verifiedAt:now,producer:{runId:run.id,jobId:job.id,artifactId:artifact.id,archiveDigest:artifact.digest,controller:run.head_sha,workflowId:run.workflow_id}});
  }
 }
 assert(files.length>0&&new Set(files).size===files.length,'Missing or duplicated executed files');assert.deepEqual(files.slice().sort(),summary.files.slice().sort(),'Summary omitted executed files');
 return reports;
}
