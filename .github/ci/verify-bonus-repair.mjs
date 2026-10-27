/** Exact current-source owner exception with shared immutable planning and bounded fresh API reads. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {BONUS_REFS as refs,validateHistoricalRuntimeCollection,assessBonusOwnerCoverage} from './bonus-owner-acceptance.mjs';
import {bonusRepairSource} from './bonus-repair-source.mjs';
import {verifyBonusInputContinuity} from './bonus-input-continuity.mjs';
import {proveReviewedFocusedController} from './reviewed-focused-controller.mjs';
import {immutablePlan} from './immutable-plan.mjs';
import {fetchRunSnapshots} from './github-snapshot-batch.mjs';
import {githubSnapshotIdentity} from './retained-units.mjs';
import {inspectFocusedSnapshotArchive} from './focused-snapshot-reader.mjs';
import {authenticateBonusBrowser} from './authenticated-bonus-browser.mjs';
import {authenticateBonusCompiler} from './bonus-compiler-evidence.mjs';
import {inspectBonusRepairBuildOnlySnapshot} from './build-only-evidence.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {sourceBoundBuild,cleanHead,controllerRoot} from './release-ci.mjs';
import {bindOriginalController} from './ci-origin-binding.mjs';
import {forwardBaselineSource} from './forward-baseline.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
const CI_BASE='2127b1a7ebd40e5b9ee7d010e72e75d4b1cb3e9f',runtime={node:'22.23.3',platform:'linux',arch:'x64'};
const load=p=>JSON.parse(readFileSync(p,'utf8'));
export function assertSnapshotSetsUnchanged(before,after){
 assert(before instanceof Map&&after instanceof Map&&before.size===after.size,'Complete actual metadata snapshot sets required');
 for(const [id,previous] of before){const current=after.get(id);assert(current&&isDeepStrictEqual(githubSnapshotIdentity(previous),githubSnapshotIdentity(current))&&isDeepStrictEqual(previous.jobs,current.jobs),'Actual CI origin or executed steps changed: '+id);}
 return true;
}
function assertOperatorControls(snapshot,verifier){
 const {run,jobs}=snapshot;assert(run.repository?.id===1333414856&&run.head_repository?.id===1333414856&&run.repository.full_name==='StradaverseHub/ai-hr'&&run.head_sha===verifier&&run.head_branch==='claude/letters-runtime-admission-20261027'&&run.path==='.github/workflows/alpha-staging.yml'&&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Actual current operator controls required');
 const active=jobs.filter(j=>j.name==='verifier-controls');assert(active.length===1&&active[0].status==='completed'&&active[0].conclusion==='success'&&active[0].head_sha===verifier&&active[0].run_id===run.id,'Actual current control job must complete');
 for(const name of ['Exact Bonus build inventory and refusal boundaries','Import Bonus operator without executing native actions'])assert(active[0].steps.some(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success'),'Actual current control step missing: '+name);
 assert(jobs.every(j=>j.name==='verifier-controls'||j.name==='bonus-negative'&&j.status==='completed'&&j.conclusion==='skipped'),'Unexpected operator control execution');
}
export async function verifyBonusRepairCi({candidatePath,deploymentBaseline,plan}){
 const began=Date.now();assert.equal(cleanHead(candidatePath),refs.candidate);assert.equal(deploymentBaseline,refs.base);
 assert(plan&&plan.wave?.length===26&&new Set(plan.wave.map(r=>r.runId)).size===26&&plan.positive?.runId===40507897305&&plan.tool?.runId===40511001942&&plan.runtimeMismatches?.length===5&&plan.controlRunId>0,'Complete private input inventory required');
 const verifier=cleanHead(controllerRoot),verifierBinding=bindOriginalController({repository:controllerRoot,verifier,controller:'9541b1686d7941f89e564723271e48bf85a21a89'}),directory=join(controllerRoot,'scratchpad','validated-bonus-'+refs.buildRunId+'-'+randomUUID());mkdirSync(directory,{mode:0o700});
 const save=(name,data)=>writeFileSync(join(directory,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 const ids=[...new Set([...plan.wave.map(r=>r.runId),...plan.runtimeMismatches.map(r=>r.runId),plan.positive.runId,plan.tool.runId,refs.buildRunId,40512563694,40509167972,plan.controlRunId])];
 const before=await fetchRunSnapshots(ids);assertOperatorControls(before.get(plan.controlRunId),verifier);save('first-api-snapshots.json',Object.fromEntries(before));
 const source=await bonusRepairSource({repository:candidatePath});assert(isDeepStrictEqual(source,load(plan.sourceImpact)),'Actual immutable source/impact differs from original source witness');save('source-proof.json',source);
 const historical=validateHistoricalRuntimeCollection({verification:load(join(plan.historicalDirectory,'verification.json')),grant:load(join(plan.historicalDirectory,'installation-grant.json'))});
 const plans=new Map();
 const read=async(row,selectedRuntime=runtime)=>{
  const snapshot=before.get(row.runId);assert(snapshot,'Missing actual metadata');
  let expected={candidate:row.candidate??refs.candidate,controller:row.controller,baseline:CI_BASE,runId:row.runId};
  if(!['alpha','main'].includes(snapshot.run.head_branch))expected={...expected,controllerBranch:snapshot.run.head_branch,reviewedControllerProof:proveReviewedFocusedController({repository:candidatePath,controller:row.controller,branch:snapshot.run.head_branch})};
  const key=expected.candidate+'|'+expected.controller+'|'+selectedRuntime.node;
  if(!plans.has(key))plans.set(key,immutablePlan({repository:candidatePath,candidate:expected.candidate,controller:expected.controller,baseline:CI_BASE,runtime:selectedRuntime}));
  const result=await inspectFocusedSnapshotArchive({repository:candidatePath,expected,snapshot,reconstructed:plans.get(key),archivePath:join(row.prefetchDirectory,'focused-development-evidence.zip'),directory:join(directory,'focused-'+row.runId)});
  assert(isDeepStrictEqual(result.files.map(f=>f.path).sort(),row.files.slice().sort()),'Actual selected membership differs from required batch');save('focused-'+row.runId+'.json',result);return result;
 };
 const wave=[];for(const row of plan.wave)wave.push(await read(row));
 const positive=await read(plan.positive),tool=await read(plan.tool);
 const continuity=await verifyBonusInputContinuity({repository:candidatePath,toolRepository:plan.toolRepository,source,continuity:load(plan.ioContinuity),originalToolAuthentication:load(plan.originalToolAuthentication),toolAuthentication:tool});save('io-continuity.json',continuity);
 const diagnostic=[];for(const row of plan.runtimeMismatches){const actual=await read(row,{...runtime,node:'22.23.4'});assert.equal(actual.originalFocusedExitCode,0);diagnostic.push({runId:row.runId,actualRuntime:'22.23.4',targetRuntime:'22.23.3',refusal:'EXACT_TARGET_RUNTIME_MISMATCH',passingFiles:actual.passingFiles,notAcceptedAsTargetCoverage:true});}save('original-runtime-mismatch-outcomes.json',diagnostic);
 const browser=await authenticateBonusBrowser({repository:candidatePath,outputParent:directory}),compiler=authenticateBonusCompiler({repository:candidatePath});save('compiler-evidence.json',compiler);
 const negative=before.get(40509167972);assert(negative.run.head_sha==='e33213148f71d71bbeabfcf3333cfc5d9a2a2058'&&negative.run.conclusion==='success'&&negative.jobs.some(j=>j.name==='bonus-negative'&&j.conclusion==='success'),'Original-component assertion control missing');
 const experience=load(plan.experienceEvidence),acceptance=assessBonusOwnerCoverage({historical,source,continuity,wave,positive,browser,compiler,experience});save('combined-coverage.json',acceptance);
 const snapshot=before.get(refs.buildRunId),expected={candidate:refs.candidate,controller:refs.controller,runId:refs.buildRunId},inventory=inspectBonusRepairBuildOnlySnapshot({...snapshot,expected});
 save('run.json',snapshot.run);save('jobs.json',snapshot.jobs);save('artifacts.json',snapshot.artifacts);save('archive-downloads.json',await downloadCiArchives([inventory.artifact],directory,{prefetchDirectory:plan.buildPrefetchDirectory}));
 const archive=join(directory,BUILD_ARTIFACT+'.zip');readCiArchive(inventory.artifact,archive);execFileSync('python3',[fileURLToPath(new URL('./build-transport-extract.py',import.meta.url)),archive,join(directory,BUILD_ARTIFACT),inventory.artifact.digest.slice(7)],{timeout:60000,stdio:'inherit'});
 const buildParams={...expected,baseline:CI_BASE,controllerBranch:'alpha'},build=await sourceBoundBuild({candidatePath,dir:directory,p:buildParams,jobs:snapshot.jobs}),baselineAdvance=forwardBaselineSource({repository:candidatePath,candidate:refs.candidate,ciBaseline:CI_BASE,deploymentBaseline});
 const evidence={kind:'AUTHENTICATED_BONUS_OWNER_EXCEPTION_AND_CANONICAL_BUILD',tier:'ci-runtime-owner-exception-v1',result:'ACCEPTED_WITH_OWNER_EXCEPTION',sha:refs.candidate,controller:refs.controller,controllerBranch:'alpha',runId:refs.buildRunId,baseline:CI_BASE,deploymentBaseline,baselineAdvance,verifierBinding,build,artifact:{id:inventory.artifact.id,digest:inventory.artifact.digest},acceptance,sourceProof:source,candidatePath,evidenceDirectory:directory,verifiedAt:new Date().toISOString(),fullGatePassCreated:false,createsNewFullPassBaseline:false,releaseAuthorized:false};
 const revalidate=async()=>{
  assert.equal(cleanHead(candidatePath),refs.candidate);assert.equal(cleanHead(controllerRoot),verifier);assertSnapshotSetsUnchanged(before,await fetchRunSnapshots(ids));
  assert(isDeepStrictEqual(await bonusRepairSource({repository:candidatePath}),source),'Frozen actual source graph changed');
  await verifyBonusInputContinuity({repository:candidatePath,toolRepository:plan.toolRepository,source,continuity,originalToolAuthentication:load(plan.originalToolAuthentication),toolAuthentication:tool});
  validateHistoricalRuntimeCollection({verification:load(join(plan.historicalDirectory,'verification.json')),grant:load(join(plan.historicalDirectory,'installation-grant.json'))});
  assert(isDeepStrictEqual(await sourceBoundBuild({candidatePath,dir:directory,p:buildParams,jobs:snapshot.jobs}),build),'Canonical candidate inputs changed');
  const alpha=JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/git/ref/heads/alpha'],{encoding:'utf8'}));assert.equal(alpha.object.sha,refs.controller,'Held alpha changed');assert.equal(installHash(installJson(load(plan.experienceEvidence))),acceptance.experienceEvidenceSha256);return true;
 };
 await revalidate();save('verification.json',evidence);save('verification-timing.json',{elapsedMs:Date.now()-began,sharedImmutablePlans:plans.size,apiSnapshots:ids.length,releaseAuthorized:false});return {evidence,snapshot,revalidate};
}
