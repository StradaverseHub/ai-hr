/** A distinct owner-exception grant; never impersonates a type-only repair or full gate PASS. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {installHash,installJson,INSTALL_BUILD_FIELDS,validateInstallGrant} from './ci-install-grant.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {inspectRuntimeRepairBuildOnlySnapshot} from './build-only-evidence.mjs';
import {RUNTIME_REPAIR as refs} from './runtime-repair-source.mjs';
export function createRuntimeInstallGrant({acceptance,evidence,snapshot,baselineBuildId,environmentSha256,now=Date.now()}){
 const {acceptanceSha256,...body}=acceptance??{};
 assert(acceptanceSha256===installHash(installJson(body))&&body.kind==='COMBINED_REQUIRED_COVERAGE_WITH_OWNER_RUNTIME_EXCEPTION'
  &&body.policy==='runtime-owner-exception/v1'&&body.result==='ACCEPTED_WITH_OWNER_EXCEPTION'&&body.candidate===refs.candidate
  &&body.fullGatePassCreated===false&&body.createsNewFullPassBaseline===false&&body.releaseAuthorized===false
  &&/^[a-f0-9]{64}$/.test(body.sourceProofSha256??'')&&body.originalFailedRun?.runId===40444007805&&body.originalFailedRun.conclusion==='failure'
  &&body.actualImpact?.base===refs.staging&&body.actualImpact.head===refs.candidate
  &&body.actualImpact?.plan.tier==='full'&&body.actualImpact.plan.risk==='unknown'&&body.actualImpact.plan.reasons.length===2
  &&body.wholeCompiler?.runId===40475176478&&body.wholeCompiler.conclusion==='success'&&body.postDeployAcceptanceRequired===true,'Complete explicit runtime owner-exception acceptance required');
 assert(body.ordinaryFiles?.length===2037&&new Set(body.ordinaryFiles.map(f=>f.path)).size===2037&&body.ordinaryFiles.every(f=>f.state==='PASSED'&&f.failedAssertions===0&&f.passingAssertions>0),'Complete ordinary file coverage required');
 assert(body.browserFiles?.length===57&&new Set(body.browserFiles.map(f=>f.engine+'\0'+f.path)).size===57&&body.browserFiles.every(f=>f.state==='PASSED'&&f.failedAssertions===0&&f.passingAssertions>0),'Complete three-engine browser coverage required');
 for(const engine of ['chromium','firefox','webkit'])assert(body.browserFiles.filter(f=>f.engine===engine).length===19,'Every actual browser engine requires nineteen files');
 assert(evidence.kind==='AUTHENTICATED_RUNTIME_OWNER_EXCEPTION_AND_CANONICAL_BUILD'&&evidence.sha===refs.candidate&&evidence.controller===refs.alpha&&evidence.controllerBranch==='alpha'
  &&evidence.baseline===refs.ciBaseline&&evidence.deploymentBaseline===refs.staging&&evidence.build?.canonicalCandidateInputsVerified===true
  &&evidence.build.source===refs.candidate&&evidence.build.controller===refs.alpha&&evidence.build.runId===evidence.runId,'Exact reviewed fresh runtime build required');
 const {proofSha256,...boundary}=evidence.baselineAdvance??{};
 assert(proofSha256===installHash(installJson(boundary))&&boundary.kind==='FORWARD_STAGING_BASELINE_SOURCE_PREFIX_NOT_CI_RECEIPT'
  &&boundary.candidate===refs.candidate&&boundary.ciBaseline===refs.ciBaseline&&boundary.deploymentBaseline===refs.staging
  &&boundary.deploymentMigrationCount===503&&boundary.candidateMigrationCount===503&&boundary.originalCiBaselinePreserved===true&&boundary.releaseAuthorized===false,'Fresh exact unchanged 503-row staging migration prefix required');
 const inventory=inspectRuntimeRepairBuildOnlySnapshot({...snapshot,expected:{candidate:refs.candidate,controller:refs.alpha,runId:evidence.runId},now});
 assert(evidence.artifact.id===inventory.artifact.id&&evidence.artifact.digest===inventory.artifact.digest,'Canonical artifact origin changed');
 const run=snapshot.run,producer=inventory.producer;
 const witnessFingerprint=installHash(installJson({kind:'RUNTIME_OWNER_EXCEPTION_AND_CANONICAL_BUILD_INSTALL',acceptanceSha256,
  sourceProofSha256:body.sourceProofSha256,runId:run.id,controller:refs.alpha,source:refs.candidate,artifact:evidence.artifact,buildProvenanceSha256:evidence.build.provenanceSha256}));
 return validateInstallGrant({format:1,kind:'OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL',policyVersion:CI_POLICY,target:'alpha-staging',installId:randomUUID(),
  source:refs.candidate,controller:refs.alpha,controllerBranch:'alpha',baseline:refs.staging,baselineBuildId,environmentSha256,
  runId:run.id,runAttempt:1,runCreatedAt:run.created_at,issuedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+30*60000,Date.parse(run.created_at)+86400000)).toISOString(),
  producerStartedAt:producer.started_at,producerCompletedAt:producer.completed_at,witnessFingerprint,artifact:evidence.artifact,
  build:Object.fromEntries(INSTALL_BUILD_FIELDS.map(k=>[k,evidence.build[k]]))},{now});
}
