/** Cross-source v2 accounting. API/archive/source authentication belongs to the adapter. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {validateCompleteUnitHealth} from './unit-repair-health.mjs';
import {validatePdfRepairMetadata} from './pdf-repair-metadata.mjs';
import {validateBrowserRepairMetadata,validateBrowserRepairImage} from './browser-repair-metadata.mjs';
import {relative} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
export const REPAIR_RECOVERY_POLICY='aihr-fixture-browser-recovery/v3';
const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>Number.isSafeInteger(x)&&x>0;
const unitJob=u=>u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`;
const fullJobs=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'];
const focusedJobs=['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-swift-models','native-bundle'];
function runIdentity(run,{runId,controller,after,now=Date.now()}){
 assert(id(runId)&&run.id===runId&&sha(controller)&&run.head_sha===controller&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign repair execution');
 assert(run.event==='workflow_dispatch'&&['main','alpha'].includes(run.head_branch)&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Successful first-attempt published-controller execution required');
 const start=Date.parse(run.created_at),end=Date.parse(run.updated_at);
 assert(Number.isFinite(start)&&Number.isFinite(end)&&start>=Date.parse(after)&&end>=start&&end<=now+60000&&now-start<=86400000,'Repair execution is stale or precedes original completion');
}
function jobsIdentity(run,jobs,names,success){
 assert(Array.isArray(jobs)&&jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length&&new Set(jobs.map(j=>j.id)).size===names.length,'Complete distinct repair job inventory required');
 for(const j of jobs){
  assert(names.includes(j.name)&&id(j.id)&&j.run_id===run.id&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed'&&j.conclusion===(success.includes(j.name)?'success':'skipped'),'Repair producing job differs');
  if(j.conclusion==='success')assert(Date.parse(j.started_at)>=Date.parse(run.created_at)&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=Date.parse(run.updated_at),'Repair job times differ');
 }
}
export function validateRepairFocusedMetadata({run,jobs,artifacts,expected,now=Date.now()}){
 runIdentity(run,{...expected,now});assert(run.workflow_id===expected.workflowId&&id(expected.workflowId)&&run.path==='.github/workflows/alpha-focused-checks.yml','Focused workflow registry differs');
 const compiler=jobs.find(j=>j.name==='typecheck');assert(['success','skipped'].includes(compiler?.conclusion),'Fresh compiler failed');
 jobsIdentity(run,jobs,focusedJobs,['resolve','selected-tests',...(compiler.conclusion==='success'?['typecheck']:[])]);
 assert(artifacts.length===1,'Exact focused artifact inventory required');const a=artifacts[0],j=jobs.find(j=>j.name==='selected-tests');
 assert(a.name==='focused-development-evidence'&&id(a.id)&&a.expired===false&&id(a.size_in_bytes)&&a.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(a.digest),'Focused evidence artifact differs');
 const w=a.workflow_run;assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Foreign focused artifact');
 assert(Date.parse(a.created_at)>=Date.parse(j.started_at)&&Date.parse(a.created_at)<=Date.parse(j.completed_at)&&Date.parse(a.expires_at)>now,'Focused artifact outside producer');
 return {producer:j,compiler:compiler.conclusion==='success'?{runId:run.id,jobId:compiler.id,controller:run.head_sha}:null};
}
export function validateRepairBuildMetadata({run,jobs,expected}){
 runIdentity(run,expected);assert(run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.display_title===`Canonical build only · ${expected.candidateBranch}`,'Exact canonical build-only route required');
 jobsIdentity(run,jobs,fullJobs,['resolve','build','deployment-hold']);return jobs.find(j=>j.name==='build');
}
/** No caller-selected invalidation list is authoritative. Input comes from immutable Git impact. */
export function repairDisposition({sourcePlan,plan,assessment,impactContext,verificationController}){
 requiredEvidence(sourcePlan);requiredEvidence(plan);
 for(const p of [sourcePlan,plan]){const {fingerprint,...body}=p;assert(fingerprint===hash(body),'Altered independently reconstructed full plan');}
 assert(sourcePlan.sha!==plan.sha&&sha(verificationController)&&impactContext.base===sourcePlan.sha&&impactContext.head===plan.sha&&impactContext.controller===verificationController,'Repair delta/controller differs');
 same(plan.runtime,sourcePlan.runtime,'Runtime changed');same(plan.execution,sourcePlan.execution,'Execution policy changed');same(plan.units,sourcePlan.units,'Unit inventory changed');same(plan.suite,sourcePlan.suite,'Test inventory changed');
 assert(plan.policyVersion===sourcePlan.policyVersion&&plan.controller===sourcePlan.controller&&plan.migrationBase===sourcePlan.migrationBase,'Policy/controller/baseline changed');
 const impact=impactContext.plan,{fingerprint,...body}=impact;
 assert(impactContext.snapshotSource==='IMMUTABLE_GIT_OBJECTS'&&sha(impactContext.baseTree)&&sha(impactContext.headTree)&&impactContext.sourceInputsFingerprint===hash({baseTree:impactContext.baseTree,headTree:impactContext.headTree,controller:verificationController,impactPolicy:4}),'Unbound impact source');
 assert(impact.policyVersion===4&&fingerprint===hash(body)&&['impact','full'].includes(impact.tier)&&['low','moderate','high','unknown'].includes(impact.risk),'Invalid independently reconstructed impact');
 assert(Array.isArray(impact.changed)&&impact.changed.length>0&&new Set(impact.changed).size===impact.changed.length&&impact.changed.every(p=>typeof p==='string'&&!p.startsWith('/')&&!p.split('/').some(x=>!x||x==='.'||x==='..')),'Invalid repair paths');
 same(impact.classifications.map(c=>c.path).sort(),impact.changed.slice().sort(),'Incomplete changed-path classifications');
 assert(Array.isArray(impact.run)&&impact.run.every(p=>plan.suite.includes(p))&&new Set(impact.run).size===impact.run.length&&typeof impact.browser==='boolean','Invalid affected test coverage');
 if(impact.tier==='impact')assert(impact.reasons.length===0&&!['high','unknown'].includes(impact.risk)&&impact.classifications.every(c=>!['high','unknown'].includes(c.risk)&&Array.isArray(c.uncertainties)&&c.uncertainties.length===0),'Impact tier contradicts full invalidation');
 const passed=new Map(assessment.reusable.map(x=>[x.id,x])),selected=new Set(impact.run),fresh=[],retained=[],fileSelection={};
 for(const u of plan.units){
  const complete=impact.tier==='full'||!passed.has(u.id)||(u.kind==='browser'&&(impact.browser||impact.changed.some(p=>/\.(tsx|css)$/.test(p)||p.startsWith('public/'))));
  const files=complete?u.files.slice():u.files.filter(p=>selected.has(p));fileSelection[u.id]=files;
  (files.length?fresh:retained).push(u.id);
 }
 return {fresh,retained,fileSelection,impactFingerprint:fingerprint,sourceInputsFingerprint:impactContext.sourceInputsFingerprint};
}

