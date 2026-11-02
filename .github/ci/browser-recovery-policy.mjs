/** Exact-source Firefox capacity recovery. Original failure and both plan identities remain intact. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {relative, isAbsolute} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {REPOSITORY,REPOSITORY_ID} from './release-policy.mjs';
export const BROWSER_RECOVERY_POLICY='aihr-browser-capacity-recovery/v2';
export const BROWSER_ASSERTION_RECOVERY_POLICY='aihr-browser-executed-assertion-recovery/v1';
export const ASSERTION_INCIDENT=Object.freeze({
 source:'a02845ba82a530ddd264f6eff1466bc106704052',
 baseline:'dfbcf85b1f03e6e3266df6244694079a98e17dc9',
 candidateBranch:'codex/board-nine-final-repair-20261103',
 runId:41526423926,firefoxJobId:125556067102,controllerJobId:125555631430,verifyJobId:125564823366,replayRunId:41529495273,
 caseInventorySha256:'62c0ff30b9b53256eff1b2b01201bf9984de7b27aa5e10937d64f7c8910dad64',
 file:'test/lifecycle-v9-html-gaps.browser.test.tsx',
 name:'repairs reference details, keyboard sections, notice and duplicate chrome in monolith dark mobile',
});
export const BROWSER_IMAGE='mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
export const BROWSER_WORKFLOW_ID=395862646;
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
export function validateBrowserMetadata({run,jobs,artifacts,expected,now=Date.now()}){
 const assertion=expected.recoveryPolicy===BROWSER_ASSERTION_RECOVERY_POLICY;
 if(assertion){
  assert(expected.runId===ASSERTION_INCIDENT.replayRunId&&expected.controller===ASSERTION_INCIDENT.source&&expected.branch==='main','Exact MAIN assertion replay required');
 }else{
 assert(positive(expected.runId)&&sha(expected.controller)&&/^codex\/[A-Za-z0-9._/-]+$/.test(expected.branch)&&!expected.branch.includes('..'),'Exact reviewed recovery producer required');
 }
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
const firefoxUnit='browser-firefox';
const expectedFailureFixture='Tailwind width utilities in a real engine SHOULD let a later width utility win over the w-full inside inputCls';

/** Vitest represents a satisfied expected-failure case as passed. Its name remains in the inventory. */
export function verifyAssertionCaseInventory({unit,original,replacement}){
 assert(unit?.id===firefoxUnit&&unit.kind==='browser'&&unit.engine==='firefox'&&unit.files.length===35,'Exact original Firefox file inventory required');
 function inventory(report,failed){
  assert(!report.error&&isAbsolute(report.cwd)&&report.batches.length===1,'One complete executed Firefox batch required');
  const [batch]=report.batches;
  const result=batch.result,failures=failed?1:0;
  assert(batch.exitCode===failures&&batch.databaseEvidence===null&&batch.databaseResourceSnapshot===null,'Unexpected Firefox batch execution');
  assert(result?.success===!failed&&result.numTotalTests===516&&result.numPassedTests===516-failures&&result.numFailedTests===failures
   &&result.numFailedTestSuites===failures&&result.numTotalTestSuites===result.numPassedTestSuites+failures
   &&result.numPendingTests===0&&result.numPendingTestSuites===0&&result.numTodoTests===0
   &&Array.isArray(result.testResults)&&result.testResults.length===35,'Incomplete or non-passing Firefox assertion inventory');
  const files=new Set(),cases=[];
  let failedCases=0,expectedFailures=0;
  for(const file of result.testResults){
   assert(typeof file.name==='string'&&isAbsolute(file.name),'Missing Firefox file path');
   const path=relative(report.cwd,file.name).split('\\').join('/');
   assert(unit.files.includes(path)&&!files.has(path),'Foreign or repeated Firefox file');
   files.add(path);
   assert(Array.isArray(file.assertionResults)&&file.assertionResults.length>0,'Missing Firefox cases');
   let fileFailures=0;
   for(const item of file.assertionResults){
    assert(typeof item.fullName==='string'&&item.fullName.length>0&&typeof item.title==='string'&&item.title.length>0
     &&Array.isArray(item.ancestorTitles)&&item.ancestorTitles.every(name=>typeof name==='string')
     &&Array.isArray(item.failureMessages),'Malformed Firefox case identity');
    if(item.status==='failed'){
     assert(failed&&path===ASSERTION_INCIDENT.file&&item.fullName===ASSERTION_INCIDENT.name
      &&item.failureMessages.some(message=>typeof message==='string'&&message.includes('__VITEST_POLL_CHAIN__')),'Unexpected Firefox assertion failure');
     fileFailures++;
     failedCases++;
    }else assert(item.status==='passed'&&item.failureMessages.length===0,'Skipped or non-passing Firefox case');
    if(path==='test/tailwind-width-order.browser.test.tsx'&&item.fullName===expectedFailureFixture)expectedFailures++;
    cases.push(JSON.stringify([path,item.fullName,item.title,item.ancestorTitles]));
   }
   assert(file.status===(fileFailures?'failed':'passed'),'Firefox file status contradicts its cases');
  }
  assert(cases.length===516&&failedCases===failures&&expectedFailures===1,'Firefox execution or expected-failure coverage differs');
  return cases.sort();
 }
 const originalCases=inventory(original,true),replacementCases=inventory(replacement,false);
 same(originalCases,replacementCases,'Firefox case multiset changed');
 return {path:ASSERTION_INCIDENT.file,fullName:ASSERTION_INCIDENT.name,files:35,cases:516,caseInventorySha256:hash(originalCases)};
}

