/** Fresh failed-file repair only; original eighteen-file passes keep their original source. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fetchGitHubRunSnapshot,githubSnapshotIdentity} from './retained-units.mjs';
import {immutablePlan} from './immutable-plan.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {RUNTIME_REPAIR as refs} from './runtime-repair-source.mjs';
const RUN=40474846420,CTRL='5ecd6ce16f64fc2586a7872e62f009dba469135c',FILE='test/atelier-mobile-navigation.browser.test.tsx',engines=['chromium','firefox','webkit'];
export function inspectBrowserRepairRecord({plan,report,raw,engine,job,tree,testBlob,configBlob}){
 assert(report.kind==='FOCUSED_BROWSER_FILE_REPAIR_NOT_RELEASE'&&report.format===1&&report.releaseAuthorized===false&&report.releaseEligible===false,'Explicit focused browser record required');
 assert(report.candidate===refs.candidate&&report.controller===CTRL&&report.baseline===refs.ciBaseline&&report.fingerprint===plan.fingerprint
  &&report.engine===engine&&report.runId===String(RUN)&&report.attempt==='1'&&report.originalFailedRun===40469625375,'Browser repair origin differs');
 assert(report.sourceTree===tree&&report.testBlob===testBlob&&report.configBlob===configBlob&&isDeepStrictEqual(report.files,[FILE]),'Browser repair immutable inputs differ');
 assert(report.runtime?.node==='22.23.3'&&report.runtime.platform==='linux'&&report.runtime.arch==='x64'&&report.healthBefore?.ok===true&&report.healthAfter?.ok===true,'Browser runtime or resource evidence differs');
 assert(report.exitCode===0&&report.processExitCode===0&&report.signal===null&&!report.error&&!report.processError&&report.assertions===5,'Actual focused browser process failed');
 assert(Date.parse(report.startedAt)>=Date.parse(job.started_at)&&Date.parse(report.endedAt)>=Date.parse(report.startedAt)&&Date.parse(report.endedAt)<=Date.parse(job.completed_at),'Browser repair report outside actual producing job');
 assert(raw.success===true&&raw.numTotalTests===5&&raw.numPassedTests===5&&raw.numFailedTests===0&&raw.numFailedTestSuites===0&&raw.numPendingTests===0&&raw.numTodoTests===0,'All five actual browser cases must pass');
 assert(raw.testResults?.length===1&&raw.testResults[0].name.endsWith('/'+FILE)&&raw.testResults[0].status==='passed','Only the failed browser file may execute');
 const cases=raw.testResults[0].assertionResults;assert(cases?.length===5&&cases.every(c=>c.status==='passed'&&typeof c.fullName==='string')&&new Set(cases.map(c=>c.fullName)).size===5,'Five distinct browser assertions required');
 return {engine,path:FILE,state:'PASSED',passingAssertions:5,failedAssertions:0,originCandidate:refs.candidate,batchProcessExitCode:0,rawFileHash:installHash(installJson(raw.testResults[0]))};
}
function inventory(snapshot,now=Date.now()){
 const {run,jobs,artifacts}=snapshot;
 assert(run.id===RUN&&run.repository?.id===1333414856&&run.repository.full_name==='StradaverseHub/ai-hr'&&run.head_repository?.id===1333414856&&run.head_sha===CTRL&&run.head_branch==='codex/board-eight-browser-failed-only-image-20261027'
  &&run.workflow_id===395862646&&run.path==='.github/workflows/alpha-staging-browser-checks.yml'&&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Exact successful browser repair workflow required');
 assert(Date.parse(run.created_at)<=Date.parse(run.updated_at)&&Date.parse(run.updated_at)<=now+60000&&now-Date.parse(run.created_at)<=86400000,'Browser repair evidence expired');
 const names=['resolve','tooling','operator-transport',...engines.map(e=>'browser-image ('+e+')')];assert(jobs.length===6&&new Set(jobs.map(j=>j.name)).size===6&&new Set(jobs.map(j=>j.id)).size===6,'Complete browser repair jobs required');
 for(const j of jobs)assert(names.includes(j.name)&&j.run_id===RUN&&j.head_sha===CTRL&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed'&&j.conclusion===(['tooling','operator-transport'].includes(j.name)?'skipped':'success'),'Unexpected browser repair job');
 const wanted=engines.flatMap(e=>['focused-browser-repair-'+e,'diagnostic-browser-image-'+e]);assert(artifacts.length===6&&new Set(artifacts.map(a=>a.name)).size===6&&new Set(artifacts.map(a=>a.id)).size===6,'Complete browser repair artifacts required');
 for(const a of artifacts){const w=a.workflow_run;assert(wanted.includes(a.name)&&a.expired===false&&w?.id===RUN&&w.repository_id===1333414856&&w.head_repository_id===1333414856&&w.head_sha===CTRL&&w.head_branch===run.head_branch,'Foreign browser repair archive');}
 return engines.map(engine=>{const job=jobs.find(j=>j.name==='browser-image ('+engine+')'),artifact=artifacts.find(a=>a.name==='focused-browser-repair-'+engine);
  assert(Date.parse(job.started_at)>=Date.parse(run.created_at)&&Date.parse(job.completed_at)<=Date.parse(run.updated_at)&&Date.parse(artifact.created_at)>=Date.parse(job.started_at)&&Date.parse(artifact.created_at)<=Date.parse(job.completed_at),'Browser repair archive chronology differs');
  for(const name of ['Bind source and exact preinstalled Playwright runtime','Execute only the original failed browser file'])assert(job.steps.filter(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success').length===1,'Actual focused browser step missing');
  return {engine,job,artifact};});
}
export async function authenticateBrowserRepair({repository,outputParent,prefetchDirectory}){
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',maxBuffer:1024**2}).trim();
 assert(git('rev-parse',CTRL+'^')===refs.staging,'Reviewed browser repair controller parent differs');
 assert(git('diff','--name-only',refs.staging,CTRL)===['.github/ci/browser-file-repair.mjs','.github/ci/browser-file-repair.test.mjs','.github/workflows/alpha-staging-browser-checks.yml'].join('\n'),'Reviewed browser repair controller boundary differs');
 const {plan,binding}=immutablePlan({repository,candidate:refs.candidate,controller:CTRL,baseline:refs.ciBaseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'}});
 const first=fetchGitHubRunSnapshot(RUN),rows=inventory(first),directory=join(outputParent,'browser-repair-'+RUN+'-'+randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
 const save=(n,v)=>writeFileSync(join(directory,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});save('first-api-snapshot.json',first);
 try{
  save('transport.json',await downloadCiArchives(rows.map(r=>r.artifact),directory,{prefetchDirectory}));const outcomes=[];
  for(const {engine,job,artifact} of rows){const archive=join(directory,artifact.name+'.zip');readCiArchive(artifact,archive);const target=join(directory,engine);execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),archive,target],{timeout:10000});
   assert(isDeepStrictEqual(readdirSync(target).sort(),['browser-repair.json','browser.vitest.json']),'Unexpected repair archive members');
   const report=JSON.parse(readFileSync(join(target,'browser-repair.json'))),raw=JSON.parse(readFileSync(join(target,'browser.vitest.json')));
   const outcome=inspectBrowserRepairRecord({plan,report,raw,engine,job,tree:git('rev-parse',refs.candidate+'^{tree}'),testBlob:git('rev-parse',refs.candidate+':'+FILE),configBlob:git('rev-parse',refs.candidate+':vitest.browser.config.ts')});
   outcomes.push({...outcome,origin:{runId:RUN,attempt:1,jobId:job.id,artifactId:artifact.id,digest:artifact.digest}});
  }
  const second=fetchGitHubRunSnapshot(RUN);inventory(second);assert(isDeepStrictEqual(githubSnapshotIdentity(first),githubSnapshotIdentity(second))&&isDeepStrictEqual(first.jobs,second.jobs),'Browser repair origin changed');save('final-api-snapshot.json',second);
  const result={kind:'AUTHENTICATED_FOCUSED_BROWSER_REPAIR_NOT_RELEASE',releaseAuthorized:false,sourceBinding:binding,outcomes,evidenceDirectory:directory};save('authentication.json',result);return result;
 }catch(error){save('refusal.json',{releaseAuthorized:false,error:String(error.message)});throw error;}
}
