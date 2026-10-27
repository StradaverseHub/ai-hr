/** Authenticate actual original/repair/compiler/build origins. No report SHA is rewritten. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {EMAIL,proveEmailController,proveEmailRepairSource,proveEmailCompilerSource} from './email-repair-source.mjs';
import {inspectEmailUnitFiles,assessEmailCoverage} from './email-repair-coverage.mjs';
import {immutablePlan} from './immutable-plan.mjs';
import {inspectRetainedInventory,githubSnapshotIdentity} from './retained-units.mjs';
import {fetchRunSnapshots} from './github-snapshot-batch.mjs';
import {inspectFocusedSnapshotArchive} from './focused-snapshot-reader.mjs';
import {inspectFocusedInventory} from './authenticated-focused.mjs';
import {inspectEmailCompilerSnapshot,inspectEmailCompilerReport} from './email-compiler-evidence.mjs';
import {inspectEmailRepairBuildOnlySnapshot} from './build-only-evidence.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {DB_BATCH_FILES} from './manifest.mjs';
import {sourceBoundBuild,cleanHead,controllerRoot} from './release-ci.mjs';
import {bindOriginalController} from './ci-origin-binding.mjs';
import {forwardBaselineSource} from './forward-baseline.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
const runtime={node:'22.23.3',platform:'linux',arch:'x64'};
const read=path=>JSON.parse(readFileSync(path,'utf8'));
function controls(snapshot,verifier){
 const {run,jobs}=snapshot;assert(run?.repository?.id===1333414856&&run.repository.full_name==='StradaverseHub/ai-hr'&&run.head_repository?.id===1333414856&&run.head_sha===verifier&&run.head_branch==='codex/email-release-admission-20261027'&&run.path==='.github/workflows/alpha-staging.yml'&&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Actual frozen email admission controls required');
 assert(jobs.length===3&&new Set(jobs.map(j=>j.name)).size===3,'Complete control inventory required');
 for(const j of jobs)assert(j.run_id===run.id&&j.run_attempt===1&&j.head_sha===verifier&&j.head_branch===run.head_branch&&j.status==='completed'&&(j.name==='verifier-controls'?j.conclusion==='success':['typecheck','bonus-negative'].includes(j.name)&&j.conclusion==='skipped'),'Unexpected controls execution');
 const job=jobs.find(j=>j.name==='verifier-controls');for(const name of ['Email install grant and native protocol refusal controls','Import email operator without executing native actions'])assert(job.steps.some(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success'),'Missing actual control execution: '+name);
}
export async function verifyEmailRepairCi({candidatePath,deploymentBaseline,plan}){
 assert.equal(cleanHead(candidatePath),EMAIL.candidate);assert.equal(deploymentBaseline,EMAIL.bonus,'Wait for verified Board arrival/handoff');
 assert(plan&&Number.isSafeInteger(plan.controlRunId)&&plan.controlRunId>0&&/^[a-f0-9]{40}$/.test(plan.expectedAlpha??''),'Actual frozen control run and current canonical identity required');
 const verifier=cleanHead(controllerRoot),verifierBinding=bindOriginalController({repository:controllerRoot,verifier,controller:EMAIL.controller});
 bindOriginalController({repository:controllerRoot,verifier,controller:EMAIL.compilerController});
 bindOriginalController({repository:controllerRoot,verifier,controller:EMAIL.buildController});
 const controllerProof=proveEmailController({repository:candidatePath}),sourceProof=proveEmailRepairSource({repository:candidatePath});proveEmailCompilerSource({repository:candidatePath});
 const directory=join(controllerRoot,'scratchpad','validated-email-'+EMAIL.buildRun+'-'+randomUUID());mkdirSync(directory,{mode:0o700});
 const save=(name,data)=>writeFileSync(join(directory,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 const expected={candidate:EMAIL.original,controller:EMAIL.controller,baseline:EMAIL.ciBaseline,runId:EMAIL.fullRun,reviewedControllerProof:controllerProof};
 const originalPlan=immutablePlan({repository:candidatePath,...expected,runtime}).plan,candidatePlan=immutablePlan({repository:candidatePath,candidate:EMAIL.candidate,controller:EMAIL.controller,baseline:EMAIL.ciBaseline,runtime}).plan;
 const ids=[EMAIL.fullRun,EMAIL.repairRun,EMAIL.compilerRun,EMAIL.buildRun,plan.controlRunId];assert.equal(new Set(ids).size,ids.length);
 const before=await fetchRunSnapshots(ids);controls(before.get(plan.controlRunId),verifier);save('first-api-snapshots.json',Object.fromEntries(before));save('source-proof.json',sourceProof);save('controller-proof.json',controllerProof);save('source-plans.json',{originalPlan,candidatePlan});
 const original=before.get(EMAIL.fullRun),inventory=inspectRetainedInventory({plan:originalPlan,expected,...original}),originalDir=join(directory,'original');mkdirSync(originalDir,{mode:0o700});
 const extract=(artifact,dir,binary=false)=>{const archive=join(dir,artifact.name+'.zip');readCiArchive(artifact,archive);const target=join(dir,artifact.name);execFileSync('python3',[fileURLToPath(new URL(binary?'./build-transport-extract.py':'./extract-artifact.py',import.meta.url)),archive,target,...(binary?[artifact.digest.slice(7)]:[])],{timeout:60000,stdio:'pipe'});return target;};
 save('original-downloads.json',await downloadCiArchives(inventory.selected,originalDir,{prefetchDirectory:plan.originalPrefetchDirectory}));
 const parsed=new Map(inventory.selected.map(a=>[a.name,extract(a,originalDir)]));assert.deepEqual(read(join(parsed.get('gate-plan'),'ci-plan.json')),originalPlan,'Archived full plan must match immutable source');
 const units=originalPlan.units.map(unit=>{const a=inventory.selected.find(a=>a.name==='unit-'+unit.id);assert(a,'Missing actual unit archive');const dir=parsed.get(a.name),report=read(join(dir,'unit-'+unit.id+'.json'));
  const checked=inspectEmailUnitFiles(originalPlan,report),job=inventory.byName.get(unit.kind==='browser'?'browser ('+unit.engine+')':'test ('+unit.id+')');
  for(let n=0;n<report.batches.length;n++){const offset=unit.kind==='db'?n*DB_BATCH_FILES:0;assert.deepEqual(read(join(dir,unit.id+'-batch-'+offset+'.json')),report.batches[n].result,'Raw original batch differs from unit report');}
  assert.deepEqual(read(join(dir,'health-before-'+unit.id+'.json')),report.healthBefore,'Original runner health differs');
  const origin={runId:EMAIL.fullRun,attempt:1,candidate:EMAIL.original,controller:EMAIL.controller,jobId:job.id,jobConclusion:job.conclusion,artifactId:a.id,digest:a.digest,reportHash:checked.rawReportSha256};return {...checked,files:checked.files.map(f=>({...f,origin}))};
 });
 const repairSnapshot=before.get(EMAIL.repairRun),repairExpected={candidate:EMAIL.candidate,controller:EMAIL.controller,baseline:EMAIL.ciBaseline,runId:EMAIL.repairRun,controllerBranch:EMAIL.controllerBranch,reviewedControllerProof:controllerProof},repairOrigin=inspectFocusedInventory({expected:repairExpected,...repairSnapshot}),repairDir=join(directory,'repair');mkdirSync(repairDir,{mode:0o700});
 save('repair-downloads.json',await downloadCiArchives([repairOrigin.artifact],repairDir,{prefetchDirectory:plan.repairPrefetchDirectory}));
 const repair=await inspectFocusedSnapshotArchive({repository:candidatePath,expected:repairExpected,snapshot:repairSnapshot,reconstructed:{plan:candidatePlan,binding:{candidate:EMAIL.candidate,controller:EMAIL.controller,baseline:EMAIL.ciBaseline,source:'IMMUTABLE_GIT_BLOBS'}},archivePath:join(repairDir,repairOrigin.artifact.name+'.zip'),directory:join(repairDir,'authenticated')});
 const compilerSnapshot=before.get(EMAIL.compilerRun),compilerOrigin=inspectEmailCompilerSnapshot(compilerSnapshot),compilerDir=join(directory,'compiler');mkdirSync(compilerDir,{mode:0o700});save('compiler-downloads.json',await downloadCiArchives([compilerOrigin.artifact],compilerDir));const compilerFiles=extract(compilerOrigin.artifact,compilerDir);assert.deepEqual(readdirSync(compilerFiles).sort(),['compiler-log.json','compiler-result.json']);
 const compiler=inspectEmailCompilerReport({snapshot:compilerSnapshot,report:read(join(compilerFiles,'compiler-result.json')),log:read(join(compilerFiles,'compiler-log.json'))});
 const acceptance=assessEmailCoverage({sourceProof,originalPlan,candidatePlan,originalSnapshot:original,units,repair,compiler});save('combined-coverage.json',acceptance);
 const snapshot=before.get(EMAIL.buildRun),buildExpected={candidate:EMAIL.candidate,controller:EMAIL.buildController,runId:EMAIL.buildRun},buildOrigin=inspectEmailRepairBuildOnlySnapshot({...snapshot,expected:buildExpected});
 save('build-downloads.json',await downloadCiArchives([buildOrigin.artifact],directory,{prefetchDirectory:plan.buildPrefetchDirectory}));extract(buildOrigin.artifact,directory,true);save('run.json',snapshot.run);save('jobs.json',snapshot.jobs);save('artifacts.json',snapshot.artifacts);
 const buildParams={...buildExpected,baseline:EMAIL.ciBaseline,controllerBranch:'alpha'},build=await sourceBoundBuild({candidatePath,dir:directory,p:buildParams,jobs:snapshot.jobs}),baselineAdvance=forwardBaselineSource({repository:candidatePath,candidate:EMAIL.candidate,ciBaseline:EMAIL.ciBaseline,deploymentBaseline});
 const evidence={kind:'AUTHENTICATED_EMAIL_TEST_REPAIR_AND_CANONICAL_BUILD',tier:'ci-email-test-contract-repair-v1',result:'ACCEPTED_WITH_AUTHENTICATED_ORIGINAL_PASSES',sha:EMAIL.candidate,controller:EMAIL.buildController,controllerBranch:'alpha',runId:EMAIL.buildRun,baseline:EMAIL.ciBaseline,deploymentBaseline,baselineAdvance,verifierBinding,build,artifact:{id:buildOrigin.artifact.id,digest:buildOrigin.artifact.digest},acceptance,sourceProof,candidatePath,evidenceDirectory:directory,fullGatePassCreated:false,createsNewFullPassBaseline:false,releaseAuthorized:false};
 const revalidate=async()=>{assert.equal(cleanHead(candidatePath),EMAIL.candidate);assert.equal(cleanHead(controllerRoot),verifier);const after=await fetchRunSnapshots(ids);controls(after.get(plan.controlRunId),verifier);inspectRetainedInventory({plan:originalPlan,expected,...after.get(EMAIL.fullRun)});inspectFocusedInventory({expected:repairExpected,...after.get(EMAIL.repairRun)});inspectEmailCompilerSnapshot(after.get(EMAIL.compilerRun));inspectEmailRepairBuildOnlySnapshot({...after.get(EMAIL.buildRun),expected:buildExpected});for(const id of ids){assert(isDeepStrictEqual(githubSnapshotIdentity(before.get(id)),githubSnapshotIdentity(after.get(id)))&&isDeepStrictEqual(before.get(id).jobs,after.get(id).jobs),'Original API origin/steps changed: '+id);}assert.deepEqual(proveEmailRepairSource({repository:candidatePath}),sourceProof);assert.deepEqual(proveEmailController({repository:candidatePath}),controllerProof);assert.deepEqual(await sourceBoundBuild({candidatePath,dir:directory,p:buildParams,jobs:snapshot.jobs}),build);assert.deepEqual(forwardBaselineSource({repository:candidatePath,candidate:EMAIL.candidate,ciBaseline:EMAIL.ciBaseline,deploymentBaseline}),baselineAdvance);const alpha=JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/git/ref/heads/alpha'],{encoding:'utf8'}));assert.equal(alpha.object.sha,plan.expectedAlpha,'Held canonical source changed');return true;};
 await revalidate();save('verification.json',evidence);return {evidence,snapshot,revalidate};
}
