/** Versioned combined coverage for one exact erased fixture cast. Never rewrites a full gate. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual}from'node:util';
import {installHash,installJson}from'./ci-install-grant.mjs';
import {FIXTURE_PATH}from'./type-only-repair.mjs';
export function assessTypeRepairAcceptance({sourceProof,original,originalSnapshot,focused,focusedSnapshot}){
 const {proofSha256,...body}=sourceProof??{};
 assert(proofSha256===installHash(installJson(body))&&body.kind==='ERASED_FIXTURE_CAST_SOURCE_COMPATIBILITY_NOT_RELEASE'&&body.format===1&&body.releaseAuthorized===false&&body.otherTrackedInputsByteIdentical===true&&body.originalFailedCompilerPreserved===true&&body.fixture?.path===FIXTURE_PATH,'Exact independently recomputed source compatibility required');
 assert(original.kind==='AUTHENTICATED_ORIGINAL_UNIT_EVIDENCE_NOT_COMBINED_RELEASE'&&original.releaseAuthorized===false&&original.expected.candidate===body.original&&original.rerun.length===0,'All original runtime units must authenticate');
 const ids=original.reusable.map(u=>u.origin&&u.id).sort();assert(ids.length>0&&new Set(ids).size===ids.length&&isDeepStrictEqual(ids,[...original.completeRequiredUnits].sort()),'Complete unique original unit membership required');
 const run=originalSnapshot.run;assert(run.id===original.expected.runId&&run.conclusion==='failure'&&run.status==='completed'&&run.run_attempt===1,'Original failure must be retained');
 const failed=originalSnapshot.jobs.filter(j=>j.conclusion!=='success'&&j.conclusion!=='skipped').map(j=>j.name).sort();assert(isDeepStrictEqual(failed,['typecheck','verify']),'Only original compiler and final verifier may fail');
 assert(originalSnapshot.jobs.filter(j=>j.conclusion==='skipped').every(j=>j.name==='runner-diagnostics'),'No required original check may be skipped');
 for(const name of ['controller-tests','migrations','build'])assert(originalSnapshot.jobs.filter(j=>j.name===name&&j.conclusion==='success').length===1,'Original prerequisite missing: '+name);
 assert(focused.kind==='AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE'&&focused.origin.candidate===body.compilerCandidate&&focused.origin.controller===original.expected.controller&&focused.origin.baseline===original.expected.baseline&&focused.failedFiles===0&&focused.originalFocusedExitCode===0,'Matching fresh repair evidence required');
 const fr=focusedSnapshot.run;assert(fr.id===focused.origin.runId&&fr.status==='completed'&&fr.conclusion==='success'&&fr.run_attempt===1,'Replacement run must genuinely pass');
 const compiler=focusedSnapshot.jobs.filter(j=>j.name==='typecheck');assert(compiler.length===1&&compiler[0].conclusion==='success'&&compiler[0].status==='completed'&&compiler[0].steps?.some(s=>s.name==='Run bash ../automation/.github/ci/typecheck.sh'&&s.conclusion==='success'),'Actual whole compiler step must pass');
 const repaired=focused.files.filter(f=>f.state==='PASSED').map(f=>f.path).sort();assert(isDeepStrictEqual(repaired,[FIXTURE_PATH]),'Actual affected fixture must be independently retested');
 const result={format:1,kind:'COMBINED_REQUIRED_COVERAGE_WITH_ERASED_FIXTURE_REPAIR',policy:'type-only-test-fixture-repair/v1',result:'ACCEPTED_WITH_AUTHENTICATED_ORIGINAL_PASSES',candidate:body.candidate,originalCandidate:body.original,originalRunId:run.id,originalRunConclusion:'failure',originalCompilerConclusion:'failure',originalFinalVerifierConclusion:'failure',originalFingerprint:original.fingerprint,retainedUnits:original.reusable,repairRunId:fr.id,wholeCompiler:{runId:fr.id,jobId:compiler[0].id,conclusion:'success'},sourceProofSha256:proofSha256,fixtureRetested:FIXTURE_PATH,requiresNewExactCandidateSystemTestingBuild:true,requiresFreshStagingBaselineAndLedger:true,requiresSourceBuildHealthArrivalAndOwnedCleanup:true,fullGatePassCreated:false,releaseAuthorized:false};return {...result,acceptanceSha256:installHash(installJson(result))};
}
