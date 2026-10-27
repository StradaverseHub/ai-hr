/** Fresh focused-run provenance, exact source selection and truthful per-file outcomes. No release authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {REPOSITORY,REPOSITORY_ID} from './release-policy.mjs';
import {fetchGitHubRunSnapshot,githubSnapshotIdentity} from './retained-units.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {immutablePlan} from './immutable-plan.mjs';
import {parseSelection} from './focused-checks.mjs';
import {inspectFocusedFiles} from './focused-file-evidence.mjs';
const WORKFLOW=395862645,PATH='.github/workflows/alpha-focused-checks.yml',ARTIFACT='focused-development-evidence';
export function inspectFocusedInventory({expected,run,jobs,artifacts,now=Date.now()}){
 assert(Number.isSafeInteger(expected.runId)&&expected.runId>0&&['candidate','controller','baseline'].every(k=>/^[a-f0-9]{40}$/.test(expected[k]??'')),'Exact focused identities required');
 assert(run?.id===expected.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign focused repository');
 assert(run.workflow_id===WORKFLOW&&run.path===PATH&&run.event==='workflow_dispatch'&&['main','alpha'].includes(run.head_branch)&&run.head_sha===expected.controller,'Untrusted focused workflow/controller');
 assert(run.status==='completed'&&['success','failure'].includes(run.conclusion)&&run.run_attempt===1,'Focused run not terminal first attempt');
 const start=Date.parse(run.created_at),end=Date.parse(run.updated_at);assert(Number.isFinite(start)&&start<=end&&end<=now+60000&&now-start<=86400000,'Expired/invalid focused run');
 assert(Array.isArray(jobs)&&jobs.length===4,'Complete focused job inventory required');
 const names=new Set(),ids=new Set();
 for(const j of jobs){assert(['resolve','selected-tests','typecheck','linux-build'].includes(j.name)&&!names.has(j.name)&&Number.isSafeInteger(j.id)&&j.id>0&&!ids.has(j.id)&&j.run_id===run.id&&j.head_sha===expected.controller&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed'&&['success','failure','skipped','timed_out','cancelled'].includes(j.conclusion),'Foreign/duplicate/nonterminal focused job');names.add(j.name);ids.add(j.id);}
 const resolveJob=jobs.find(j=>j.name==='resolve'),job=jobs.find(j=>j.name==='selected-tests');
 assert(resolveJob.conclusion==='success'&&['success','failure'].includes(job.conclusion),'Unexecuted focused checks');
 assert(Date.parse(job.started_at)>=start&&Date.parse(job.completed_at)>=Date.parse(job.started_at)&&Date.parse(job.completed_at)<=end,'Invalid focused producing time');
 const matches=artifacts.filter(a=>a.name===ARTIFACT);assert(matches.length===1,'Missing/duplicate focused artifact');const a=matches[0],w=a.workflow_run;
 assert(a.expired===false&&Number.isSafeInteger(a.id)&&a.id>0&&Number.isSafeInteger(a.size_in_bytes)&&a.size_in_bytes>0&&a.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(a.digest??''),'Invalid focused archive');
 assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===expected.controller&&w.head_branch===run.head_branch,'Focused artifact origin differs');
 assert(Date.parse(a.created_at)>=Date.parse(job.started_at)&&Date.parse(a.created_at)<=Date.parse(job.completed_at)&&Date.parse(a.expires_at)>now,'Focused artifact time differs');
 return {artifact:a,job};
}
export async function authenticateFocusedFiles({repository,expected,runtime,outputParent,prefetchDirectory}){
 const first=fetchGitHubRunSnapshot(expected.runId),origin=inspectFocusedInventory({expected,...first});
 const dir=join(resolve(outputParent),'focused-'+expected.runId+'-'+randomUUID());mkdirSync(dir,{recursive:true,mode:0o700});
 const save=(n,v)=>writeFileSync(join(dir,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});save('first-api-snapshot.json',first);
 try{
  save('transport.json',await downloadCiArchives([origin.artifact],dir,{prefetchDirectory}));const archive=join(dir,ARTIFACT+'.zip');readCiArchive(origin.artifact,archive);
  const extracted=join(dir,'evidence');execFileSync('python3',[fileURLToPath(new URL('./extract-focused.py',import.meta.url)),archive,extracted],{timeout:10000,stdio:'pipe'});
  const report=JSON.parse(readFileSync(join(extracted,'focused.json'))),files=parseSelection(JSON.stringify(report.files));
  const reconstructed=immutablePlan({repository,candidate:expected.candidate,controller:expected.controller,baseline:expected.baseline,runtime}),plan=reconstructed.plan;
  assert(files.every(f=>plan.suite.includes(f)),'Focused selection absent from immutable source');
  const groups={NODB:[],DB:[]};for(const f of files){const u=plan.units.find(u=>u.files.includes(f));assert(u&&['db','nodb'].includes(u.kind),'Unknown focused classification');groups[u.kind==='db'?'DB':'NODB'].push(f);}
  const classifier=execFileSync('git',['-C',repository,'show',expected.candidate+':scripts/gate-db-classify.ts']);
  const trusted=execFileSync('git',['-C',repository,'show',expected.controller+':scripts/gate-db-classify.ts']);assert(classifier.equals(trusted),'Candidate classifier differs from trusted historical controller');
  const wanted=new Set(['focused.json',...Object.entries(groups).filter(([,fs])=>fs.length).map(([kind])=>kind.toLowerCase()+'.vitest.json')]);
  for(const name of ['nodb.vitest.json','db.vitest.json'])assert(existsSync(join(extracted,name))===wanted.has(name),'Extra/missing raw focused group');
  const results=new Map(Object.entries(groups).filter(([,fs])=>fs.length).map(([kind])=>[kind,JSON.parse(readFileSync(join(extracted,kind.toLowerCase()+'.vitest.json')))]));
  const outcome=inspectFocusedFiles({report,results,expected:{...expected,runtime,files,groups,classifierHash:createHash('sha256').update(classifier).digest('hex')},postgresExecution:plan.execution});
  assert(origin.job.conclusion===(report.exitCode?'failure':'success'),'Focused job and report outcome differ');
  assert(Date.parse(report.startedAt)>=Date.parse(origin.job.started_at)&&Date.parse(report.endedAt)<=Date.parse(origin.job.completed_at),'Focused report outside job');
  if(groups.DB.length){const cleanup=origin.job.steps?.filter(s=>s.name==='Ensure owned database cleanup after interrupted checks');assert(cleanup?.length===1&&cleanup[0].status==='completed'&&cleanup[0].conclusion==='success','Focused owned database cleanup unproven');}
  const second=fetchGitHubRunSnapshot(expected.runId);const finalOrigin=inspectFocusedInventory({expected,...second});assert(isDeepStrictEqual(origin.job.steps,finalOrigin.job.steps),'Focused cleanup/step outcomes changed');assert(isDeepStrictEqual(githubSnapshotIdentity(first),githubSnapshotIdentity(second)),'Focused GitHub origin changed');save('final-api-snapshot.json',second);
  const result={...outcome,kind:'AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE',sourceBinding:reconstructed.binding,origin:{...expected,artifactId:origin.artifact.id,digest:origin.artifact.digest,jobId:origin.job.id},apiRevalidatedAt:new Date().toISOString(),evidenceDirectory:dir};save('authentication.json',result);return result;
 }catch(error){save('refusal.json',{releaseAuthorized:false,error:String(error.message)});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [repository,run,candidate,controller,baseline,outputParent,prefetchDirectory]=process.argv.slice(2);
 authenticateFocusedFiles({repository,expected:{runId:Number(run),candidate,controller,baseline},runtime:{node:'22.23.3',platform:'linux',arch:'x64'},outputParent,prefetchDirectory}).then(r=>console.log(JSON.stringify({kind:r.kind,originalFocusedExitCode:r.originalFocusedExitCode,passingFiles:r.passingFiles,failedFiles:r.failedFiles,evidenceDirectory:r.evidenceDirectory}))).catch(e=>{console.error(e);process.exitCode=1;});
}
