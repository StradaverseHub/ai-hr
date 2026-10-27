import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectBrowserRepairRecord} from './authenticated-browser-repair.mjs';
import {RUNTIME_REPAIR as refs} from './runtime-repair-source.mjs';
function fixture(){const path='test/atelier-mobile-navigation.browser.test.tsx';return {plan:{fingerprint:'pin'},engine:'chromium',tree:'tree',testBlob:'test',configBlob:'config',job:{started_at:'2026-10-27T00:00:00Z',completed_at:'2026-10-27T00:10:00Z'},
 report:{kind:'FOCUSED_BROWSER_FILE_REPAIR_NOT_RELEASE',format:1,releaseAuthorized:false,releaseEligible:false,candidate:refs.candidate,controller:'5ecd6ce16f64fc2586a7872e62f009dba469135c',baseline:refs.ciBaseline,fingerprint:'pin',engine:'chromium',runId:'40474846420',attempt:'1',originalFailedRun:40469625375,sourceTree:'tree',testBlob:'test',configBlob:'config',files:[path],runtime:{node:'22.23.3',platform:'linux',arch:'x64'},healthBefore:{ok:true},healthAfter:{ok:true},exitCode:0,processExitCode:0,signal:null,assertions:5,startedAt:'2026-10-27T00:01:00Z',endedAt:'2026-10-27T00:02:00Z'},
 raw:{success:true,numTotalTests:5,numPassedTests:5,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numTodoTests:0,testResults:[{name:'/source/'+path,status:'passed',assertionResults:Array.from({length:5},(_,i)=>({fullName:'actual case '+i,status:'passed'}))}]}};}
test('accepts one genuine source-bound five-case file without claiming complete browser coverage',()=>{const r=inspectBrowserRepairRecord(fixture());assert.equal(r.passingAssertions,5);assert.equal(r.path,'test/atelier-mobile-navigation.browser.test.tsx');assert.equal(r.originCandidate,refs.candidate);});
for(const [name,change] of [
 ['wrong source',f=>f.report.candidate=refs.wave],['wrong source graph',f=>f.report.fingerprint='foreign'],['wrong engine',f=>f.report.engine='webkit'],['different test blob',f=>f.report.testBlob='foreign'],
 ['wrong runtime',f=>f.report.runtime.node='20.0.0'],['failed process',f=>f.report.processExitCode=1],['killed process',f=>f.report.signal='SIGTERM'],['host failure',f=>f.report.healthAfter.ok=false],
 ['omitted case',f=>f.raw.testResults[0].assertionResults.pop()],['duplicate case',f=>f.raw.testResults[0].assertionResults[1].fullName='actual case 0'],['skipped case',f=>f.raw.testResults[0].assertionResults[0].status='skipped'],['different file',f=>f.raw.testResults[0].name='/source/test/other.browser.test.tsx'],['outside producing job',f=>f.report.endedAt='2026-10-28T00:02:00Z']
])test('refuses '+name,()=>{const f=fixture();change(f);assert.throws(()=>inspectBrowserRepairRecord(f));});
