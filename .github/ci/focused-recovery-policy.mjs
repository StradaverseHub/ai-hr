/** Versioned exact-source recovery. Never rewrites an original run, unit report or gate receipt. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {relative} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
export const RECOVERY_POLICY='aihr-focused-recovery/v1';
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const positive=x=>Number.isSafeInteger(x)&&x>0;
const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
const jobName=u=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`;
const focusedJobs=['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-swift-models','native-bundle'];
export function validateRecoveryControllerDiagnostic({run,jobs,controller,now=Date.now()}){
 assert(sha(controller)&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&positive(run.id),'Foreign verification-controller diagnostic');
 assert(run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.event==='workflow_dispatch'&&run.head_sha===controller&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1&&run.display_title?.startsWith('CI controller checks · '),'Exact successful controller-only diagnostic required');
 assert(now-Date.parse(run.created_at)<=86400000&&Date.parse(run.created_at)<=now+60000,'Stale controller diagnostic');
 const names=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'];
 assert(jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length,'Complete controller diagnostic job inventory required');
 for(const j of jobs)assert(names.includes(j.name)&&j.run_id===run.id&&j.head_sha===controller&&j.run_attempt===1&&j.status==='completed'&&j.conclusion===(['resolve','deployment-hold'].includes(j.name)?'success':'skipped'),'Diagnostic executed application checks or failed controls');
 assert(jobs.find(j=>j.name==='resolve').steps?.some(s=>s.name==='CI integrity regression checks'&&s.conclusion==='success'),'Controller integrity controls did not pass');
 return {runId:run.id,controller,resolveJobId:jobs.find(j=>j.name==='resolve').id,kind:'CONTROLLER_ONLY_NOT_APPLICATION_GATE'};
}
export function validateFocusedMetadata({run,jobs,artifacts,expected,now=Date.now()}){
 assert(run.id===expected.runId&&positive(run.id)&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign focused run');
 assert(positive(expected.workflowId)&&run.workflow_id===expected.workflowId&&run.path==='.github/workflows/alpha-focused-checks.yml'&&run.event==='workflow_dispatch'&&['main','alpha'].includes(run.head_branch)&&run.head_sha===expected.controller,'Untrusted focused controller/workflow');
 assert(run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Focused run must be a successful first attempt');
 const created=Date.parse(run.created_at),finished=Date.parse(run.updated_at);
 assert(Number.isFinite(created)&&Number.isFinite(finished)&&created>=Date.parse(expected.after)&&finished>=created&&finished<=now+60000&&now-created<=86400000,'Focused evidence is stale or precedes source completion');
 assert(Array.isArray(jobs)&&jobs.length===focusedJobs.length&&new Set(jobs.map(j=>j.name)).size===jobs.length&&new Set(jobs.map(j=>j.id)).size===jobs.length,'Exact focused job inventory required');
 for(const j of jobs){
  assert(focusedJobs.includes(j.name)&&positive(j.id)&&j.run_id===run.id&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed','Foreign, missing or rerun focused job');
  assert(j.conclusion===(['resolve','selected-tests'].includes(j.name)?'success':'skipped'),'Unexpected focused prerequisite result');
 }
 assert(Array.isArray(artifacts)&&artifacts.length===1,'Unique focused artifact required');
 const a=artifacts[0],w=a.workflow_run,j=jobs.find(j=>j.name==='selected-tests');
 assert(a.name==='focused-development-evidence'&&positive(a.id)&&a.expired===false&&positive(a.size_in_bytes)&&a.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(a.digest),'Invalid focused artifact');
 assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Focused artifact provenance differs');
 assert(Date.parse(j.started_at)>=created&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=finished&&Date.parse(a.created_at)>=Date.parse(j.started_at)&&Date.parse(a.created_at)<=Date.parse(j.completed_at)&&Date.parse(a.expires_at)>now,'Focused artifact is outside its producing job');
 return j;
}
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
export function verifyFocusedRecovery({plan,assessment,run,jobs,reports,focused,classifierHash,verificationController}){
 assert(sha(verificationController)&&assessment.sourceRun?.id===run.id&&assessment.sha===plan.sha&&assessment.controller===plan.controller&&assessment.baseline===plan.migrationBase&&assessment.fingerprint===plan.fingerprint,'Recovery source identity differs');
 assert(run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1,'Original failed first attempt must remain failed');
 const required=requiredEvidence(plan),failed=new Set(assessment.rerun.map(x=>x.id));
 assert(failed.size>0&&failed.size===assessment.rerun.length&&assessment.reusable.length+failed.size===plan.units.length,'Incomplete source coverage assessment');
 for(const j of jobs){
  const unit=plan.units.find(u=>jobName(u)===j.name);
  if(j.name==='runner-diagnostics'){assert(j.conclusion==='skipped');continue;}
  assert(required.jobs.includes(j.name),'Unknown source job');
  if(j.name==='verify'){assert(j.conclusion==='failure','Original dependent verifier must remain failed');continue;}
  if(unit&&failed.has(unit.id)){assert(unit.kind==='nodb'&&j.conclusion==='failure','v1 recovers failed no-DB test units only');continue;}
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
  same(r.files,[...r.files].sort(),'Focused selection must be canonical');same(r.groups,{NODB:r.files,DB:[]},'Only no-DB focused recovery is supported');
  assert(r.batches?.length===1&&r.batches[0].kind==='NODB'&&r.batches[0].exitCode===0&&r.batches[0].processExitCode===0&&r.batches[0].signal===null,'Focused process did not pass');
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
 return {kind:'AUTHENTICATED_FOCUSED_RECOVERY',recoveryPolicy:RECOVERY_POLICY,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,baseline:plan.migrationBase,runId:run.id,sourceFingerprint:plan.fingerprint,originalConclusion:run.conclusion,originalFailureObservations:assessment.observations,focusedSources:focusedSources.sort((a,b)=>a.runId-b.runId),units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests};
}
/** Installation grant keeps the original failed run and build tuple; its fingerprint binds this distinct certificate. */
export function validateRecoveryGrantEvidence(evidence,run){
 const c=evidence.recovery;
 assert(c?.kind==='AUTHENTICATED_FOCUSED_RECOVERY'&&c.recoveryPolicy===RECOVERY_POLICY&&c.originalConclusion==='failure'&&evidence.fingerprint===hash(c),'Authenticated recovery certificate required');
 for(const key of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests'])same(evidence[key],c[key],'Recovery grant identity differs: '+key);
 assert(sha(c.verificationController)&&c.runId===run.id&&c.controller===run.head_sha&&run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1&&c.focusedSources?.length>0&&c.units?.some(u=>u.kind==='focused-recovery'),'Original failure/recovery provenance required');
 assert(c.verificationDiagnostic?.controller===c.verificationController&&positive(c.verificationDiagnostic.runId),'Verification controller validation missing');
 return true;
}
