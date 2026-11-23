// Staging-only recovery for the frozen payroll replay. Every execution keeps its original conclusion.
import assert from 'node:assert/strict';
import {hash,requiredEvidence} from './manifest.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';

export const POLICY='aihr-payroll-replay-build-recovery/v1';
export const SOURCE='a30caff9f5d2d881faa0b56f1d6d633ab124d19e';
export const BASELINE='b0c603e0eea4bc0963b8673c0a034fa4403cb835';
export const BRANCH='codex/payroll-unpaid-leave-replay-20261123';
export const TEST_RUN=45093269314;
export const BUILD_RUN=45068296428;
export const BUILD_ID='ro8_kDFgz764_D9K6Axpz';
export const BUILD_DIGEST='sha256:37106f9a66ebbd8e3720eca33c22b768b842a1d3c7e285cbb92f790a267f88f8';
export const FAILURE_DIGEST='sha256:04882c1dba77815a13fa2dca4942b99f95b61e3f7cccb6cd687d7fd44989a2fa';

export function requireReview(controller,reviewed){
 assert(/^[a-f0-9]{40}$/.test(controller)&&reviewed===controller,'Exact independent verifier approval required');
}

export function checkTestCoverage({plan,jobs,assessment}){
 const topology=requiredEvidence(plan);
 assert(plan.sha===SOURCE&&plan.controller===BASELINE&&plan.migrationBase===BASELINE,'Foreign test plan');
 assert(topology.jobs.every(name=>jobs.find(job=>job.name===name)?.conclusion===
  (['build','verify'].includes(name)?'failure':'success')),'Unsupported test-run failure');
 assert(assessment.sourceRun.id===TEST_RUN&&assessment.sourceRun.conclusion==='failure'&&
  assessment.rerun.length===0&&assessment.reusable.length===102&&plan.units.length===102&&
  new Set(assessment.reusable.map(unit=>unit.id)).size===topology.units.length&&
  assessment.reusable.every(unit=>topology.units.includes(unit.id))&&
  assessment.reusable.reduce((total,unit)=>total+unit.tests,0)===55383,'Incomplete authenticated test coverage');
}

export function validatePayrollReplayGrant(evidence,run,reviewed=process.env.AIHR_PAYROLL_REPLAY_REVIEWED_CONTROLLER){
 const r=evidence.recovery;
 requireReview(evidence.verificationController,reviewed);
 assert(evidence.policyVersion===CI_POLICY&&evidence.installationEligible===true&&r?.recoveryPolicy===POLICY&&
  r.pendingReview===false&&evidence.fingerprint===hash(r)&&r.verificationController===reviewed&&
  r.verificationDiagnostic?.controller===reviewed&&Number.isSafeInteger(r.verificationDiagnostic?.runId)&&
  evidence.sha===SOURCE&&evidence.baseline===BASELINE&&evidence.controller===BASELINE&&evidence.controllerBranch==='main'&&
  evidence.runId===BUILD_RUN&&run.id===BUILD_RUN&&r.testRun===TEST_RUN&&r.buildRun===BUILD_RUN&&
  r.buildArchiveDigest===BUILD_DIGEST&&r.failureArchiveDigest===FAILURE_DIGEST&&
  r.testUnits===102&&r.assertions===55383&&evidence.build?.nextBuildId===BUILD_ID&&
  evidence.artifacts.filter(a=>a.name===BUILD_ARTIFACT&&a.id===14772602180&&a.digest===BUILD_DIGEST).length===1,
 'Exact staged recovery evidence required');
}
