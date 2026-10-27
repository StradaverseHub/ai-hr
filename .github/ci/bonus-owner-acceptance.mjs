/** Complete current coverage plus sealed historical case origins; never a new full PASS baseline. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {installHash,installJson,validateInstallGrant} from './ci-install-grant.mjs';
export const BONUS_REFS=Object.freeze({base:'e07a86340d1ced979868bf4359d73597301d0f15',candidate:'d52563c666d39074217ed42191866add4a2793a0',controller:'dc74b804fcecb4bab3207e82c9b9f099b9bf13be',buildRunId:40508894540,baselineBuildId:'vMUJ2kG7uh_zZz4EO8LEb',historicalAuthorizationSha256:'f6b2cf4368065900ba2077afb7938467edece868aa35058a57bb6118c7fba202'});
const FILE='test/rewards-bonus-budget.dom.test.tsx';
const hashBody=(value,key)=>{const {[key]:hash,...body}=value??{};assert.equal(hash,installHash(installJson(body)),'Evidence body changed');return body;};
const passing=files=>Array.isArray(files)&&files.every(f=>f.state==='PASSED'&&f.failedAssertions===0&&Number.isSafeInteger(f.passingAssertions)&&f.passingAssertions>0);
export function validateHistoricalRuntimeCollection({verification,grant}){
 // This expired grant is only an immutable historical seal, never authority for a new action.
 validateInstallGrant(grant,{allowExpired:true});
 assert.equal(installHash(Buffer.from(installJson(grant)+'\n')),BONUS_REFS.historicalAuthorizationSha256,'Historical private installation authorization differs');
 assert(grant.source===BONUS_REFS.base&&grant.installId==='2d0b7770-4305-44f7-a27c-77ff90493df8'&&grant.runId===40475979249&&grant.build.nextBuildId===BONUS_REFS.baselineBuildId,'Wrong historical staging installation');
 const acceptance=verification?.acceptance,body=hashBody(acceptance,'acceptanceSha256');
 assert(body.kind==='COMBINED_REQUIRED_COVERAGE_WITH_OWNER_RUNTIME_EXCEPTION'&&body.candidate===BONUS_REFS.base&&body.result==='ACCEPTED_WITH_OWNER_EXCEPTION'&&body.fullGatePassCreated===false&&body.createsNewFullPassBaseline===false&&body.releaseAuthorized===false,'Historical exception is not a full gate baseline');
 assert(body.originalFailedRun?.runId===40444007805&&body.originalFailedRun.conclusion==='failure','Preserve original full gate failure');
 assert(body.ordinaryFiles.length===2037&&new Set(body.ordinaryFiles.map(f=>f.path)).size===2037&&passing(body.ordinaryFiles),'Complete authentic historical ordinary cases required');
 assert(body.browserFiles.length===57&&new Set(body.browserFiles.map(f=>f.engine+'\0'+f.path)).size===57&&passing(body.browserFiles),'Complete authentic historical browser cases required');
 assert(verification.sha===BONUS_REFS.base&&verification.controller===BONUS_REFS.controller&&verification.runId===grant.runId&&isDeepStrictEqual(verification.artifact,grant.artifact),'Historical canonical origin differs');
 const witness=installHash(installJson({kind:'RUNTIME_OWNER_EXCEPTION_AND_CANONICAL_BUILD_INSTALL',acceptanceSha256:acceptance.acceptanceSha256,sourceProofSha256:body.sourceProofSha256,runId:grant.runId,controller:BONUS_REFS.controller,source:BONUS_REFS.base,artifact:grant.artifact,buildProvenanceSha256:verification.build.provenanceSha256}));
 assert.equal(witness,grant.witnessFingerprint,'Historical acceptance does not match the actual sealed installation');
 return {kind:'AUTHENTICATED_SEALED_HISTORICAL_CASE_COLLECTION_NOT_NEW_BASELINE',candidate:BONUS_REFS.base,authorizationSha256:BONUS_REFS.historicalAuthorizationSha256,acceptanceSha256:acceptance.acceptanceSha256,ordinaryFiles:body.ordinaryFiles,browserFiles:body.browserFiles,originalFailedRun:body.originalFailedRun,originalRepairFailure:body.originalRepairFailure,originalBrowserFailure:body.originalBrowserFailure,releaseAuthorized:false};
}
export function assessBonusOwnerCoverage({historical,source,continuity,wave,positive,browser,compiler,experience}){
 assert(historical?.kind==='AUTHENTICATED_SEALED_HISTORICAL_CASE_COLLECTION_NOT_NEW_BASELINE'&&historical.candidate===BONUS_REFS.base&&historical.authorizationSha256===BONUS_REFS.historicalAuthorizationSha256,'Authentic prior case collection required');
 assert(source.base===BONUS_REFS.base&&source.head===BONUS_REFS.candidate&&source.actualPolicy===3&&source.plan.policyVersion===3&&source.plan.tier==='impact'&&source.plan.risk==='moderate'&&source.plan.browser===true&&source.plan.run.length===1772,'Actual frozen policy3 scope must remain intact');
 assert(isDeepStrictEqual(source.changedFiles,['app/rewards/[unitId]/bonus-budget.tsx',FILE]),'Only exact reviewed display and regression fixture may change');
 const io=hashBody(continuity,'proofSha256');
 assert(io.kind==='ACTUAL_UNCHANGED_NON_SOURCE_IO_INPUT_CONTINUITY_NOT_RELEASE'&&io.base===BONUS_REFS.base&&io.candidate===BONUS_REFS.candidate&&io.actualImpactPolicy===3&&io.actualPlanSha256===installHash(installJson(source))&&io.actualPlanFingerprint===source.plan.fingerprint&&io.inputClosureVerified===true&&io.currentClassifierChanged===false&&io.unknownConsumersRetained===false&&io.browserCoverageRetained===false&&io.releaseAuthorized===false,'Actual bounded input continuity required, not a replacement classifier');
 const modules=['packs/performance/onehr/evidence-extraction.ts','test/profile.ts'],reasons=modules.map(p=>'source reading or uncertain module reach through '+p);
 assert(isDeepStrictEqual(io.pins.map(p=>p.path),modules)&&io.pins.every(p=>/^[a-f0-9]{40}$/.test(p.blob)&&p.unchangedBetweenActualCandidates===true&&p.sameAsActuallyTestedToolFixture===true),'Exact unchanged input owners required');
 const retained=source.plan.run.filter(path=>source.plan.selection[path]?.length&&source.plan.selection[path].every(reason=>reasons.includes(reason)));
 assert(retained.length===913&&isDeepStrictEqual(retained,io.retainedFiles)&&isDeepStrictEqual(source.plan.run.filter(f=>!retained.includes(f)),io.remainingRequiredFiles),'Never retain a genuine unknown consumer');
 assert(wave.length===26&&new Set(wave.map(a=>a.origin.runId)).size===26,'Complete actual consumer wave required');
 const current=new Map();
 for(const report of wave){assert(report.kind==='AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE'&&report.origin.candidate===BONUS_REFS.candidate&&report.failedFiles===0&&report.originalFocusedExitCode===0,'Required current consumer did not pass');for(const f of report.files){assert(!current.has(f.path)&&f.path!==FILE&&io.remainingRequiredFiles.includes(f.path)&&passing([f]),'Duplicate/foreign/failed consumer');current.set(f.path,{...f,origin:report.origin});}}
 assert.equal(current.size,858);
 assert(positive.kind==='AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE'&&positive.origin.runId===40507897305&&positive.origin.candidate===BONUS_REFS.candidate&&positive.failedFiles===0&&positive.originalFocusedExitCode===0&&positive.files.length===1&&positive.files[0].path===FILE&&positive.files[0].passingAssertions===5&&passing(positive.files),'Actual repaired money assertions required');current.set(FILE,{...positive.files[0],origin:positive.origin});
 const original=new Map(historical.ordinaryFiles.map(f=>[f.path,f]));assert(original.size===2037&&original.size===historical.ordinaryFiles.length&&passing(historical.ordinaryFiles));
 for(const [path,f] of current){assert(original.has(path)&&f.passingAssertions>=original.get(path).passingAssertions,'Fresh coverage cannot lose registered assertions');}
 for(const path of source.plan.run)assert(current.has(path)||retained.includes(path),'Missing affected consumer evidence');
 for(const [path,f] of original)if(!current.has(path)){assert(!source.plan.run.includes(path)||retained.includes(path),'Unproved historical carry');current.set(path,f);}
 assert.equal(current.size,2037);assert(passing([...current.values()]));
 assert(browser.kind==='AUTHENTICATED_FRESH_BONUS_BROWSER_FILE_OUTCOMES_NOT_RELEASE'&&browser.sourceBinding.candidate===BONUS_REFS.candidate&&browser.outcomes.length===3,'Fresh actual browser evidence required');
 const browserFiles=[];for(const engine of ['chromium','firefox','webkit']){const unit=browser.outcomes.find(o=>o.engine===engine);assert(unit?.passingFiles===19&&unit.failedFiles===0&&unit.originalUnitExitCode===0&&unit.files.length===19&&passing(unit.files)&&new Set(unit.files.map(f=>f.path)).size===19,'Complete three-engine browser cases required');for(const f of unit.files){const before=historical.browserFiles.find(o=>o.path===f.path&&o.engine===engine);assert(before&&f.passingAssertions>=before.passingAssertions,'Browser coverage lost cases');browserFiles.push({...f,origin:unit.origin});}}
 assert(compiler?.candidate===BONUS_REFS.candidate&&compiler.runId===40507897305&&compiler.conclusion==='success','Exact final whole compiler required');
 assert(experience?.allItemsAccepted===false&&experience.items?.length===8&&experience.verificationAdjustment?.sourceCandidate===BONUS_REFS.candidate,'Frozen eight-item current-source reconciliation required');
 const body={format:1,kind:'COMBINED_REQUIRED_BONUS_COVERAGE_WITH_OWNER_EXCEPTION',policy:'runtime-owner-exception/v1',result:'ACCEPTED_WITH_OWNER_EXCEPTION',candidate:BONUS_REFS.candidate,stagingBaseline:BONUS_REFS.base,historicalAuthorizationSha256:historical.authorizationSha256,historicalAcceptanceSha256:historical.acceptanceSha256,actualImpact:source,ioContinuitySha256:continuity.proofSha256,ordinaryFiles:[...current.values()].sort((a,b)=>a.path.localeCompare(b.path)),browserFiles,wholeCompiler:compiler,originalFailedRun:historical.originalFailedRun,originalRepairFailure:historical.originalRepairFailure,originalBrowserFailure:historical.originalBrowserFailure,experienceEvidenceSha256:installHash(installJson(experience)),postDeployAcceptanceRequired:true,fullGatePassCreated:false,createsNewFullPassBaseline:false,releaseAuthorized:false};return {...body,acceptanceSha256:installHash(installJson(body))};
}
