/** A missing DB-unit report gets fresh whole-unit evidence, never an invented old report. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {relative} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
export const MISSING_UNIT_POLICY='aihr-unobserved-missing-whole-db-unit/v1';
export const MISSING_UNIT_FILE='test/system-label-exchange-browser.test.ts';
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>Number.isSafeInteger(x)&&x>0;
const branch=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(x)&&!x.includes('..');
function fullPlan(p){const {fingerprint,...body}=p;assert(fingerprint===hash(body),'Complete plan fingerprint changed');requiredEvidence(p);assert(sha(p.sha)&&sha(p.controller)&&sha(p.migrationBase)&&p.runtime?.node==='22.23.3'&&p.runtime.platform==='linux'&&p.runtime.arch==='x64','Pinned original source/controller/runtime required');}
export function missingUnit(plan,unitId){fullPlan(plan);const rows=plan.units.filter(u=>u.id===unitId);assert(rows.length===1&&rows[0].kind==='db'&&!rows[0].pdfTools,'One exact ordinary DB unit required');same(rows[0].files,[MISSING_UNIT_FILE],'Only the unchanged isolated System Labels whole unit is supported');assert(plan.execution.workers===2,'Original two-worker topology required');return rows[0];}
export function validateMissingUnitRequest(inputs,event){
 assert(event==='workflow_dispatch'&&typeof inputs.missing_unit==='string'&&/^db-[a-f0-9]{16}$/.test(inputs.missing_unit)&&/^[1-9][0-9]*$/.test(inputs.missing_original_run??''),'Exact dispatched missing unit/original run required');
 assert(sha(inputs.expected_sha)&&branch(inputs.candidate_ref)&&!['build_only','diagnostics_only','controller_only'].some(k=>inputs[k]===true||inputs[k]==='true'),'Missing-unit mode is exclusive');
}
export function validateMissingOriginalUnit({run,jobs,artifacts,plan,unitId,now=Date.now()}){
 const unit=missingUnit(plan,unitId);assert(id(run.id)&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&run.head_sha===plan.controller&&run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.event==='workflow_dispatch'&&['main','alpha'].includes(run.head_branch),'Original full gate owner differs');
 assert(run.status==='completed'&&['cancelled','failure'].includes(run.conclusion)&&run.run_attempt===1&&Date.parse(run.created_at)<=Date.parse(run.updated_at)&&Date.parse(run.updated_at)<=now+60000&&now-Date.parse(run.created_at)<=86400000,'Original must remain a terminal unsuccessful first attempt');
 assert(new Set(jobs.map(j=>j.id)).size===jobs.length&&new Set(jobs.map(j=>j.name)).size===jobs.length,'Duplicate original jobs');
 const required=['resolve','typecheck','migrations','controller-tests','plan','runner-diagnostics','build',...plan.units.map(u=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`)];
 assert(required.every(n=>jobs.some(j=>j.name===n))&&jobs.every(j=>[...required,'verify','deployment-hold'].includes(j.name)),'Complete original planned job inventory required');
 assert(new Set(artifacts.map(a=>a.name)).size===artifacts.length&&artifacts.some(a=>a.name==='gate-plan'),'Distinct original artifacts/full plan required');
 for(const j of jobs)assert(id(j.id)&&j.run_id===run.id&&j.head_sha===plan.controller&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed','Pending/foreign original job');
 const job=jobs.find(j=>j.name===`test (${unitId})`);assert(job?.conclusion===(run.conclusion==='cancelled'?'cancelled':'failure'),'Missing original job was not interrupted');
 const process=job.steps?.find(s=>s.name.includes('run-unit.mjs'));
 assert(job.steps?.some(s=>s.name.includes('setup-alpha')&&s.conclusion==='success')&&job.steps.some(s=>s.name==='Provision System Labels multilingual fonts before tests'&&s.conclusion==='success')&&process?.started_at&&['in_progress','completed'].includes(process.status)&&[null,'cancelled'].includes(process.conclusion),'Original started unit coverage remains unavailable; completed setup/started process witness required');
 if(run.conclusion==='failure'){
  assert(process.conclusion==='cancelled'&&job.steps.some(s=>s.name.includes('upload-artifact@')&&s.conclusion==='skipped'),'Failed runner must have an interrupted process and skipped upload');
 }
 assert(!artifacts.some(a=>a.name==='unit-'+unitId)&&!artifacts.some(a=>a.name==='gate-evidence'),'Original missing report and receipt must stay absent');
 for(const u of plan.units.filter(u=>u.id!==unitId))assert(artifacts.some(a=>a.name==='unit-'+u.id),'Another original unit artifact is missing');
 return unit;
}
export function validateMissingUnitProducer({run,jobs,artifacts,expected,now=Date.now()}){
 const {controller,branch:producerBranch,candidateBranch,unitId,after}=expected;
 assert(sha(controller)&&branch(producerBranch)&&branch(candidateBranch)&&/^db-[a-f0-9]{16}$/.test(unitId),'Reviewed exact producer selection required');
 assert(id(expected.runId)&&run.id===expected.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&run.head_sha===controller&&run.head_branch===producerBranch&&run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.event==='workflow_dispatch','Foreign missing-unit producer');
 assert(run.display_title===`Missing whole unit · ${unitId} · ${candidateBranch}`&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Successful first-attempt whole-unit producer required');
 assert(Date.parse(run.created_at)>=Date.parse(after)&&Date.parse(run.updated_at)>=Date.parse(run.created_at)&&Date.parse(run.updated_at)<=now+60000&&now-Date.parse(run.created_at)<=86400000,'Fresh unit chronology differs');
 const names=['resolve','typecheck','migrations','controller-tests','plan','runner-diagnostics','build',`test (${unitId})`,'browser','verify','deployment-hold'];const successes=['resolve','plan',`test (${unitId})`,'deployment-hold'];
 assert(jobs.length===names.length&&new Set(jobs.map(j=>j.id)).size===jobs.length&&new Set(jobs.map(j=>j.name)).size===names.length,'Omitted/extra fresh jobs');
 for(const j of jobs){assert(id(j.id)&&names.includes(j.name)&&j.run_id===run.id&&j.head_sha===controller&&j.head_branch===producerBranch&&j.run_attempt===1&&j.status==='completed'&&j.conclusion===(successes.includes(j.name)?'success':'skipped'),'Fresh job identity/result differs');if(j.conclusion==='success')assert(Date.parse(j.started_at)>=Date.parse(run.created_at)&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=Date.parse(run.updated_at),'Fresh job outside producer run');}
 const producer=jobs.find(j=>j.name===`test (${unitId})`);
 const fontStep=producer.steps?.find(s=>s.name==='Provision System Labels multilingual fonts before tests'),processStep=producer.steps?.find(s=>s.name.includes('run-unit.mjs')&&s.conclusion==='success');
 assert(fontStep?.conclusion==='success'&&processStep?.conclusion==='success'&&Date.parse(fontStep.started_at)>=Date.parse(producer.started_at)&&Date.parse(fontStep.completed_at)>=Date.parse(fontStep.started_at)&&Date.parse(fontStep.completed_at)<=Date.parse(processStep.started_at)&&Date.parse(processStep.completed_at)>=Date.parse(processStep.started_at)&&Date.parse(processStep.completed_at)<=Date.parse(producer.completed_at),'Actual fonts must finish before complete unit process inside producer');
 const allowed=['gate-plan','unit-'+unitId];assert(artifacts.length===2&&new Set(artifacts.map(a=>a.name)).size===2&&artifacts.every(a=>allowed.includes(a.name)),'Only plan and whole-unit artifacts permitted; no gate receipt/build');
 for(const a of artifacts){const j=jobs.find(j=>j.name===(a.name==='gate-plan'?'plan':producer.name)),w=a.workflow_run;assert(id(a.id)&&!a.expired&&a.size_in_bytes>0&&a.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(a.digest)&&w?.id===run.id&&w.head_sha===controller&&w.head_branch===producerBranch&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&Date.parse(a.created_at)>=Date.parse(j.started_at)&&Date.parse(a.created_at)<=Date.parse(j.completed_at)&&Date.parse(a.expires_at)>now,'Fresh artifact producer/digest interval differs');}
 return producer;
}
export function validateCaseExpectation({metadata,selection,plan,unitId}){
 const {run,jobs,artifacts}=metadata;assert(selection&&id(selection.runId)&&sha(selection.source)&&sha(selection.controller)&&branch(selection.branch),'Exact independent prior selection required');
 assert(run.id===selection.runId&&run.head_sha===selection.controller&&run.head_branch===selection.branch&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.event==='workflow_dispatch'&&run.status==='completed'&&run.run_attempt===1,'Independent expected run differs');
 assert(plan.sha===selection.source&&plan.controller===selection.controller,'Independent expectation complete plan differs');
 const job=jobs.find(j=>j.name===`test (${unitId})`),a=artifacts.find(a=>a.name==='unit-'+unitId);
 assert(job&&job.run_id===run.id&&job.head_sha===run.head_sha&&job.head_branch===run.head_branch&&job.run_attempt===1&&job.status==='completed'&&job.conclusion==='success','Prior case inventory producing job differs');
 assert(a&&!a.expired&&a.workflow_run?.id===run.id&&a.workflow_run.head_sha===run.head_sha&&a.workflow_run.head_branch===run.head_branch&&a.workflow_run.repository_id===REPOSITORY_ID&&a.workflow_run.head_repository_id===REPOSITORY_ID&&/^sha256:[a-f0-9]{64}$/.test(a.digest)&&Date.parse(a.created_at)>=Date.parse(job.started_at)&&Date.parse(a.created_at)<=Date.parse(job.completed_at),'Independent prior inventory artifact differs');
 return {runId:run.id,controller:run.head_sha,branch:run.head_branch,jobId:job.id,artifactId:a.id,digest:a.digest};
}
export function assertionInventory(report,{passing=false}={}){
 const rows=[];
 for(const b of report?.batches??[])for(const f of b.result?.testResults??[]){const path=relative(report.cwd,f.name).split('\\').join('/');assert(!rows.some(r=>r.path===path)&&f.assertionResults?.length>0,'Missing/repeated independent assertions');const cases=f.assertionResults.map(a=>{assert(typeof a.fullName==='string'&&a.fullName.length>0&&(!passing||a.status==='passed'),'Missing/nonpassing assertion identity');return a.fullName;}).sort();assert(new Set(cases).size===cases.length,'Duplicate assertion identity');rows.push({path,cases});}
 return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
export function verifyMissingUnitEvidence({sourcePlan,plan,missing,proof,now=Date.now()}){
 missing=typeof missing==='string'?missing:missing?.id;
 const unit=missingUnit(sourcePlan,missing),repaired=missingUnit(plan,missing);same(unit,repaired,'Repair changed missing unit topology');
 for(const key of ['schemaVersion','policyVersion','migrationBase','runtime','execution','pdfTooling','suite','units'])same(plan[key],sourcePlan[key],'Repair changed original complete topology/runtime: '+key);
 const {freshPlan,run,producer,report,font,expectation,fileBlob,source}=proof;fullPlan(freshPlan);
 const actualProducer=validateMissingUnitProducer({...proof.metadata,expected:proof.expected,now});same(actualProducer,producer,'Fresh producer changed after authentication');same(proof.metadata.run,run,'Fresh run changed after authentication');
 const artifact=proof.metadata.artifacts.find(a=>a.name==='unit-'+missing);same(source,{runId:run.id,controller:run.head_sha,branch:run.head_branch,jobId:producer.id,artifactId:artifact.id,digest:artifact.digest},'Fresh provenance changed');
 same(validateCaseExpectation({metadata:expectation.metadata,selection:expectation.selection,plan:expectation.plan,unitId:missing}),expectation.source,'Independent expectation provenance changed');
 const {fingerprint:a,controller:b,...body}=freshPlan,{fingerprint:c,controller:d,...expected}=plan;same(body,expected,'Producer changed repaired source/full plan/runtime');assert(freshPlan.controller===run.head_sha,'Fresh plan controller differs');
 assert(fileBlob&&/^[a-f0-9]{40}$/.test(fileBlob.original)&&fileBlob.original===fileBlob.candidate&&fileBlob.original===fileBlob.expectation,'Actual unchanged Git test blob required');
 assert(expectation?.plan&&expectation.report&&expectation.source?.runId&&expectation.source?.digest,'Authenticated independent expectation required');fullPlan(expectation.plan);same(missingUnit(expectation.plan,missing),unit,'Prior expectation whole unit changed');
 assert(report?.id===missing&&!report.error&&!report.databaseTelemetryError,'Fresh whole-unit report error');const verified=verifyUnitReport(freshPlan,report);
 verifyUnitReport(expectation.plan,expectation.report);
 const prior=assertionInventory(expectation.report,{passing:true}),current=assertionInventory(report,{passing:true});same(prior,current,'Fresh missing unit dropped/renamed/added original same-blob assertions');same(prior.map(x=>x.path),unit.files,'Prior expectation omitted/added files');
 assert(expectation.report.sha===expectation.plan.sha&&expectation.report.fingerprint===expectation.plan.fingerprint,'Prior expectation source/fingerprint differs');same(expectation.report.files,unit.files,'Prior expected file list differs');
 for(const h of [report.healthBefore,report.healthAfter])assert(h?.ok===true&&h.platform==='linux'&&Date.parse(h.at)>=Date.parse(producer.started_at)&&Date.parse(h.at)<=Date.parse(producer.completed_at),'Fresh host health interval differs');
 for(const e of [report.databaseTerminalEvidence,...report.batches.map(b=>b.databaseEvidence)]){validatePostgresEvidence(e,freshPlan.execution);assert(e.name===`aihr-ci-${run.id}-1-${missing}`&&Date.parse(e.capturedAt)>=Date.parse(producer.started_at)&&Date.parse(e.capturedAt)<=Date.parse(producer.completed_at)&&e.settings.serverVersionNum===report.databaseTerminalEvidence.settings.serverVersionNum,'Fresh PostgreSQL ownership/PG16 chronology differs');}
 const t=font?.transport;assert(font?.kind==='FIXED_NOTO_BOOTSTRAP_NOT_TEST_OR_RELEASE_PASS'&&font.candidate===plan.sha&&font.controller===freshPlan.controller&&font.releaseAuthorized===false&&t?.afterBytesVerified===true&&t.phase==='verified'&&t.variant==='primary-https'&&t.signaturePolicyUnchanged===true&&t.packageSelectionUnchanged===true&&/^[a-f0-9]{64}$/.test(t.beforeSha256??'')&&/^[a-f0-9]{64}$/.test(t.afterSha256??'')&&t.beforeSha256!==t.afterSha256&&font.steps?.length>0&&font.steps.every(s=>[0,100].includes(s.status)&&!s.errorCode&&!s.signal)&&font.steps.at(-1).status===0,'Actual source-bound fixed HTTPS font setup required');same(font.packages,['fonts-noto-core','fonts-noto-cjk'],'Font package policy differs');
 return {unitId:missing,files:unit.files,casesByFile:current,source,expectation:expectation.source,reportHash:hash(report),fontHash:hash(font),databaseEvidenceHash:hash(report.databaseTerminalEvidence),tests:verified.tests,policy:MISSING_UNIT_POLICY,priorExpectationUsedAsPass:false,originalApplicationCoverage:'UNAVAILABLE_NO_ORIGINAL_UNIT_ARTIFACT',releaseAuthorized:false};
}
