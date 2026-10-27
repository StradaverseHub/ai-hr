import test from 'node:test';
import assert from 'node:assert/strict';
import {installHash,installJson} from './ci-install-grant.mjs';
import {EMAIL,EMAIL_REPAIRED_FILES} from './email-repair-source.mjs';
import {inspectEmailUnitFiles,assessEmailCoverage} from './email-repair-coverage.mjs';
function file(path,failed=false){return {name:'/home/runner/work/ai-hr/ai-hr/source/'+path,status:failed?'failed':'passed',assertionResults:[{status:failed?'failed':'passed'}]};}
function reportFixture(){const unit={id:'nodb-example',kind:'nodb',files:['test/example.test.ts'],pdfTools:false},plan={sha:EMAIL.original,controller:EMAIL.controller,fingerprint:'f'.repeat(64),units:[unit],execution:{}};
 const raw={testResults:[file(unit.files[0])],numPassedTests:1,numFailedTests:0,numTotalTests:1,numFailedTestSuites:0,success:true};
 const report={schemaVersion:1,sha:plan.sha,fingerprint:plan.fingerprint,id:unit.id,cwd:'/home/runner/work/ai-hr/ai-hr/source',files:unit.files,exitCode:0,batches:[{exitCode:0,result:raw}],healthBefore:{ok:true},healthAfter:{ok:true},pdfToolSetup:{kind:'NO_EXTERNAL_PDF_TOOLS_REQUIRED_FOR_COMPLETE_UNIT',unit:unit.id,candidate:plan.sha,controller:plan.controller,fingerprint:plan.fingerprint,pdfToolsRequired:false,releaseAuthorized:false,steps:[]}};
 return {plan,report};}
test('keeps complete actual per-file outcomes and refuses nonexecuted or inconsistent coverage',()=>{
 const {plan,report}=reportFixture();assert.equal(inspectEmailUnitFiles(plan,report).files[0].state,'PASSED');
 for(const change of [r=>r.batches[0].result.testResults[0].assertionResults[0].status='pending',r=>r.batches[0].result.numTotalTests=2,r=>r.exitCode=1,r=>r.error='controller failed',r=>r.files=[],r=>r.batches[0].result.testResults.push(r.batches[0].result.testResults[0])]){const r=structuredClone(report);change(r);assert.throws(()=>inspectEmailUnitFiles(plan,r));}
});
test('passing cases inside a failed batch remain file evidence, never a passing batch',()=>{
 const {plan,report}=reportFixture();report.exitCode=1;report.batches[0].exitCode=1;const raw=report.batches[0].result;raw.testResults=[file(plan.units[0].files[0],true)];Object.assign(raw,{numPassedTests:0,numFailedTests:1,numFailedTestSuites:1,success:false});
 const checked=inspectEmailUnitFiles(plan,report);assert.equal(checked.originalUnitExitCode,1);assert.equal(checked.files[0].state,'FAILED');
});
function coverageFixture(){
 const ordinary=[...EMAIL_REPAIRED_FILES,'test/unchanged.test.ts'];
 const units=[{id:'nodb-8bdb44999773d9ff',kind:'nodb',files:ordinary,pdfTools:false},...['chromium','firefox','webkit'].map(engine=>({id:'browser-'+engine,kind:'browser',engine,files:['test/page.browser.test.tsx']}))];
 const originalPlan={sha:EMAIL.original,controller:EMAIL.controller,migrationBase:EMAIL.ciBaseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'},execution:{},suite:ordinary,units};
 const candidatePlan={...originalPlan,sha:EMAIL.candidate};
 const source={kind:'EXACT_EMAIL_TEST_CONTRACT_REPAIR_NOT_RELEASE',original:EMAIL.original,candidate:EMAIL.candidate,applicationSqlAndJournalUnchanged:true,releaseAuthorized:false};
 const sourceProof={...source,proofSha256:installHash(installJson(source))};
 const rows=units.map(u=>({unit:u.id,kind:u.kind,originalUnitExitCode:u.kind==='nodb'?1:0,files:u.files.map(path=>({path,state:EMAIL_REPAIRED_FILES.includes(path)?'FAILED':'PASSED',failedAssertions:EMAIL_REPAIRED_FILES.includes(path)?1:0,passingAssertions:1,originCandidate:EMAIL.original,...(u.engine?{engine:u.engine}:{})}))}));
 const jobs=['resolve','plan','controller-tests','migrations','typecheck','build',...units.map(u=>u.kind==='browser'?'browser ('+u.engine+')':'test ('+u.id+')'),'test (db-c3c5226458939268)','verify'].map(name=>({name,conclusion:name.startsWith('test (')||name==='verify'?'failure':'success'}));
 const originalSnapshot={run:{id:EMAIL.fullRun,conclusion:'failure',head_sha:EMAIL.controller,head_branch:EMAIL.controllerBranch},jobs};
 const repair={kind:'AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE',origin:{runId:EMAIL.repairRun,candidate:EMAIL.candidate,controller:EMAIL.controller,baseline:EMAIL.ciBaseline},originalFocusedExitCode:0,failedFiles:0,files:EMAIL_REPAIRED_FILES.map(path=>({path,state:'PASSED',failedAssertions:0,passingAssertions:1}))};
 const compiler={kind:'AUTHENTICATED_EMAIL_REPAIR_WHOLE_COMPILER',candidate:EMAIL.candidate,conclusion:'success',runtime:originalPlan.runtime,reportSha256:'f'.repeat(64)};
 return {sourceProof,originalPlan,candidatePlan,originalSnapshot,units:rows,repair,compiler};
}
test('combines complete preserved coverage with only the exact repaired files without claiming full PASS',()=>{
 const r=assessEmailCoverage(coverageFixture());assert.equal(r.fullGatePassCreated,false);assert.equal(r.releaseAuthorized,false);assert.equal(r.originalRun.conclusion,'failure');assert.equal(r.originalFailures.length,2);assert(r.ordinaryFiles.every(f=>f.state==='PASSED'));
});
for(const [name,change] of [['missing original member',f=>f.units[0].files.pop()],['missing engine',f=>f.units.pop()],['foreign repair',f=>f.repair.origin.candidate=EMAIL.original],['skipped repair',f=>f.repair.files[0].state='PENDING'],['unrepaired failure',f=>f.units[0].files[2].state='FAILED'],['unexpected failed prerequisite',f=>f.originalSnapshot.jobs[0].conclusion='failure'],['unverified fresh compiler',f=>f.compiler=null],['changed runtime',f=>f.candidatePlan={...f.candidatePlan,runtime:{...f.candidatePlan.runtime,node:'22.23.4'}}]])test('refuses '+name,()=>{const f=coverageFixture();change(f);assert.throws(()=>assessEmailCoverage(f));});