export function originalAssertionProducer(run,jobs){
 assert(run.id===ASSERTION_INCIDENT.runId&&run.head_sha===ASSERTION_INCIDENT.source&&run.head_branch==='main','Exact original MAIN assertion run required');
 const integrity=jobs.find(job=>job.name==='controller-tests'),firefox=jobs.find(job=>job.name==='browser (firefox)'),verify=jobs.find(job=>job.name==='verify');
 for(const [job,id,status] of [[integrity,ASSERTION_INCIDENT.controllerJobId,'success'],[firefox,ASSERTION_INCIDENT.firefoxJobId,'failure'],[verify,ASSERTION_INCIDENT.verifyJobId,'failure']]){
  assert(job?.id===id&&job.run_id===run.id&&job.run_attempt===1&&job.head_sha===run.head_sha
   &&job.head_branch==='main'&&job.status==='completed'&&job.conclusion===status,'Original assertion producer identity differs');
 }
 assert(integrity.steps?.some(step=>step.name==='Owned Linux install cleanup and immutable byte inventory controls'&&step.conclusion==='success')
  &&integrity.steps?.some(step=>step.name==='Exercise actual official detached-deploy helpers with shim transport'&&step.conclusion==='success')
  &&firefox.steps?.some(step=>step.name==='Run ./automation/.github/actions/setup-browser-image'&&step.conclusion==='success')
  &&firefox.steps?.some(step=>step.name==='Run node ../automation/.github/ci/run-unit.mjs "browser-$ENGINE" "$RUNNER_TEMP/aihr-ci"'&&step.conclusion==='failure')
  &&firefox.steps?.some(step=>step.name==='Run actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'&&step.conclusion==='success')
  &&verify.steps?.some(step=>step.name==='Every prerequisite succeeded'&&step.conclusion==='failure')
  &&verify.steps?.some(step=>step.name==='Run node ../automation/.github/ci/verify-shards.mjs "$RUNNER_TEMP/aihr-ci" "$RUNNER_TEMP/ci-receipt.json"'&&step.conclusion==='skipped'),'Original assertion producer steps differ');
 return {kind:'original-full-controller-tests',controller:run.head_sha,runId:run.id,jobId:integrity.id};
}

