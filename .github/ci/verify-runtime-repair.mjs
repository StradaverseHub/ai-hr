/** Exact Board owner exception: authenticate originals, every affected file, final compiler and canonical bytes. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {runtimeRepairSource,RUNTIME_REPAIR as refs} from './runtime-repair-source.mjs';
import {authenticateRetainedUnits,fetchGitHubRunSnapshot,githubSnapshotIdentity} from './retained-units.mjs';
import {authenticateFocusedFiles} from './authenticated-focused.mjs';
import {authenticateOriginalBrowserPartial} from './authenticated-browser-partial.mjs';
import {authenticateBrowserRepair} from './authenticated-browser-repair.mjs';
import {authenticateRuntimeCompiler} from './runtime-compiler-evidence.mjs';
import {assessRuntimeOwnerCoverage} from './runtime-owner-acceptance.mjs';
import {inspectRuntimeRepairBuildOnlySnapshot} from './build-only-evidence.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {sourceBoundBuild,cleanHead,controllerRoot} from './release-ci.mjs';
import {bindOriginalController} from './ci-origin-binding.mjs';
import {forwardBaselineSource} from './forward-baseline.mjs';
import {immutablePlan} from './immutable-plan.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
const runtime={node:'22.23.3',platform:'linux',arch:'x64'},originalController='9541b1686d7941f89e564723271e48bf85a21a89';
const load=p=>JSON.parse(readFileSync(p,'utf8'));
export async function verifyRuntimeRepairCi({candidatePath,deploymentBaseline,plan}){
 assert(cleanHead(candidatePath)===refs.candidate&&deploymentBaseline===refs.staging,'Exact frozen candidate and ready staging baseline required');
 assert(plan&&plan.buildRunId===40475979249&&Array.isArray(plan.wave)&&plan.wave.length===29&&new Set(plan.wave.map(w=>w.runId)).size===29,'Exact complete private runtime repair plan required');
 const verifier=cleanHead(controllerRoot),verifierBinding=bindOriginalController({repository:controllerRoot,verifier,controller:originalController});
 const directory=join(controllerRoot,'scratchpad','validated-runtime-'+plan.buildRunId+'-'+randomUUID());mkdirSync(directory,{mode:0o700});
 const save=(n,v)=>writeFileSync(join(directory,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
 const sourceProof=await runtimeRepairSource({repository:candidatePath,candidate:refs.candidate});save('source-proof.json',sourceProof);
 const finalPlan=immutablePlan({repository:candidatePath,candidate:refs.candidate,controller:refs.alpha,baseline:refs.ciBaseline,runtime}).plan;
 const baselineAdvance=forwardBaselineSource({repository:candidatePath,candidate:refs.candidate,ciBaseline:refs.ciBaseline,deploymentBaseline});
 const snapshots=new Map();
 const retainSnapshot=(runId,path)=>{const snapshot=load(path);assert(snapshot.run.id===runId,'Authenticated snapshot differs');snapshots.set(runId,snapshot);return snapshot;};
 const original=await authenticateRetainedUnits({repository:candidatePath,expected:{candidate:refs.original,controller:originalController,baseline:refs.ciBaseline,runId:40444007805},runtime,outputParent:directory,prefetchDirectory:plan.originalPrefetchDirectory});
 const originalSnapshot=retainSnapshot(40444007805,join(original.evidenceDirectory,'final-api-snapshot.json'));
 const oldPlan=immutablePlan({repository:candidatePath,candidate:refs.original,controller:originalController,baseline:refs.ciBaseline,runtime}).plan;
 const originalFiles=[];
 for(const unit of oldPlan.units.filter(u=>u.kind!=='browser')){
  const report=load(join(original.evidenceDirectory,'unit-'+unit.id,'unit-'+unit.id+'.json'));verifyUnitReport(oldPlan,report);
  const origin=original.reusable.find(u=>u.id===unit.id)?.origin;assert(origin,'Original source unit lacks authenticated origin');
  for(const batch of report.batches)for(const file of batch.result.testResults){const path=file.name.slice(report.cwd.length+1);assert(finalPlan.suite.includes(path),'Foreign original ordinary file');originalFiles.push({path,state:'PASSED',passingAssertions:file.assertionResults.length,failedAssertions:0,originCandidate:refs.original,batchProcessExitCode:batch.exitCode,rawFileHash:installHash(installJson(file)),origin});}
 }
 const focused=async(row,candidate)=>{
  const result=await authenticateFocusedFiles({repository:candidatePath,expected:{candidate,controller:row.controller,baseline:refs.ciBaseline,runId:row.runId},runtime,outputParent:directory,prefetchDirectory:row.prefetchDirectory});
  retainSnapshot(row.runId,join(result.evidenceDirectory,'final-api-snapshot.json'));return result;
 };
 const wave=[];for(const row of plan.wave)wave.push(await focused(row,refs.wave));
 const letter=await focused({runId:40464427366,controller:'67be2710c35035af433bdb2fcdfb2cb30277ceda',prefetchDirectory:plan.letterPrefetchDirectory},refs.letter);
 const backendRepair=await focused({runId:40473934442,controller:'abd8d5b462e984f80cb5bdf8ef471d048fe7437b',prefetchDirectory:plan.backendPrefetchDirectory},refs.backendRepair);
 const browserOriginal=await authenticateOriginalBrowserPartial({repository:candidatePath,outputParent:directory});retainSnapshot(40469625375,join(browserOriginal.directory,'final-api-snapshot.json'));
 const browserRepair=await authenticateBrowserRepair({repository:candidatePath,outputParent:directory,prefetchDirectory:plan.browserRepairPrefetchDirectory});retainSnapshot(40474846420,join(browserRepair.evidenceDirectory,'final-api-snapshot.json'));
 const compiler=authenticateRuntimeCompiler({repository:candidatePath});snapshots.set(compiler.runId,compiler.snapshot);save('compiler-evidence.json',compiler);
 // The intervening fixture attempt also remains a genuine failure; it contributes no coverage.
 const intermediate=fetchGitHubRunSnapshot(40473787034);assert(intermediate.run.status==='completed'&&intermediate.run.conclusion==='failure'&&intermediate.run.head_sha==='5ecd6ce16f64fc2586a7872e62f009dba469135c'&&intermediate.run.run_attempt===1,'Original intermediate browser failure must remain failed');snapshots.set(40473787034,intermediate);save('intermediate-browser-failure.json',intermediate);
 const experience=load(plan.experienceEvidence),acceptance=assessRuntimeOwnerCoverage({sourceProof,plan:finalPlan,original,originalSnapshot,originalFiles,wave,letter,backendRepair,browserOriginal,browserRepair,compiler,experience});save('combined-coverage.json',acceptance);
 const expected={candidate:refs.candidate,controller:refs.alpha,runId:plan.buildRunId},snapshot=fetchGitHubRunSnapshot(plan.buildRunId),inventory=inspectRuntimeRepairBuildOnlySnapshot({...snapshot,expected});snapshots.set(plan.buildRunId,snapshot);
 save('run.json',snapshot.run);save('jobs.json',snapshot.jobs);save('artifacts.json',snapshot.artifacts);
 save('archive-downloads.json',await downloadCiArchives([inventory.artifact],directory,{prefetchDirectory:plan.buildPrefetchDirectory}));
 const archive=join(directory,BUILD_ARTIFACT+'.zip');readCiArchive(inventory.artifact,archive);
 execFileSync('python3',[fileURLToPath(new URL('./build-transport-extract.py',import.meta.url)),archive,join(directory,BUILD_ARTIFACT),inventory.artifact.digest.slice(7)],{timeout:60000,stdio:'inherit'});
 const p={...expected,baseline:refs.ciBaseline,controllerBranch:'alpha'},build=await sourceBoundBuild({candidatePath,dir:directory,p,jobs:snapshot.jobs});
 const evidence={kind:'AUTHENTICATED_RUNTIME_OWNER_EXCEPTION_AND_CANONICAL_BUILD',tier:'ci-runtime-owner-exception-v1',result:'ACCEPTED_WITH_OWNER_EXCEPTION',sha:refs.candidate,controller:refs.alpha,controllerBranch:'alpha',runId:plan.buildRunId,
  baseline:refs.ciBaseline,deploymentBaseline,baselineAdvance,verifierBinding,build,artifact:{id:inventory.artifact.id,digest:inventory.artifact.digest},acceptance,sourceProof,candidatePath,evidenceDirectory:directory,verifiedAt:new Date().toISOString(),fullGatePassCreated:false,createsNewFullPassBaseline:false,releaseAuthorized:false};
 const revalidate=async()=>{
  assert(cleanHead(candidatePath)===refs.candidate&&cleanHead(controllerRoot)===verifier,'Frozen runtime source/verifier changed');
  for(const [id,before] of snapshots){const actual=fetchGitHubRunSnapshot(id);assert(isDeepStrictEqual(githubSnapshotIdentity(actual),githubSnapshotIdentity(before))&&isDeepStrictEqual(actual.jobs,before.jobs),'Required original CI origin changed: '+id);}
  assert(isDeepStrictEqual(await runtimeRepairSource({repository:candidatePath,candidate:refs.candidate}),sourceProof),'Source graph proof changed');
  assert(isDeepStrictEqual(await sourceBoundBuild({candidatePath,dir:directory,p,jobs:snapshot.jobs}),build),'Canonical source-bound build changed');
  const alpha=JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/git/ref/heads/alpha'],{encoding:'utf8'}));assert(alpha.object?.sha===refs.alpha,'Unrelated alpha history changed during runtime admission');
  assert(installHash(installJson(load(plan.experienceEvidence)))===acceptance.experienceEvidenceSha256,'Acceptance reconciliation changed');return true;
 };
 await revalidate();save('verification.json',evidence);return {evidence,snapshot,revalidate};
}
