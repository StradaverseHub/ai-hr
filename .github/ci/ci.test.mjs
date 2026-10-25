import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyReports} from './verify-shards.mjs';
import {candidateRequest,repository} from './resolve.mjs';
const sha='a'.repeat(40),base='b'.repeat(40);
function sample(){
 const plan={sha,controller:'c'.repeat(40),fingerprint:'fixture',suite:['test/example.test.ts'],units:[{id:'nodb-1',files:['test/example.test.ts'],kind:'nodb'}]};
 const report={schemaVersion:1,sha,fingerprint:'fixture',id:'nodb-1',cwd:'/candidate',files:['test/example.test.ts'],exitCode:0,batches:[{exitCode:0,result:{success:true,numFailedTests:0,numFailedTestSuites:0,numTotalTests:1,numPassedTests:1,testResults:[{name:'/candidate/test/example.test.ts',status:'passed',assertionResults:[{status:'passed'}]}]}}]};
 return {plan,report};
}
test('Complete execution retains exact candidate and controller identity',()=>{const {plan,report}=sample();const receipt=verifyReports(plan,[report]);assert.equal(receipt.sha,sha);assert.equal(receipt.controller,plan.controller);assert.equal(receipt.tests,1);});
for(const [name,change] of [
 ['foreign commit',r=>r.sha=base],
 ['missing suite',r=>r.files=[]],
 ['failing worker',r=>r.exitCode=1],
 ['skipped assertion',r=>r.batches[0].result.testResults[0].assertionResults[0].status='pending'],
 ['invented assertion count',r=>r.batches[0].result.numTotalTests=2],
 ['foreign suite',r=>r.batches[0].result.testResults[0].name='/candidate/test/foreign.test.ts'],
 ['zero tests',r=>r.batches[0].result.numTotalTests=0],
 ['changed partition',r=>r.fingerprint='different']
])test('Reject '+name,()=>{const {plan,report}=sample();change(report);assert.throws(()=>verifyReports(plan,[report]));});
test('Reject omitted and duplicate workers',()=>{const {plan,report}=sample();assert.throws(()=>verifyReports(plan,[]));assert.throws(()=>verifyReports(plan,[report,report]));});
const event={repository:{full_name:repository},ref:'refs/heads/main',inputs:{}};
test('Dispatch selects explicit frozen pilot branch, not controller main',()=>{assert.deepEqual(candidateRequest(event,{candidate_ref:'codex/board3-ci-pilot',expected_sha:sha,migration_base:base}),{branch:'codex/board3-ci-pilot',expected:sha,base});});
test('Reject branch injection and malformed commit',()=>{for(const candidate_ref of ['../main','alpha\nmain','-bad','a//b'])assert.throws(()=>candidateRequest(event,{candidate_ref,expected_sha:sha}));assert.throws(()=>candidateRequest(event,{candidate_ref:'alpha',expected_sha:'HEAD'}));});
test('Reject foreign repository and non-alpha push',()=>{assert.throws(()=>candidateRequest({...event,repository:{full_name:'other/repo'}}));assert.throws(()=>candidateRequest({repository:event.repository,ref:'refs/heads/main'}));});
test('Reject fork, draft and wrong-target PRs',()=>{const pr={draft:false,head:{repo:{full_name:repository},ref:'feature',sha},base:{ref:'alpha',sha:base}};for(const patch of [{draft:true},{head:{...pr.head,repo:{full_name:'fork/repo'}}},{base:{...pr.base,ref:'main'}}])assert.throws(()=>candidateRequest({repository:event.repository,pull_request:{...pr,...patch}}));});