export function verifyBrowserRecovery({plan,freshPlan,assessment,run,jobs,reports,fresh,verificationController,verificationDiagnostic,producerDiagnostic,reviewedController=null,lockSha256,recoveryPolicy=BROWSER_RECOVERY_POLICY}){
 const assertion=recoveryPolicy===BROWSER_ASSERTION_RECOVERY_POLICY;
 assert(assertion||recoveryPolicy===BROWSER_RECOVERY_POLICY,'Unknown browser recovery policy');
 if(assertion){
  assert(plan.sha===ASSERTION_INCIDENT.source&&plan.controller===plan.sha&&plan.migrationBase===ASSERTION_INCIDENT.baseline
   &&freshPlan.fingerprint===plan.fingerprint&&fresh.run.id===ASSERTION_INCIDENT.replayRunId&&fresh.run.head_branch==='main'
   &&plan.units.length===75&&jobs.length===84,'Assertion replay source, baseline or complete plan differs');
  assert(verificationController!==plan.controller&&reviewedController===verificationController,'Separately reviewed assertion verifier required');
  same(producerDiagnostic,originalAssertionProducer(run,jobs),'Original producer proof differs');
  same(fresh.producer,validateBrowserMetadata({...fresh,expected:{runId:ASSERTION_INCIDENT.replayRunId,controller:plan.controller,branch:'main',candidateBranch:ASSERTION_INCIDENT.candidateBranch,after:run.updated_at,recoveryPolicy}}),'Fresh assertion producer differs');
 }
 assert(sha(verificationController)&&verificationDiagnostic?.controller===verificationController&&positive(verificationDiagnostic.runId),'Hosted recovery verifier controls missing');
 for(const p of [plan,freshPlan]){const {fingerprint,...body}=p;assert(fingerprint===hash(body),'Invalid browser plan fingerprint');}
 assert(sha(freshPlan.controller)&&freshPlan.controller===fresh.run.head_sha&&producerDiagnostic?.controller===freshPlan.controller&&positive(producerDiagnostic.runId),'Fresh producer must retain its own validated controller identity');
 assert(reviewedController===null||reviewedController===verificationController,'Reviewed verifier changed');
 const {fingerprint:a,controller:b,...originalBody}=plan,{fingerprint:c,controller:d,...freshBody}=freshPlan;same(originalBody,freshBody,'Browser recovery changed source, coverage, runtime or execution');
 same(plan.runtime,{node:'22.23.3',platform:'linux',arch:'x64'},'Browser runtime changed');
 assert(run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1&&assessment.sourceRun?.id===run.id&&assessment.sha===plan.sha&&assessment.controller===plan.controller&&assessment.baseline===plan.migrationBase&&assessment.fingerprint===plan.fingerprint,'Original authenticated failure identity required');
 same(assessment.rerun.map(x=>x.id),['browser-firefox'],assertion?'Only the recorded Firefox assertion unit can be recovered':'Only a failed Firefox capacity unit can be recovered');
 assert(assessment.reusable.length===plan.units.length-1&&new Set(assessment.reusable.map(x=>x.id)).size===assessment.reusable.length,'Retained coverage incomplete');
 const required=requiredEvidence(plan);
 for(const j of jobs){assert(required.jobs.includes(j.name)||(j.name==='runner-diagnostics'&&j.conclusion==='skipped'),'Unknown original job');assert(j.conclusion===(['browser (firefox)','verify'].includes(j.name)?'failure':j.name==='runner-diagnostics'?'skipped':'success'),'Failed prerequisite cannot be recovered with Firefox');}
 assert(reports.length===plan.units.length&&new Set(reports.map(r=>r.id)).size===reports.length,'Complete original reports required');
 const failed=reports.find(r=>r.id==='browser-firefox'),unit=plan.units.find(u=>u.id==='browser-firefox');
 assert(failed&&unit?.kind==='browser'&&unit.engine==='firefox'&&failed.schemaVersion===1&&failed.sha===plan.sha&&failed.fingerprint===plan.fingerprint&&failed.exitCode===1,'Original Firefox failure differs');
 same(failed.files,unit.files,'Original Firefox coverage differs');
 if(!assertion){
  same(failed.batches,[],'Capacity recovery cannot replace any executed test failure');
  assert(failed.healthBefore?.ok===false&&Number.isSafeInteger(failed.healthBefore.availableDiskBytes)&&failed.healthBefore.availableDiskBytes>=0&&failed.healthBefore.availableDiskBytes<20*1024**3&&failed.error?.startsWith('Error: Runner disk headroom too low: '),'Original failure was not the unchanged disk guard');
  same(failed.healthBefore.reasons,['Less than 20 GiB available on the worktree volume'],'Non-capacity failure requires independent repair');
 }
 const binding=fresh.binding;
 assert(binding.kind==='PINNED_OFFICIAL_IMAGE_TOOLING_NOT_TEST_OR_RELEASE_PASS'&&binding.releaseAuthorized===false&&binding.image===BROWSER_IMAGE&&binding.playwrightVersion==='1.62.1'&&binding.nodeVersion==='22.23.3'&&binding.candidate===plan.sha&&binding.controller===freshPlan.controller&&binding.baseline===plan.migrationBase&&binding.engine==='firefox'&&binding.runId===String(fresh.run.id)&&binding.attempt==='1'&&binding.lockSha256===lockSha256,'Pinned browser runtime/source binding differs');
 same(binding.runtime,plan.runtime,'Actual Firefox runtime differs');assert(binding.lang==='en_US.UTF-8'&&binding.tz==='Asia/Kuala_Lumpur'&&binding.browsersPath==='/ms-playwright','Browser locale/environment differs');
 const report=fresh.report;assert(report.id==='browser-firefox'&&!report.error,'Fresh Firefox process failed');
 for(const h of [report.healthBefore,report.healthAfter])assert(h?.platform==='linux'&&h.ok===true&&Number.isSafeInteger(h.availableDiskBytes)&&h.availableDiskBytes>=20*1024**3&&h.reasons?.length===0&&Date.parse(h.at)>=Date.parse(fresh.producer.started_at)&&Date.parse(h.at)<=Date.parse(fresh.producer.completed_at),'Fresh Firefox health/chronology failed');
 const replacement=verifyUnitReport(freshPlan,report);
 let originalFirefoxAssertion;
 if(assertion){
  const originalJob=jobs.find(job=>job.id===ASSERTION_INCIDENT.firefoxJobId);
  for(const h of [failed.healthBefore,failed.healthAfter])assert(h?.platform==='linux'&&h.ok===true&&Number.isSafeInteger(h.availableDiskBytes)&&h.availableDiskBytes>=20*1024**3&&h.reasons?.length===0&&Date.parse(h.at)>=Date.parse(originalJob.started_at)&&Date.parse(h.at)<=Date.parse(originalJob.completed_at),'Original Firefox health/chronology failed');
  originalFirefoxAssertion=verifyAssertionCaseInventory({unit,original:failed,replacement:report});
  assert(originalFirefoxAssertion.caseInventorySha256===ASSERTION_INCIDENT.caseInventorySha256,'Original incident case inventory differs');
  const observation=assessment.observations.find(row=>row.id===firefoxUnit);
  assert(observation?.jobId===originalJob.id&&observation.conclusion==='failure'&&positive(observation.artifact?.id)
   &&/^sha256:[a-f0-9]{64}$/.test(observation.artifact?.digest??''),'Original failed Firefox artifact provenance required');
  originalFirefoxAssertion={...originalFirefoxAssertion,source:{runId:run.id,attempt:1,controller:plan.controller,jobId:originalJob.id,artifact:observation.artifact}};
 }

 const units=plan.units.map(u=>{
  if(u.id==='browser-firefox')return {id:u.id,kind:assertion?'browser-assertion-recovery':'browser-capacity-recovery',originalReportHash:hash(failed),reportHash:hash(report),tests:replacement.tests,files:replacement.files,source:{runId:fresh.run.id,attempt:1,controller:freshPlan.controller,jobId:fresh.producer.id,artifacts:fresh.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest})).sort((a,b)=>a.name.localeCompare(b.name))}};
  const r=reports.find(r=>r.id===u.id),v=verifyUnitReport(plan,r),s=assessment.reusable.find(s=>s.id===u.id);assert(s?.reportHash===hash(r)&&s.source?.runId===run.id,'Retained unit provenance changed');return {id:u.id,kind:'retained',reportHash:hash(r),tests:v.tests,files:v.files,source:s.source};
 });
 return {kind:assertion?'AUTHENTICATED_BROWSER_ASSERTION_RECOVERY':'AUTHENTICATED_BROWSER_CAPACITY_RECOVERY',recoveryPolicy,...(assertion?{originalFirefoxAssertion}:{}),policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,verificationDiagnostic,browserProducerController:freshPlan.controller,producerDiagnostic,reviewedController,pendingReview:reviewedController!==verificationController,releaseAuthorized:false,baseline:plan.migrationBase,runId:run.id,originalConclusion:'failure',originalFailureObservations:assessment.observations,sourceFingerprint:plan.fingerprint,replacementFingerprint:freshPlan.fingerprint,browserRunId:fresh.run.id,units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests:units.reduce((n,u)=>n+u.tests,0)};
}

