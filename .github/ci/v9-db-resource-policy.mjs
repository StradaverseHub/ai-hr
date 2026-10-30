/** Finite, read-only review evidence. Never an installation certificate or guard waiver. */
import assert from 'node:assert/strict';
import {relative} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {hash,requiredEvidence,CI_EXECUTION} from './manifest.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {validateFocusedMetadata} from './focused-recovery-policy.mjs';
export const V9_DB_CASE=Object.freeze({candidate:'72a2673af354f382502ecc7799316fac3c19b1ac',controller:'d6cb83d620d8d4380c981a72fc41628780840b4e',baseline:'d6cb83d620d8d4380c981a72fc41628780840b4e',runId:41039154492,unit:'db-612c0b9a012cdaa1',plan:'0b3787677b26ca4165cafb28f82d75bb048c9c031fc3cc3c581797216ec610b5',report:'5429b7d8a7bfa9d16c14ee670a8f40b07d35ec7b9909e946c70aff148eb368e9',artifactId:12970211002,digest:'sha256:bc35513cb5eebaee4551598098b3bb45164d732d504694ccfed259fc6401bfaa',cases:'8f4cc9f0a377aaed37a549e0a7400ab5d303b06fdeb3386d4edb43b7b81313a7',files:24,tests:435,branch:'codex/v9-navigation-correction-20261030'});
const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
const date=value=>{const n=Date.parse(value);assert(Number.isFinite(n),'Invalid evidence timestamp');return n;};
export function caseInventory(result,files,cwd){
 assert(result?.success===true&&result.numFailedTests===0&&result.numFailedTestSuites===0&&[result.numPendingTests??0,result.numPendingTestSuites??0,result.numTodoTests??0].every(n=>n===0),'Incomplete assertion result');
 assert(Array.isArray(result.testResults)&&result.testResults.length===files.length,'Missing assertion files');
 const found=new Map();let total=0;
 for(const file of result.testResults){const path=relative(cwd,file.name).split('\\').join('/');assert(files.includes(path)&&!found.has(path)&&file.status==='passed'&&file.assertionResults?.length>0,'Foreign/duplicate/failing assertion file');const names=file.assertionResults.map(a=>{assert(a.status==='passed'&&typeof a.fullName==='string'&&a.fullName,'Failed/skipped/unnamed assertion');return a.fullName;}).sort();found.set(path,names);total+=names.length;}
 assert(total>0&&result.numTotalTests===total&&result.numPassedTests===total,'Assertion counts differ');
 return {entries:[...found].sort(([a],[b])=>a.localeCompare(b)),total};
}
/** A short page is not proof of completeness when GitHub still reports more rows. */
export function collectPages(read,key){
 const rows=[],seen=new Set();let total=null;
 for(let page=1;page<=10;page++){const d=read(page);assert(Array.isArray(d?.[key])&&Number.isSafeInteger(d.total_count)&&d.total_count>=0&&d.total_count<=1000,'Missing/unbounded API total');if(total===null)total=d.total_count;assert(total===d.total_count,'API inventory changed during pagination');for(const row of d[key]){assert(Number.isSafeInteger(row.id)&&row.id>0&&!seen.has(row.id),'Repeated/foreign API row');seen.add(row.id);rows.push(row);}assert(rows.length<=total,'API inventory exceeds total');if(rows.length===total)return rows;assert(d[key].length===100,'Truncated API inventory');}
 throw Error('Incomplete bounded API pagination');
}
/** Includes runs overlapping original completion, active runs predating the lookback and duplicate API snapshots. */
export function checkHistory(rows,{original,focusedRunId,workflowIds,bindings=new Map(),now=Date.now()}){
 assert(Array.isArray(rows)&&rows.length>0&&rows.length<=8000,'Incomplete/unbounded history');
 const titles=new Set([`Alpha CI · ${V9_DB_CASE.branch}`,`Canonical build only · ${V9_DB_CASE.branch}`,`Focused only · ${V9_DB_CASE.branch}`,`Tooling transport only · ${V9_DB_CASE.branch}`]),seen=new Map();
 for(const run of rows){
  assert(workflowIds.includes(run.workflow_id)&&Number.isSafeInteger(run.id)&&run.id>0,'Foreign history workflow');date(run.created_at);date(run.updated_at);assert(date(run.updated_at)>=date(run.created_at)&&date(run.updated_at)<=now+60000,'Invalid history interval');
  const outstanding=run.status!=='completed'||date(run.updated_at)>=date(original.updated_at),known=run.id===original.id||run.id===focusedRunId,binding=bindings.get(run.id);
  if(!known&&!outstanding)continue;
  if(binding)assert(binding.runId===run.id&&binding.controller===run.head_sha&&binding.authenticated===true&&/^[a-f0-9]{40}$/.test(binding.source)&&Number.isSafeInteger(binding.artifactId)&&/^sha256:[a-f0-9]{64}$/.test(binding.digest),'Unauthenticated history binding');
  if(!known&&!titles.has(run.display_title)){assert(binding,'Unresolved application identity in later/active history');if(binding.source!==V9_DB_CASE.candidate)continue;}
  const row={id:run.id,workflow:run.workflow_id,title:run.display_title,controller:run.head_sha,status:run.status,conclusion:run.conclusion,attempt:run.run_attempt,created:run.created_at,updated:run.updated_at,...(binding?{binding}: {})};if(seen.has(row.id))same(row,seen.get(row.id),'History changed during collection');seen.set(row.id,row);
 }
 const source=seen.get(original.id);assert(source?.status==='completed'&&source.conclusion==='failure'&&source.attempt===1&&source.controller===V9_DB_CASE.controller&&source.updated===original.updated_at,'Original absent/altered in complete history');
 const fresh=[...seen.values()].filter(r=>r.id!==original.id&&(r.status!=='completed'||date(r.updated)>=date(original.updated_at)));
 assert(fresh.length===1&&fresh[0].id===focusedRunId&&fresh[0].status==='completed'&&fresh[0].conclusion==='success'&&fresh[0].attempt===1&&fresh[0].controller===V9_DB_CASE.controller,'Unaccounted, pending, failed or superseding execution');
 return {kind:'COMPLETE_HISTORY_REVIEW_ONLY',hash:hash([...seen.values()].sort((a,b)=>a.id-b.id)),runIds:[original.id,focusedRunId]};
}
export function validateFreshDb({plan,unit,source,focused,classifierHash,selectedLog,focusedWorkflowId,oldCases,now=Date.now()}){
 const pin=V9_DB_CASE;
 const producer=validateFocusedMetadata({...focused,expected:{runId:focused.run.id,controller:pin.controller,workflowId:focusedWorkflowId,after:source.run.updated_at},now}),r=focused.report,b=r.batches?.[0];
 assert(r.kind==='FOCUSED_ONLY'&&r.releaseEligible===false&&r.schemaVersion===1&&r.sha===pin.candidate&&r.controller===pin.controller&&r.runId===String(focused.run.id)&&r.attempt==='1'&&r.exitCode===0&&!r.error&&!r.databaseTelemetryError,'Focused identity/result differs');
 same(r.runtime,plan.runtime,'Runtime changed');same(r.files,unit.files.slice().sort(),'Entire original unit required');same(r.groups,{NODB:[],DB:r.files},'Homogeneous DB unit required');assert(r.manifestHash===hash(JSON.stringify(r.files))&&r.classifierHash===classifierHash,'Selection/classifier changed');
 assert(r.healthBefore?.ok===true&&r.healthAfter?.ok===true&&r.batches.length===1&&b.kind==='DB'&&b.exitCode===0&&b.processExitCode===0&&b.signal===null&&!b.error,'Unhealthy/incomplete focused process');same(b.files,r.files,'Focused batch omitted files');
 assert(date(r.startedAt)>=date(producer.started_at)&&date(r.endedAt)>=date(r.startedAt)&&date(r.endedAt)<=date(producer.completed_at)&&date(b.startedAt)>=date(r.startedAt)&&date(b.endedAt)>=date(b.startedAt)&&date(b.endedAt)<=date(r.endedAt),'Focused process outside producer');
 validatePostgresEvidence(r.databaseTerminalEvidence,plan.execution);const fresh=r.databaseTerminalEvidence;
 assert(fresh.name===`aihr-ci-${focused.run.id}-1-db-1`&&Object.keys(fresh.errors??{}).length===0&&fresh.memoryEvents.oom===0&&fresh.settings.serverVersionNum==='160015'&&date(fresh.capturedAt)>=date(b.endedAt)&&date(fresh.capturedAt)<=date(r.endedAt),'Fresh database ownership/runtime/capture differs');
 assert(focused.state.Running===true&&focused.state.OOMKilled===false&&focused.state.Dead===false&&focused.state.Pid===fresh.state.Pid&&focused.state.StartedAt===fresh.state.StartedAt,'Database diagnostics unhealthy');
 assert(producer.steps?.some(step=>step.name==='Ensure owned database cleanup after interrupted checks'&&step.conclusion==='success'),'Owned cleanup step did not pass');
 assert(typeof selectedLog==='string'&&Buffer.byteLength(selectedLog)<16*1024**2,'Bounded API job log required');
 for(const [name,value] of [['AIHR_CI_PG_MEMORY_GIB','2'],['AIHR_CI_PG_JIT','on'],['AIHR_TEST_DURATION_ORDER','true']]){const values=[...selectedLog.matchAll(new RegExp(name+':\\s*([^\\s]+)','g'))].map(m=>m[1]);assert(values.length>0&&values.every(v=>v===value),'Producer resource/scheduling environment differs: '+name);}
 const replacement=caseInventory(focused.result,r.files,'/home/runner/work/ai-hr/ai-hr/source');same(replacement.entries,oldCases.entries,'Missing, extra or renamed cases');assert(replacement.total===pin.tests&&b.assertions===pin.tests,'Focused case total differs');
 return {producer,r,fresh,replacement};
}
export function assertStableSnapshot(before,after){same(before,after,'Evidence metadata changed');}
export function validateOriginalPrerequisites(plan,source,failedId){
 const topology=requiredEvidence(plan);assert(source.jobs.length===topology.jobs.length+source.jobs.filter(j=>j.name==='runner-diagnostics').length&&new Set(source.jobs.map(j=>j.name)).size===source.jobs.length&&topology.jobs.every(name=>source.jobs.some(j=>j.name===name)),'Missing or duplicate original prerequisite');
 for(const job of source.jobs){if(job.name==='runner-diagnostics'){assert(job.conclusion==='skipped');continue;}assert(topology.jobs.includes(job.name),'Unexpected original job');assert(job.status==='completed'&&job.run_attempt===1&&job.conclusion===([`test (${failedId})`,'verify'].includes(job.name)?'failure':'success'),'Another prerequisite failed');}
}
export function validateRetainedReports(plan,reports,assessment,failedId){
 assert(reports.length===plan.units.length&&new Set(reports.map(r=>r.id)).size===reports.length,'Incomplete original report inventory');
 return plan.units.filter(u=>u.id!==failedId).map(u=>{const report=reports.find(r=>r.id===u.id),proof=verifyUnitReport(plan,report),prior=assessment.reusable.find(r=>r.id===u.id);assert(prior?.reportHash===hash(report)&&prior.source,'Retained evidence changed');return {...proof,reportHash:hash(report),source:prior.source};});
}
export function assessV9DbResource({plan,assessment,source,reports,focused,classifierHash,selectedLog,history,historyBindings=new Map(),workflowIds,focusedWorkflowId,verificationController,now=Date.now()}){
 const pin=V9_DB_CASE,{fingerprint,...body}=plan;
 assert(plan.sha===pin.candidate&&plan.controller===pin.controller&&plan.migrationBase===pin.baseline&&fingerprint===pin.plan&&hash(body)===fingerprint,'Outside finite source/plan');same(plan.execution,CI_EXECUTION,'Execution budget/workers/scheduling changed');
 assert(source.run.id===pin.runId&&source.run.status==='completed'&&source.run.conclusion==='failure'&&source.run.run_attempt===1,'Original first failure must remain unchanged');
 assert(assessment.sha===pin.candidate&&assessment.controller===pin.controller&&assessment.baseline===pin.baseline&&assessment.fingerprint===pin.plan&&assessment.sourceRun?.id===pin.runId,'Original assessment identity differs');
 same(assessment.rerun.map(unit=>unit.id),[pin.unit],'Only the exact resource-failed unit is supported');
 validateOriginalPrerequisites(plan,source,pin.unit);const unit=plan.units.find(unit=>unit.id===pin.unit);assert(unit?.kind==='db'&&unit.files.length===pin.files,'Original unit differs');
 assert(reports.length===plan.units.length&&new Set(reports.map(r=>r.id)).size===reports.length,'Incomplete original report inventory');

 const old=reports.find(report=>report.id===pin.unit);assert(hash(old)===pin.report&&old.exitCode!==0&&old.batches.length===1&&old.batches[0].exitCode===0&&old.error.includes('Missing, unhealthy or mismatched PostgreSQL resource evidence'),'Original failure bytes/reason changed');
 const oldCases=caseInventory(old.batches[0].result,unit.files,old.cwd);assert(oldCases.total===pin.tests&&hash(oldCases.entries)===pin.cases,'Original assertion inventory changed');
 const originalArtifact=source.artifacts.find(a=>a.name==='unit-'+pin.unit);assert(originalArtifact?.id===pin.artifactId&&originalArtifact.digest===pin.digest,'Original artifact identity changed');
 const e=old.databaseTerminalEvidence;assert(e.memoryLimit===2147483648&&e.memoryMax===2147483648&&e.memoryPeak===2147491840&&e.memoryEvents.oom===0&&e.memoryEvents.oom_kill===0&&e.state.Running&&e.state.OOMKilled===false&&e.settings.serverVersionNum==='160015','Original resource observation changed');
 const {producer,r,fresh,replacement}=validateFreshDb({plan,unit,source,focused,classifierHash,selectedLog,focusedWorkflowId,oldCases,now});
 const retained=validateRetainedReports(plan,reports,assessment,pin.unit);
 const lineage=checkHistory(history,{original:source.run,focusedRunId:focused.run.id,workflowIds,bindings:historyBindings,now});assert(/^[a-f0-9]{40}$/.test(verificationController),'Exact review source required');
 return {kind:'V9_SAME_SOURCE_DB_RESOURCE_REVIEW_ONLY',installationEligible:false,releaseAuthorized:false,originalConclusion:'failure',candidate:pin.candidate,controller:pin.controller,baseline:pin.baseline,verificationController,originalRunId:pin.runId,originalFailedUnit:pin.unit,originalResource:e,focused:{runId:focused.run.id,jobId:producer.id,artifactId:focused.artifacts[0].id,digest:focused.artifacts[0].digest,reportHash:hash(r),resultHash:hash(focused.result),logHash:hash(selectedLog),resource:fresh,tests:replacement.total},retained,history:lineage,tests:retained.reduce((n,u)=>n+u.tests,0)+replacement.total,requiresIndependentReview:true,requiresSeparateAdmissionDecision:true};
}
