/** Complete file coverage under the owner's explicit failed-only retest exception, never a full PASS. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {installHash,installJson} from './ci-install-grant.mjs';
import {RUNTIME_REPAIR as refs} from './runtime-repair-source.mjs';
const FILE='test/atelier-mobile-navigation.browser.test.tsx',BACKEND='test/r396-theme-switch.test.ts';
export function assessRuntimeOwnerCoverage({sourceProof,plan,original,originalSnapshot,originalFiles,wave,letter,backendRepair,browserOriginal,browserRepair,compiler,experience}){
 const {proofSha256,...boundary}=sourceProof??{};
 assert(proofSha256===installHash(installJson(boundary))&&boundary.kind==='EXACT_BOARD_RUNTIME_REPAIR_SOURCE_NOT_RELEASE'
  &&boundary.candidate===refs.candidate&&boundary.fixtureOnlyAfterWave===true&&boundary.unchangedSharedInputs===true
  &&boundary.originalFailedCompilerPreserved===true&&boundary.releaseAuthorized===false&&boundary.fullGatePassCreated===false,'Actual reviewed runtime source proof required');
 assert(plan.sha===refs.candidate&&plan.migrationBase===refs.ciBaseline&&plan.suite.length===2037&&new Set(plan.suite).size===2037,'Exact final ordinary inventory required');
 const impact=boundary.impacts.find(i=>i.base===refs.staging),letterImpact=boundary.impacts.find(i=>i.base===refs.letter);
 assert(impact?.head===refs.candidate&&letterImpact?.head===refs.candidate&&impact.plan.tier==='full'&&impact.plan.risk==='unknown'
  &&impact.plan.reasons.length===2&&letterImpact.plan.tier==='full'&&letterImpact.plan.risk==='unknown','Keep actual final policy3 FULL/UNKNOWN reasons');
 assert(original.kind==='AUTHENTICATED_ORIGINAL_UNIT_EVIDENCE_NOT_COMBINED_RELEASE'&&original.expected.runId===40444007805&&original.expected.candidate===refs.original
  &&original.rerun.length===0&&original.reusable.length===original.completeRequiredUnits.length,'Complete authenticated original runtime coverage required');
 assert(originalSnapshot.run.id===40444007805&&originalSnapshot.run.conclusion==='failure','Original failed full attempt must remain failed');
 assert(isDeepStrictEqual(originalSnapshot.jobs.filter(j=>!['success','skipped'].includes(j.conclusion)).map(j=>j.name).sort(),['typecheck','verify']),'Unexpected original prerequisite failure');
 for(const name of ['controller-tests','migrations','build'])assert(originalSnapshot.jobs.filter(j=>j.name===name&&j.conclusion==='success').length===1,'Original prerequisite missing: '+name);
 const originalMap=new Map(originalFiles.map(f=>[f.path,f]));assert(originalMap.size===2037&&originalMap.size===originalFiles.length&&originalFiles.every(f=>f.state==='PASSED'&&plan.suite.includes(f.path)),'Complete original per-file membership required');
 assert(wave.length===29&&new Set(wave.map(a=>a.origin.runId)).size===29,'Complete original repair wave required');
 const current=new Map(),failures=[];
 for(const a of wave){assert(a.kind==='AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE'&&a.origin.candidate===refs.wave&&a.origin.baseline===refs.ciBaseline,'Foreign original repair wave');
  for(const f of a.files){assert(plan.suite.includes(f.path)&&!current.has(f.path),'Duplicate/foreign wave file');current.set(f.path,{...f,origin:a.origin});if(f.state!=='PASSED')failures.push({path:f.path,origin:a.origin});}}
 assert(current.size===1772&&isDeepStrictEqual(failures.map(f=>f.path),[BACKEND]),'Original wave has unexpected coverage or failures');
 assert(letter.origin.runId===40464427366&&letter.origin.candidate===refs.letter&&letter.failedFiles===0&&letter.originalFocusedExitCode===0,'Actual initial letter repair coverage required');
 const carry=letter.files.filter(f=>!letterImpact.plan.run.includes(f.path));assert(carry.length===8,'Exact eight unaffected letter files required');
 for(const f of carry){assert(f.state==='PASSED'&&!current.has(f.path),'Invalid letter carry-forward');current.set(f.path,{...f,origin:letter.origin});}
 assert(backendRepair.origin.runId===40473934442&&backendRepair.origin.candidate===refs.backendRepair&&backendRepair.failedFiles===0&&backendRepair.originalFocusedExitCode===0
  &&backendRepair.files.length===1&&backendRepair.files[0].path===BACKEND&&backendRepair.files[0].state==='PASSED','Actual failed backend file repair required');
 current.set(BACKEND,{...backendRepair.files[0],origin:backendRepair.origin});
 assert(impact.plan.run.every(f=>current.get(f)?.state==='PASSED'),'Affected ordinary file lacks valid repair-wave evidence');
 const unchanged=plan.suite.filter(f=>!current.has(f));assert(unchanged.length===257&&unchanged.every(f=>!impact.plan.run.includes(f)),'Only genuinely unaffected original files may be carried');
 for(const path of unchanged)current.set(path,originalMap.get(path));
 assert(current.size===2037&&[...current.values()].every(f=>f.state==='PASSED'&&f.failedAssertions===0&&f.passingAssertions>0),'Every required ordinary file must pass');
 assert(browserOriginal.kind==='AUTHENTICATED_ORIGINAL_BROWSER_FILE_OUTCOMES_NOT_RELEASE'&&browserOriginal.sourceBinding.candidate===refs.wave&&browserOriginal.outcomes.length===3,'Actual original browser partial evidence required');
 assert(browserRepair.kind==='AUTHENTICATED_FOCUSED_BROWSER_REPAIR_NOT_RELEASE'&&browserRepair.sourceBinding.candidate===refs.candidate&&browserRepair.outcomes.length===3,'Actual final browser repair evidence required');
 const browser=[];
 for(const engine of ['chromium','firefox','webkit']){
  const unit=plan.units.find(u=>u.kind==='browser'&&u.engine===engine),old=browserOriginal.outcomes.find(o=>o.engine===engine),repair=browserRepair.outcomes.find(o=>o.engine===engine);
  assert(unit?.files.length===19&&old?.originalUnitExitCode===1&&old.passingFiles===18&&old.failedFiles===1
   &&isDeepStrictEqual(old.files.filter(f=>f.state==='FAILED').map(f=>f.path),[FILE]),'Original browser failure or complete membership differs');
  assert(repair?.path===FILE&&repair.state==='PASSED'&&repair.passingAssertions===5&&repair.failedAssertions===0&&repair.originCandidate===refs.candidate,'Actual failed browser file repair required');
  const rows=[...old.files.filter(f=>f.state==='PASSED').map(f=>({...f,origin:old.origin})),repair];
  assert(isDeepStrictEqual(rows.map(f=>f.path).sort(),[...unit.files].sort()),'Browser engine omitted required files');browser.push(...rows);
 }
 assert(compiler.kind==='AUTHENTICATED_WHOLE_COMPILER_ONLY_NOT_TEST_COVERAGE'&&compiler.candidate===refs.candidate&&compiler.runId===40475176478&&compiler.conclusion==='success','Fresh final whole compiler required');
 assert(experience&&experience.allItemsAccepted===false&&Array.isArray(experience.items)&&experience.items.length===8,'Original eight-item acceptance reconciliation required; final post-deployment acceptance remains separate');
 assert(experience.verificationAdjustment?.humanInstruction==='i dont have his access, can you run the test backend?'
  &&experience.verificationAdjustment.sourceCandidate===refs.candidate,'Explicit approved actor-access verification adjustment required');
 const body={format:1,kind:'COMBINED_REQUIRED_COVERAGE_WITH_OWNER_RUNTIME_EXCEPTION',policy:'runtime-owner-exception/v1',result:'ACCEPTED_WITH_OWNER_EXCEPTION',candidate:refs.candidate,
  sourceProofSha256:proofSha256,actualImpact:impact,letterCarryImpact:letterImpact,ordinaryFiles:[...current.values()].sort((a,b)=>a.path.localeCompare(b.path)),browserFiles:browser,
  originalFailedRun:{runId:40444007805,conclusion:'failure',failedJobs:['typecheck','verify']},originalRepairFailure:failures,
  originalBrowserFailure:browserOriginal.outcomes.map(o=>({engine:o.engine,unitExitCode:o.originalUnitExitCode,rawReportSha256:o.rawReportSha256})),
  wholeCompiler:{runId:compiler.runId,jobId:compiler.jobId,conclusion:'success',logSha256:compiler.logSha256},
  experienceEvidenceSha256:installHash(installJson(experience)),postDeployAcceptanceRequired:true,
  fullGatePassCreated:false,createsNewFullPassBaseline:false,releaseAuthorized:false};
 return {...body,acceptanceSha256:installHash(installJson(body))};
}
