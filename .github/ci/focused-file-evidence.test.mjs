import test from 'node:test';import assert from 'node:assert/strict';
import {hash} from './manifest.mjs';import {inspectFocusedFiles} from './focused-file-evidence.mjs';
function fixture(failed=false){
 const files=['test/a.test.ts','test/b.test.ts'];
 const expected={candidate:'a'.repeat(40),controller:'b'.repeat(40),runId:1,runtime:{node:'22.23.3',platform:'linux',arch:'x64'},files,groups:{NODB:files,DB:[]},classifierHash:'c'.repeat(64)};
 const batch={kind:'NODB',files,exitCode:failed?1:0,processExitCode:failed?1:0,signal:null,...(failed?{error:'Selected test process failed'}:{assertions:2})};
 const report={schemaVersion:1,kind:'FOCUSED_ONLY',releaseEligible:false,sha:expected.candidate,controller:expected.controller,runId:'1',attempt:'1',runtime:expected.runtime,files,groups:expected.groups,manifestHash:hash(JSON.stringify(files)),classifierHash:expected.classifierHash,healthBefore:{ok:true},healthAfter:{ok:true},batches:[batch],exitCode:failed?1:0};
 const raw={success:!failed,numPassedTests:failed?1:2,numFailedTests:failed?1:0,numTotalTests:2,numFailedTestSuites:failed?1:0,testResults:files.map((path,i)=>({name:'/home/runner/work/ai-hr/ai-hr/source/'+path,status:failed&&i===1?'failed':'passed',assertionResults:[{status:failed&&i===1?'failed':'passed'}]}))};
 return {report,results:new Map([['NODB',raw]]),expected,postgresExecution:{postgres:{memoryBytes:2147483648,jit:'on'}}};
}
test('all selected files passed with original successful process retained',()=>{const r=inspectFocusedFiles(fixture());assert.equal(r.passingFiles,2);assert.equal(r.releaseAuthorized,false);});
test('passing file in actual failed batch keeps failure and never becomes a passing process',()=>{const r=inspectFocusedFiles(fixture(true));assert.equal(r.passingFiles,1);assert.equal(r.failedFiles,1);assert.equal(r.originalFocusedExitCode,1);assert.equal(r.files[0].batchProcessExitCode,1);});
for(const [name,change] of [
 ['unknown process exit',f=>f.report.batches[0].processExitCode=null],
 ['signal termination',f=>f.report.batches[0].signal='SIGTERM'],
 ['missing file',f=>f.results.get('NODB').testResults.pop()],
 ['repeated file',f=>f.results.get('NODB').testResults[1].name=f.results.get('NODB').testResults[0].name],
 ['foreign source directory',f=>f.results.get('NODB').testResults[0].name='/elsewhere/source/test/a.test.ts'],
 ['skipped assertion',f=>f.results.get('NODB').testResults[0].assertionResults[0].status='skipped'],
 ['lying aggregate',f=>f.results.get('NODB').numPassedTests=99],
 ['hidden pending',f=>f.results.get('NODB').numPendingTests=1],
 ['extra authority',f=>f.report.releaseEligible=true],
 ['unhealthy runner',f=>f.report.healthAfter.ok=false],
 ['changed classifier',f=>f.report.classifierHash='d'.repeat(64)],
 ['unknown final failure',f=>f.report.exitCode=1],
])test('refuses '+name,()=>{const f=fixture();change(f);assert.throws(()=>inspectFocusedFiles(f));});