/** Frozen reviewed operator controller only; the existing receiver's exact grant format is unchanged. */
export function requireReviewedBrowserController({execute,controller,reviewedController}){
 if(execute)assert(sha(controller)&&reviewedController===controller,'Browser recovery installation requires its exact reviewed operator controller');
}
export function validateBrowserRecoveryGrantEvidence(evidence,run){
 const c=evidence.recovery;
 const assertion=c?.recoveryPolicy===BROWSER_ASSERTION_RECOVERY_POLICY;
 assert(c?.kind===(assertion?'AUTHENTICATED_BROWSER_ASSERTION_RECOVERY':'AUTHENTICATED_BROWSER_CAPACITY_RECOVERY')
  &&(assertion||c.recoveryPolicy===BROWSER_RECOVERY_POLICY)&&c.originalConclusion==='failure'&&evidence.fingerprint===hash(c),assertion?'Authenticated assertion recovery certificate required':'Authenticated v2 browser recovery certificate required');
 if(assertion){
  assert(c.sha===ASSERTION_INCIDENT.source&&c.controller===c.sha&&c.browserProducerController===c.sha
   &&c.baseline===ASSERTION_INCIDENT.baseline&&c.runId===ASSERTION_INCIDENT.runId&&run.head_branch==='main'
   &&c.browserRunId===ASSERTION_INCIDENT.replayRunId&&/^[a-f0-9]{64}$/.test(c.sourceFingerprint??'')&&c.sourceFingerprint===c.replacementFingerprint
   &&c.verificationController!==c.controller&&c.units?.length===75,'Closed assertion grant identity differs');
  same(c.producerDiagnostic,{kind:'original-full-controller-tests',controller:c.controller,runId:c.runId,jobId:ASSERTION_INCIDENT.controllerJobId},'Original controller proof differs');
  assert(new Set(c.units.map(unit=>unit.id)).size===75,'Assertion recovery unit inventory differs');
  const retained=c.units.filter(unit=>unit.kind==='retained');
  assert(retained.length===74&&retained.every(unit=>unit.source?.runId===c.runId&&unit.source.attempt===1
   &&positive(unit.source.jobId)&&positive(unit.source.artifactId)&&/^sha256:[a-f0-9]{64}$/.test(unit.source.digest??'')),'Retained original unit provenance required');
  const replay=c.units.find(unit=>unit.id===firefoxUnit);
  assert(replay?.kind==='browser-assertion-recovery'&&replay.tests===516&&replay.files?.length===35
   &&/^[a-f0-9]{64}$/.test(replay.originalReportHash??'')&&/^[a-f0-9]{64}$/.test(replay.reportHash??'')
   &&replay.source?.attempt===1&&positive(replay.source.jobId),'Exact replay report provenance required');
  const artifacts=replay.source.artifacts;
  assert(Array.isArray(artifacts)&&artifacts.length===2&&new Set(artifacts.map(artifact=>artifact.id)).size===2
   &&artifacts.every(artifact=>positive(artifact.id)&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest??'')),'Exact replay artifact provenance required');
  same(artifacts.map(artifact=>artifact.name),['browser-recovery-runtime-firefox','diagnostic-complete-image-browser-firefox'],'Exact replay artifact names required');
  const witness=c.originalFirefoxAssertion;
  assert(witness?.path===ASSERTION_INCIDENT.file&&witness.fullName===ASSERTION_INCIDENT.name&&witness.files===35
   &&witness.cases===516&&witness.caseInventorySha256===ASSERTION_INCIDENT.caseInventorySha256
   &&witness.source?.runId===c.runId&&witness.source.attempt===1&&witness.source.controller===c.controller
   &&witness.source.jobId===ASSERTION_INCIDENT.firefoxJobId&&positive(witness.source.artifact?.id)
   &&/^sha256:[a-f0-9]{64}$/.test(witness.source.artifact?.digest??''),'Exact assertion coverage witness required');
 }
 for(const key of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests','browserRunId'])same(evidence[key],c[key],'Browser recovery grant identity differs: '+key);
 assert(c.pendingReview===false&&c.reviewedController===c.verificationController&&c.releaseAuthorized===false,'Exact reviewed verifier required for browser recovery grant');
 assert(sha(c.verificationController)&&sha(c.browserProducerController)&&c.verificationDiagnostic?.controller===c.verificationController&&positive(c.verificationDiagnostic.runId)&&c.producerDiagnostic?.controller===c.browserProducerController&&positive(c.producerDiagnostic.runId),'Both hosted controller validations required');
 assert(c.runId===run.id&&c.controller===run.head_sha&&run.status==='completed'&&run.conclusion==='failure'&&run.run_attempt===1&&positive(c.browserRunId),'Original failed run and browser provenance required');
 const unitKind=assertion?'browser-assertion-recovery':'browser-capacity-recovery';
 assert(c.units?.filter(u=>u.kind===unitKind).length===1&&c.units.find(u=>u.kind===unitKind).source?.runId===c.browserRunId&&c.units.find(u=>u.kind===unitKind).source?.controller===c.browserProducerController,'Unique original Firefox replacement required');
 return true;
}
