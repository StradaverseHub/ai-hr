/** aihr-build-capacity-recovery/v1: exact-source replacement of ONE canonical build that failed only on the
 * reviewed sampled-memory floor. The original failed gate, its failed build job and its failure diagnostic stay
 * failed and are retained as evidence; one fresh first-attempt build-only execution on the same controller and
 * the same candidate supplies the installable packet. Every other job keeps its original authenticated evidence,
 * verified exactly as the normal verifier would. API/archive authentication belongs to build-recovery.mjs. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {hash,requiredEvidence} from './manifest.mjs';
import {verifyReports,verifyUnitReport} from './verify-shards.mjs';
import {REPOSITORY_ID,validateProof} from './release-policy.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {NEXT_APPLICATION_FAILURE,NEXT_APPLICATION_STATE} from './next-application-cache-protocol.mjs';
import {COMPILER_STATE_ARTIFACT} from './compiler-cache-protocol.mjs';
import {BUILD_HEAP_CEILING_MB,BUILD_HEAP_PROFILE,BUILD_MEM_AVAILABLE_MIN_KIB,BUILD_RSS_WARN_KIB,BUILD_RSS_FAIL_KIB,buildMemoryVerdict,parseMaxRssKiB} from './build-heap.mjs';
import {validateRepairBuildMetadata} from './repair-recovery-policy.mjs';
export const BUILD_RECOVERY_POLICY='aihr-build-capacity-recovery/v1';
// String(error) of the single assertion in next-application-cache.mjs that enforces the reviewed floor.
export const MEMORY_FLOOR_ERROR='AssertionError [ERR_ASSERTION]: Canonical next build sampled available memory missing or below reviewed floor';
export const BUILD_STEP='Canonical System Testing production build and byte bundle';
export const BUILD_DIAGNOSTIC_STEP='Preserve failed canonical build diagnostics';
export const VERIFY_GUARD_STEP='Every prerequisite succeeded';
export const BUILD_FAILURE_MEMBERS=['application-typegen.log','canonical-build.log','comparison.json'];
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>Number.isSafeInteger(x)&&x>0;
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
const sha256=text=>createHash('sha256').update(text).digest('hex');
const branchName=b=>typeof b==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b)&&!b.includes('..')&&b.length<=200;
const gnuExit=text=>{const m=[...text.matchAll(/^\s*Exit status: (\d+)\s*$/gm)];assert(m.length>=1,'GNU time exit status required');return Number(m.at(-1)[1]);};

/** The single failed step must be the named one; earlier steps passed and only bookkeeping may follow. */
function onlyFailedStep(job,name,message){
 assert(Array.isArray(job?.steps)&&job.steps.length>0&&job.steps.every(s=>typeof s?.name==='string'&&Number.isSafeInteger(s.number)),message+': step inventory required');
 const failed=job.steps.filter(s=>s.conclusion!=='success'&&s.conclusion!=='skipped');
 assert(failed.length===1&&failed[0].name===name&&failed[0].conclusion==='failure'&&job.steps.filter(s=>s.name===name).length===1,message);
 assert(job.steps.filter(s=>s.number<failed[0].number).every(s=>['success','skipped'].includes(s.conclusion)),message+': an earlier step did not pass');
 return failed[0];
}
/** Original job/artifact shape: build is the only failed prerequisite and verify failed only as its dependent. */
export function validateOriginalBuildFailure({plan,run,jobs,artifacts,now=Date.now()}){
 assert(run?.status==='completed'&&run.conclusion==='failure'&&run.run_attempt===1,'Original gate must be a completed failed first attempt');
 const required=requiredEvidence(plan);
 assert(Array.isArray(jobs)&&jobs.length===required.jobs.length+1&&new Set(jobs.map(j=>j.name)).size===jobs.length,'Complete original job inventory required');
 for(const j of jobs){
  assert(j.run_id===run.id&&j.run_attempt===1&&j.head_sha===run.head_sha&&j.status==='completed','Foreign, rerun or incomplete original job');
  if(j.name==='runner-diagnostics'){assert(j.conclusion==='skipped','Runner diagnostics must be skipped in a full gate');continue;}
  assert(required.jobs.includes(j.name),'Unknown original job: '+j.name);
  assert(j.conclusion===(['build','verify'].includes(j.name)?'failure':'success'),'Only the canonical build may have failed; '+j.name+' concluded '+j.conclusion);
 }
 const build=jobs.find(j=>j.name==='build'),verify=jobs.find(j=>j.name==='verify');
 onlyFailedStep(build,BUILD_STEP,'Canonical build step must be the only failed build step');
 assert(build.steps.find(s=>s.name===BUILD_DIAGNOSTIC_STEP)?.conclusion==='success','Original build failure diagnostic was not preserved');
 const guard=onlyFailedStep(verify,VERIFY_GUARD_STEP,'Verifier must fail only on its prerequisite guard');
 assert(verify.steps.filter(s=>s.number>guard.number&&s.name!=='Complete job'&&!s.name.startsWith('Post ')).every(s=>s.conclusion==='skipped'),'Original verifier executed beyond its dependency guard');
 const allowed=new Set([...required.artifacts.filter(n=>n!=='gate-evidence'&&n!==BUILD_ARTIFACT),NEXT_APPLICATION_FAILURE,COMPILER_STATE_ARTIFACT]);
 const names=artifacts.map(a=>a.name);
 assert(new Set(names).size===names.length&&names.every(n=>allowed.has(n)),'Original gate carries a build packet, receipt, state or unknown artifact');
 for(const n of allowed)if(n!==COMPILER_STATE_ARTIFACT)assert(names.includes(n),'Original artifact missing: '+n);
 const a=artifacts.find(x=>x.name===NEXT_APPLICATION_FAILURE),w=a.workflow_run;
 assert(id(a.id)&&a.expired===false&&id(a.size_in_bytes)&&a.size_in_bytes<=32*1024**2&&/^sha256:[a-f0-9]{64}$/.test(a.digest??''),'Invalid original build failure artifact');
 assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Foreign original build failure artifact');
 assert(Date.parse(a.created_at)>=Date.parse(build.started_at)&&Date.parse(a.created_at)<=Date.parse(build.completed_at)&&Date.parse(a.expires_at)>now,'Build failure artifact outside its producing job');
 return {buildJobId:build.id,verifyJobId:verify.id,failureArtifact:{id:a.id,digest:a.digest}};
}
/** Prove the memory floor, and nothing else, failed: recompute the verdict and re-run the compiler log checks
 * that the original wrapper never reached because the floor assertion fired first. */
