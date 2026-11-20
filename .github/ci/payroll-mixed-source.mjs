import assert from 'node:assert/strict';
import {validateMissingUnitRequest,validateMissingOriginalUnit} from './repair-missing-unit-policy.mjs';

export const MIXED=Object.freeze({
 branch:'codex/payroll-mixed-recovery-controller-20261120',
 candidateBranch:'codex/payroll-transaction-view-release-20261120',
 source:'bee0a72b0cb2f14710d7b9f6897703074dfc3a58',
 originalRun:44653948000,
 interruptedJob:136023820286,
 unit:'db-cc251cbe6920741e',
 baseline:'d6bfd00891e4db5d25d5f0027d0b14b0383ef6fd',
 expectedSource:'ebbb66ba9c34e8453e7a6eb2ee47b0f751900e4a',
 expectedRun:44592409673,
 interruptedRecoveryRun:44660932367,
 interruptedRecoveryController:'5dea33e2df8e84ee6685ec0d8f44b2ed6d7604b0',
 interruptedRecoveryJob:136039577928,
 failedFocusedRun:44659230701,
 failedFocusedJob:136033266140,
 failedFocusedArtifact:14595420727,
 failedFocusedDigest:'sha256:4f35bdbcf389960abe0242d65c73f62ba03f4e20af62cd83dcdf62fa4c9a81c9',
 refusedUnitRun:44659735445,
 refusedController:'f0186f2a370bfbe3de8204e193f170853b557102',
});
export function validateMixedHostedRequest(env,event){
 const i=event?.inputs,ref='refs/heads/'+MIXED.branch;
 assert(env.GITHUB_ACTIONS==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.GITHUB_JOB==='resolve'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_RUN_ATTEMPT==='1','First manual hosted execution required');
 assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856'&&event.repository?.id===1333414856&&env.GITHUB_REF===ref&&env.GITHUB_SHA===env.AIHR_CI_CONTROL_HEAD,'Owned controller and canonical repository required');
 assert(i?.migration_base===MIXED.baseline&&i.build_only!=='true'&&i.build_only!==true,'Wrong baseline or unsupported build mode');
 if(String(i.controller_only)==='true'&&String(i.diagnostics_only)==='true'){
  assert(i.candidate_ref===MIXED.branch&&i.expected_sha===env.GITHUB_SHA&&!i.missing_unit&&!i.missing_original_run,'Exact controller-only controls required');return;
 }
 validateMissingUnitRequest(i,'workflow_dispatch');
 assert(i.candidate_ref===MIXED.candidateBranch&&i.expected_sha===MIXED.source&&i.missing_original_run===String(MIXED.originalRun)&&i.missing_unit===MIXED.unit,'Only the exact interrupted System Labels unit may run');
}
export function validateMixedOriginal(source,plan){
 assert(source.run.id===MIXED.originalRun&&source.run.conclusion==='failure'&&plan.sha===MIXED.source&&plan.controller===MIXED.baseline&&plan.migrationBase===MIXED.baseline,'Mixed recovery requires the exact original payroll run and source');
 const interrupted=source.jobs.find(job=>job.name===`test (${MIXED.unit})`);
 assert(interrupted?.id===MIXED.interruptedJob,'Wrong interrupted job');
 return validateMissingOriginalUnit({...source,plan,unitId:MIXED.unit});
}
