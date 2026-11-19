/** One interrupted complete DB unit, unchanged source, original build and retained witnesses. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {validateMissingOriginalUnit,validateMissingUnitRequest,verifyMissingUnitEvidence} from './repair-missing-unit-policy.mjs';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {validatePostgresPrepull,NATIVE_POSTGRES_IMAGE} from './unit-postgres-prepull.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
export const UNIT_RECOVERY_POLICY='aihr-complete-db-unit-recovery/v2';
export const UNIT_RECOVERY_BINDING='825-20261119';
export const UNIT_RECOVERY=Object.freeze({source:'825371c791a3e84b126c6cf01ef7c174df578175',controller:'ebe2cc615894bbed895088e999b2bb48280b867a',baseline:'6a45d90233b30ec2e75acab842a2a61aae6d2ac3',runId:44485408065,jobId:135428147244,unit:'db-cc251cbe6920741e',file:'test/system-label-exchange-browser.test.ts',expectationSource:'2ec7140b3627e0604c04c26c3181c066b2c5ffae',expectationController:'ebe2cc615894bbed895088e999b2bb48280b867a',expectationRunId:44458355850,testBlob:'a6fd0eff185738630beb067f5b645e662b0173f4'});
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
const id=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const jobName=u=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`;
export function validateUnitRecoveryRequest(inputs,event){
 validateMissingUnitRequest(inputs,event);
 assert(inputs.missing_unit===UNIT_RECOVERY.unit&&inputs.missing_original_run===String(UNIT_RECOVERY.runId)&&inputs.expected_sha===UNIT_RECOVERY.source,'Exact frozen interrupted execution required');
}
export function validateInterruptedSource({run,jobs,artifacts,plan,now=Date.now()}){
 const c=UNIT_RECOVERY;requiredEvidence(plan);validateMissingOriginalUnit({run,jobs,artifacts,plan,unitId:c.unit,now});
 assert(plan.sha===c.source&&plan.controller===c.controller&&plan.migrationBase===c.baseline,'Frozen original source/controller/baseline required');
 assert(run.id===c.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&run.head_sha===c.controller&&run.path===WORKFLOW_PATH&&run.workflow_id===WORKFLOW_ID&&run.event==='workflow_dispatch'&&run.head_branch==='main','Exact original execution required');
 assert(run.status==='completed'&&run.conclusion==='cancelled'&&run.run_attempt===1,'Wait for the original terminal unsuccessful first attempt');
 assert(Date.parse(run.created_at)<=Date.parse(run.updated_at)&&Date.parse(run.updated_at)<=now+60000&&now-Date.parse(run.created_at)<=86400000,'Original execution expired');
 const required=requiredEvidence(plan).jobs,dependent=['verify','deployment-hold'];
 assert(new Set(jobs.map(j=>j.name)).size===jobs.length&&new Set(jobs.map(j=>j.id)).size===jobs.length,'Complete distinct original jobs required');
 for(const name of [...required.filter(n=>!dependent.includes(n)),'runner-diagnostics'])assert(jobs.some(j=>j.name===name),'Original executed prerequisite/unit missing');
 for(const j of jobs){
  assert(id(j.id)&&j.run_id===run.id&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed','Original job is pending, foreign or rerun');
  if(j.name==='runner-diagnostics'){assert(j.conclusion==='skipped');continue;}
  assert(required.includes(j.name),'Unknown original job');
  if(j.name===`test (${c.unit})`){
   assert(j.id===c.jobId&&j.conclusion==='cancelled','Exact cancelled interrupted job required');
   assert(j.steps?.some(s=>s.name==='Provision System Labels multilingual fonts before tests'&&s.conclusion==='success'),'Successful original font prerequisite required');
   const process=j.steps.find(s=>s.name.includes('run-unit.mjs'));
   assert(process?.started_at&&['in_progress','completed'].includes(process.status)&&[null,'cancelled'].includes(process.conclusion),'Actual incomplete process metadata required; no original application coverage inferred');
   assert(j.steps.some(s=>s.name.includes('upload-artifact@')&&[null,'skipped','cancelled'].includes(s.conclusion)),'Original upload must remain unobserved/unsuccessful');continue;
  }
  assert(!dependent.includes(j.name),'Original verify/hold were not created after interrupted prerequisite');
  assert(j.conclusion==='success','Cannot recover another failed prerequisite/unit');
 }
 assert(!artifacts.some(a=>a.name==='unit-'+c.unit)&&!artifacts.some(a=>a.name==='gate-evidence'),'Original missing report/receipt must remain absent');
 const unit=plan.units.find(u=>u.id===c.unit);assert(unit?.kind==='db');same(unit.files,[c.file],'Exact full original DB unit required');
 return unit;
}
export function verifyUnitRecovery({plan,freshPlan,source,reports,missingProof,verificationController,verificationDiagnostic,reviewedController}){
 const unit=validateInterruptedSource({...source,plan});
 for(const p of [plan,freshPlan]){const {fingerprint,...body}=p;assert(fingerprint===hash(body),'Altered complete plan');}
 const {fingerprint:a,controller:b,...original}=plan,{fingerprint:c,controller:d,...current}=freshPlan;same(original,current,'Exact-source recovery changed source/runtime/PG/coverage');
 assert(verificationController===freshPlan.controller&&verificationDiagnostic.controller===verificationController&&reviewedController===verificationController,'Exact independently qualified controller required');
 const v=verifyMissingUnitEvidence({sourcePlan:plan,plan:freshPlan,missing:unit.id,proof:missingProof.proof});
 const proof=missingProof.proof;
 const owner={path:'.github/ci/postgres.sh',gitBlob:'49d3fe2671ca6f13192169d8101c2c14f62236fc',sha256:'e14ab0a207112c61d40b7801c0b1272ed20eb0aca0042d56c8a4cc7e572e52d0',image:NATIVE_POSTGRES_IMAGE};
 const nativePrepull=validatePostgresPrepull(proof.nativePrepull,{owner,source:plan.sha,controller:freshPlan.controller,runId:proof.run.id,unit:unit.id,producer:proof.producer,fontStep:proof.producer.steps.find(s=>s.name==='Source-bound fixed HTTPS fonts for missing whole unit')});
 assert(proof.producer.steps.some(s=>s.name==='Bounded source-owned native PostgreSQL image transport'&&s.conclusion==='success'),'Actual pre-pull workflow step required');
 assert(proof.metadata.jobs.find(j=>j.name==='deployment-hold').steps?.some(s=>s.name==='Deployment remains disabled'&&s.conclusion==='success'),'Actual fresh deployment-disabled proof required');
 assert(proof.expected.after===source.run.updated_at&&proof.fileBlob.original===UNIT_RECOVERY.testBlob,'Replacement chronology/test blob changed');
 assert(proof.expectation.selection.runId===UNIT_RECOVERY.expectationRunId&&proof.expectation.selection.source===UNIT_RECOVERY.expectationSource&&proof.expectation.selection.controller===UNIT_RECOVERY.expectationController&&proof.expectation.selection.branch==='main','Closed independent assertion inventory required');
 assert(missingProof.producerDiagnostic.controller===freshPlan.controller,'Qualified producing controller differs');
 assert(reports.length===plan.units.length-1&&new Set(reports.map(r=>r.id)).size===reports.length&&!reports.some(r=>r.id===unit.id),'No synthetic original interrupted-unit report');
 const units=plan.units.map(u=>{if(u.id===unit.id)return {id:u.id,kind:'complete-unit-recovery',originalReport:null,tests:v.tests,reportHash:v.reportHash,source:v.source,expectation:v.expectation,priorExpectationUsedAsPass:false};
  const r=reports.find(r=>r.id===u.id),verified=verifyUnitReport(plan,r),job=source.jobs.find(j=>j.name===jobName(u)),artifact=source.artifacts.find(a=>a.name==='unit-'+u.id);assert(job.conclusion==='success'&&artifact);return {id:u.id,kind:'retained',tests:verified.tests,reportHash:hash(r),source:{runId:source.run.id,jobId:job.id,artifactId:artifact.id,digest:artifact.digest}};});
 const interrupted=source.jobs.find(j=>j.id===UNIT_RECOVERY.jobId);
 return {kind:'AUTHENTICATED_COMPLETE_DB_UNIT_RECOVERY',recoveryPolicy:UNIT_RECOVERY_POLICY,bindingVersion:UNIT_RECOVERY_BINDING,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,verificationDiagnostic,producerDiagnostic:missingProof.producerDiagnostic,reviewedController,baseline:plan.migrationBase,runId:source.run.id,originalConclusion:'cancelled',originalReportAbsent:true,originalInterruptedJob:{id:interrupted.id,hash:hash(interrupted),steps:interrupted.steps,applicationCoverage:'UNAVAILABLE_NO_ORIGINAL_REPORT'},originalDependentJobs:['verify','deployment-hold'].map(name=>({name,observation:'NOT_PRESENT_IN_TERMINAL_API_INVENTORY',cause:'CANCELLED_REQUIRED_UNIT'})),missingProof:v,nativePrepull,sourceFingerprint:plan.fingerprint,replacementFingerprint:freshPlan.fingerprint,unitRunId:proof.run.id,units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests:units.reduce((n,u)=>n+u.tests,0),releaseAuthorized:false};
}
export function validateUnitRecoveryGrantEvidence(evidence,run){
 const c=evidence.recovery;assert(c?.kind==='AUTHENTICATED_COMPLETE_DB_UNIT_RECOVERY'&&c.recoveryPolicy===UNIT_RECOVERY_POLICY&&c.bindingVersion===UNIT_RECOVERY_BINDING&&c.reviewedController===c.verificationController&&c.originalReportAbsent===true&&c.releaseAuthorized===false&&evidence.fingerprint===hash(c),'Reviewed complete-unit certificate required');
 for(const k of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests'])same(evidence[k],c[k],'Recovery grant identity changed');
 assert(c.sha===UNIT_RECOVERY.source&&c.controller===UNIT_RECOVERY.controller&&c.baseline===UNIT_RECOVERY.baseline&&evidence.controllerBranch==='main'&&run.head_branch===evidence.controllerBranch&&c.runId===UNIT_RECOVERY.runId&&run.id===c.runId&&run.head_sha===c.controller&&run.conclusion===c.originalConclusion&&['failure','cancelled'].includes(run.conclusion)&&run.status==='completed'&&run.run_attempt===1,'Original failure identity changed');
 assert(c.sourceFingerprint==='4b79e6d71ec9e215c02b0132736b9227c46243245484ada91ac448dd1c709cc1'&&c.units.length===101&&new Set(c.units.map(u=>u.id)).size===101&&c.suiteFiles===4290&&c.browserFiles===126&&c.tests===55195,'Complete frozen original coverage required');
 const retained=c.units.filter(u=>u.kind==='retained');assert(retained.length===100&&retained.reduce((n,u)=>n+u.tests,0)===55194&&retained.every(u=>Number.isSafeInteger(u.tests)&&u.tests>0&&u.source.runId===UNIT_RECOVERY.runId&&id(u.source.jobId)&&id(u.source.artifactId)&&/^sha256:[a-f0-9]{64}$/.test(u.source.digest))&&new Set(retained.map(u=>u.source.jobId)).size===100&&new Set(retained.map(u=>u.source.artifactId)).size===100,'All 100 actual retained passing units required');
 const unit=c.units.find(u=>u.id===UNIT_RECOVERY.unit);
 assert(unit?.tests===1&&unit.priorExpectationUsedAsPass===false&&c.missingProof?.priorExpectationUsedAsPass===false&&c.missingProof.tests===1,'Fresh singleton execution required; prior supplies inventory only');
 assert(c.originalConclusion==='cancelled'&&c.originalInterruptedJob?.id===UNIT_RECOVERY.jobId&&c.originalDependentJobs?.length===2&&new Set(c.originalDependentJobs.map(x=>x.name)).size===2&&c.originalDependentJobs.every(x=>['verify','deployment-hold'].includes(x.name)&&x.observation==='NOT_PRESENT_IN_TERMINAL_API_INVENTORY'),'Original cancellation/absence proof required');
 assert(c.units.filter(u=>u.kind==='complete-unit-recovery').length===1&&unit?.kind==='complete-unit-recovery'&&unit.originalReport===null&&unit.source?.runId===c.unitRunId&&unit.source.controller===c.producerDiagnostic?.controller&&sha(unit.source.controller)&&c.verificationDiagnostic?.controller===c.verificationController&&id(c.verificationDiagnostic.runId)&&id(c.producerDiagnostic.runId)&&c.history?.sourceRunId===run.id,'Complete recovery history/controller provenance required');
}
