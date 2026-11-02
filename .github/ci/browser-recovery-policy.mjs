/** Exact-source Firefox capacity recovery. Original failure and both plan identities remain intact. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {REPOSITORY,REPOSITORY_ID} from './release-policy.mjs';
export const BROWSER_RECOVERY_POLICY='aihr-browser-capacity-recovery/v2';
export const BROWSER_IMAGE='mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
export const BROWSER_WORKFLOW_ID=395862646;
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
export function validateBrowserMetadata({run,jobs,artifacts,expected,now=Date.now()}){
 assert(positive(expected.runId)&&sha(expected.controller)&&/^codex\/[A-Za-z0-9._/-]+$/.test(expected.branch)&&!expected.branch.includes('..'),'Exact reviewed recovery producer required');
 assert(run.id===expected.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign browser producer');
 assert(run.workflow_id===BROWSER_WORKFLOW_ID&&run.path==='.github/workflows/alpha-staging-browser-checks.yml'&&run.event==='workflow_dispatch'&&run.head_sha===expected.controller&&run.head_branch===expected.branch,'Unexpected browser controller/workflow');
 assert(run.display_title===`Tooling transport only · ${expected.candidateBranch}`&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Exact successful first-attempt browser producer required');
 const created=Date.parse(run.created_at),finished=Date.parse(run.updated_at);
 assert(Number.isFinite(created)&&Number.isFinite(finished)&&created>=Date.parse(expected.after)&&created<=finished&&finished<=now+60000&&now-created<=86400000,'Browser recovery chronology differs');
 const names=['resolve','tooling','operator-transport','browser-image (firefox)'];
 assert(jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length&&new Set(jobs.map(j=>j.id)).size===names.length,'Exact Firefox-only job inventory required');
 for(const j of jobs){
  assert(names.includes(j.name)&&positive(j.id)&&j.run_id===run.id&&j.run_attempt===1&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.status==='completed','Foreign/incomplete browser job');
  assert(j.conclusion===(['resolve','browser-image (firefox)'].includes(j.name)?'success':'skipped'),'Unexpected browser job result');
  if(j.conclusion==='success')assert(Date.parse(j.started_at)>=created&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=finished,'Browser job outside run');
 }
 const producer=jobs.find(j=>j.name==='browser-image (firefox)');
 assert(producer.steps?.some(s=>s.name==='Complete original browser unit in pinned image'&&s.conclusion==='success'),'Full Firefox execution missing');
 const allowed=['browser-recovery-runtime-firefox','diagnostic-complete-image-browser-firefox'];
 assert(artifacts.length===2&&new Set(artifacts.map(a=>a.name)).size===2&&new Set(artifacts.map(a=>a.id)).size===2,'Exact recovery artifacts required');
 for(const a of artifacts){const w=a.workflow_run;
  assert(allowed.includes(a.name)&&positive(a.id)&&positive(a.size_in_bytes)&&a.size_in_bytes<=64*1024**2&&a.expired===false&&/^sha256:[a-f0-9]{64}$/.test(a.digest??''),'Invalid browser artifact');
  assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Foreign browser artifact');
  assert(Date.parse(a.created_at)>=Date.parse(producer.started_at)&&Date.parse(a.created_at)<=Date.parse(producer.completed_at)&&Date.parse(a.expires_at)>now,'Browser artifact outside producer');
 }
 return producer;
}
export function verifyBrowserRecovery({plan,freshPlan,assessment,run,jobs,reports,fresh,verificationController,verificationDiagnostic,producerDiagnostic,reviewedController=null,lockSha256}){
 assert(sha(verificationController)&&verificationDiagnostic?.controller===verificationController&&positive(verificationDiagnostic.runId),'Hosted recovery verifier controls missing');
 for(const p of [plan,freshPlan]){const {fingerprint,...body}=p;assert(fingerprint===hash(body),'Invalid browser plan fingerprint');}
 assert(sha(freshPlan.controller)&&freshPlan.controller===fresh.run.head_sha&&producerDiagnostic?.controller===freshPlan.controller&&positive(producerDiagnostic.runId),'Fresh producer must retain its own validated controller identity');
 assert(reviewedController===null||reviewedController===verificationController,'Reviewed verifier changed');
 const {fingerprint:a,controller:b,...originalBody}=plan,{fingerprint:c,controller:d,...freshBody}=freshPlan;same(originalBody,freshBody,'Browser recovery changed source, coverage, runtime or execution');
 same(plan.runtime,{node:'22.23.3',platform:'linux',arch:'x64'},'Browser runtime changed');
 assert(run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1&&assessment.sourceRun?.id===run.id&&assessment.sha===plan.sha&&assessment.controller===plan.controller&&assessment.baseline===plan.migrationBase&&assessment.fingerprint===plan.fingerprint,'Original authenticated failure identity required');
 same(assessment.rerun.map(x=>x.id),['browser-firefox'],'Only a failed Firefox capacity unit can be recovered');
 assert(assessment.reusable.length===plan.units.length-1&&new Set(assessment.reusable.map(x=>x.id)).size===assessment.reusable.length,'Retained coverage incomplete');
 const required=requiredEvidence(plan);
 for(const j of jobs){assert(required.jobs.includes(j.name)||(j.name==='runner-diagnostics'&&j.conclusion==='skipped'),'Unknown original job');assert(j.conclusion===(['browser (firefox)','verify'].includes(j.name)?'failure':j.name==='runner-diagnostics'?'skipped':'success'),'Failed prerequisite cannot be recovered with Firefox');}
 assert(reports.length===plan.units.length&&new Set(reports.map(r=>r.id)).size===reports.length,'Complete original reports required');
 const failed=reports.find(r=>r.id==='browser-firefox'),unit=plan.units.find(u=>u.id==='browser-firefox');
 assert(failed&&unit?.kind==='browser'&&unit.engine==='firefox'&&failed.schemaVersion===1&&failed.sha===plan.sha&&failed.fingerprint===plan.fingerprint&&failed.exitCode===1,'Original Firefox failure differs');
 same(failed.files,unit.files,'Original Firefox coverage differs');same(failed.batches,[],'Capacity recovery cannot replace any executed test failure');
 assert(failed.healthBefore?.ok===false&&Number.isSafeInteger(failed.healthBefore.availableDiskBytes)&&failed.healthBefore.availableDiskBytes>=0&&failed.healthBefore.availableDiskBytes<20*1024**3&&failed.error?.startsWith('Error: Runner disk headroom too low: '),'Original failure was not the unchanged disk guard');
 same(failed.healthBefore.reasons,['Less than 20 GiB available on the worktree volume'],'Non-capacity failure requires independent repair');
 const binding=fresh.binding;
 assert(binding.kind==='PINNED_OFFICIAL_IMAGE_TOOLING_NOT_TEST_OR_RELEASE_PASS'&&binding.releaseAuthorized===false&&binding.image===BROWSER_IMAGE&&binding.playwrightVersion==='1.62.1'&&binding.nodeVersion==='22.23.3'&&binding.candidate===plan.sha&&binding.controller===freshPlan.controller&&binding.baseline===plan.migrationBase&&binding.engine==='firefox'&&binding.runId===String(fresh.run.id)&&binding.attempt==='1'&&binding.lockSha256===lockSha256,'Pinned browser runtime/source binding differs');
 same(binding.runtime,plan.runtime,'Actual Firefox runtime differs');assert(binding.lang==='en_US.UTF-8'&&binding.tz==='Asia/Kuala_Lumpur'&&binding.browsersPath==='/ms-playwright','Browser locale/environment differs');
 const report=fresh.report;assert(report.id==='browser-firefox'&&!report.error,'Fresh Firefox process failed');
 for(const h of [report.healthBefore,report.healthAfter])assert(h?.platform==='linux'&&h.ok===true&&Number.isSafeInteger(h.availableDiskBytes)&&h.availableDiskBytes>=20*1024**3&&h.reasons?.length===0&&Date.parse(h.at)>=Date.parse(fresh.producer.started_at)&&Date.parse(h.at)<=Date.parse(fresh.producer.completed_at),'Fresh Firefox health/chronology failed');
 const replacement=verifyUnitReport(freshPlan,report);
 const units=plan.units.map(u=>{
  if(u.id==='browser-firefox')return {id:u.id,kind:'browser-capacity-recovery',originalReportHash:hash(failed),reportHash:hash(report),tests:replacement.tests,files:replacement.files,source:{runId:fresh.run.id,attempt:1,controller:freshPlan.controller,jobId:fresh.producer.id,artifacts:fresh.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest})).sort((a,b)=>a.name.localeCompare(b.name))}};
  const r=reports.find(r=>r.id===u.id),v=verifyUnitReport(plan,r),s=assessment.reusable.find(s=>s.id===u.id);assert(s?.reportHash===hash(r)&&s.source?.runId===run.id,'Retained unit provenance changed');return {id:u.id,kind:'retained',reportHash:hash(r),tests:v.tests,files:v.files,source:s.source};
 });
 return {kind:'AUTHENTICATED_BROWSER_CAPACITY_RECOVERY',recoveryPolicy:BROWSER_RECOVERY_POLICY,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,verificationDiagnostic,browserProducerController:freshPlan.controller,producerDiagnostic,reviewedController,pendingReview:reviewedController!==verificationController,releaseAuthorized:false,baseline:plan.migrationBase,runId:run.id,originalConclusion:'failure',originalFailureObservations:assessment.observations,sourceFingerprint:plan.fingerprint,replacementFingerprint:freshPlan.fingerprint,browserRunId:fresh.run.id,units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests:units.reduce((n,u)=>n+u.tests,0)};
}

/** Frozen reviewed operator controller only; the existing receiver's exact grant format is unchanged. */
export function requireReviewedBrowserController({execute,controller,reviewedController}){
 if(execute)assert(sha(controller)&&reviewedController===controller,'Browser recovery installation requires its exact reviewed operator controller');
}
export function validateBrowserRecoveryGrantEvidence(evidence,run){
 const c=evidence.recovery;
 assert(c?.kind==='AUTHENTICATED_BROWSER_CAPACITY_RECOVERY'&&c.recoveryPolicy===BROWSER_RECOVERY_POLICY&&c.originalConclusion==='failure'&&evidence.fingerprint===hash(c),'Authenticated v2 browser recovery certificate required');
 for(const key of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests','browserRunId'])same(evidence[key],c[key],'Browser recovery grant identity differs: '+key);
 assert(c.pendingReview===false&&c.reviewedController===c.verificationController&&c.releaseAuthorized===false,'Exact reviewed verifier required for browser recovery grant');
 assert(sha(c.verificationController)&&sha(c.browserProducerController)&&c.verificationDiagnostic?.controller===c.verificationController&&positive(c.verificationDiagnostic.runId)&&c.producerDiagnostic?.controller===c.browserProducerController&&positive(c.producerDiagnostic.runId),'Both hosted controller validations required');
 assert(c.runId===run.id&&c.controller===run.head_sha&&run.status==='completed'&&run.conclusion==='failure'&&run.run_attempt===1&&positive(c.browserRunId),'Original failed run and browser provenance required');
 assert(c.units?.filter(u=>u.kind==='browser-capacity-recovery').length===1&&c.units.find(u=>u.kind==='browser-capacity-recovery').source?.runId===c.browserRunId&&c.units.find(u=>u.kind==='browser-capacity-recovery').source?.controller===c.browserProducerController,'Unique original Firefox replacement required');
 return true;
}
