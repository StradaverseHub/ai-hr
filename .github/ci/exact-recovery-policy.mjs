/** Separately versioned exact-source Node/DB recovery; v1 is unchanged. Never rewrites an original run, unit report or gate receipt. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {relative} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {exactCanonicalRefs,validateCanonicalContext} from './canonical-docs-advance.mjs';
import {verifyMissingUnitEvidence} from './repair-missing-unit-policy.mjs';
import {MIXED,validateMixedOriginal} from './payroll-mixed-source.mjs';
export const EXACT_RECOVERY_POLICY='aihr-exact-source-recovery/v6';
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
export function verifyExactRecovery({plan,assessment,run,jobs,reports,focused,missingProof,classifierHash,verificationController,canonicalAdvance=exactCanonicalRefs({originalController:plan.controller,baseline:plan.migrationBase,candidate:plan.sha})}){
 assert(sha(verificationController)&&assessment.sourceRun?.id===run.id&&assessment.sha===plan.sha&&assessment.controller===plan.controller&&assessment.baseline===plan.migrationBase&&assessment.fingerprint===plan.fingerprint,'Recovery source identity differs');
 validateCanonicalContext(canonicalAdvance,{originalController:plan.controller,baseline:plan.migrationBase,candidate:plan.sha});
 const focusedController=canonicalAdvance.focusedController;
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
 if(run.id===MIXED.originalRun)assert(missingProof,'Exact interrupted System Labels proof required');
 let missing;
 if(missingProof){
  const unit=validateMixedOriginal({run,jobs,artifacts:missingProof.originalArtifacts},plan);
  const observed=assessment.observations.find(row=>row.id===unit.id);
  assert(failed.has(unit.id)&&observed?.artifact===null&&observed.jobId===MIXED.interruptedJob,'Interrupted unit must remain without an original report');
  assert(missingProof.proof.freshPlan.controller===verificationController&&missingProof.proof.expected.after===run.updated_at,'Replacement unit controller or chronology differs');
  missing={...verifyMissingUnitEvidence({sourcePlan:plan,plan,missing:unit.id,proof:missingProof.proof}),nativePrepull:missingProof.nativePrepull,hostSwap:missingProof.proof.hostSwap};
 }
 assert(Array.isArray(reports)&&reports.length===plan.units.length-(missing?1:0)&&new Set(reports.map(r=>r.id)).size===reports.length,'Complete available original report inventory required');
 const replacements=new Map(),focusedSources=[];
 for(const f of focused){
  const r=f.report;
  assert(r.kind==='FOCUSED_ONLY'&&r.releaseEligible===false&&r.schemaVersion===1&&r.sha===plan.sha&&r.controller===focusedController&&f.run.head_sha===focusedController&&r.runId===String(f.run.id)&&r.attempt==='1'&&r.exitCode===0,'Focused report identity/result differs');
  same(r.runtime,plan.runtime,'Focused runtime differs');
  assert(r.healthBefore?.ok===true&&r.healthAfter?.ok===true,'Focused runner health did not pass');
  assert(r.classifierHash===classifierHash&&r.manifestHash===hash(JSON.stringify(r.files)),'Focused selection/classifier hash differs');
  assert(Array.isArray(r.files)&&r.files.length>0&&r.files.length<=64&&new Set(r.files).size===r.files.length,'Bounded distinct focused files required');
  same(r.files,[...r.files].sort(),'Focused selection must be canonical');
  const database=r.groups?.DB?.length>0,kind=database?'DB':'NODB';
  same(r.groups,database?{NODB:[],DB:r.files}:{NODB:r.files,DB:[]},'One homogeneous focused partition required');
  const unit=plan.units.find(u=>failed.has(u.id)&&u.id!==missing?.unitId&&u.kind===(database?'db':'nodb')&&!u.pdfTools&&
    (database?isDeepStrictEqual(u.files.slice().sort(),r.files):r.files.every(file=>u.files.includes(file))));
  assert(unit,'Replacement must cover one full DB unit or files from one failed no-DB unit');
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
  focusedSources.push({runId:f.run.id,controller:focusedController,jobId:f.producer.id,artifactId:f.artifact.id,digest:f.artifact.digest,reportHash:hash(r),resultHash:hash(f.result)});
 }
 const units=[];let tests=0;
 for(const unit of plan.units){
  const report=reports.find(r=>r.id===unit.id);
  if(unit.id===missing?.unitId){
   assert(!report,'Original interrupted report must remain absent');
   tests+=missing.tests;
   units.push({id:unit.id,kind:'interrupted-unit-recovery',originalReport:null,...missing});continue;
  }
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
 assert(replacements.size===plan.units.filter(u=>failed.has(u.id)&&u.id!==missing?.unitId).reduce((n,u)=>n+u.files.length,0),'Recovery coverage is incomplete');
 return {kind:'AUTHENTICATED_EXACT_SOURCE_RECOVERY',recoveryPolicy:EXACT_RECOVERY_POLICY,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,focusedController,canonicalAdvance,baseline:plan.migrationBase,runId:run.id,sourceFingerprint:plan.fingerprint,originalConclusion:run.conclusion,originalFailureObservations:assessment.observations,...(missing?{missingUnit:missing}:{}),focusedSources:focusedSources.sort((a,b)=>a.runId-b.runId),units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests};
}
/** Installation grant keeps the original failed run and build tuple; its fingerprint binds this distinct certificate. */
export function validateExactRecoveryGrantEvidence(evidence,run){
 const c=evidence.recovery;
 assert(c?.kind==='AUTHENTICATED_EXACT_SOURCE_RECOVERY'&&c.recoveryPolicy===EXACT_RECOVERY_POLICY&&c.originalConclusion==='failure'&&evidence.fingerprint===hash(c),'Authenticated recovery certificate required');
 for(const key of ['sha','controller','verificationController','focusedController','canonicalAdvance','baseline','runId','policyVersion','suiteFiles','browserFiles','tests'])same(evidence[key],c[key],'Recovery grant identity differs: '+key);
 assert(sha(c.verificationController)&&c.runId===run.id&&c.controller===run.head_sha&&run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1&&c.focusedSources?.length>0&&c.units?.some(u=>u.kind==='focused-recovery'),'Original failure/recovery provenance required');
 validateCanonicalContext(c.canonicalAdvance,{originalController:c.controller,baseline:c.baseline,candidate:c.sha});
 assert(c.focusedController===c.canonicalAdvance.focusedController&&c.focusedSources.every(f=>f.controller===c.focusedController),'Focused producer differs from audited canonical context');
 const runIds=c.focusedSources.map(f=>f.runId);
 if(c.runId===MIXED.originalRun){
  assert(c.missingUnit?.unitId===MIXED.unit&&c.missingUnit.source.controller===c.verificationController&&c.missingUnit.hostSwap?.cleanupVerified===true&&c.missingUnit.priorExpectationUsedAsPass===false,'Reviewed interrupted unit proof required');
  runIds.push(c.missingUnit.source.runId);
  same(c.history?.previousFailures?.map(entry=>entry.id).sort((a,b)=>a-b),[MIXED.failedFocusedRun,MIXED.refusedUnitRun,MIXED.interruptedRecoveryRun],'All previous failed recovery attempts must remain in the certificate');
 }
 assert(c.history?.kind==='AUTHENTICATED_EXACT_SOURCE_RECOVERY_HISTORY'&&c.history.originalRunId===c.runId&&isDeepStrictEqual(c.history.runIds,runIds.sort((a,b)=>a-b)),'Complete exact recovery history required');
 assert(c.verificationDiagnostic?.controller===c.verificationController&&positive(c.verificationDiagnostic.runId)&&c.reviewedController===c.verificationController,'Reviewed verification controller validation missing');
 return true;
}

