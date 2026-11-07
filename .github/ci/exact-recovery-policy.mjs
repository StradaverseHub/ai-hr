/** Separately versioned exact-source Node/DB recovery; v1 is unchanged. Never rewrites an original run, unit report or gate receipt. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {relative} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
export const EXACT_RECOVERY_POLICY='aihr-exact-source-recovery/v3';
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const positive=x=>Number.isSafeInteger(x)&&x>0;
const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
const jobName=u=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`;
const focusedJobs=['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-swift-models','native-bundle'];
function cases(result,files,cwd){
 assert(result?.success===true&&result.numFailedTests===0&&result.numFailedTestSuites===0&&[result.numPendingTests??0,result.numPendingTestSuites??0,result.numTodoTests??0].every(n=>n===0),'Focused result contains errors/skips');
 assert(Array.isArray(result.testResults)&&result.testResults.length===files.length,'Focused result file count differs');
 const found=new Map();let count=0;
 for(const file of result.testResults){
  const path=relative(cwd,file.name).split('\\').join('/');
  assert(files.includes(path)&&!found.has(path)&&file.status==='passed'&&Array.isArray(file.assertionResults)&&file.assertionResults.length>0,'Foreign, duplicate or failing focused file');
  const names=file.assertionResults.map(a=>{assert(a.status==='passed'&&typeof a.fullName==='string'&&a.fullName.length>0,'Failed/skipped/unnamed assertion');return a.fullName;});
  count+=names.length;found.set(path,{tests:names.length,cases:names.slice().sort()});
 }
 assert(positive(count)&&result.numTotalTests===count&&result.numPassedTests===count,'Focused assertion totals differ');return found;
}
/** All metadata and archives must first be authenticated by the API/byte adapter. */
export function verifyExactRecovery({plan,assessment,run,jobs,reports,focused,classifierHash,verificationController}){
 assert(sha(verificationController)&&assessment.sourceRun?.id===run.id&&assessment.sha===plan.sha&&assessment.controller===plan.controller&&assessment.baseline===plan.migrationBase&&assessment.fingerprint===plan.fingerprint,'Recovery source identity differs');
 assert(run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1,'Original failed first attempt must remain failed');
 const required=requiredEvidence(plan),failed=new Set(assessment.rerun.map(x=>x.id));
 assert(failed.size>0&&failed.size===assessment.rerun.length&&assessment.reusable.length+failed.size===plan.units.length,'Incomplete source coverage assessment');
 for(const j of jobs){
  const unit=plan.units.find(u=>jobName(u)===j.name);
  if(j.name==='runner-diagnostics'){assert(j.conclusion==='skipped');continue;}
  assert(required.jobs.includes(j.name),'Unknown source job');
  if(j.name==='verify'){assert(j.conclusion==='failure','Original dependent verifier must remain failed');continue;}
  if(unit&&failed.has(unit.id)){assert(['nodb','db'].includes(unit.kind)&&j.conclusion==='failure','Only complete failed Node/DB units are recoverable');continue;}
  assert(j.conclusion==='success','A failed build/compiler/migration/controller/browser prerequisite cannot be recovered by focused tests');
 }
 assert(Array.isArray(reports)&&reports.length===plan.units.length&&new Set(reports.map(r=>r.id)).size===reports.length,'Complete original report inventory required');
 const replacements=new Map(),focusedSources=[];
 for(const f of focused){
  const r=f.report;
  assert(r.kind==='FOCUSED_ONLY'&&r.releaseEligible===false&&r.schemaVersion===1&&r.sha===plan.sha&&r.controller===plan.controller&&r.runId===String(f.run.id)&&r.attempt==='1'&&r.exitCode===0,'Focused report identity/result differs');
  same(r.runtime,plan.runtime,'Focused runtime differs');
  assert(r.healthBefore?.ok===true&&r.healthAfter?.ok===true,'Focused runner health did not pass');
  assert(r.classifierHash===classifierHash&&r.manifestHash===hash(JSON.stringify(r.files)),'Focused selection/classifier hash differs');
  assert(Array.isArray(r.files)&&r.files.length>0&&r.files.length<=64&&new Set(r.files).size===r.files.length,'Bounded distinct focused files required');
  same(r.files,[...r.files].sort(),'Focused selection must be canonical');
  const database=r.groups?.DB?.length>0,kind=database?'DB':'NODB';
  same(r.groups,database?{NODB:[],DB:r.files}:{NODB:r.files,DB:[]},'One homogeneous focused partition required');
  const unit=plan.units.find(u=>failed.has(u.id)&&u.kind===(database?'db':'nodb')&&isDeepStrictEqual(u.files.slice().sort(),r.files));
  assert(unit,'Every replacement must cover one entire original failed unit');
  assert(r.batches?.length===1&&r.batches[0].kind===kind&&r.batches[0].exitCode===0&&r.batches[0].processExitCode===0&&r.batches[0].signal===null,'Focused process did not pass');
  if(database){
   validatePostgresEvidence(r.databaseTerminalEvidence,plan.execution);
   const e=r.databaseTerminalEvidence,original=reports.find(x=>x.id===unit.id)?.databaseTerminalEvidence;
   const times=[r.startedAt,r.batches[0].startedAt,r.batches[0].endedAt,e.capturedAt,r.endedAt,f.producer.completed_at].map(Date.parse);
   assert(times.every(Number.isFinite)&&times.every((t,i)=>i===0||t>=times[i-1]),'DB evidence must be captured after the entire batch and before report/job completion');
   assert(e.name===`aihr-ci-${f.run.id}-1-db-1`&&e.settings.serverVersionNum===original?.settings?.serverVersionNum,'Fresh DB ownership/runtime differs');
  }
  same(r.batches[0].files,r.files,'Focused batch omitted files');
  assert(Date.parse(r.startedAt)>=Date.parse(f.producer.started_at)&&Date.parse(r.endedAt)<=Date.parse(f.producer.completed_at)&&Date.parse(r.endedAt)>=Date.parse(r.startedAt),'Focused execution outside producing job');
  const verified=cases(f.result,r.files,'/home/runner/work/ai-hr/ai-hr/source');
  assert(r.batches[0].assertions===[...verified.values()].reduce((n,x)=>n+x.tests,0),'Focused summary assertion count differs');
  for(const [path,value] of verified){
   const unit=plan.units.find(u=>u.files.includes(path));
   assert(unit&&failed.has(unit.id)&&!replacements.has(path),'Focused recovery repeats or includes an unaffected file');
   replacements.set(path,{...value,runId:f.run.id,jobId:f.producer.id,artifactId:f.artifact.id,digest:f.artifact.digest});
  }
  focusedSources.push({runId:f.run.id,jobId:f.producer.id,artifactId:f.artifact.id,digest:f.artifact.digest,reportHash:hash(r),resultHash:hash(f.result)});
 }
 const units=[];let tests=0;
 for(const unit of plan.units){
  const report=reports.find(r=>r.id===unit.id);
  if(!failed.has(unit.id)){
   const result=verifyUnitReport(plan,report),source=assessment.reusable.find(r=>r.id===unit.id);
   assert(source?.reportHash===hash(report),'Retained report changed');tests+=result.tests;units.push({id:unit.id,kind:'retained',files:result.files,tests:result.tests,reportHash:hash(report),source:source.source});continue;
  }
  assert(report.sha===plan.sha&&report.fingerprint===plan.fingerprint&&report.exitCode!==0,'Failed original unit identity differs');same(report.files,unit.files,'Original failed coverage differs');
  // Recover the complete failed process, never infer passes from a process with an unhandled error.
  const originalCases=new Map();
  for(const batch of report.batches??[])for(const file of batch.result?.testResults??[]){
   const path=relative(report.cwd,file.name).split('\\').join('/');assert(unit.files.includes(path)&&!originalCases.has(path),'Foreign/duplicate original failed-unit file');
   assert(file.assertionResults?.length>0&&file.assertionResults.every(a=>typeof a.fullName==='string'&&a.fullName.length>0),'Original case inventory unavailable');
   originalCases.set(path,file.assertionResults.map(a=>a.fullName).sort());
  }
  assert(originalCases.size===unit.files.length,'Original failed process did not enumerate every file');
  let count=0;const files=[];
  for(const path of unit.files){const replacement=replacements.get(path);assert(replacement,'Failed unit lacks focused recovery: '+path);same(replacement.cases,originalCases.get(path),'Recovery dropped/changed assertions');count+=replacement.tests;files.push({path,...replacement});}
  tests+=count;units.push({id:unit.id,kind:'focused-recovery',originalReportHash:hash(report),tests:count,files});
 }
 assert(replacements.size===plan.units.filter(u=>failed.has(u.id)).reduce((n,u)=>n+u.files.length,0),'Recovery coverage is incomplete');
 return {kind:'AUTHENTICATED_EXACT_SOURCE_RECOVERY',recoveryPolicy:EXACT_RECOVERY_POLICY,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,baseline:plan.migrationBase,runId:run.id,sourceFingerprint:plan.fingerprint,originalConclusion:run.conclusion,originalFailureObservations:assessment.observations,focusedSources:focusedSources.sort((a,b)=>a.runId-b.runId),units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests};
}
/** Installation grant keeps the original failed run and build tuple; its fingerprint binds this distinct certificate. */
export function validateExactRecoveryGrantEvidence(evidence,run){
 const c=evidence.recovery;
 assert(c?.kind==='AUTHENTICATED_EXACT_SOURCE_RECOVERY'&&c.recoveryPolicy===EXACT_RECOVERY_POLICY&&c.originalConclusion==='failure'&&evidence.fingerprint===hash(c),'Authenticated recovery certificate required');
 for(const key of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests'])same(evidence[key],c[key],'Recovery grant identity differs: '+key);
 assert(sha(c.verificationController)&&c.runId===run.id&&c.controller===run.head_sha&&run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1&&c.focusedSources?.length>0&&c.units?.some(u=>u.kind==='focused-recovery'),'Original failure/recovery provenance required');
 assert(c.history?.kind==='AUTHENTICATED_EXACT_SOURCE_RECOVERY_HISTORY'&&c.history.originalRunId===c.runId&&isDeepStrictEqual(c.history.runIds,c.focusedSources.map(f=>f.runId).sort((a,b)=>a-b)),'Complete exact recovery history required');
 assert(c.verificationDiagnostic?.controller===c.verificationController&&positive(c.verificationDiagnostic.runId)&&c.reviewedController===c.verificationController,'Reviewed verification controller validation missing');
 return true;
}

export function requireReviewedExactController({controller,reviewedController}){assert(sha(controller)&&reviewedController===controller,'Exact independently reviewed recovery controller required');}

/** Complete API history, including overlapping failures and active executions. */
export function validateExactRecoveryHistory({sourceRun,rows,candidateBranch,focusedRunIds}){
 assert(sourceRun.display_title===`Alpha CI · ${candidateBranch}`&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidateBranch)&&!candidateBranch.includes('..'),'Exact original candidate branch required');
 assert(Array.isArray(rows)&&rows.length<=8000,'Bounded complete history required');
 const expected=new Set(focusedRunIds),names=new Set([sourceRun.display_title,`Focused only · ${candidateBranch}`,`Canonical build only · ${candidateBranch}`]),found=new Map();
 for(const r of rows){
  if(r.id===sourceRun.id||!names.has(r.display_title))continue;
  assert(positive(r.id)&&Number.isFinite(Date.parse(r.created_at))&&Number.isFinite(Date.parse(r.updated_at))&&Date.parse(r.updated_at)>=Date.parse(r.created_at)&&['queued','in_progress','waiting','requested','pending','completed'].includes(r.status),'Malformed relevant history');
  const record={id:r.id,title:r.display_title,controller:r.head_sha,status:r.status,conclusion:r.conclusion,attempt:r.run_attempt,createdAt:r.created_at,updatedAt:r.updated_at};
  assert(!found.has(r.id)||isDeepStrictEqual(found.get(r.id),record),'Conflicting history snapshots; retry after stabilization');found.set(r.id,record);
 }
 const relevant=[...found.values()].filter(r=>r.status!=='completed'||Date.parse(r.updatedAt)>=Date.parse(sourceRun.updated_at)).sort((a,b)=>a.id-b.id);
 assert(relevant.length===expected.size&&relevant.every(r=>expected.has(r.id)&&r.status==='completed'&&r.conclusion==='success'&&r.attempt===1),'Unaccounted, failed, superseding or active recovery execution');
 return {kind:'AUTHENTICATED_EXACT_SOURCE_RECOVERY_HISTORY',originalRunId:sourceRun.id,runIds:relevant.map(r=>r.id),metadataFingerprint:hash(relevant)};
}
