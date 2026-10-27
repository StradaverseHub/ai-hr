import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessRuntimeOwnerCoverage} from './runtime-owner-acceptance.mjs';
import {RUNTIME_REPAIR as refs} from './runtime-repair-source.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
const FILE='test/atelier-mobile-navigation.browser.test.tsx',BACKEND='test/r396-theme-switch.test.ts',LETTER='test/letter-workflow.test.ts';
function fixture(){
 const suite=[...Array.from({length:2035},(_,i)=>'test/file-'+i+'.test.ts'),BACKEND,LETTER],paths=[...suite.slice(0,1771),BACKEND];
 const pass=path=>({path,state:'PASSED',passingAssertions:1,failedAssertions:0,rawFileHash:'a'.repeat(64),originCandidate:refs.original});
 const impact={base:refs.staging,head:refs.candidate,plan:{tier:'full',risk:'unknown',reasons:['unknown CSS','unknown browser'],run:[...paths,LETTER]}};
 const letterImpact={base:refs.letter,head:refs.candidate,plan:{tier:'full',risk:'unknown',reasons:['unknown CSS','unknown browser'],run:paths}};
 const body={kind:'EXACT_BOARD_RUNTIME_REPAIR_SOURCE_NOT_RELEASE',candidate:refs.candidate,fixtureOnlyAfterWave:true,unchangedSharedInputs:true,originalFailedCompilerPreserved:true,releaseAuthorized:false,fullGatePassCreated:false,impacts:[impact,letterImpact]};
 const sourceProof={...body,proofSha256:installHash(installJson(body))};
 const wave=Array.from({length:29},(_,i)=>({kind:'AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE',origin:{runId:100+i,candidate:refs.wave,baseline:refs.ciBaseline},files:paths.slice(i*62,(i+1)*62).map(path=>path===BACKEND?{...pass(path),state:'FAILED',passingAssertions:0,failedAssertions:1}:pass(path))}));
 const browserPaths=[FILE,...Array.from({length:18},(_,i)=>'test/browser-'+i+'.browser.test.tsx')],engines=['chromium','firefox','webkit'];
 return {sourceProof,plan:{sha:refs.candidate,migrationBase:refs.ciBaseline,suite,units:engines.map(engine=>({kind:'browser',engine,files:browserPaths}))},
  original:{kind:'AUTHENTICATED_ORIGINAL_UNIT_EVIDENCE_NOT_COMBINED_RELEASE',expected:{runId:40444007805,candidate:refs.original},rerun:[],reusable:[{id:'unit'}],completeRequiredUnits:['unit']},
  originalSnapshot:{run:{id:40444007805,conclusion:'failure'},jobs:[...['typecheck','verify'].map(name=>({name,conclusion:'failure'})),...['controller-tests','migrations','build'].map(name=>({name,conclusion:'success'}))]},originalFiles:suite.map(pass),wave,
  letter:{origin:{runId:40464427366,candidate:refs.letter},failedFiles:0,originalFocusedExitCode:0,files:[LETTER,...suite.slice(1771,1778)].map(pass)},
  backendRepair:{origin:{runId:40473934442,candidate:refs.backendRepair},failedFiles:0,originalFocusedExitCode:0,files:[pass(BACKEND)]},
  browserOriginal:{kind:'AUTHENTICATED_ORIGINAL_BROWSER_FILE_OUTCOMES_NOT_RELEASE',sourceBinding:{candidate:refs.wave},outcomes:engines.map(engine=>({engine,originalUnitExitCode:1,passingFiles:18,failedFiles:1,rawReportSha256:'c'.repeat(64),files:browserPaths.map(path=>path===FILE?{...pass(path),state:'FAILED',failedAssertions:5}:pass(path))}))},
  browserRepair:{kind:'AUTHENTICATED_FOCUSED_BROWSER_REPAIR_NOT_RELEASE',sourceBinding:{candidate:refs.candidate},outcomes:engines.map(engine=>({...pass(FILE),engine,passingAssertions:5,originCandidate:refs.candidate}))},
  compiler:{kind:'AUTHENTICATED_WHOLE_COMPILER_ONLY_NOT_TEST_COVERAGE',candidate:refs.candidate,runId:40475176478,jobId:1,conclusion:'success',logSha256:'d'.repeat(64)},experience:{allItemsAccepted:false,items:Array.from({length:8},()=>({})),verificationAdjustment:{humanInstruction:'i dont have his access, can you run the test backend?',sourceCandidate:refs.candidate}}};
}
test('accepts complete scoped retained coverage while retaining UNKNOWN/FULL and failed origins',()=>{const r=assessRuntimeOwnerCoverage(fixture());assert.equal(r.ordinaryFiles.length,2037);assert.equal(r.browserFiles.length,57);assert.equal(r.result,'ACCEPTED_WITH_OWNER_EXCEPTION');assert.equal(r.originalFailedRun.conclusion,'failure');assert.equal(r.actualImpact.plan.risk,'unknown');assert.equal(r.fullGatePassCreated,false);assert.equal(r.createsNewFullPassBaseline,false);assert.equal(r.releaseAuthorized,false);});
for(const [name,change] of [
 ['forged source proof',f=>f.sourceProof.proofSha256='0'.repeat(64)],['foreign final source',f=>f.plan.sha=refs.wave],['missing original ordinary file',f=>f.originalFiles.pop()],
 ['original unresolved runtime unit',f=>f.original.rerun.push({})],['original migration failed',f=>f.originalSnapshot.jobs.find(j=>j.name==='migrations').conclusion='failure'],
 ['missing wave',f=>f.wave.pop()],['duplicate wave origin',f=>f.wave[1].origin.runId=f.wave[0].origin.runId],['missing affected file',f=>f.wave[0].files.pop()],
 ['unexpected genuine failure',f=>f.wave[0].files[0].state='FAILED'],['missing backend retest',f=>f.backendRepair.files=[]],['wrong backend repair source',f=>f.backendRepair.origin.candidate=refs.wave],
 ['failed backend retest',f=>f.backendRepair.failedFiles=1],['missing browser engine',f=>f.browserRepair.outcomes.pop()],['only four browser cases',f=>f.browserRepair.outcomes[0].passingAssertions=4],
 ['failed original browser unit relabelled green',f=>f.browserOriginal.outcomes[0].originalUnitExitCode=0],['missing original browser file',f=>f.browserOriginal.outcomes[0].files.pop()],
 ['stale compiler',f=>f.compiler.candidate=refs.backendRepair],['compiler failed',f=>f.compiler.conclusion='failure'],['premature final acceptance',f=>f.experience.allItemsAccepted=true]
])test('refuses '+name,()=>{const f=fixture();change(f);assert.throws(()=>assessRuntimeOwnerCoverage(f));});
