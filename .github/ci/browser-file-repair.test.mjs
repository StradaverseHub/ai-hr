import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REPAIR_FILE,repairBrowserConfig,verifyBrowserFileRepair,runBrowserFileRepair} from './browser-file-repair.mjs';
function valid(){return {success:true,numFailedTests:0,numFailedTestSuites:0,numTotalTests:5,numPassedTests:5,numPendingTests:0,numTodoTests:0,testResults:[{name:'/source/'+REPAIR_FILE,status:'passed',assertionResults:Array.from({length:5},()=>({status:'passed'}))}]};}
test('accepts exactly the five real cases of the one failed file',()=>assert.equal(verifyBrowserFileRepair(valid(),'/source'),5));
test('refuses missing, extra, foreign, skipped, failed and zero-case results',()=>{
 for(const change of [r=>r.success=false,r=>r.numPassedTests=0,r=>r.numPendingTests=1,r=>r.numTodoTests=1,r=>r.testResults=[],r=>r.testResults.push(r.testResults[0]),r=>r.testResults[0].name='/source/test/other.browser.test.tsx',r=>r.testResults[0].assertionResults[0].status='skipped',r=>r.testResults[0].assertionResults[0].status='failed',r=>r.testResults[0].assertionResults=[]]){
  const result=valid();change(result);assert.throws(()=>verifyBrowserFileRepair(result,'/source'));
 }
});
test('selects only one approved actual engine without changing the base browser configuration',()=>{
 for(const engine of ['chromium','firefox','webkit']){const source=repairBrowserConfig(engine);assert(source.includes("import base from '../vitest.browser.config'"));assert(source.includes(JSON.stringify(engine)));assert(source.includes('...base.test.browser'));}
 for(const engine of ['',undefined,'chrome','chromium;exit 0'])assert.throws(()=>repairBrowserConfig(engine));
});
test('refuses to execute outside an authenticated disposable runner',()=>{
 const saved=process.env.GITHUB_ACTIONS;delete process.env.GITHUB_ACTIONS;
 try{assert.throws(()=>runBrowserFileRepair('/tmp/not-runner'),/Disposable standard GitHub runner only/);}finally{if(saved===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=saved;}
});
