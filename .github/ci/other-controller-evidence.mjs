import assert from 'node:assert/strict';
import {join} from 'node:path';import{fileURLToPath}from'node:url';import{execFileSync}from'node:child_process';import{readFileSync,mkdirSync}from'node:fs';import{randomUUID}from'node:crypto';import{isDeepStrictEqual}from'node:util';
import{fetchGitHubRunSnapshot,githubSnapshotIdentity}from'./retained-units.mjs';import{downloadCiArchives,readCiArchive}from'./archive-downloads.mjs';import{immutablePlan}from'./immutable-plan.mjs';import{inspectOtherControllerRun}from'./other-controller-run.mjs';
export async function authenticateDifferentCandidateRun({repository,runId,candidate,controller,outputParent}){
 const snapshot=fetchGitHubRunSnapshot(runId),matches=snapshot.artifacts.filter(a=>a.name==='gate-plan');assert(matches.length===1,'Additional run has no unique candidate plan');
 const artifact=matches[0];assert(artifact.size_in_bytes<=1048576,'Additional plan exceeds bound');const dir=join(outputParent,'other-controller-'+runId+'-'+randomUUID());mkdirSync(dir,{mode:0o700});
 await downloadCiArchives([artifact],dir);const zip=join(dir,'gate-plan.zip');readCiArchive(artifact,zip);const target=join(dir,'gate-plan');execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),zip,target],{timeout:10000,stdio:'pipe'});
 const archivedPlan=JSON.parse(readFileSync(join(target,'ci-plan.json')));assert(archivedPlan.sha!==candidate,'Additional verification exists for frozen candidate');
 const reconstructedPlan=immutablePlan({repository,candidate:archivedPlan.sha,controller,baseline:archivedPlan.migrationBase,runtime:archivedPlan.runtime}).plan;
 const proof=inspectOtherControllerRun({snapshot,artifact,archivedPlan,reconstructedPlan,candidate,controller});const current=fetchGitHubRunSnapshot(runId);assert(isDeepStrictEqual(githubSnapshotIdentity(current),githubSnapshotIdentity(snapshot)),'Additional run changed during authentication');
 return{proof,identity:githubSnapshotIdentity(current),evidenceDirectory:dir};
}
