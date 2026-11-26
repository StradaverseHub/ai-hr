/** Owner-approved exact-source DB-unit recovery. Never a full gate PASS; never rewrites the original run or its reports. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {relative} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID} from './release-policy.mjs';
export const DB_UNIT_RECOVERY_POLICY='aihr-db-unit-recovery/v1';
export const DB_UNIT_RECOVERY_KIND='AUTHENTICATED_OWNER_APPROVED_DB_UNIT_RECOVERY';
export const DB_UNIT_RECOVERY_EXCEPTION='OWNER_APPROVED_DB_UNIT_RECOVERY_NOT_A_FULL_GATE_PASS';
// Owner's own words to the session, 23 November 2026, approving ONE original gate. Review 2026-11-24: they are bound only
// to that gate and candidate and are never presented as approval for any other gate.
export const DB_UNIT_BOUND_DECISION='OWNER_WORDS_BOUND_IN_REVIEWED_SOURCE_FOR_ONE_GATE';
export const DB_UNIT_RECORDED_APPROVAL='OPERATOR_RECORDED_OWNER_APPROVAL_NOT_AUTHENTICATED';
export const DB_UNIT_OWNER_DECISION=Object.freeze({provenance:DB_UNIT_BOUND_DECISION,originalRunId:45191515984,candidate:'9336682460ff8bad3c6b745d7cf8029c2b7e918f',date:'2026-11-23',quotes:Object.freeze([
 'For the browser test that fails, lets run the test specifically for it, dont have to run a new full gate, once the test pass, we can release',
 'No need to check, i allow and approve it, go ahead',
 'Just use gate 4, re test the failed one and go with hand installed exception'])});
const FOCUSED_PATH='.github/workflows/alpha-focused-checks.yml',CWD='/home/runner/work/ai-hr/ai-hr/source';
const focusedJobs=['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-swift-models','native-bundle'];
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>Number.isSafeInteger(x)&&x>0;
const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
const unitJob=u=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`;
const rel=(cwd,name)=>relative(cwd,name).split('\\').join('/');
const quotesOk=q=>Array.isArray(q)&&q.length>0&&q.length<=8&&q.every(x=>typeof x==='string'&&x.trim().length>0&&x.length<=1000);
/** The decision a certificate binds: the reviewed 23 November words for their own gate, otherwise a per-gate approval
 * that the operator records verbatim ({date,quotes}) and that is labelled as unauthenticated operator testimony. */