export function requireReviewedExactController({controller,reviewedController}){assert(sha(controller)&&reviewedController===controller,'Exact independently reviewed recovery controller required');}

/** Each reserved alias can run concurrently and must point at the same frozen candidate. */
export function exactRecoveryBranch(candidateBranch,runId,ref){
 if(ref===candidateBranch)return true;
 const prefix=candidateBranch+'-recovery-'+runId+'-';
 if(typeof ref!=='string'||!ref.startsWith(prefix))return false;
 return /^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(ref.slice(prefix.length));
}

/** Complete API history, including overlapping failures and active executions. */
export function validateExactRecoveryHistory({sourceRun,rows,candidateBranch,focusedRunIds,focusedController=sourceRun.head_sha,missingRunId,missingController,previousFailures=[]}){
 assert(sourceRun.display_title===`Alpha CI · ${candidateBranch}`&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidateBranch)&&!candidateBranch.includes('..'),'Exact original candidate branch required');
 assert(Array.isArray(rows)&&rows.length<=8000,'Bounded complete history required');
 const expected=new Set(focusedRunIds),found=new Map();
 if(missingRunId)expected.add(missingRunId);
 for(const r of rows){
  const title=typeof r.display_title==='string'?r.display_title.match(/^(?:Alpha CI|Focused only|Canonical build only) · (.+)$/):null;
  const missingTitle=sourceRun.id===MIXED.originalRun&&r.display_title===`Missing whole unit · ${MIXED.unit} · ${candidateBranch}`;
  if(r.id===sourceRun.id||(!missingTitle&&(!title||!exactRecoveryBranch(candidateBranch,sourceRun.id,title[1]))))continue;
  assert(positive(r.id)&&Number.isFinite(Date.parse(r.created_at))&&Number.isFinite(Date.parse(r.updated_at))&&Date.parse(r.updated_at)>=Date.parse(r.created_at)&&['queued','in_progress','waiting','requested','pending','completed'].includes(r.status),'Malformed relevant history');
  const record={id:r.id,title:r.display_title,controller:r.head_sha,status:r.status,conclusion:r.conclusion,attempt:r.run_attempt,createdAt:r.created_at,updatedAt:r.updated_at};
  assert(!found.has(r.id)||isDeepStrictEqual(found.get(r.id),record),'Conflicting history snapshots; retry after stabilization');found.set(r.id,record);
 }
 const relevant=[...found.values()].filter(r=>r.status!=='completed'||Date.parse(r.updatedAt)>=Date.parse(sourceRun.updated_at)).sort((a,b)=>a.id-b.id);
 const failures=new Map(previousFailures.map(failure=>[failure.id,failure]));
 assert(failures.size===previousFailures.length,'Duplicate failed recovery observations');
 if(failures.size)assert(sourceRun.id===MIXED.originalRun&&failures.size===3&&failures.has(MIXED.failedFocusedRun)&&failures.has(MIXED.refusedUnitRun)&&failures.has(MIXED.interruptedRecoveryRun),'Only the exact audited recovery failures may be retained');
 for(const [id,failure] of failures){
  const row=relevant.find(item=>item.id===id);
  assert(row&&row.title===failure.title&&row.controller===failure.controller&&row.status==='completed'&&row.conclusion===failure.conclusion&&(['failure'].includes(row.conclusion)||id===MIXED.interruptedRecoveryRun&&row.conclusion==='cancelled')&&row.attempt===1&&row.updatedAt===failure.updatedAt,'Previous failed run identity changed');
  assert(!expected.has(id),'Failed attempt cannot supply passing coverage');
 }
 const successes=relevant.filter(row=>!failures.has(row.id));
 assert(successes.length===expected.size&&successes.every(r=>expected.has(r.id)&&r.controller===(r.id===missingRunId?missingController:focusedController)&&r.status==='completed'&&r.conclusion==='success'&&r.attempt===1),'Unaccounted, failed, superseding, foreign-controller or active recovery execution');
 return {kind:'AUTHENTICATED_EXACT_SOURCE_RECOVERY_HISTORY',originalRunId:sourceRun.id,runIds:successes.map(r=>r.id),metadataFingerprint:hash(relevant),...(failures.size?{previousFailures}: {})};
}
