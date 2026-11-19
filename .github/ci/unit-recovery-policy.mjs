/** One interrupted complete DB unit, unchanged source, original build and retained witnesses. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {relative} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
export const UNIT_RECOVERY_POLICY='aihr-complete-db-unit-recovery/v1';
export const UNIT_RECOVERY=Object.freeze({source:'6a45d90233b30ec2e75acab842a2a61aae6d2ac3',controller:'ddbde7585424c928d92b994b38fd3d553bf52ee5',baseline:'f8c90ebcd3c0d4bd8310d9fb1cbab645b2ad108e',runId:44438979459,unit:'db-cc251cbe6920741e',file:'test/system-label-exchange-browser.test.ts',expectationSource:'67bf8a2ad26faada3b728d4e9684be70f1a61576',expectationRunId:44376658727});
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
const id=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const jobName=u=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`;
export function validateUnitRecoveryRequest(inputs,event){
 assert(inputs.unit_recovery===UNIT_RECOVERY.unit&&inputs.recovery_original_run===String(UNIT_RECOVERY.runId),'Exact interrupted unit and original run required');
 assert(inputs.expected_sha===UNIT_RECOVERY.source&&event==='workflow_dispatch'&&!['build_only','diagnostics_only','controller_only'].some(k=>inputs[k]===true||inputs[k]==='true'),'Recovery cannot run another mode or candidate');
}
export function validateInterruptedSource({run,jobs,artifacts,plan,now=Date.now()}){
 const c=UNIT_RECOVERY;requiredEvidence(plan);
 assert(plan.sha===c.source&&plan.controller===c.controller&&plan.migrationBase===c.baseline,'Frozen original source/controller/baseline required');
 assert(run.id===c.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&run.head_sha===c.controller&&run.path===WORKFLOW_PATH&&run.workflow_id===WORKFLOW_ID&&run.event==='workflow_dispatch'&&run.head_branch==='main','Exact original execution required');
 assert(run.status==='completed'&&['failure','cancelled'].includes(run.conclusion)&&run.run_attempt===1,'Wait for the original terminal unsuccessful first attempt');
 assert(Date.parse(run.created_at)<=Date.parse(run.updated_at)&&Date.parse(run.updated_at)<=now+60000&&now-Date.parse(run.created_at)<=86400000,'Original execution expired');
 const required=requiredEvidence(plan).jobs,dependent=['verify','deployment-hold'];
 assert(new Set(jobs.map(j=>j.name)).size===jobs.length&&new Set(jobs.map(j=>j.id)).size===jobs.length,'Complete distinct original jobs required');
 for(const name of [...required.filter(n=>!dependent.includes(n)),'runner-diagnostics'])assert(jobs.some(j=>j.name===name),'Original executed prerequisite/unit missing');
 for(const j of jobs){
  assert(id(j.id)&&j.run_id===run.id&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed','Original job is pending, foreign or rerun');
  if(j.name==='runner-diagnostics'){assert(j.conclusion==='skipped');continue;}
  assert(required.includes(j.name),'Unknown original job');
  if(j.name===`test (${c.unit})`){
   assert(['failure','cancelled','timed_out'].includes(j.conclusion),'Original interrupted unit must remain unsuccessful');
   assert(j.steps?.some(s=>s.name==='Provision System Labels multilingual fonts before tests'&&s.conclusion==='success'),'This route is not a pre-test font failure recovery');
   assert(j.steps?.some(s=>s.name.includes('run-unit.mjs')&&s.status==='completed'&&s.conclusion==='cancelled'),'Actual interrupted complete-unit process required');
   assert(j.steps?.some(s=>s.name.includes('upload-artifact@')&&s.conclusion==='skipped'),'Missing original upload observation required');continue;
  }
  if(j.name==='verify'){assert(['failure','cancelled','skipped'].includes(j.conclusion));continue;}
  if(j.name==='deployment-hold'){assert(['success','cancelled','skipped'].includes(j.conclusion));continue;}
  assert(j.conclusion==='success','Cannot recover another failed prerequisite/unit');
 }
 assert(!artifacts.some(a=>a.name==='unit-'+c.unit)&&!artifacts.some(a=>a.name==='gate-evidence'),'Original missing report/receipt must remain absent');
 const unit=plan.units.find(u=>u.id===c.unit);assert(unit?.kind==='db');same(unit.files,[c.file],'Exact full original DB unit required');
 return unit;
}
export function validateUnitProducer({run,jobs,artifacts,controller,branch,candidateBranch,after,now=Date.now()}){
 assert(sha(controller)&&/^codex\/[A-Za-z0-9._/-]+$/.test(branch??'')&&!branch.includes('..'),'Frozen reviewed producer required');
 assert(id(run.id)&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&run.head_sha===controller&&run.head_branch===branch&&run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.event==='workflow_dispatch','Foreign complete-unit producer');
 assert(run.display_title===`Complete unit recovery · ${UNIT_RECOVERY.unit} · ${candidateBranch}`&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Successful first-attempt complete-unit run required');
 assert(Date.parse(run.created_at)>=Date.parse(after)&&Date.parse(run.updated_at)>=Date.parse(run.created_at)&&Date.parse(run.updated_at)<=now+60000&&now-Date.parse(run.created_at)<=86400000,'Recovery chronology invalid');
 const names=['resolve','typecheck','migrations','controller-tests','plan','runner-diagnostics','build',`test (${UNIT_RECOVERY.unit})`,'browser','verify','deployment-hold'];
 const successes=['resolve','plan',`test (${UNIT_RECOVERY.unit})`,'deployment-hold'];
 assert(jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length&&new Set(jobs.map(j=>j.id)).size===jobs.length,'Recovery executed omitted/extra units');
 for(const j of jobs){assert(id(j.id)&&names.includes(j.name)&&j.run_id===run.id&&j.head_sha===controller&&j.head_branch===branch&&j.run_attempt===1&&j.status==='completed'&&j.conclusion===(successes.includes(j.name)?'success':'skipped'),'Unexpected recovery job identity/result');if(j.conclusion==='success')assert(Date.parse(j.started_at)>=Date.parse(run.created_at)&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=Date.parse(run.updated_at),'Recovery producing job outside run');}
 const allowed=['gate-plan','unit-'+UNIT_RECOVERY.unit];assert(artifacts.length===2&&new Set(artifacts.map(a=>a.name)).size===2&&artifacts.every(a=>allowed.includes(a.name)),'No replacement build or gate PASS allowed');
 const producer=jobs.find(j=>j.name===`test (${UNIT_RECOVERY.unit})`);
 for(const fragment of ['run-unit.mjs','Source-bound fixed HTTPS fonts'])assert(producer.steps?.some(s=>s.name.includes(fragment)&&s.conclusion==='success'),'Complete runner/font prerequisite step missing');
 assert(jobs.find(j=>j.name==='deployment-hold').steps?.some(s=>s.name==='Deployment remains disabled'&&s.conclusion==='success'),'Fresh deployment-disabled proof required');
 return producer;
}
export function assertionInventory(report){
 const rows=[];
 for(const b of report.batches??[])for(const f of b.result?.testResults??[]){
  const path=relative(report.cwd,f.name).split('\\').join('/');
  assert(!rows.some(r=>r.path===path)&&f.assertionResults?.length>0,'Missing or duplicated assertion inventory');
  const cases=f.assertionResults.map(a=>{assert(a.status==='passed'&&typeof a.fullName==='string'&&a.fullName.length>0);return a.fullName;}).sort();
  assert(new Set(cases).size===cases.length,'Duplicate assertion identity');rows.push({path,cases});
 }
 return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
export function verifyUnitRecovery({plan,freshPlan,source,reports,fresh,expectation,verificationController,verificationDiagnostic,producerDiagnostic,reviewedController}){
 const unit=validateInterruptedSource({...source,plan});
 for(const p of [plan,freshPlan,expectation.plan]){const {fingerprint,...body}=p;assert(fingerprint===hash(body),'Altered full plan');}
 const {fingerprint:a,controller:b,...original}=plan,{fingerprint:c,controller:d,...current}=freshPlan;same(original,current,'Recovery changed source/runtime/PG/coverage/execution');
 assert(freshPlan.controller===fresh.run.head_sha&&verificationDiagnostic.controller===verificationController&&producerDiagnostic.controller===freshPlan.controller&&reviewedController===verificationController,'Both reviewed controller diagnostics required');
 assert(expectation.plan.sha===UNIT_RECOVERY.expectationSource&&expectation.run.id===UNIT_RECOVERY.expectationRunId&&expectation.run.conclusion==='success','Authentic independent prior assertion expectation required');
 const prior=expectation.plan.units.find(u=>u.id===unit.id);same(prior,unit,'Independent expectation omitted/changed complete unit');verifyUnitReport(expectation.plan,expectation.report);
 assert(!fresh.report.error&&!fresh.report.databaseTelemetryError,'Fresh unit contains execution/telemetry error');
 const verified=verifyUnitReport(freshPlan,fresh.report);same(assertionInventory(fresh.report),assertionInventory(expectation.report),'Fresh unit dropped/renamed/added independent assertions');
 for(const h of [fresh.report.healthBefore,fresh.report.healthAfter])assert(h?.ok===true&&h.platform==='linux'&&Date.parse(h.at)>=Date.parse(fresh.producer.started_at)&&Date.parse(h.at)<=Date.parse(fresh.producer.completed_at),'Fresh host health/chronology missing');
 // The unchanged normal policy admits PG16 security patch updates. Require one
 // consistent actual fresh server version, not equality with a historical patch.
 for(const e of [fresh.report.databaseTerminalEvidence,...fresh.report.batches.map(b=>b.databaseEvidence)])assert(e.name===`aihr-ci-${fresh.run.id}-1-${unit.id}`&&Date.parse(e.capturedAt)>=Date.parse(fresh.producer.started_at)&&Date.parse(e.capturedAt)<=Date.parse(fresh.producer.completed_at)&&e.settings.serverVersionNum===fresh.report.databaseTerminalEvidence.settings.serverVersionNum,'Fresh PostgreSQL ownership/version/chronology differs');
 const font=fresh.font;assert(font?.kind==='FIXED_NOTO_BOOTSTRAP_NOT_TEST_OR_RELEASE_PASS'&&font.candidate===plan.sha&&font.controller===freshPlan.controller&&font.releaseAuthorized===false&&font.transport?.afterBytesVerified===true&&font.transport.phase==='verified'&&font.transport.variant==='primary-https'&&font.transport.signaturePolicyUnchanged===true&&font.transport.packageSelectionUnchanged===true&&/^[a-f0-9]{64}$/.test(font.transport.beforeSha256??'')&&/^[a-f0-9]{64}$/.test(font.transport.afterSha256??'')&&font.transport.beforeSha256!==font.transport.afterSha256&&font.steps?.length>0&&font.steps.every(s=>[0,100].includes(s.status)&&!s.errorCode&&!s.signal)&&font.steps.at(-1).status===0,'Actual successful source-bound HTTPS font prerequisite required');
 same(font.packages,['fonts-noto-core','fonts-noto-cjk'],'Font packages changed');
 assert(reports.length===plan.units.length-1&&new Set(reports.map(r=>r.id)).size===reports.length&&!reports.some(r=>r.id===unit.id),'No synthetic original failed-unit report');
 const units=plan.units.map(u=>{if(u.id===unit.id)return {id:u.id,kind:'complete-unit-recovery',originalReport:null,tests:verified.tests,reportHash:hash(fresh.report),source:{runId:fresh.run.id,controller:freshPlan.controller,jobId:fresh.producer.id,artifacts:fresh.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))},expectation:{runId:expectation.run.id,sha:expectation.plan.sha,reportHash:hash(expectation.report),assertions:assertionInventory(expectation.report)}};
  const r=reports.find(r=>r.id===u.id),v=verifyUnitReport(plan,r),j=source.jobs.find(j=>j.name===jobName(u)),artifact=source.artifacts.find(a=>a.name==='unit-'+u.id);assert(j.conclusion==='success'&&artifact);return {id:u.id,kind:'retained',tests:v.tests,reportHash:hash(r),source:{runId:source.run.id,jobId:j.id,artifactId:artifact.id,digest:artifact.digest}};});
 const originalDependentJobs=['verify','deployment-hold'].map(name=>{const job=source.jobs.find(j=>j.name===name);return job?{name,id:job.id,conclusion:job.conclusion}:{name,observation:'NOT_PRESENT_IN_TERMINAL_API_INVENTORY'};});
 return {kind:'AUTHENTICATED_COMPLETE_DB_UNIT_RECOVERY',recoveryPolicy:UNIT_RECOVERY_POLICY,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,verificationDiagnostic,producerDiagnostic,reviewedController,baseline:plan.migrationBase,runId:source.run.id,originalConclusion:source.run.conclusion,originalReportAbsent:true,originalDependentJobs,postgresRuntime:{requiredMajor:16,independentExpectationVersion:expectation.report.databaseTerminalEvidence.settings.serverVersionNum,replacementVersion:fresh.report.databaseTerminalEvidence.settings.serverVersionNum},sourceFingerprint:plan.fingerprint,replacementFingerprint:freshPlan.fingerprint,unitRunId:fresh.run.id,units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests:units.reduce((n,u)=>n+u.tests,0),releaseAuthorized:false};
}
export function validateUnitRecoveryGrantEvidence(evidence,run){
 const c=evidence.recovery;assert(c?.kind==='AUTHENTICATED_COMPLETE_DB_UNIT_RECOVERY'&&c.recoveryPolicy===UNIT_RECOVERY_POLICY&&c.reviewedController===c.verificationController&&c.originalReportAbsent===true&&c.releaseAuthorized===false&&evidence.fingerprint===hash(c),'Reviewed complete-unit certificate required');
 for(const k of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests'])same(evidence[k],c[k],'Recovery grant identity changed');
 assert(c.sha===UNIT_RECOVERY.source&&c.runId===UNIT_RECOVERY.runId&&run.id===c.runId&&run.head_sha===c.controller&&run.conclusion===c.originalConclusion&&['failure','cancelled'].includes(run.conclusion)&&run.status==='completed'&&run.run_attempt===1,'Original failure identity changed');
 const unit=c.units.find(u=>u.id===UNIT_RECOVERY.unit);
 assert(c.units.filter(u=>u.kind==='complete-unit-recovery').length===1&&unit?.kind==='complete-unit-recovery'&&unit.originalReport===null&&unit.source?.runId===c.unitRunId&&unit.source.controller===c.producerDiagnostic?.controller&&sha(unit.source.controller)&&c.verificationDiagnostic?.controller===c.verificationController&&id(c.verificationDiagnostic.runId)&&id(c.producerDiagnostic.runId)&&c.history?.sourceRunId===run.id,'Complete recovery history/controller provenance required');
}