export function dbUnitOwnerDecision({approval,runId,candidate}){
 if(runId===DB_UNIT_OWNER_DECISION.originalRunId){assert(approval===undefined&&candidate===DB_UNIT_OWNER_DECISION.candidate,'The bound 23 November decision covers only its own gate and candidate');return DB_UNIT_OWNER_DECISION;}
 assert(approval&&typeof approval==='object'&&!Array.isArray(approval)&&Object.keys(approval).sort().join(',')==='date,quotes'&&/^\d{4}-\d{2}-\d{2}$/.test(approval.date)&&quotesOk(approval.quotes),'A per-gate owner approval {"date","quotes"} is required; the 23 November decision approved another gate');
 return {provenance:DB_UNIT_RECORDED_APPROVAL,originalRunId:runId,candidate,date:approval.date,quotes:approval.quotes.slice()};
}
export function validateDbUnitOwnerDecision(decision,{runId,candidate}){
 if(decision?.provenance===DB_UNIT_BOUND_DECISION){same(decision,DB_UNIT_OWNER_DECISION,'Owner decision must be bound verbatim');assert(runId===decision.originalRunId&&candidate===decision.candidate,'Owner decision approved another gate or candidate');return;}
 assert(decision?.provenance===DB_UNIT_RECORDED_APPROVAL&&Object.keys(decision).sort().join(',')==='candidate,date,originalRunId,provenance,quotes'&&decision.originalRunId===runId&&decision.candidate===candidate&&/^\d{4}-\d{2}-\d{2}$/.test(decision.date)&&quotesOk(decision.quotes),'Per-gate owner approval missing, altered or for another gate');
}
/** Focused runs dispatched with `--ref main|alpha`: head_sha is the ORIGINAL gate's controller, never the candidate. */
export function validateDbFocusedMetadata({run,jobs,artifacts,expected,now=Date.now()}){
 assert(id(expected.runId)&&run.id===expected.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign focused run');
 assert(id(expected.workflowId)&&run.workflow_id===expected.workflowId&&run.path===FOCUSED_PATH&&run.event==='workflow_dispatch','Untrusted focused workflow');
 assert(sha(expected.controller)&&run.head_sha===expected.controller&&run.head_branch===expected.controllerBranch&&['main','alpha'].includes(run.head_branch),'Focused run must execute on the original gate controller');
 assert(run.display_title===`Focused only · ${expected.candidateBranch}`,'Focused run names a different candidate branch');
 assert(run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Focused run must be a successful first attempt');
 const created=Date.parse(run.created_at),finished=Date.parse(run.updated_at);
 assert(Number.isFinite(created)&&Number.isFinite(finished)&&created>=Date.parse(expected.after)&&finished>=created&&finished<=now+60000&&now-created<=86400000,'Focused evidence is stale or precedes original completion');
 assert(Array.isArray(jobs)&&jobs.length===focusedJobs.length&&new Set(jobs.map(j=>j.name)).size===jobs.length&&new Set(jobs.map(j=>j.id)).size===jobs.length,'Exact focused job inventory required');
 for(const j of jobs){
  assert(focusedJobs.includes(j.name)&&id(j.id)&&j.run_id===run.id&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed','Foreign, missing or rerun focused job');
  const allowed=['resolve','selected-tests'].includes(j.name)?['success']:j.name==='typecheck'?['success','skipped']:['skipped'];
  assert(allowed.includes(j.conclusion),'Unexpected focused job result: '+j.name);
 }
 assert(Array.isArray(artifacts)&&artifacts.length===1,'Unique focused artifact required');
 const a=artifacts[0],w=a.workflow_run,j=jobs.find(j=>j.name==='selected-tests');
 assert(a.name==='focused-development-evidence'&&id(a.id)&&a.expired===false&&id(a.size_in_bytes)&&a.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(a.digest),'Invalid focused artifact');
 assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Focused artifact provenance differs');
 assert(Date.parse(j.started_at)>=created&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=finished&&Date.parse(a.created_at)>=Date.parse(j.started_at)&&Date.parse(a.created_at)<=Date.parse(j.completed_at)&&Date.parse(a.expires_at)>now,'Focused artifact is outside its producing job');
 return j;
}
/**
 * Complete branch history after the original finished. Accounted: the declared focused runs, and a later full gate
 * cancelled on the same candidate SHA and controller (recorded, never used as evidence). Anything else refuses.
 */
export function validateDbUnitHistory({source,rows,candidate,candidateBranch,focusedRunIds,laterGatePlans=new Map()}){
 assert(source.run.display_title===`Alpha CI · ${candidateBranch}`&&Array.isArray(rows)&&rows.length<=8000,'Frozen candidate branch history required');
 const titles=new Set([`Alpha CI · ${candidateBranch}`,`Focused only · ${candidateBranch}`,`Canonical build only · ${candidateBranch}`,`Tooling transport only · ${candidateBranch}`]);
 const created=Date.parse(source.run.created_at),after=Date.parse(source.run.updated_at),found=new Map();
 for(const r of rows){if(r.id===source.run.id||!titles.has(r.display_title))continue;
  assert(id(r.id)&&Number.isFinite(Date.parse(r.created_at))&&Number.isFinite(Date.parse(r.updated_at))&&Date.parse(r.updated_at)>=Date.parse(r.created_at),'Malformed relevant history execution');
  const record={id:r.id,workflowId:r.workflow_id,title:r.display_title,controller:r.head_sha,status:r.status,conclusion:r.conclusion,attempt:r.run_attempt,createdAt:r.created_at,updatedAt:r.updated_at};
  assert(!found.has(r.id)||isDeepStrictEqual(found.get(r.id),record),'Conflicting history API snapshots; retry after stabilization');found.set(r.id,record);
 }
 const executions=[],overlapping=[];
 for(const r of [...found.values()].sort((a,b)=>a.id-b.id)){
  const end=Date.parse(r.updatedAt);
  if(r.status==='completed'&&end<after){if(end>=created)overlapping.push({...r,disposition:'COMPLETED_BEFORE_ORIGINAL_FINISHED'});continue;}
  if(focusedRunIds.includes(r.id)){
   assert(r.title===`Focused only · ${candidateBranch}`&&r.controller===source.run.head_sha&&r.status==='completed'&&r.conclusion==='success'&&r.attempt===1,'Declared focused run is pending, failed, rerun or foreign');
   executions.push({...r,disposition:'FOCUSED_DB_UNIT_RECOVERY'});continue;
  }
  const plan=laterGatePlans.get(r.id);
  // A later full gate on the identical source is not superseding. Refuse only a different source or controller.
  assert(r.title===`Alpha CI · ${candidateBranch}`&&r.workflowId===WORKFLOW_ID&&r.status==='completed'&&r.conclusion==='cancelled'&&r.attempt===1&&r.controller===source.run.head_sha,'Unaccounted, pending, failed or superseding execution: '+r.id);
  assert(plan&&plan.sha===candidate&&plan.controller===source.run.head_sha,'Later gate source differs or is unproven: '+r.id);
  // Review 2026-11-24: a cancelled gate on the identical source may still hold completed failures (contrary evidence).
  assert(Array.isArray(plan.jobs)&&plan.jobs.length>0&&plan.jobs.every(j=>j.status==='completed'&&j.attempt===1&&(['success','skipped','cancelled'].includes(j.conclusion)||(j.name==='verify'&&j.conclusion==='failure'))),'Later same-source gate holds a failed, timed-out or incomplete job: '+r.id);
  executions.push({...r,disposition:'LATER_SAME_SOURCE_GATE_CANCELLED_BY_OWNER_NOT_EVIDENCE',sourceSha:plan.sha,planFingerprint:plan.fingerprint,jobConclusions:Object.fromEntries(['success','skipped','cancelled','failure'].map(c=>[c,plan.jobs.filter(j=>j.conclusion===c).length]))});
 }
 for(const n of focusedRunIds)assert(executions.some(e=>e.id===n&&e.disposition==='FOCUSED_DB_UNIT_RECOVERY'),'Declared focused run missing from history: '+n);
 return {kind:'AUTHENTICATED_COMPLETE_DB_UNIT_RECOVERY_HISTORY',sourceRunId:source.run.id,after:source.run.updated_at,executions,overlapping,metadataFingerprint:hash({executions,overlapping})};
}
function passingCases(result,files){
 assert(result?.success===true&&result.numFailedTests===0&&result.numFailedTestSuites===0&&[result.numPendingTests??0,result.numPendingTestSuites??0,result.numTodoTests??0].every(n=>n===0),'Focused result contains errors/skips');
 assert(Array.isArray(result.testResults)&&result.testResults.length===files.length,'Focused result file count differs');
 const found=new Map();let count=0;
 for(const file of result.testResults){const path=rel(CWD,file.name);
  assert(files.includes(path)&&!found.has(path)&&file.status==='passed'&&Array.isArray(file.assertionResults)&&file.assertionResults.length>0,'Foreign, duplicate or failing focused file');
  const names=file.assertionResults.map(a=>{assert(a.status==='passed'&&typeof a.fullName==='string'&&a.fullName.length>0,'Failed/skipped/unnamed assertion');return a.fullName;}).sort();
  count+=names.length;found.set(path,names);
 }
 assert(id(count)&&result.numTotalTests===count&&result.numPassedTests===count,'Focused assertion totals differ');return found;
}
/** Original failed DB process: every file must be enumerated and none may have passed (no partial-process inference). */
function originalFailedCases(unit,report){
 const cases=new Map();
 for(const batch of report.batches??[])for(const file of batch.result?.testResults??[]){
  const path=rel(report.cwd,file.name);assert(unit.files.includes(path)&&!cases.has(path),'Foreign/duplicate original failed-unit file');
  assert(file.status!=='passed','v1 recovers only DB units whose every file failed; a partially passing unit needs a full gate');
  assert(file.assertionResults?.length>0&&file.assertionResults.every(a=>typeof a.fullName==='string'&&a.fullName.length>0),'Original case inventory unavailable');
  cases.set(path,file.assertionResults.map(a=>a.fullName).sort());
 }
 assert(cases.size===unit.files.length,'Original failed process did not enumerate every file');return cases;
}
/** All metadata and archives must first be authenticated by the API/byte adapter. */
export function verifyDbUnitRecovery({plan,assessment,run,jobs,reports,focused,classifierHash,verificationController,verificationDiagnostic,history,ownerDecision}){
 assert(sha(verificationController)&&verificationDiagnostic?.controller===verificationController&&id(verificationDiagnostic.runId),'Hosted verifier controller diagnostic required');
 // Review 2026-11-24: verify from the exact original gate controller; no unreviewed controller delta is admitted.
 assert(verificationController===plan.controller&&verificationController===run.head_sha,'Verify from the exact original gate controller checkout');
 validateDbUnitOwnerDecision(ownerDecision,{runId:run.id,candidate:plan.sha});
 assert(assessment.sourceRun?.id===run.id&&assessment.sha===plan.sha&&assessment.controller===plan.controller&&assessment.baseline===plan.migrationBase&&assessment.fingerprint===plan.fingerprint&&plan.controller===run.head_sha,'Recovery source identity differs');
 assert(run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1,'Original failed first attempt must remain failed');
 assert(history?.kind==='AUTHENTICATED_COMPLETE_DB_UNIT_RECOVERY_HISTORY'&&history.sourceRunId===run.id,'Complete branch history required');
 const required=requiredEvidence(plan),failed=new Set(assessment.rerun.map(x=>x.id));
 assert(failed.size>0&&failed.size===assessment.rerun.length&&assessment.reusable.length+failed.size===plan.units.length,'Incomplete source coverage assessment');
 for(const u of plan.units.filter(u=>failed.has(u.id)))assert(u.kind==='db'&&u.pdfTools===false,'v1 recovers failed DB units without PDF tooling only');
 for(const j of jobs){
  const unit=plan.units.find(u=>unitJob(u)===j.name);
  if(j.name==='runner-diagnostics'){assert(j.conclusion==='skipped','Runner diagnostics executed');continue;}
  assert(required.jobs.includes(j.name),'Unknown source job');
  if(j.name==='verify'){assert(j.conclusion==='failure','Original dependent verifier must remain failed');continue;}
  if(unit&&failed.has(unit.id)){assert(j.conclusion==='failure','Failed DB unit job must remain failed');continue;}
  assert(j.conclusion==='success','Every other job must have succeeded: '+j.name);
 }
 assert(Array.isArray(reports)&&reports.length===plan.units.length&&new Set(reports.map(r=>r?.id)).size===reports.length,'Complete original report inventory required');
 const replacements=new Map(),focusedSources=[];
 for(const f of focused){
  const r=f.report;
  assert(r.kind==='FOCUSED_ONLY'&&r.releaseEligible===false&&r.schemaVersion===1&&r.sha===plan.sha&&r.controller===plan.controller&&r.runId===String(f.run.id)&&r.attempt==='1'&&r.exitCode===0,'Focused report identity/result differs');
  same(r.runtime,plan.runtime,'Focused runtime differs');
  assert(r.healthBefore?.ok===true&&r.healthAfter?.ok===true,'Focused runner health did not pass');
  assert(r.classifierHash===classifierHash&&r.manifestHash===hash(JSON.stringify(r.files)),'Focused selection/classifier hash differs');
  assert(Array.isArray(r.files)&&r.files.length>0&&r.files.length<=64&&new Set(r.files).size===r.files.length,'Bounded distinct focused files required');
  same(r.files,[...r.files].sort(),'Focused selection must be canonical');same(r.groups,{NODB:[],DB:r.files},'One homogeneous DB focused partition required');
  assert(r.batches?.length===1&&r.batches[0].kind==='DB'&&r.batches[0].exitCode===0&&r.batches[0].processExitCode===0&&r.batches[0].signal===null,'Focused DB process did not pass');
  same(r.batches[0].files,r.files,'Focused batch omitted files');
  const unit=plan.units.find(u=>u.kind==='db'&&isDeepStrictEqual(u.files.slice().sort(),r.files));
  assert(unit&&failed.has(unit.id),'Focused run must rerun exactly the failed files of one failed DB unit');
  const original=reports.find(x=>x?.id===unit.id);
  validatePostgresEvidence(r.databaseTerminalEvidence,plan.execution);const e=r.databaseTerminalEvidence;
  assert(e.name===`aihr-ci-${f.run.id}-1-db-1`&&Date.parse(e.capturedAt)>=Date.parse(r.batches[0].startedAt??r.startedAt)&&Date.parse(e.capturedAt)<=Date.parse(f.producer.completed_at)&&e.settings.serverVersionNum===original?.databaseTerminalEvidence?.settings?.serverVersionNum,'DB ownership, capture interval or PG runtime differs');
  assert(Date.parse(r.startedAt)>=Date.parse(f.producer.started_at)&&Date.parse(r.endedAt)<=Date.parse(f.producer.completed_at)&&Date.parse(r.endedAt)>=Date.parse(r.startedAt),'Focused execution outside producing job');
  const cases=passingCases(f.result,r.files);
  assert(r.batches[0].assertions===[...cases.values()].reduce((n,x)=>n+x.length,0),'Focused summary assertion count differs');
  for(const [path,names] of cases){assert(!replacements.has(path),'Focused recovery repeats a file');replacements.set(path,{cases:names,tests:names.length,runId:f.run.id,jobId:f.producer.id,artifactId:f.artifact.id,digest:f.artifact.digest});}
  focusedSources.push({runId:f.run.id,jobId:f.producer.id,artifactId:f.artifact.id,digest:f.artifact.digest,controller:f.run.head_sha,reportHash:hash(r),resultHash:hash(f.result),databaseName:e.name});
 }
 const units=[];let tests=0;
 for(const unit of plan.units){
  const report=reports.find(r=>r?.id===unit.id);
  if(!failed.has(unit.id)){
   const result=verifyUnitReport(plan,report),source=assessment.reusable.find(r=>r.id===unit.id);
   assert(source?.reportHash===hash(report),'Retained report changed');tests+=result.tests;units.push({id:unit.id,kind:'retained',files:result.files,tests:result.tests,reportHash:hash(report),source:source.source});continue;
  }
  assert(report.sha===plan.sha&&report.fingerprint===plan.fingerprint&&report.exitCode!==0,'Failed original unit identity differs');same(report.files,unit.files,'Original failed coverage differs');
  const originals=originalFailedCases(unit,report);let count=0;const files=[];
  for(const path of unit.files){const replacement=replacements.get(path);assert(replacement,'Failed DB unit lacks focused recovery: '+path);same(replacement.cases,originals.get(path),'Recovery dropped/changed assertions');count+=replacement.tests;files.push({path,...replacement});}
  tests+=count;units.push({id:unit.id,kind:'db-unit-recovery',originalReportHash:hash(report),originalExitCode:report.exitCode,tests:count,files});
 }
 assert(replacements.size===plan.units.filter(u=>failed.has(u.id)).reduce((n,u)=>n+u.files.length,0),'Recovery coverage is incomplete or excessive');
 return {kind:DB_UNIT_RECOVERY_KIND,recoveryPolicy:DB_UNIT_RECOVERY_POLICY,exception:DB_UNIT_RECOVERY_EXCEPTION,fullGatePass:false,ownerDecision,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,verificationDiagnostic,baseline:plan.migrationBase,runId:run.id,sourceFingerprint:plan.fingerprint,originalConclusion:run.conclusion,originalFailureObservations:assessment.observations,originalJobConclusions:jobs.filter(j=>j.conclusion!=='success').map(j=>({id:j.id,name:j.name,conclusion:j.conclusion})),focusedSources:focusedSources.sort((a,b)=>a.runId-b.runId),history,units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests};
}
/** Installation grant binds the original failed run and its successful build; the distinct certificate is the witness. */
export function validateDbUnitGrantEvidence(evidence,run){
 const c=evidence.recovery;
 assert(c?.kind===DB_UNIT_RECOVERY_KIND&&c.recoveryPolicy===DB_UNIT_RECOVERY_POLICY&&c.exception===DB_UNIT_RECOVERY_EXCEPTION&&c.fullGatePass===false&&c.originalConclusion==='failure'&&evidence.fingerprint===hash(c),'Authenticated DB-unit recovery certificate required');
 validateDbUnitOwnerDecision(c.ownerDecision,{runId:c.runId,candidate:c.sha});
 for(const key of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests'])same(evidence[key],c[key],'Recovery grant identity differs: '+key);
 assert(sha(c.verificationController)&&c.verificationController===c.controller&&c.runId===run.id&&c.controller===run.head_sha&&run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1&&c.focusedSources?.length>0&&c.focusedSources.every(s=>s.controller===c.controller)&&c.units?.some(u=>u.kind==='db-unit-recovery'),'Original failure/recovery provenance required');
 assert(c.verificationDiagnostic?.controller===c.verificationController&&id(c.verificationDiagnostic.runId)&&c.history?.sourceRunId===c.runId,'Verification controller/history missing');
 return true;
}
