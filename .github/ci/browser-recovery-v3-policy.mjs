/** aihr-browser-recovery/v3 (ADR-0175 decision 4a): ONE single-shot rerun of ONE failed browser engine unit
 * that executed tests, on the unchanged candidate. The original failure, every retained unit and both plan
 * identities stay intact. A second execution of that engine unit for the candidate closes recovery: fix the
 * source instead. Proposed controller: review-only, never installation evidence until separately adopted. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {relative} from 'node:path';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {REPOSITORY,REPOSITORY_ID} from './release-policy.mjs';
import {BROWSER_IMAGE,BROWSER_WORKFLOW_ID} from './browser-recovery-policy.mjs';
export const SINGLE_SHOT_POLICY='aihr-browser-recovery/v3';
/** Engines whose single-engine complete-suite scope also uploads the pinned runtime binding. */
export const SINGLE_SHOT_SCOPES=Object.freeze({firefox:'browser-image-suite-firefox'});
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
export const ownedBranch=b=>typeof b==='string'&&/^(?:codex|claude)\/[A-Za-z0-9._/-]+$/.test(b)&&!b.includes('..');
export const candidateBranchAllowed=b=>b==='main'||b==='alpha'||ownedBranch(b);
const SUITE_STEP='Complete original browser unit in pinned image';
/** Inputs every browser test reads without importing them: a change here is inside every impact set. */
const GLOBAL=[/^package\.json$/,/(^|\/)pnpm-(lock|workspace)\.yaml$/,/^(vitest|playwright|next|tsconfig|postcss|tailwind)[./]/,/\.css$/,/^test\/(setup[^/]*|env\.ts|global-setup\.ts|dom-setup\.ts|browser-setup\.ts|db-names\.ts)$/,/^public\//];

/** Run named checks in order. collect=false throws the first refusal (admission); true records all (diagnosis). */
export function runChecks(checks,{collect=false}={}){
 const results=[],values={},failed=new Set();
 for(const [name,fn,needs=[]]of checks){
  const missing=needs.filter(n=>failed.has(n));
  if(missing.length){failed.add(name);results.push({name,ok:false,refusal:'not evaluated: needs '+missing.join(', ')});continue;}
  try{values[name]=fn(values);results.push({name,ok:true});}
  catch(error){if(!collect)throw error;failed.add(name);results.push({name,ok:false,refusal:String(error?.message??error)});}
 }
 return {results,values,ok:results.every(r=>r.ok)};
}

export function validateSingleShotMetadata({run,jobs,artifacts,expected,now=Date.now()}){
 const engine=expected.engine;
 assert(Object.hasOwn(SINGLE_SHOT_SCOPES,engine),'No single-engine recovery scope for this engine');
 assert(positive(expected.runId)&&sha(expected.controller)&&ownedBranch(expected.branch)&&candidateBranchAllowed(expected.candidateBranch),'Exact reviewed recovery producer required');
 assert(run.id===expected.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign browser producer');
 assert(run.workflow_id===BROWSER_WORKFLOW_ID&&run.path==='.github/workflows/alpha-staging-browser-checks.yml'&&run.event==='workflow_dispatch'&&run.head_sha===expected.controller&&run.head_branch===expected.branch,'Unexpected browser controller/workflow');
 assert(run.display_title===`Tooling transport only · ${expected.candidateBranch}`&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Exact successful first-attempt browser producer required');
 const created=Date.parse(run.created_at),finished=Date.parse(run.updated_at);
 assert(Number.isFinite(created)&&Number.isFinite(finished)&&created>=Date.parse(expected.after)&&created<=finished&&finished<=now+60000&&now-created<=86400000,'Browser recovery chronology differs');
 const producerName=`browser-image (${engine})`,names=['resolve','tooling','operator-transport',producerName];
 assert(jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length&&new Set(jobs.map(j=>j.id)).size===names.length,'Exact single-engine job inventory required');
 for(const j of jobs){
  assert(names.includes(j.name)&&positive(j.id)&&j.run_id===run.id&&j.run_attempt===1&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.status==='completed','Foreign/incomplete browser job');
  assert(j.conclusion===(['resolve',producerName].includes(j.name)?'success':'skipped'),'Unexpected browser job result');
  if(j.conclusion==='success')assert(Date.parse(j.started_at)>=created&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=finished,'Browser job outside run');
 }
 const producer=jobs.find(j=>j.name===producerName);
 assert(producer.steps?.some(s=>s.name===SUITE_STEP&&s.conclusion==='success'),'Complete engine execution missing');
 const allowed=[`browser-recovery-runtime-${engine}`,`diagnostic-complete-image-browser-${engine}`];
 assert(artifacts.length===2&&new Set(artifacts.map(a=>a.name)).size===2&&new Set(artifacts.map(a=>a.id)).size===2,'Exact recovery artifacts required');
 for(const a of artifacts){const w=a.workflow_run;
  assert(allowed.includes(a.name)&&positive(a.id)&&positive(a.size_in_bytes)&&a.size_in_bytes<=64*1024**2&&a.expired===false&&/^sha256:[a-f0-9]{64}$/.test(a.digest??''),'Invalid browser artifact');
  assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Foreign browser artifact');
  assert(Date.parse(a.created_at)>=Date.parse(producer.started_at)&&Date.parse(a.created_at)<=Date.parse(producer.completed_at)&&Date.parse(a.expires_at)>now,'Browser artifact outside producer');
 }
 return producer;
}

/** Case inventory per file: every file enumerated once, every case named. Status is retained separately. */
export function caseInventory(report,unitFiles){
 const files=new Map();
 for(const batch of report.batches??[])for(const file of batch.result?.testResults??[]){
  const path=relative(report.cwd,file.name).split('\\').join('/');
  assert(unitFiles.includes(path)&&!files.has(path),'Foreign/duplicate browser file');
  assert(Array.isArray(file.assertionResults)&&file.assertionResults.length>0&&file.assertionResults.every(a=>typeof a.fullName==='string'&&a.fullName.length>0),'Browser case inventory unavailable');
  files.set(path,{cases:file.assertionResults.map(a=>a.fullName).sort(),failed:file.status!=='passed'||file.assertionResults.some(a=>a.status!=='passed')});
 }
 assert(files.size===unitFiles.length,'Browser process did not enumerate every file');
 return files;
}

/** The original gate: exactly one browser engine unit failed by executed tests; every other job passed. */
export function originalBrowserFailure({plan,assessment,run,jobs,reports}){
 assert(run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1&&assessment.sourceRun?.id===run.id&&assessment.sha===plan.sha&&assessment.controller===plan.controller&&assessment.baseline===plan.migrationBase&&assessment.fingerprint===plan.fingerprint,'Original authenticated failure identity required');
 assert(assessment.rerun.length===1,'Exactly one failed area can be recovered by v3');
 const unit=plan.units.find(u=>u.id===assessment.rerun[0].id);
 assert(unit?.kind==='browser'&&Object.hasOwn(SINGLE_SHOT_SCOPES,unit.engine),'Only one failed browser engine with a single-engine scope can be recovered by v3');
 assert(assessment.reusable.length===plan.units.length-1&&new Set(assessment.reusable.map(x=>x.id)).size===assessment.reusable.length,'Retained coverage incomplete');
 const required=requiredEvidence(plan),failedJob=`browser (${unit.engine})`;
 for(const j of jobs){assert(required.jobs.includes(j.name)||(j.name==='runner-diagnostics'&&j.conclusion==='skipped'),'Unknown original job');assert(j.conclusion===([failedJob,'verify'].includes(j.name)?'failure':j.name==='runner-diagnostics'?'skipped':'success'),'A failed prerequisite or second area cannot be recovered by one browser rerun');}
 assert(reports.length===plan.units.length&&new Set(reports.map(r=>r?.id)).size===reports.length,'Complete original reports required');
 const report=reports.find(r=>r.id===unit.id);
 assert(report&&report.schemaVersion===1&&report.sha===plan.sha&&report.fingerprint===plan.fingerprint&&report.exitCode!==0&&!report.error,'Original browser failure must be executed test failures, not a process or setup error');
 same(report.files,unit.files,'Original browser coverage differs');
 assert(report.healthBefore?.ok===true,'Capacity/health failures use the capacity route, not v3');
 assert(Array.isArray(report.batches)&&report.batches.length>0,'Original browser unit executed no tests');
 const cases=caseInventory(report,unit.files),failing=[...cases].filter(([,v])=>v.failed).map(([p])=>p).sort();
 assert(failing.length>0,'No failing browser file identified');
 return {unit,report,cases,failing};
}

/** Static impact: the failing files and their forward import closure must contain no changed path, no
 * global input and no unresolvable load. Any doubt keeps the failure inside the candidate's impact set. */
export function browserImpact({changed,edges,failing,uncertain=new Set()}){
 const reasons=[],changedSet=new Set(changed);
 for(const p of changed)if(GLOBAL.some(r=>r.test(p)))reasons.push('global input changed: '+p);
 const closure=new Set();
 for(const file of failing){
  if(changedSet.has(file))reasons.push('failing file changed: '+file);
  if(!edges.has(file)){reasons.push('failing file has no resolved import graph: '+file);continue;}
  const queue=[file];
  while(queue.length){const p=queue.pop();if(closure.has(p))continue;closure.add(p);for(const d of edges.get(p)??[])queue.push(d);}
 }
 for(const p of [...closure].sort()){
  if(changedSet.has(p)&&!failing.includes(p))reasons.push(`changed dependency ${p} reaches a failing file`);
  if(uncertain.has(p))reasons.push('unresolvable dynamic load in the failing closure: '+p);
 }
 return {outside:reasons.length===0,reasons,closureFiles:closure.size,changedFiles:changedSet.size};
}

/** Every complete-suite execution of the engine since the original run must be accounted for, wherever it
 * was dispatched from: exactly one for this candidate (the supplied recovery), none pending or unidentified. */
export function validateSingleShotHistory({executions,browserRunId,candidate,engine}){
 assert(Array.isArray(executions)&&executions.length<=500,'Bounded execution history required');
 const mine=[];
 for(const e of executions){
  if(e.engine!==engine)continue;
  assert(positive(e.id),'Malformed execution history');
  assert(e.status==='completed','A pending or running execution of this engine must finish before recovery');
  assert(e.candidate===null||sha(e.candidate),'Malformed execution candidate');
  assert(e.candidate!==null,`Execution ${e.id} has no readable candidate identity; recovery cannot prove it was single-shot`);
  if(e.candidate===candidate)mine.push(e);
 }
 assert(mine.length>0&&mine.every(e=>e.id===browserRunId)&&mine.length===1,`Single-shot recovery refused: ${mine.length} executions of the ${engine} unit for this candidate (${mine.map(e=>e.id).join(', ')||'none'}); fix the source instead`);
 assert(mine[0].conclusion==='success'&&mine[0].attempt===1,'The single recovery execution must be a successful first attempt');
 return {kind:'SINGLE_SHOT_HISTORY',engine,candidate,executions:executions.filter(e=>e.engine===engine).map(e=>({id:e.id,candidate:e.candidate,conclusion:e.conclusion})).sort((a,b)=>a.id-b.id)};
}

export function registeredFlakes(registerText,failing){
 assert(typeof registerText==='string'&&registerText.length>0,'Flaky test register unavailable in the verification controller');
 const missing=failing.filter(f=>!registerText.includes('`'+f+'`'));
 assert(missing.length===0,'Failing files are not in the flaky test register: '+missing.join(', '));
 return failing;
}

export function verifySingleShotRecovery({plan,freshPlan,assessment,run,jobs,reports,fresh,impact,executions,flakeRegister,verificationController,verificationDiagnostic,producerDiagnostic,reviewedController=null,lockSha256},{collect=false}={}){
 const checks=[
  ['verifier controls',()=>assert(sha(verificationController)&&verificationDiagnostic?.controller===verificationController&&positive(verificationDiagnostic.runId),'Hosted recovery verifier controls missing')],
  ['plan fingerprints',()=>{for(const p of [plan,freshPlan]){const {fingerprint,...body}=p;assert(fingerprint===hash(body),'Invalid browser plan fingerprint');}}],
  ['producer controller',()=>assert(sha(freshPlan.controller)&&freshPlan.controller===fresh.run.head_sha&&producerDiagnostic?.controller===freshPlan.controller&&positive(producerDiagnostic.runId),'Fresh producer must retain its own validated controller identity')],
  ['reviewed verifier',()=>assert(reviewedController===null||reviewedController===verificationController,'Reviewed verifier changed')],
  ['unchanged source and execution',()=>{const {fingerprint:a,controller:b,...o}=plan,{fingerprint:c,controller:d,...f}=freshPlan;same(o,f,'Browser recovery changed source, coverage, runtime or execution');same(plan.runtime,{node:'22.23.3',platform:'linux',arch:'x64'},'Browser runtime changed');}],
  ['original failure',()=>originalBrowserFailure({plan,assessment,run,jobs,reports})],
  ['pinned runtime binding',v=>{const engine=v['original failure'].unit.engine,b=fresh.binding;
   assert(b.kind==='PINNED_OFFICIAL_IMAGE_TOOLING_NOT_TEST_OR_RELEASE_PASS'&&b.releaseAuthorized===false&&b.image===BROWSER_IMAGE&&b.playwrightVersion==='1.62.1'&&b.nodeVersion==='22.23.3'&&b.candidate===plan.sha&&b.controller===freshPlan.controller&&b.baseline===plan.migrationBase&&b.engine===engine&&b.runId===String(fresh.run.id)&&b.attempt==='1'&&b.lockSha256===lockSha256,'Pinned browser runtime/source binding differs');
   same(b.runtime,plan.runtime,'Actual browser runtime differs');assert(b.lang==='en_US.UTF-8'&&b.tz==='Asia/Kuala_Lumpur'&&b.browsersPath==='/ms-playwright','Browser locale/environment differs');},['original failure']],
  ['complete fresh engine unit',v=>{const {unit}=v['original failure'],r=fresh.report;
   assert(r.id===unit.id&&!r.error,'Fresh browser process failed');
   for(const h of [r.healthBefore,r.healthAfter])assert(h?.platform==='linux'&&h.ok===true&&h.reasons?.length===0&&Date.parse(h.at)>=Date.parse(fresh.producer.started_at)&&Date.parse(h.at)<=Date.parse(fresh.producer.completed_at),'Fresh browser health/chronology failed');
   return verifyUnitReport(freshPlan,r);},['original failure']],
  ['same files and cases',v=>{const {unit,cases}=v['original failure'],now=caseInventory(fresh.report,unit.files);
   for(const [path,c]of cases)same(now.get(path)?.cases,c.cases,'Recovery dropped or changed cases: '+path);},['original failure']],
  ['outside impact set',()=>assert(impact?.outside===true,'Failing browser files are inside the candidate impact set: '+(impact?.reasons??['no impact decision']).slice(0,5).join('; '))],
  ['single shot',v=>validateSingleShotHistory({executions,browserRunId:fresh.run.id,candidate:plan.sha,engine:v['original failure'].unit.engine}),['original failure']],
  ['registered flake',v=>registeredFlakes(flakeRegister?.text,v['original failure'].failing),['original failure']],
  ['retained units',v=>plan.units.filter(u=>u.id!==v['original failure'].unit.id).map(u=>{
   const r=reports.find(r=>r.id===u.id),checked=verifyUnitReport(plan,r),s=assessment.reusable.find(s=>s.id===u.id);assert(s?.reportHash===hash(r)&&s.source?.runId===run.id,'Retained unit provenance changed');return {id:u.id,kind:'retained',reportHash:hash(r),tests:checked.tests,files:checked.files,source:s.source};}),['original failure']],
 ];
 const outcome=runChecks(checks,{collect});
 if(!outcome.ok)return {kind:'BROWSER_SINGLE_SHOT_DIAGNOSTIC',recoveryPolicy:SINGLE_SHOT_POLICY,result:'REFUSED',checks:outcome.results,installationEligible:false,releaseAuthorized:false};
 const {unit,report,failing}=outcome.values['original failure'],replacement=outcome.values['complete fresh engine unit'];
 const units=plan.units.map(u=>{
  if(u.id===unit.id)return {id:u.id,kind:'browser-single-shot-recovery',originalReportHash:hash(report),reportHash:hash(fresh.report),tests:replacement.tests,files:replacement.files,source:{runId:fresh.run.id,attempt:1,controller:freshPlan.controller,jobId:fresh.producer.id,artifacts:fresh.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest})).sort((a,b)=>a.name.localeCompare(b.name))}};
  return outcome.values['retained units'].find(r=>r.id===u.id);
 });
 return {kind:'AUTHENTICATED_BROWSER_SINGLE_SHOT_RECOVERY',recoveryPolicy:SINGLE_SHOT_POLICY,result:'RECOVERED_PENDING_ADOPTION',checks:outcome.results,policyVersion:plan.policyVersion,sha:plan.sha,controller:plan.controller,verificationController,verificationDiagnostic,browserProducerController:freshPlan.controller,producerDiagnostic,reviewedController,pendingReview:reviewedController!==verificationController,
  // v3 has no installation grant route until this controller is independently reviewed and adopted.
  installationEligible:false,releaseAuthorized:false,
  baseline:plan.migrationBase,runId:run.id,originalConclusion:'failure',originalFailureObservations:assessment.observations,engine:unit.engine,failingFiles:failing,impact:{closureFiles:impact.closureFiles,changedFiles:impact.changedFiles},history:outcome.values['single shot'],flakeRegister:{path:flakeRegister.path,sha256:flakeRegister.sha256},sourceFingerprint:plan.fingerprint,replacementFingerprint:freshPlan.fingerprint,browserRunId:fresh.run.id,units,suiteFiles:plan.suite.length,browserFiles:plan.units.filter(u=>u.kind==='browser').reduce((n,u)=>n+u.files.length,0),tests:units.reduce((n,u)=>n+u.tests,0)};
}
