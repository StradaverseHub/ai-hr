/** Independently authenticate retained runtime coverage, replacement compiler and new canonical bytes. */
import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{mkdirSync,writeFileSync,readFileSync}from'node:fs';import{join}from'node:path';import{fileURLToPath}from'node:url';import{randomUUID}from'node:crypto';import{createRequire}from'node:module';import{isDeepStrictEqual}from'node:util';
import{authenticateRetainedUnits,fetchGitHubRunSnapshot,githubSnapshotIdentity}from'./retained-units.mjs';import{authenticateFocusedFiles}from'./authenticated-focused.mjs';import{typeOnlyRepairSource}from'./type-only-repair.mjs';import{assessTypeRepairAcceptance}from'./type-repair-acceptance.mjs';import{inspectBuildOnlySnapshot}from'./build-only-evidence.mjs';import{downloadCiArchives,readCiArchive}from'./archive-downloads.mjs';import{sourceBoundBuild,cleanHead,controllerRoot}from'./release-ci.mjs';import{bindOriginalController}from'./ci-origin-binding.mjs';import{forwardBaselineSource}from'./forward-baseline.mjs';import{BUILD_ARTIFACT}from'./build-artifact.mjs';
import{authenticateDifferentCandidateRun}from'./other-controller-evidence.mjs';
const runtime={node:'22.23.3',platform:'linux',arch:'x64'};
export function validateTypeRepairPlan(plan){
 const refs=['originalCandidate','compilerCandidate','originalController','ciBaseline'],runs=['originalRunId','compilerRunId','buildRunId'],optional=['originalPrefetchDirectory','focusedPrefetchDirectory','buildPrefetchDirectory'];
 assert(plan&&typeof plan==='object'&&!Array.isArray(plan)&&Object.keys(plan).every(k=>[...refs,...runs,...optional].includes(k)),'Exact private type-repair plan required');
 for(const k of refs)assert(/^[a-f0-9]{40}$/.test(plan[k]??''),'Exact plan source required: '+k);
 for(const k of runs)assert(Number.isSafeInteger(plan[k])&&plan[k]>0,'Exact plan run required: '+k);
 assert(new Set(runs.map(k=>plan[k])).size===3,'Distinct run origins required');
 for(const k of optional)if(plan[k]!==undefined)assert(typeof plan[k]==='string'&&plan[k].startsWith('/')&&!plan[k].includes('\0'),'Canonical local prefetch path required');return plan;
}
export async function verifyTypeRepairCi({candidatePath,deploymentBaseline,plan}){
 validateTypeRepairPlan(plan);
 const sha=cleanHead(candidatePath),verifier=cleanHead(controllerRoot);const verifierBinding=bindOriginalController({repository:controllerRoot,verifier,controller:plan.originalController});
 assert(plan.originalRunId!==plan.compilerRunId&&plan.compilerRunId!==plan.buildRunId,'Distinct actual evidence origins required');
 const typescript=createRequire(new URL('../../package.json',import.meta.url))('typescript');
 const sourceProof=typeOnlyRepairSource({repository:candidatePath,original:plan.originalCandidate,compilerCandidate:plan.compilerCandidate,candidate:sha,typescript});
 assert(sourceProof.workflowCompatibility?.actualBuildJobUnchanged===true,'Exact reviewed workflow publication required');
 const changed=execFileSync('git',['-C',candidatePath,'diff','--name-only',plan.originalController,sha,'--','.github','scripts/gate-db-classify.ts'],{encoding:'utf8'}).trim();assert(changed==='.github/workflows/alpha-staging.yml','Producer authority must retain all original controller code');
 const baselineAdvance=forwardBaselineSource({repository:candidatePath,candidate:sha,ciBaseline:plan.ciBaseline,deploymentBaseline});
 const original=await authenticateRetainedUnits({repository:candidatePath,expected:{candidate:plan.originalCandidate,controller:plan.originalController,baseline:plan.ciBaseline,runId:plan.originalRunId},runtime,outputParent:join(controllerRoot,'scratchpad'),prefetchDirectory:plan.originalPrefetchDirectory});
 const focused=await authenticateFocusedFiles({repository:candidatePath,expected:{candidate:plan.compilerCandidate,controller:plan.originalController,baseline:plan.ciBaseline,runId:plan.compilerRunId},runtime,outputParent:join(controllerRoot,'scratchpad'),prefetchDirectory:plan.focusedPrefetchDirectory});
 const originalSnapshot=fetchGitHubRunSnapshot(plan.originalRunId),focusedSnapshot=fetchGitHubRunSnapshot(plan.compilerRunId);
 for(const[actual,proof]of[[originalSnapshot,original],[focusedSnapshot,focused]])assert(isDeepStrictEqual(githubSnapshotIdentity(actual),githubSnapshotIdentity(JSON.parse(readFileSync(join(proof.evidenceDirectory,'final-api-snapshot.json'))))),'Original authenticated origin changed');
 const acceptance=assessTypeRepairAcceptance({sourceProof,original,originalSnapshot,focused,focusedSnapshot});
 const expected={candidate:sha,controller:sha,runId:plan.buildRunId},snapshot=fetchGitHubRunSnapshot(plan.buildRunId),inventory=inspectBuildOnlySnapshot({...snapshot,expected});
 const dir=join(controllerRoot,'scratchpad','validated-type-repair-'+plan.buildRunId+'-'+randomUUID());mkdirSync(dir,{mode:0o700});const save=(n,v)=>writeFileSync(join(dir,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
 save('source-proof.json',sourceProof);save('combined-coverage.json',acceptance);save('run.json',snapshot.run);save('jobs.json',snapshot.jobs);save('artifacts.json',snapshot.artifacts);
 save('archive-downloads.json',await downloadCiArchives([inventory.artifact],dir,{prefetchDirectory:plan.buildPrefetchDirectory}));const archive=join(dir,BUILD_ARTIFACT+'.zip');readCiArchive(inventory.artifact,archive);
 execFileSync('python3',[fileURLToPath(new URL('./build-transport-extract.py',import.meta.url)),archive,join(dir,BUILD_ARTIFACT),inventory.artifact.digest.slice(7)],{stdio:'inherit',timeout:60000});
 const p={...expected,controllerBranch:'alpha'},build=await sourceBoundBuild({candidatePath,dir,p,jobs:snapshot.jobs});
 const evidence={kind:'AUTHENTICATED_CANONICAL_BUILD_ONLY_NOT_FULL_GATE',tier:'ci-type-only-repair-v1',result:'ACCEPTED_WITH_AUTHENTICATED_ORIGINAL_PASSES',sha,controller:sha,controllerBranch:'alpha',runId:plan.buildRunId,baseline:plan.ciBaseline,deploymentBaseline,baselineAdvance,verifierBinding,build,artifact:{id:inventory.artifact.id,digest:inventory.artifact.digest},acceptance,sourceProof,candidatePath,evidenceDirectory:dir,verifiedAt:new Date().toISOString(),fullGatePassCreated:false,releaseAuthorized:false};
 const origins={originalSnapshot,focusedSnapshot,snapshot},otherRuns=new Map();
 const revalidate=async()=>{
  assert(cleanHead(candidatePath)===sha&&cleanHead(controllerRoot)===verifier,'Candidate/verifier changed');
  for(const[runId,before]of[[plan.originalRunId,origins.originalSnapshot],[plan.compilerRunId,origins.focusedSnapshot],[plan.buildRunId,origins.snapshot]])assert(isDeepStrictEqual(githubSnapshotIdentity(fetchGitHubRunSnapshot(runId)),githubSnapshotIdentity(before)),'Required original evidence changed');
  const current=await sourceBoundBuild({candidatePath,dir,p,jobs:snapshot.jobs});assert(isDeepStrictEqual(current,build),'Original canonical packet changed');
  assert(isDeepStrictEqual(typeOnlyRepairSource({repository:candidatePath,original:plan.originalCandidate,compilerCandidate:plan.compilerCandidate,candidate:sha,typescript}),sourceProof),'Source compatibility changed');
  const live=JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/git/ref/heads/alpha'],{encoding:'utf8'}));assert(live.object?.sha===sha,'Trusted alpha moved');
  const latest=JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/actions/runs?head_sha='+sha+'&per_page=100'],{encoding:'utf8',maxBuffer:8*1024**2}));assert(Number.isSafeInteger(latest.total_count)&&latest.total_count<=100&&Array.isArray(latest.workflow_runs)&&latest.workflow_runs.length===latest.total_count&&new Set(latest.workflow_runs.map(r=>r.id)).size===latest.total_count,'Complete bounded additional run inventory required');
  for(const run of latest.workflow_runs){if(run.id===plan.buildRunId||run.status==='completed'&&run.conclusion==='skipped')continue;
   const cached=otherRuns.get(run.id);if(cached){assert(isDeepStrictEqual(githubSnapshotIdentity(fetchGitHubRunSnapshot(run.id)),cached.identity),'Assessed other candidate run changed');continue;}
   const assessed=await authenticateDifferentCandidateRun({repository:candidatePath,runId:run.id,candidate:sha,controller:sha,outputParent:dir});otherRuns.set(run.id,assessed);save('other-candidate-'+run.id+'.json',assessed);
  }
  return true;
 };
 await revalidate();save('verification.json',evidence);return{evidence,snapshot,revalidate};
}