function caseInventory(result,files,cwd,{passing}){
 assert(Array.isArray(result?.testResults)&&result.testResults.length===files.length,'Complete assertion inventory required');
 if(passing)assert(result.success===true&&result.numFailedTests===0&&result.numFailedTestSuites===0&&[result.numPendingTests??0,result.numPendingTestSuites??0,result.numTodoTests??0].every(x=>x===0),'Failed or skipped fresh process');
 const found=new Map();let total=0;
 for(const f of result.testResults){const path=relative(cwd,f.name).split('\\').join('/');
  assert(files.includes(path)&&!found.has(path)&&Array.isArray(f.assertionResults)&&f.assertionResults.length>0&&(!passing||f.status==='passed'),'Foreign/duplicate/empty assertion file');
  const cases=f.assertionResults.map(a=>{assert(typeof a.fullName==='string'&&a.fullName.length>0&&(!passing||a.status==='passed'),'Missing/failed assertion');return a.fullName;}).sort();
  found.set(path,cases);total+=cases.length;
 }
 if(passing)assert(result.numPassedTests===total&&result.numTotalTests===total,'Fresh assertion total differs');return found;
}
export function requireReviewedRepairController({execute,repair,controller,reviewedController}){
 if(execute&&repair)assert(sha(controller)&&reviewedController===controller,'Exact independent verifier review required before any repair deployment operation');
}
export function validateCompilerAuxiliary(aux,{plan,sourceRun,classifierHash,history}){
 const authenticated=validateRepairFocusedMetadata({...aux,expected:{runId:aux.run.id,controller:plan.controller,workflowId:aux.workflowId,after:sourceRun.updated_at}});
 assert(authenticated.compiler&&history.runIds.includes(aux.run.id),'Successful source-bound auxiliary compiler required');
 const r=aux.report;
 assert(r?.kind==='FOCUSED_ONLY'&&r.releaseEligible===false&&r.schemaVersion===1&&r.sha===plan.sha&&r.controller===plan.controller&&r.runId===String(aux.run.id)&&r.attempt==='1'&&r.exitCode===0,'Auxiliary compiler source identity differs');
 same(r.runtime,plan.runtime,'Auxiliary compiler runtime differs');
 assert(Date.parse(r.startedAt)>=Date.parse(authenticated.producer.started_at)&&Date.parse(r.endedAt)<=Date.parse(authenticated.producer.completed_at)&&Date.parse(r.endedAt)>=Date.parse(r.startedAt),'Auxiliary report outside producing job');
 assert(r.classifierHash===classifierHash&&r.healthBefore?.ok===true&&r.healthAfter?.ok===true&&Array.isArray(r.files)&&r.files.length>0&&r.files.length<=64&&new Set(r.files).size===r.files.length&&r.manifestHash===hash(JSON.stringify(r.files)),'Auxiliary compiler source selection differs');
 same(r.files,r.files.slice().sort(),'Noncanonical auxiliary compiler files');
 assert(r.groups&&Array.isArray(r.groups.NODB)&&Array.isArray(r.groups.DB),'Compiler source partition missing');
 same([...r.groups.NODB,...r.groups.DB].sort(),r.files,'Auxiliary compiler partition differs');
 assert(r.files.every(p=>plan.suite.includes(p))&&Array.isArray(r.batches)&&r.batches.length>0&&r.batches.every(b=>b.exitCode===0&&b.processExitCode===0&&b.signal===null),'Unsuccessful auxiliary source preflight');
 return {...authenticated.compiler,auxiliary:true,artifactId:aux.artifacts[0].id,digest:aux.artifacts[0].digest,reportHash:hash(r)};
}
export const RETAINED_PDF_EXECUTION_CONTROLLER='f133ce140f38f782d44de1187a82b822e2acdb74';
export function verifyFixtureBrowserRecovery({sourcePlan,plan,assessment,sourceRun,reports,focused,browsers=[],pdf=null,compilerAuxiliary=null,impactContext,classifierHash,verificationController,verificationDiagnostic,reviewedController=null,buildRun,build,history}){
 assert(sourceRun.status==='completed'&&sourceRun.conclusion==='failure'&&sourceRun.run_attempt===1&&assessment.sourceRun.id===sourceRun.id,'Original complete failure required');
 assert(assessment.sha===sourcePlan.sha&&assessment.controller===sourcePlan.controller&&assessment.fingerprint===sourcePlan.fingerprint&&assessment.baseline===plan.migrationBase,'Original source assessment differs');
 assert(verificationDiagnostic.controller===verificationController&&id(verificationDiagnostic.runId),'Hosted verifier diagnostic required');
 assert(reviewedController===null||reviewedController===verificationController,'Reviewed verifier identity changed');
 const disposition=repairDisposition({sourcePlan,plan,assessment,impactContext,verificationController}),fresh=new Set(disposition.fresh),needed=new Map(Object.entries(disposition.fileSelection).map(([id,files])=>[id,new Set(files)]));
 assert(fresh.size>0,'No failed/invalidated units to recover');
 const browserUnits=plan.units.filter(u=>u.kind==='browser'&&fresh.has(u.id));
 assert(browsers.length===(browserUnits.length?1:0)&&(!browserUnits.length||browserUnits.length===3),'One complete three-engine replacement execution required');
 assert(Array.isArray(reports)&&reports.length===sourcePlan.units.length&&new Set(reports.map(r=>r.id)).size===reports.length,'Complete original reports required');
 assert(build?.canonicalCandidateInputsVerified===true&&build.source===plan.sha&&build.controller===plan.controller&&build.runId===buildRun.id&&buildRun.conclusion==='success','Fresh source-bound canonical build required');
 assert(history?.kind==='AUTHENTICATED_COMPLETE_REPAIR_HISTORY'&&history.sourceRunId===sourceRun.id&&Array.isArray(history.runIds)&&history.runIds.includes(buildRun.id),'Complete latest execution history required');
 const replacements=new Map(),focusedSources=[],compilers=compilerAuxiliary?[validateCompilerAuxiliary(compilerAuxiliary,{plan,sourceRun,classifierHash,history})]:[];
 for(const f of focused){
  const r=f.report;assert(r.kind==='FOCUSED_ONLY'&&r.releaseEligible===false&&r.schemaVersion===1&&r.sha===plan.sha&&r.controller===plan.controller&&r.runId===String(f.run.id)&&r.attempt==='1'&&r.exitCode===0,'Fresh report identity differs');
  same(r.runtime,plan.runtime,'Focused runtime changed');assert(r.classifierHash===classifierHash&&r.manifestHash===hash(JSON.stringify(r.files)),'Classifier/selection differs');
  assert(r.healthBefore?.ok===true&&r.healthAfter?.ok===true&&Array.isArray(r.files)&&r.files.length>0&&r.files.length<=64&&new Set(r.files).size===r.files.length,'Unhealthy or unbounded focused selection');
  same(r.files,r.files.slice().sort(),'Noncanonical focused selection');const database=r.groups?.DB?.length>0,kind=database?'DB':'NODB';same(r.groups,database?{NODB:[],DB:r.files}:{NODB:r.files,DB:[]},'One homogeneous focused partition required');
  assert(r.batches?.length===1&&r.batches[0].kind===kind&&r.batches[0].exitCode===0&&r.batches[0].processExitCode===0&&r.batches[0].signal===null,'Fresh process did not pass');same(r.batches[0].files,r.files,'Focused process omitted files');
  if(database){
   const unit=plan.units.find(u=>u.kind==='db'&&isDeepStrictEqual(disposition.fileSelection[u.id].slice().sort(),r.files));assert(unit&&fresh.has(unit.id),'DB recovery must rerun the entire independently selected original-unit subset in its own fresh database');
   validatePostgresEvidence(r.databaseTerminalEvidence,plan.execution);
   const e=r.databaseTerminalEvidence,original=reports.find(x=>x.id===unit.id)?.databaseTerminalEvidence;
   assert(e.name===`aihr-ci-${f.run.id}-1-db-1`&&Date.parse(e.capturedAt)>=Date.parse(r.batches[0].startedAt)&&Date.parse(e.capturedAt)<=Date.parse(f.producer.completed_at)&&e.settings.serverVersionNum===original?.settings?.serverVersionNum,'DB ownership, capture interval or actual PG16 runtime differs');
  }
  assert(Date.parse(r.startedAt)>=Date.parse(f.producer.started_at)&&Date.parse(r.endedAt)<=Date.parse(f.producer.completed_at)&&Date.parse(r.endedAt)>=Date.parse(r.startedAt),'Focused report outside producing job');
  const cases=caseInventory(f.result,r.files,'/home/runner/work/ai-hr/ai-hr/source',{passing:true});
  assert(r.batches[0].assertions===[...cases.values()].reduce((n,c)=>n+c.length,0),'Focused summary count differs');
  for(const [path,names] of cases){const unit=plan.units.find(u=>u.files.includes(path));assert(unit&&unit.kind===(database?'db':'nodb')&&fresh.has(unit.id)&&needed.get(unit.id).has(path)&&!replacements.has(path),'Foreign, misclassified, retained or duplicated replacement');replacements.set(path,{cases:names,runId:f.run.id,jobId:f.producer.id,artifactId:f.artifact.id,digest:f.artifact.digest});}
  if(f.compiler){const job=f.jobs.find(j=>j.name==='typecheck');assert(f.compiler.runId===f.run.id&&f.compiler.controller===plan.controller&&f.compiler.jobId===job?.id&&job.conclusion==='success','Fresh whole compiler identity differs');compilers.push(f.compiler);}
  focusedSources.push({runId:f.run.id,jobId:f.producer.id,artifactId:f.artifact.id,digest:f.artifact.digest,reportHash:hash(r),resultHash:hash(f.result)});
 }
 const pdfUnits=plan.units.filter(u=>u.pdfTools&&fresh.has(u.id)),pdfSources=[];
 assert((pdfUnits.length>0)===(pdf!==null)&&pdfUnits.length<=1,'Exactly the required complete native PDF unit must be authenticated');
 if(pdf){
  const binding=validatePdfRepairMetadata({...pdf,expected:{runId:pdf.run.id,verificationController:RETAINED_PDF_EXECUTION_CONTROLLER,after:sourceRun.updated_at}});
  assert(history.runIds.includes(pdf.run.id)&&pdf.codeController===plan.controller,'Unaccounted or unpinned PDF code controller');
  const {fingerprint,...executionBody}={...plan,controller:RETAINED_PDF_EXECUTION_CONTROLLER},executionPlan={...executionBody,fingerprint:hash(executionBody)};
  const u=pdfUnits[0];assert(pdf.report?.id===u.id,'Foreign PDF unit');validateCompleteUnitHealth({report:pdf.report,standaloneHealth:pdf.standaloneHealth,producer:binding.producer});verifyUnitReport(executionPlan,pdf.report);
  assert(pdf.report.batches.length===1&&isDeepStrictEqual(pdf.report.pdfToolSetup,pdf.setup)&&isDeepStrictEqual(pdf.report.batches[0].result,pdf.result),'PDF setup or standalone result differs');
  const cases=caseInventory(pdf.result,u.files,pdf.report.cwd,{passing:true});
  for(const [path,names] of cases){assert(needed.get(u.id).has(path)&&!replacements.has(path),'Extra or duplicate PDF replacement');replacements.set(path,{cases:names,runId:pdf.run.id,jobId:binding.producer.id,artifactId:binding.artifact.id,digest:binding.artifact.digest,executionController:RETAINED_PDF_EXECUTION_CONTROLLER,codeController:pdf.codeController});}
  pdfSources.push({runId:pdf.run.id,jobId:binding.producer.id,artifactId:binding.artifact.id,digest:binding.artifact.digest,executionController:RETAINED_PDF_EXECUTION_CONTROLLER,codeController:pdf.codeController,reportHash:hash(pdf.report),setupHash:hash(pdf.setup)});
 }
 const browserSources=[];
 for(const b of browsers){
  const bindings=validateBrowserRepairMetadata({...b,expected:{runId:b.run.id,controller:plan.controller,after:sourceRun.updated_at,candidateBranch:b.candidateBranch}});
  assert(history.runIds.includes(b.run.id)&&b.packets.length===3,'Browser execution missing from complete history or packet inventory');
  for(const binding of bindings){
   const p=b.packets.find(p=>p.engine===binding.engine),u=browserUnits.find(u=>u.engine===binding.engine);
   assert(p&&u&&p.report?.id===u.id,'Foreign browser engine or duplicate packet');
   validateBrowserRepairImage({...p,expected:{runtime:plan.runtime,candidate:plan.sha,controller:plan.controller,lockSha256:b.lockSha256}});
   validateCompleteUnitHealth({report:p.report,standaloneHealth:p.standaloneHealth,producer:binding.producer});
   const verified=verifyUnitReport(plan,p.report);
   assert(p.report.batches.length===1&&isDeepStrictEqual(p.report.batches[0].result,p.result),'Browser standalone result differs from complete unit report');
   const cases=caseInventory(p.result,u.files,p.report.cwd,{passing:true});
   assert(verified.tests===[...cases.values()].reduce((n,c)=>n+c.length,0),'Browser assertion count differs');
   for(const [path,names] of cases){
    const key=u.id+'\0'+path;assert(!replacements.has(key),'Duplicate browser replacement');
    replacements.set(key,{cases:names,runId:b.run.id,jobId:binding.producer.id,artifactId:binding.artifact.id,digest:binding.artifact.digest,identityArtifactId:binding.identityArtifact.id,identityDigest:binding.identityArtifact.digest});
   }
   browserSources.push({runId:b.run.id,engine:binding.engine,jobId:binding.producer.id,artifactId:binding.artifact.id,digest:binding.artifact.digest,identityArtifactId:binding.identityArtifact.id,identityDigest:binding.identityArtifact.digest,reportHash:hash(p.report)});
  }
 }
 assert(compilers.length>0,'Fresh whole compiler execution required');
 const units=[];let tests=0;
 for(const u of plan.units){const report=reports.find(r=>r.id===u.id);assert(report?.sha===sourcePlan.sha&&report.fingerprint===sourcePlan.fingerprint,'Original report was relabelled');
  if(!fresh.has(u.id)){
   const witness=assessment.reusable.find(x=>x.id===u.id),verified=verifyUnitReport(sourcePlan,report);assert(witness?.source&&witness.reportHash===hash(report),'Retained original proof changed');
   tests+=verified.tests;units.push({id:u.id,kind:'retained',originalSha:sourcePlan.sha,originalFingerprint:sourcePlan.fingerprint,reportHash:hash(report),tests:verified.tests,source:witness.source});continue;
  }
  same(report.files,u.files,'Original process coverage changed');const originals=new Map();
  for(const batch of report.batches??[]){const files=(batch.result?.testResults??[]).map(f=>relative(report.cwd,f.name).split('\\').join('/'));assert(files.length>0&&files.every(p=>u.files.includes(p)),'Original batch has foreign coverage');const names=caseInventory(batch.result,files,report.cwd,{passing:false});for(const [path,cases] of names){assert(!originals.has(path),'Duplicate original assertion file');originals.set(path,cases);}}
  assert(originals.size===u.files.length,'Original failed/affected process did not enumerate every file');let count=0;const files=[];
  const witness=assessment.reusable.find(x=>x.id===u.id);
  if(needed.get(u.id).size<u.files.length){assert(witness?.source&&witness.reportHash===hash(report),'Partial retention requires authenticated successful original process');verifyUnitReport(sourcePlan,report);}
  for(const path of u.files){
   if(needed.get(u.id).has(path)){
    const replacement=replacements.get(u.kind==='browser'?u.id+'\0'+path:path);assert(replacement,'Missing failed/affected file: '+path);same(replacement.cases,originals.get(path),'Dropped/changed original assertions');count+=replacement.cases.length;files.push({path,kind:'fresh',...replacement});
   }else{
    assert(witness?.source,'Cannot retain assertions from a failed original process');const cases=originals.get(path);count+=cases.length;files.push({path,kind:'retained-original',cases,originalSha:sourcePlan.sha,originalReportHash:hash(report),source:witness.source});
   }
  }
  tests+=count;units.push({id:u.id,kind:needed.get(u.id).size===u.files.length?'repaired-source':'mixed-source',originalReportHash:hash(report),tests:count,files});
 }
 assert(replacements.size===[...needed.values()].reduce((n,files)=>n+files.size,0),'Incomplete or excessive replacement coverage');
 return {kind:'AUTHENTICATED_FIXTURE_BROWSER_RECOVERY',recoveryPolicy:REPAIR_RECOVERY_POLICY,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,verificationDiagnostic,reviewedController:null,pendingReview:true,releaseAuthorized:false,baseline:plan.migrationBase,runId:buildRun.id,originalRunId:sourceRun.id,originalSha:sourcePlan.sha,originalConclusion:sourceRun.conclusion,originalFingerprint:sourcePlan.fingerprint,candidateFingerprint:plan.fingerprint,disposition,originalFailureObservations:assessment.observations,focusedSources,browserSources,pdfSources,compilers,history,units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests};
}
