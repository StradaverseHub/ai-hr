/** Complete, immutable-controller browser suite transport; never a standalone release receipt. */
import assert from 'node:assert/strict';
import {REPOSITORY,REPOSITORY_ID} from './release-policy.mjs';
export const BROWSER_REPAIR_WORKFLOW_ID=395862646;
export const BROWSER_REPAIR_WORKFLOW_PATH='.github/workflows/alpha-staging-browser-checks.yml';
export const BROWSER_REPAIR_IMAGE='mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
export const BROWSER_REPAIR_ENGINES=['chromium','firefox','webkit'];
export function validateBrowserRepairMetadata({run,jobs,artifacts,expected,now=Date.now()}){
 const id=x=>Number.isSafeInteger(x)&&x>0,sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
 assert(id(expected.runId)&&sha(expected.controller)&&run.id===expected.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign browser recovery execution');
 assert(run.workflow_id===BROWSER_REPAIR_WORKFLOW_ID&&run.path===BROWSER_REPAIR_WORKFLOW_PATH&&run.head_sha===expected.controller&&['main','alpha'].includes(run.head_branch)&&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success'&&run.display_title===`Tooling transport only · ${expected.candidateBranch}`,'Exact complete published browser execution required');
 const start=Date.parse(run.created_at),end=Date.parse(run.updated_at);
 assert(Number.isFinite(start)&&Number.isFinite(end)&&Number.isFinite(Date.parse(expected.after))&&start>=Date.parse(expected.after)&&end>=start&&end<=now+60000&&now-start<=86400000,'Browser execution stale or precedes completed original');
 const names=['resolve','tooling','operator-transport',...BROWSER_REPAIR_ENGINES.map(e=>`browser-image (${e})`)];
 assert(jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length&&new Set(jobs.map(j=>j.id)).size===names.length,'Complete distinct browser job inventory required');
 for(const j of jobs){
  const active=j.name==='resolve'||j.name.startsWith('browser-image (');
  assert(names.includes(j.name)&&id(j.id)&&j.run_id===run.id&&j.run_attempt===1&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.status==='completed'&&j.conclusion===(active?'success':'skipped'),'Foreign, failed or extra browser job');
  if(active)assert(Date.parse(j.started_at)>=start&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=end,'Browser job outside execution');
  if(j.name.startsWith('browser-image (')){
   const complete=j.steps?.filter(s=>s.name==='Complete original browser unit in pinned image'),probe=j.steps?.filter(s=>s.name==='Native browser launch and multilingual raster with preinstalled dependencies');
   assert(complete?.length===1&&complete[0].conclusion==='success'&&probe?.length===1&&probe[0].conclusion==='skipped','Browser install/probe/partial mode is not a complete suite');
  }
 }
 const expectedNames=BROWSER_REPAIR_ENGINES.flatMap(e=>[`diagnostic-complete-image-browser-${e}`,`diagnostic-browser-image-${e}`]);
 assert(artifacts.length===6&&new Set(artifacts.map(a=>a.name)).size===6&&new Set(artifacts.map(a=>a.id)).size===6,'All six original browser archives required');
 const bindings=[];
 for(const engine of BROWSER_REPAIR_ENGINES){
  const producer=jobs.find(j=>j.name===`browser-image (${engine})`),selected=[];
  for(const name of [`diagnostic-complete-image-browser-${engine}`,`diagnostic-browser-image-${engine}`]){
   const a=artifacts.find(a=>a.name===name),w=a?.workflow_run;
   assert(a&&expectedNames.includes(a.name)&&id(a.id)&&id(a.size_in_bytes)&&a.size_in_bytes<=64*1024**2&&a.expired===false&&/^sha256:[a-f0-9]{64}$/.test(a.digest),'Invalid browser archive metadata');
   assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Foreign browser archive');
   assert(Date.parse(a.created_at)>=Date.parse(producer.started_at)&&Date.parse(a.created_at)<=Date.parse(producer.completed_at)&&Date.parse(a.expires_at)>now,'Browser archive outside producing job');
   selected.push(a);
  }
  bindings.push({engine,producer,artifact:selected[0],identityArtifact:selected[1]});
 }
 return bindings;
}
export function validateBrowserRepairImage({binding,sourceText,lockText,expected}){
 assert(binding?.kind==='PINNED_OFFICIAL_IMAGE_TOOLING_NOT_TEST_OR_RELEASE_PASS'&&binding.releaseAuthorized===false&&binding.image===BROWSER_REPAIR_IMAGE&&binding.playwrightVersion==='1.62.1'&&binding.nodeVersion===expected.runtime.node&&binding.candidate===expected.candidate&&binding.controller===expected.controller,'Browser image/runtime/source binding differs');
 assert(sourceText===expected.candidate+'\n'&&lockText===expected.lockSha256+'  pnpm-lock.yaml\n','Browser source or dependency bytes differ');
 return true;
}
