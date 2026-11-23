import assert from 'node:assert/strict';
import test from 'node:test';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {hash,buildUnits,requiredEvidence} from './manifest.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {POLICY,SOURCE,BASELINE,TEST_RUN,BUILD_RUN,BUILD_ID,BUILD_DIGEST,FAILURE_DIGEST,
 checkTestCoverage,requireReview,validatePayrollReplayGrant} from './payroll-replay-recovery-policy.mjs';

const verifier='c'.repeat(40);
const freshEvidence=()=>{
 const recovery={recoveryPolicy:POLICY,verificationController:verifier,
  verificationDiagnostic:{controller:verifier,runId:123},pendingReview:false,
  testRun:TEST_RUN,buildRun:BUILD_RUN,testUnits:102,assertions:55383,
  buildArchiveDigest:BUILD_DIGEST,failureArchiveDigest:FAILURE_DIGEST};
 return {policyVersion:CI_POLICY,recovery,fingerprint:hash(recovery),installationEligible:true,
  verificationController:verifier,sha:SOURCE,baseline:BASELINE,controller:BASELINE,controllerBranch:'main',
  runId:BUILD_RUN,build:{nextBuildId:BUILD_ID},artifacts:[{name:BUILD_ARTIFACT,id:14772602180,digest:BUILD_DIGEST}]};
};
test('requires the complete, independently reviewed verifier SHA',()=>{
 assert.doesNotThrow(()=>requireReview(verifier,verifier));
 for(const value of [null,verifier.slice(0,9),'d'.repeat(40)])assert.throws(()=>requireReview(verifier,value),/approval/);
});
test('only the reviewed staging certificate for the frozen test and build pair can authorize a grant',()=>{
 assert.doesNotThrow(()=>validatePayrollReplayGrant(freshEvidence(),{id:BUILD_RUN},verifier));
 assert.throws(()=>validatePayrollReplayGrant(freshEvidence(),{id:TEST_RUN},verifier),/evidence/);
 for(const change of [
  evidence=>{evidence.sha='f'.repeat(40);},
  evidence=>{evidence.controllerBranch='alpha';},
  evidence=>{evidence.installationEligible=false;},
  evidence=>{evidence.build.nextBuildId='foreign';},
  evidence=>{evidence.artifacts[0].digest=FAILURE_DIGEST;},
  evidence=>{evidence.recovery.testRun=BUILD_RUN;},
  evidence=>{evidence.recovery.pendingReview=true;},
  evidence=>{evidence.recovery.testUnits--;},
  evidence=>{evidence.recovery.assertions--;},
  evidence=>{evidence.recovery.verificationDiagnostic.controller='d'.repeat(40);},
 ]){
  const evidence=freshEvidence();
  change(evidence);
  evidence.fingerprint=hash(evidence.recovery);
  assert.throws(()=>validatePayrollReplayGrant(evidence,{id:BUILD_RUN},verifier),/evidence/);
 }
});

test('test accounting requires every unit and rejects a failure outside build and its dependent verifier',()=>{
 const db=Array.from({length:98*24},(_,index)=>'test/example-'+index+'.test.ts');
 const nodb=['test/no-database.test.ts'];
 const suite=[...db,...nodb];
 const plan={sha:SOURCE,controller:BASELINE,migrationBase:BASELINE,suite,units:buildUnits(suite,{db,nodb},['test/example.browser.test.tsx'])};
 const jobs=requiredEvidence(plan).jobs.map(name=>({name,conclusion:['build','verify'].includes(name)?'failure':'success'}));
 const reusable=plan.units.map((unit,index)=>({id:unit.id,tests:index===0?55282:1}));
 const assessment={sourceRun:{id:TEST_RUN,conclusion:'failure'},reusable,rerun:[]};
 assert.doesNotThrow(()=>checkTestCoverage({plan,jobs,assessment}));
 assert.throws(()=>checkTestCoverage({plan,jobs,assessment:{...assessment,reusable:reusable.slice(1)}}),/coverage/);
 const duplicate=[...reusable.slice(1),reusable[1]];
 assert.throws(()=>checkTestCoverage({plan,jobs,assessment:{...assessment,reusable:duplicate}}),/coverage/);
 jobs.find(job=>job.name==='typecheck').conclusion='failure';
 assert.throws(()=>checkTestCoverage({plan,jobs,assessment}),/Unsupported/);
});
