import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectPartialBrowserReport} from './browser-partial-outcomes.mjs';
function fixture(){const files=['test/a.browser.test.tsx','test/b.browser.test.tsx'];return {plan:{sha:'a'.repeat(40),controller:'b'.repeat(40),fingerprint:'pin',units:[{id:'browser-chromium',kind:'browser',engine:'chromium',files}]},report:{schemaVersion:1,id:'browser-chromium',sha:'a'.repeat(40),fingerprint:'pin',files,cwd:'/source',exitCode:1,healthBefore:{ok:true},healthAfter:{ok:true},batches:[{exitCode:1,result:{success:false,numPassedTests:1,numFailedTests:1,numTotalTests:2,numPendingTests:0,testResults:files.map((path,i)=>({name:'/source/'+path,status:i?'failed':'passed',assertionResults:[{status:i?'failed':'passed'}]}))}}]}};}
test('preserves a failed whole unit while retaining genuine passing files',()=>{const {plan,report}=fixture(),r=inspectPartialBrowserReport(plan,report);assert.equal(r.passingFiles,1);assert.equal(r.failedFiles,1);assert.equal(r.originalUnitExitCode,1);assert.equal(r.releaseAuthorized,false);});
for(const [name,change] of [
 ['source',f=>f.report.sha='c'.repeat(40)],['fingerprint',f=>f.report.fingerprint='foreign'],['unit type',f=>f.plan.units[0].kind='db'],
 ['missing file',f=>f.report.batches[0].result.testResults.pop()],['duplicate file',f=>f.report.batches[0].result.testResults[1]=f.report.batches[0].result.testResults[0]],
 ['skipped assertion',f=>f.report.batches[0].result.testResults[0].assertionResults[0].status='skipped'],['pending count',f=>f.report.batches[0].result.numPendingTests=1],
 ['false process pass',f=>f.report.exitCode=0],['false case pass',f=>f.report.batches[0].result.success=true],['false totals',f=>f.report.batches[0].result.numPassedTests=2],
 ['host failure',f=>f.report.healthAfter.ok=false],['controller failure',f=>f.report.error='failure'],['missing batch',f=>f.report.batches=[]]
])test('refuses '+name,()=>{const f=fixture();change(f);assert.throws(()=>inspectPartialBrowserReport(f.plan,f.report));});
