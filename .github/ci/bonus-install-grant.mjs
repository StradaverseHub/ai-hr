/** One exact Bonus forward installation; never a full-gate PASS or production authority. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {installHash,installJson,INSTALL_BUILD_FIELDS,validateInstallGrant} from './ci-install-grant.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {inspectBonusRepairBuildOnlySnapshot} from './build-only-evidence.mjs';
import {BONUS_REFS as refs} from './bonus-owner-acceptance.mjs';
const CI_BASELINE='2127b1a7ebd40e5b9ee7d010e72e75d4b1cb3e9f';
export const BONUS_BUILD_ID='zJFJQr19Y97mHtZqFaeb9';
export function createBonusInstallGrant({acceptance,evidence,snapshot,baselineBuildId,environmentSha256,now=Date.now()}){
 const {acceptanceSha256,...body}=acceptance??{};
 assert(acceptanceSha256===installHash(installJson(body))&&body.kind==='COMBINED_REQUIRED_BONUS_COVERAGE_WITH_OWNER_EXCEPTION'
  &&body.policy==='runtime-owner-exception/v1'&&body.result==='ACCEPTED_WITH_OWNER_EXCEPTION'&&body.candidate===refs.candidate&&body.stagingBaseline===refs.base
  &&body.historicalAuthorizationSha256===refs.historicalAuthorizationSha256&&/^[a-f0-9]{64}$/.test(body.historicalAcceptanceSha256??'')
  &&body.fullGatePassCreated===false&&body.createsNewFullPassBaseline===false&&body.releaseAuthorized===false&&body.postDeployAcceptanceRequired===true
  &&body.originalFailedRun?.runId===40444007805&&body.originalFailedRun.conclusion==='failure'
  &&/^[a-f0-9]{64}$/.test(body.ioContinuitySha256??'')&&/^[a-f0-9]{64}$/.test(body.experienceEvidenceSha256??''),'Complete explicit Bonus owner-exception acceptance required');
 const impact=body.actualImpact;
 assert(impact?.base===refs.base&&impact.head===refs.candidate&&impact.actualPolicy===3&&impact.plan?.policyVersion===3
  &&impact.plan.tier==='impact'&&impact.plan.risk==='moderate'&&impact.plan.browser===true&&impact.plan.run?.length===1772
  &&impact.plan.fingerprint==='c66e7f43f048a2a53c86205e31366d99bdd28214606a61d09d623638c51e7cc3'
  &&isDeepStrictEqual(impact.changedFiles,['app/rewards/[unitId]/bonus-budget.tsx','test/rewards-bonus-budget.dom.test.tsx']),'Actual unchanged policy3 source impact required');
 const passing=files=>Array.isArray(files)&&files.every(f=>f.state==='PASSED'&&f.failedAssertions===0&&Number.isSafeInteger(f.passingAssertions)&&f.passingAssertions>0);
 assert(body.ordinaryFiles?.length===2037&&new Set(body.ordinaryFiles.map(f=>f.path)).size===2037&&passing(body.ordinaryFiles),'Complete ordinary coverage required');
 const current=body.ordinaryFiles.filter(f=>f.originCandidate===refs.candidate);
 assert(current.length===859&&current.some(f=>f.path==='test/rewards-bonus-budget.dom.test.tsx'&&f.passingAssertions===5),'All current consumers and five literal money assertions required');
 assert(body.browserFiles?.length===57&&new Set(body.browserFiles.map(f=>f.engine+'\0'+f.path)).size===57&&passing(body.browserFiles)
  &&body.browserFiles.every(f=>f.originCandidate===refs.candidate),'Fresh complete browser cases required');
 const browserPaths=body.browserFiles.filter(f=>f.engine==='chromium').map(f=>f.path).sort();
 for(const engine of ['chromium','firefox','webkit'])assert(isDeepStrictEqual(body.browserFiles.filter(f=>f.engine===engine).map(f=>f.path).sort(),browserPaths)&&browserPaths.length===19,'Nineteen identical registered files in every engine required');
 const compiler=body.wholeCompiler;
 assert(compiler?.kind==='AUTHENTICATED_WHOLE_COMPILER_ONLY_NOT_TEST_COVERAGE'&&compiler.candidate===refs.candidate&&compiler.controller===refs.controller
  &&compiler.runId===40507897305&&compiler.conclusion==='success'&&isDeepStrictEqual(compiler.runtime,{node:'22.23.3',platform:'linux',arch:'x64'})
  &&/^[a-f0-9]{64}$/.test(compiler.logSha256??''),'Actual exact-source whole compiler required');
 assert(baselineBuildId===refs.baselineBuildId&&evidence.kind==='AUTHENTICATED_BONUS_OWNER_EXCEPTION_AND_CANONICAL_BUILD'
  &&evidence.sha===refs.candidate&&evidence.controller===refs.controller&&evidence.controllerBranch==='alpha'&&evidence.runId===refs.buildRunId
  &&evidence.baseline===CI_BASELINE&&evidence.deploymentBaseline===refs.base&&evidence.build?.canonicalCandidateInputsVerified===true
  &&evidence.build.source===refs.candidate&&evidence.build.controller===refs.controller&&evidence.build.runId===refs.buildRunId
  &&evidence.build.nextBuildId===BONUS_BUILD_ID,'Exact new Bonus build and actual installed baseline required');
 const {proofSha256,...boundary}=evidence.baselineAdvance??{};
 assert(proofSha256===installHash(installJson(boundary))&&boundary.kind==='FORWARD_STAGING_BASELINE_SOURCE_PREFIX_NOT_CI_RECEIPT'
  &&boundary.candidate===refs.candidate&&boundary.ciBaseline===CI_BASELINE&&boundary.deploymentBaseline===refs.base
  &&boundary.ciMigrationCount===498&&boundary.deploymentMigrationCount===503&&boundary.candidateMigrationCount===503
  &&boundary.originalCiBaselinePreserved===true&&boundary.requiresFreshActualLedgerAndBuildBinding===true
  &&boundary.requiresOriginalCIAuthentication===true&&boundary.releaseAuthorized===false,'Exact unchanged 503-entry migration boundary required');
 const inventory=inspectBonusRepairBuildOnlySnapshot({...snapshot,expected:{candidate:refs.candidate,controller:refs.controller,runId:refs.buildRunId},now});
 assert(evidence.artifact.id===inventory.artifact.id&&evidence.artifact.digest===inventory.artifact.digest,'Canonical build artifact origin changed');
 const run=snapshot.run,producer=inventory.producer;
 const witnessFingerprint=installHash(installJson({kind:'BONUS_OWNER_EXCEPTION_AND_CANONICAL_BUILD_INSTALL',acceptanceSha256,
  ioContinuitySha256:body.ioContinuitySha256,historicalAuthorizationSha256:body.historicalAuthorizationSha256,
  runId:run.id,controller:refs.controller,source:refs.candidate,artifact:evidence.artifact,buildProvenanceSha256:evidence.build.provenanceSha256}));
 return validateInstallGrant({format:1,kind:'OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL',policyVersion:CI_POLICY,target:'alpha-staging',installId:randomUUID(),
  source:refs.candidate,controller:refs.controller,controllerBranch:'alpha',baseline:refs.base,baselineBuildId,environmentSha256,
  runId:run.id,runAttempt:1,runCreatedAt:run.created_at,issuedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+30*60000,Date.parse(run.created_at)+86400000)).toISOString(),
  producerStartedAt:producer.started_at,producerCompletedAt:producer.completed_at,witnessFingerprint,artifact:evidence.artifact,
  build:Object.fromEntries(INSTALL_BUILD_FIELDS.map(k=>[k,evidence.build[k]]))},{now});
}
