/** Exact fresh Bonus image-suite provenance; never a complete release PASS. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fetchGitHubRunSnapshot,githubSnapshotIdentity} from './retained-units.mjs';
import {immutablePlan} from './immutable-plan.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
const RUN=40512563694,CONTROLLER='dc74b804fcecb4bab3207e82c9b9f099b9bf13be',CANDIDATE='d52563c666d39074217ed42191866add4a2793a0';
const BASELINE='2127b1a7ebd40e5b9ee7d010e72e75d4b1cb3e9f',TRUSTED='9bf924ff3389fd5f5a41c03d062a40c429216585';
const engines=['chromium','firefox','webkit'];
export function inspectBonusBrowserInventory(snapshot,now=Date.now()){
 const {run,jobs,artifacts}=snapshot;
 assert(run?.id===RUN&&run.repository?.id===1333414856&&run.repository.full_name==='StradaverseHub/ai-hr'&&run.head_repository?.id===1333414856,'Foreign original browser repository');
 assert(run.head_sha===CONTROLLER&&run.head_branch==='alpha'&&run.workflow_id===395862646&&run.path==='.github/workflows/alpha-staging-browser-checks.yml'
  &&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Wrong original browser controller or outcome');
 const began=Date.parse(run.created_at),ended=Date.parse(run.updated_at);
 assert(Number.isFinite(began)&&began<=ended&&ended<=now+60000&&now-began<=86400000,'Expired original browser evidence');
 const names=['resolve','tooling','operator-transport',...engines.map(e=>'browser-image ('+e+')')];
 assert(jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length&&new Set(jobs.map(j=>j.id)).size===names.length,'Complete original browser jobs required');
 for(const job of jobs){assert(names.includes(job.name)&&job.run_id===RUN&&job.head_sha===CONTROLLER&&job.head_branch==='alpha'&&job.run_attempt===1&&job.status==='completed','Foreign or nonterminal browser job');
  assert(job.conclusion===(job.name==='resolve'?'success':['tooling','operator-transport'].includes(job.name)?'skipped':'success'),'Original browser outcome changed');}
 const expected=engines.flatMap(e=>['diagnostic-browser-image-'+e,'diagnostic-complete-image-browser-'+e]);
 assert(artifacts.length===expected.length&&new Set(artifacts.map(a=>a.name)).size===expected.length&&new Set(artifacts.map(a=>a.id)).size===expected.length,'Complete original browser artifacts required');
 for(const a of artifacts){const w=a.workflow_run;assert(expected.includes(a.name)&&a.expired===false&&w?.id===RUN&&w.repository_id===1333414856&&w.head_repository_id===1333414856&&w.head_sha===CONTROLLER&&w.head_branch==='alpha','Foreign original browser archive');}
 return engines.map(engine=>{
  const job=jobs.find(j=>j.name==='browser-image ('+engine+')'),artifact=artifacts.find(a=>a.name==='diagnostic-complete-image-browser-'+engine);
  assert(Date.parse(job.started_at)>=began&&Date.parse(job.completed_at)<=ended&&Date.parse(artifact.created_at)>=Date.parse(job.started_at)&&Date.parse(artifact.created_at)<=Date.parse(job.completed_at),'Browser artifact chronology differs');
  for(const [name,conclusion] of [['Bind source and exact preinstalled Playwright runtime','success'],['Complete original browser unit in pinned image','success']]){
   const steps=job.steps.filter(s=>s.name===name);assert(steps.length===1&&steps[0].status==='completed'&&steps[0].conclusion===conclusion,'Original browser execution steps differ');}
  return {engine,job,artifact};
 });
}
export async function authenticateBonusBrowser({repository,outputParent}){
 const first=fetchGitHubRunSnapshot(RUN),inventory=inspectBonusBrowserInventory(first);
 const diff=execFileSync('git',['-C',repository,'diff','--name-only',TRUSTED,CONTROLLER,'--','.github/ci','.github/actions','.github/workflows/alpha-staging-browser-checks.yml'],{encoding:'utf8'});
 assert(diff==='','Actual alpha browser controller inputs differ from reviewed staging controller');
 const {plan,binding}=immutablePlan({repository,candidate:CANDIDATE,controller:CONTROLLER,baseline:BASELINE,runtime:{node:'22.23.3',platform:'linux',arch:'x64'}});
 const directory=join(resolve(outputParent),'browser-bonus-'+RUN+'-'+randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
 const save=(name,data)=>writeFileSync(join(directory,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});save('first-api-snapshot.json',first);
 try{
  save('transport.json',await downloadCiArchives(inventory.map(i=>i.artifact),directory));const outcomes=[];
  for(const {engine,job,artifact} of inventory){
   const archive=join(directory,artifact.name+'.zip');readCiArchive(artifact,archive);const extracted=join(directory,engine);
   execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),archive,extracted],{timeout:10000});
   const unit=plan.units.find(u=>u.kind==='browser'&&u.engine===engine);assert(unit,'Missing original source browser unit');
   const report=JSON.parse(readFileSync(join(extracted,'unit-'+unit.id+'.json')));
   const names=readdirSync(extracted).sort(),wanted=['health-before-'+unit.id+'.json',unit.id+'-batch-0.json','unit-'+unit.id+'.json'].sort();
   assert(isDeepStrictEqual(names,wanted),'Unexpected original browser archive members');
   assert(isDeepStrictEqual(report.batches[0].result,JSON.parse(readFileSync(join(extracted,unit.id+'-batch-0.json')))),'Raw original browser result differs');
   assert(isDeepStrictEqual(report.healthBefore,JSON.parse(readFileSync(join(extracted,'health-before-'+unit.id+'.json')))),'Original browser resource evidence differs');
   verifyUnitReport(plan,report);
   assert(report.exitCode===0&&report.batches.length===1&&report.batches[0].exitCode===0,'Actual browser process must pass');
   const files=report.batches[0].result.testResults.map(file=>{const path=file.name.slice(report.cwd.length+1);assert(file.name===report.cwd+'/'+path&&unit.files.includes(path)&&file.assertionResults.length>0&&file.assertionResults.every(c=>c.status==='passed'),'Complete passing browser assertions required');return {path,engine,state:'PASSED',passingAssertions:file.assertionResults.length,failedAssertions:0,originCandidate:CANDIDATE,rawFileHash:installHash(installJson(file))};});
   assert(isDeepStrictEqual(files.map(f=>f.path).sort(),unit.files.slice().sort()),'Actual browser membership differs');
   outcomes.push({engine,originalUnitExitCode:0,passingFiles:files.length,failedFiles:0,files,rawReportSha256:installHash(installJson(report)),origin:{runId:RUN,attempt:1,jobId:job.id,artifactId:artifact.id,digest:artifact.digest}});
  }
  const second=fetchGitHubRunSnapshot(RUN);inspectBonusBrowserInventory(second);assert(isDeepStrictEqual(githubSnapshotIdentity(first),githubSnapshotIdentity(second)),'Original browser API identity changed');
  for(const row of inventory)assert(isDeepStrictEqual(row.job.steps,second.jobs.find(j=>j.id===row.job.id)?.steps),'Original browser steps changed');
  save('final-api-snapshot.json',second);
  const result={kind:'AUTHENTICATED_FRESH_BONUS_BROWSER_FILE_OUTCOMES_NOT_RELEASE',releaseAuthorized:false,sourceBinding:binding,outcomes,directory,apiRevalidatedAt:new Date().toISOString()};save('authentication.json',result);return result;
 }catch(error){save('refusal.json',{releaseAuthorized:false,error:String(error.message)});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))authenticateBonusBrowser({repository:process.argv[2],outputParent:process.argv[3]}).then(r=>console.log(JSON.stringify({directory:r.directory,outcomes:r.outcomes.map(o=>({engine:o.engine,passingFiles:o.passingFiles,failedFiles:o.failedFiles,originalUnitExitCode:o.originalUnitExitCode}))}))).catch(e=>{console.error(e);process.exitCode=1;});