export function validateMemoryFloorFailure({report,buildLog,typegenLog,expected}){
 assert(report?.kind==='CANONICAL_CI_APPLICATION_COMPILER_STATE_NOT_RELEASE'&&report.releaseAuthorized===false&&report.source===expected.candidate&&report.controller===expected.controller&&report.runId===String(expected.runId)&&report.attempt==='1','Build failure diagnostic identity differs');
 assert(report.exitCode===1&&report.error===MEMORY_FLOOR_ERROR,'Original build failure is not the sampled-memory floor');
 assert(report.capacityProfile==='bounded-canonical-build','Original build did not use the bounded canonical capacity profile');
 const m=report.memory;
 assert(m?.heapMb===BUILD_HEAP_CEILING_MB&&m.heapProfile===BUILD_HEAP_PROFILE&&m.minMemAvailableBudgetKiB===BUILD_MEM_AVAILABLE_MIN_KIB,'Original build heap/floor profile differs');
 same(m.rssBudgetKiB,{warn:BUILD_RSS_WARN_KIB,fail:BUILD_RSS_FAIL_KIB},'Original RSS budget differs');
 // Review 2026-11-24: a missing sample is a telemetry failure, not a proven floor breach; it needs a fresh whole gate.
 assert(Number.isSafeInteger(m.peakRssKiB)&&m.peakRssKiB>0&&Number.isSafeInteger(m.minMemAvailableKiB)&&m.minMemAvailableKiB>=0&&m.minMemAvailableKiB<BUILD_MEM_AVAILABLE_MIN_KIB,'Memory telemetry does not show a sampled floor breach');
 const recomputed=buildMemoryVerdict(m.heapMb,m.peakRssKiB,m.minMemAvailableKiB);
 assert(recomputed.availableMemoryVerdict==='fail'&&recomputed.rssVerdict!=='fail'&&m.availableMemoryVerdict==='fail'&&m.verdict==='fail'&&m.rssVerdict===recomputed.rssVerdict,'Peak RSS also failed or the recorded verdict differs');
 assert(Array.isArray(report.phases)&&report.phases.length===2&&report.phases[0].name==='application-typegen'&&report.phases[1].name==='canonical-build','Original build phases differ');
 for(const p of report.phases)assert(p.code===0&&p.signal===null&&p.timedOut===false,'An original build command itself failed: '+p.name);
 same(report.actualCanonicalBuild,report.phases[1],'Canonical build command record differs');
 assert(report.phases[1].peakRssKiB===m.peakRssKiB,'Canonical build peak RSS differs');
 assert(report.sourceRestored===true&&report.controllerRestored===true&&report.ownedRecordsRemoved===true&&report.workingStateRemoved===true&&report.cleanupError===undefined&&report.diskSamplingError===undefined,'Original build cleanup or sampling also failed');
 const disk=Array.isArray(report.diskSamples)?report.diskSamples.flatMap(s=>s.volumes??[]).map(v=>v.availableBytes):[];
 assert(disk.length>0&&disk.every(Number.isSafeInteger)&&Math.min(...disk)>=2*1024**3,'Original build also breached disk headroom');
 assert(typeof buildLog==='string'&&typeof typegenLog==='string'&&gnuExit(buildLog)===0&&gnuExit(typegenLog)===0,'Original command logs show a failed process');
 assert(/\bCompiled successfully in /.test(buildLog)&&/Finished TypeScript in /.test(buildLog)&&!/Skipping validation of types|Finished TypeScript config validation|\berror TS\d+:/.test(buildLog),'Original canonical compiler did not complete cleanly');
 assert(parseMaxRssKiB(buildLog)===m.peakRssKiB,'Build log peak RSS differs from the diagnostic');
 return {proven:true,error:report.error,floorKiB:BUILD_MEM_AVAILABLE_MIN_KIB,minMemAvailableKiB:m.minMemAvailableKiB,peakRssKiB:m.peakRssKiB,rssVerdict:m.rssVerdict,comparisonSha256:hash(report),buildLogSha256:sha256(buildLog),typegenLogSha256:sha256(typegenLog)};
}
/** Complete branch history: the replacement build is the ONLY relevant execution since the original started. */
export function validateBuildRecoveryHistory({source,rows,candidateBranch,buildRunId}){
 assert(branchName(candidateBranch)&&source?.run?.display_title===`Alpha CI · ${candidateBranch}`&&Array.isArray(rows)&&rows.length<=8000,'Frozen candidate branch history required');
 const titles=new Set(['Alpha CI','Canonical build only','CI controller checks','Runner diagnostics','Focused only','Tooling transport only'].map(t=>`${t} · ${candidateBranch}`));
 const found=new Map(),start=Date.parse(source.run.created_at);
 assert(Number.isFinite(start),'Original creation time required');
 for(const r of rows){
  if(r?.id===source.run.id||!titles.has(r?.display_title))continue;
  assert(id(r.id)&&Number.isFinite(Date.parse(r.created_at))&&Number.isFinite(Date.parse(r.updated_at))&&Date.parse(r.updated_at)>=Date.parse(r.created_at)&&['queued','in_progress','waiting','requested','pending','completed'].includes(r.status),'Malformed relevant history');
  // Older completed history precedes the original gate; every overlapping, later or active run is relevant.
  if(r.status==='completed'&&Date.parse(r.updated_at)<start)continue;
  const record={id:r.id,workflowId:r.workflow_id,title:r.display_title,controller:r.head_sha,status:r.status,conclusion:r.conclusion,attempt:r.run_attempt,createdAt:r.created_at,updatedAt:r.updated_at};
  assert(!found.has(r.id)||isDeepStrictEqual(found.get(r.id),record),'Conflicting history API snapshots; retry after stabilization');found.set(r.id,record);
 }
 const relevant=[...found.values()];
 assert(relevant.length===1&&relevant[0].id===buildRunId,'Unaccounted, pending or superseding execution for '+candidateBranch+': '+relevant.map(r=>r.id).join(','));
 const b=relevant[0];
 assert(b.title===`Canonical build only · ${candidateBranch}`&&b.status==='completed'&&b.conclusion==='success'&&b.attempt===1&&b.controller===source.run.head_sha,'Replacement build history differs');
 return {kind:'AUTHENTICATED_BUILD_RECOVERY_HISTORY',sourceRunId:source.run.id,candidateBranch,executions:relevant};
}
export function verifyBuildRecovery({expectedPlan,p,plan,sourceRun,sourceJobs,sourceArtifacts,reports,assessment,failure,buildRun,buildJobs,build,history,candidateBranch,verificationController,now=Date.now()}){
 assert(sha(p?.candidate)&&sha(p.controller)&&sha(p.baseline)&&p.runId===sourceRun?.id,'Exact expected identity required');
 assert(verificationController===p.controller&&sourceRun.head_sha===p.controller,'Verifier must be the exact original gate controller');
 assert(sourceRun.display_title===`Alpha CI · ${candidateBranch}`,'Original gate does not belong to the candidate branch');
 const original=validateOriginalBuildFailure({plan,run:sourceRun,jobs:sourceJobs,artifacts:sourceArtifacts,now});
 // Exactly the normal verifier's proof; the dependent verifier never wrote its receipt, so reconstruct it.
 const receipt=verifyReports(plan,reports),verified=validateProof({plan,reports,receipt,expectedPlan,p});
 assert(assessment?.sourceRun?.id===sourceRun.id&&assessment.sha===p.candidate&&assessment.controller===p.controller&&assessment.baseline===p.baseline&&assessment.fingerprint===plan.fingerprint,'Original source assessment differs');
 assert(Array.isArray(assessment.rerun)&&assessment.rerun.length===0&&assessment.reusable.length===plan.units.length,'Every test and browser unit must have passed in the original gate');
 const memoryFloor=validateMemoryFloorFailure({...failure,expected:{candidate:p.candidate,controller:p.controller,runId:sourceRun.id}});
 const producer=validateRepairBuildMetadata({run:buildRun,jobs:buildJobs,expected:{runId:buildRun?.id,controller:p.controller,after:sourceRun.updated_at,candidateBranch,now}});
 assert(buildRun.id!==sourceRun.id&&buildRun.head_branch===sourceRun.head_branch,'Replacement build must use the original controller branch');
 assert(build?.canonicalCandidateInputsVerified===true&&build.source===p.candidate&&build.controller===p.controller&&build.runId===buildRun.id,'Replacement build is not bound to the exact candidate/controller');
 assert(history?.kind==='AUTHENTICATED_BUILD_RECOVERY_HISTORY'&&history.sourceRunId===sourceRun.id&&history.executions?.length===1&&history.executions[0].id===buildRun.id,'Complete branch history required');
 const units=plan.units.map(u=>{const r=reports.find(x=>x.id===u.id),v=verifyUnitReport(plan,r),s=assessment.reusable.find(x=>x.id===u.id);
  assert(s?.reportHash===hash(r)&&s.source?.runId===sourceRun.id,'Retained unit provenance changed');return {id:u.id,kind:'retained',reportHash:hash(r),tests:v.tests,source:s.source};});
 return {kind:'AUTHENTICATED_BUILD_CAPACITY_RECOVERY',recoveryPolicy:BUILD_RECOVERY_POLICY,policyVersion:verified.policyVersion,sha:p.candidate,controller:p.controller,verificationController,baseline:p.baseline,
  runId:buildRun.id,buildRunId:buildRun.id,buildJobId:producer.id,originalRunId:sourceRun.id,originalConclusion:'failure',originalFingerprint:plan.fingerprint,receiptFingerprint:hash(receipt),candidateBranch,
  originalBuild:{jobId:original.buildJobId,conclusion:'failure',failureArtifact:original.failureArtifact},verifyJobId:original.verifyJobId,memoryFloor,
  originalJobConclusions:sourceJobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion})).sort((a,b)=>a.id-b.id),history,units,releaseAuthorized:false,
  suiteFiles:verified.suiteFiles,browserFiles:verified.browserFiles,tests:verified.tests};
}
/** The grant binds the replacement build run; the certificate keeps the original failed gate. */
export function validateBuildRecoveryGrantEvidence(evidence,run){
 const c=evidence.recovery;
 assert(c?.kind==='AUTHENTICATED_BUILD_CAPACITY_RECOVERY'&&c.recoveryPolicy===BUILD_RECOVERY_POLICY&&c.originalConclusion==='failure'&&evidence.fingerprint===hash(c),'Authenticated build capacity recovery certificate required');
 for(const key of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests'])same(evidence[key],c[key],'Build recovery grant identity differs: '+key);
 assert(c.verificationController===c.controller&&c.releaseAuthorized===false&&c.memoryFloor?.proven===true&&c.memoryFloor.error===MEMORY_FLOOR_ERROR,'Exact controller and proven memory-floor failure required');
 assert(id(c.originalRunId)&&c.originalRunId!==c.runId&&c.buildRunId===c.runId&&c.originalBuild?.conclusion==='failure'&&id(c.originalBuild.failureArtifact?.id),'Original failed build provenance required');
 assert(c.units?.length>0&&c.units.every(u=>u.kind==='retained'&&u.source?.runId===c.originalRunId),'Only original retained test evidence is admitted');
 assert(c.history?.kind==='AUTHENTICATED_BUILD_RECOVERY_HISTORY'&&c.history.executions?.length===1&&c.history.executions[0].id===c.runId,'Complete branch history required');
 assert(run.id===c.runId&&run.head_sha===c.controller&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Replacement build run identity required');
 return true;
}
