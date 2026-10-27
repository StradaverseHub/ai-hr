/** Fresh GitHub provenance plus immutable-source coverage. Never a combined release receipt. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {immutablePlan} from './immutable-plan.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX} from './build-artifact.mjs';
import {COMPILER_STATE_ARTIFACT} from './compiler-cache-protocol.mjs';
import {NEXT_APPLICATION_STATE,NEXT_APPLICATION_FAILURE} from './next-application-cache-protocol.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {hash} from './manifest.mjs';
import {validateEmailControllerProof} from './email-repair-source.mjs';
const id=n=>Number.isSafeInteger(n)&&n>0;
const time=s=>typeof s==='string'?Date.parse(s):NaN;
const jobName=u=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`;
export function inspectRetainedInventory({plan,expected,run,jobs,artifacts,now=Date.now()}){
 assert(id(expected.runId)&&['candidate','controller','baseline'].every(k=>/^[a-f0-9]{40}$/.test(expected[k]??'')),'Exact retained identities required');
 assert(plan.sha===expected.candidate&&plan.controller===expected.controller&&plan.migrationBase===expected.baseline,'Reconstructed plan identity differs');
 assert(plan.runtime?.platform==='linux'&&plan.runtime.arch==='x64'&&/^22\./.test(plan.runtime.node),'Unsupported original runtime');
 assert(run?.id===expected.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign retained repository/run');
 if(!['main','alpha'].includes(run.head_branch))validateEmailControllerProof(expected.reviewedControllerProof,{controller:expected.controller,branch:run.head_branch});
 assert(run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.head_sha===expected.controller,'Untrusted retained controller/workflow');
 assert(run.event==='workflow_dispatch'||run.event==='push'&&run.head_branch==='alpha'&&expected.candidate===expected.controller,'Unsupported retained event');
 assert(run.status==='completed'&&['success','failure'].includes(run.conclusion)&&run.run_attempt===1,'Retained run must be terminal first attempt');
 const began=time(run.created_at),ended=time(run.updated_at);
 assert(Number.isFinite(now)&&Number.isFinite(began)&&Number.isFinite(ended)&&began<=ended&&now-began<=86400000&&began<=now+60000&&ended<=now+60000,'Expired or invalid retained time');
 const requiredJobs=['resolve','plan','controller-tests','migrations','typecheck','build',...plan.units.map(jobName),'verify','deployment-hold'];
 assert(new Set(requiredJobs).size===requiredJobs.length,'Duplicate reconstructed job');
 assert(Array.isArray(jobs)&&jobs.length<=requiredJobs.length+1,'Bounded full job inventory required');
 const byName=new Map(),jobIds=new Set();
 for(const j of jobs){
  assert(id(j.id)&&!jobIds.has(j.id)&&!byName.has(j.name)&&j.run_id===run.id&&j.run_attempt===1&&j.head_sha===expected.controller&&j.head_branch===run.head_branch,'Duplicate/foreign/rerun job');
  assert(j.status==='completed'&&['success','failure','cancelled','timed_out','skipped'].includes(j.conclusion),'Nonterminal job');
  assert(requiredJobs.includes(j.name)||j.name==='runner-diagnostics'&&j.conclusion==='skipped','Unexpected job');
  if(j.conclusion!=='skipped')assert(time(j.started_at)>=began&&time(j.completed_at)>=time(j.started_at)&&time(j.completed_at)<=ended,'Invalid job chronology');
  byName.set(j.name,j);jobIds.add(j.id);
 }
 assert(requiredJobs.every(n=>byName.has(n)),'Omitted required job');
 assert(['resolve','plan','controller-tests'].every(n=>byName.get(n).conclusion==='success'),'Original bootstrap failed');
 if(run.conclusion==='success')assert(requiredJobs.every(n=>byName.get(n).conclusion==='success'),'Run success contradicts jobs');
 const allowed=new Set(['gate-plan','gate-evidence',BUILD_ARTIFACT,COMPILER_STATE_ARTIFACT,NEXT_APPLICATION_STATE,NEXT_APPLICATION_FAILURE,...plan.units.map(u=>'unit-'+u.id)]);
 assert(Array.isArray(artifacts)&&artifacts.length<=allowed.size,'Bounded complete artifact inventory required');
 const seen=new Set(),artifactIds=new Set();
 for(const a of artifacts){
  const w=a.workflow_run;
  assert(allowed.has(a.name)&&!seen.has(a.name)&&id(a.id)&&!artifactIds.has(a.id)&&a.expired===false,'Foreign/duplicate/expired artifact');
  assert(id(a.size_in_bytes)&&a.size_in_bytes<=(a.name===BUILD_ARTIFACT?BUILD_ZIP_MAX:64*1024**2)&&/^sha256:[a-f0-9]{64}$/.test(a.digest??''),'Invalid artifact byte boundary');
  assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===expected.controller&&w.head_branch===run.head_branch,'Artifact provenance differs');
  assert(time(a.created_at)>=began&&time(a.created_at)<=ended&&time(a.expires_at)>now,'Invalid artifact chronology');
  seen.add(a.name);artifactIds.add(a.id);
 }
 assert(seen.has('gate-plan'),'Missing original plan archive');
 const selected=artifacts.filter(a=>a.name==='gate-plan'||a.name.startsWith('unit-'));
 for(const a of selected){
  const unit=plan.units.find(u=>'unit-'+u.id===a.name),j=byName.get(unit?jobName(unit):'plan');
  assert(j.conclusion!=='skipped'&&time(a.created_at)>=time(j.started_at)&&time(a.created_at)<=time(j.completed_at),'Archive outside producing job');
 }
 return {selected,byName};
}
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
function pages(path,key){const rows=[];for(let n=1;n<=10;n++){const value=api(path+(path.includes('?')?'&':'?')+'per_page=100&page='+n);assert(Array.isArray(value[key]),'Missing API page');rows.push(...value[key]);if(value[key].length<100)return rows;}throw Error('API inventory exceeds bound');}
export function fetchGitHubRunSnapshot(runId){return {run:api('actions/runs/'+runId),jobs:pages('actions/runs/'+runId+'/jobs?filter=all','jobs'),artifacts:pages('actions/runs/'+runId+'/artifacts','artifacts')};}
export const githubSnapshotIdentity=s=>({run:{id:s.run.id,run_attempt:s.run.run_attempt,status:s.run.status,conclusion:s.run.conclusion,head_sha:s.run.head_sha,head_branch:s.run.head_branch},jobs:s.jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion,status:j.status,run_id:j.run_id,run_attempt:j.run_attempt,head_sha:j.head_sha,started_at:j.started_at,completed_at:j.completed_at})).sort((a,b)=>a.id-b.id),artifacts:s.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest,size_in_bytes:a.size_in_bytes,expired:a.expired})).sort((a,b)=>a.id-b.id)});
export async function authenticateRetainedUnits({repository,expected,runtime,outputParent,prefetchDirectory}){
 const reconstructed=immutablePlan({repository,candidate:expected.candidate,controller:expected.controller,baseline:expected.baseline,runtime}),plan=reconstructed.plan;
 const first=fetchGitHubRunSnapshot(expected.runId),inventory=inspectRetainedInventory({plan,expected,...first});
 const dir=join(resolve(outputParent),'retained-'+expected.runId+'-'+randomUUID());mkdirSync(dir,{recursive:true,mode:0o700});
 const save=(name,data)=>writeFileSync(join(dir,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 save('first-api-snapshot.json',first);save('source-plan.json',reconstructed);
 try{
  const transport=await downloadCiArchives(inventory.selected,dir,{prefetchDirectory});save('transport.json',transport);
  const parsed=new Map();
  for(const a of inventory.selected){const archive=join(dir,a.name+'.zip');readCiArchive(a,archive);
   const target=join(dir,a.name);execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),archive,target],{timeout:10000,stdio:'pipe'});
   const name=a.name==='gate-plan'?'ci-plan.json':a.name+'.json';parsed.set(a.name,JSON.parse(readFileSync(join(target,name),'utf8')));
  }
  assert(isDeepStrictEqual(parsed.get('gate-plan'),plan),'Archived manifest differs from immutable reconstruction');
  const reusable=[],rerun=[];
  for(const u of plan.units){const a=inventory.selected.find(a=>a.name==='unit-'+u.id),j=inventory.byName.get(jobName(u)),report=parsed.get('unit-'+u.id);
   if(!a){rerun.push({id:u.id,reason:'Missing original archive',jobConclusion:j.conclusion});continue;}
   try{const verified=verifyUnitReport(plan,report);assert(j.conclusion==='success','Original producing job did not pass');reusable.push({...verified,origin:{candidate:plan.sha,policy:plan.policyVersion,fingerprint:plan.fingerprint,runId:expected.runId,attempt:1,jobId:j.id,artifactId:a.id,digest:a.digest,reportHash:hash(report)}});}
   catch(error){rerun.push({id:u.id,jobConclusion:j.conclusion,artifactId:a.id,digest:a.digest,reportHash:hash(report),reason:String(error.message)});}
  }
  const second=fetchGitHubRunSnapshot(expected.runId);inspectRetainedInventory({plan,expected,...second});assert(isDeepStrictEqual(githubSnapshotIdentity(first),githubSnapshotIdentity(second)),'GitHub origin changed during authentication');save('final-api-snapshot.json',second);
  const result={kind:'AUTHENTICATED_ORIGINAL_UNIT_EVIDENCE_NOT_COMBINED_RELEASE',releaseAuthorized:false,sourceBinding:reconstructed.binding,expected,policy:plan.policyVersion,fingerprint:plan.fingerprint,apiRevalidatedAt:new Date().toISOString(),completeRequiredUnits:plan.units.map(u=>u.id),reusable,rerun,uncheckedPrerequisites:['migrations','typecheck','build','browser/source equivalence','latest failure history','repair impact','final combined release validation'],evidenceDirectory:dir};save('authentication.json',result);return result;
 }catch(error){save('refusal.json',{releaseAuthorized:false,error:String(error.message)});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [repository,run,candidate,controller,baseline,outputParent,prefetchDirectory]=process.argv.slice(2);
 authenticateRetainedUnits({repository,expected:{runId:Number(run),candidate,controller,baseline},runtime:{node:'22.23.3',platform:'linux',arch:'x64'},outputParent,prefetchDirectory}).then(r=>console.log(JSON.stringify({kind:r.kind,reusable:r.reusable.length,rerun:r.rerun.length,tests:r.reusable.reduce((n,u)=>n+u.tests,0),evidenceDirectory:r.evidenceDirectory}))).catch(e=>{console.error(e);process.exitCode=1;});
}
