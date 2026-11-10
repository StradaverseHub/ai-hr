import test from 'node:test';
import {readFileSync as readModelSource} from 'node:fs';
import {controllerRegressionRoots} from './controller-regression-roots.mjs';
import {createHash as modelCreateHash} from 'node:crypto';
import {buildUnits as buildDatabaseModelUnits} from './manifest.mjs';
import {singletonSources} from './singleton-protocol.mjs';
import {join as modelJoin} from 'node:path';
import assert from 'node:assert/strict';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {verifyReports} from './verify-shards.mjs';
import {buildUnits,hash,CI_EXECUTION} from './manifest.mjs';
import {CI_POLICY} from './policy-version.mjs';

// Source-data model only: actual hosted/source authentication belongs to the real adapters.
const {candidate:modelRoot}=controllerRegressionRoots();
function databaseModel(f,root=modelRoot){
 const plan=f.expectedPlan,old=plan.units.find(unit=>unit.kind==='db'),oldId=old.id,file='test/notification-worker-lifecycle.test.ts';
 const browser=plan.units.find(unit=>unit.kind==='browser');assert(browser,'Existing model browser inventory required');
 const unit=buildDatabaseModelUnits([file],{db:[file],nodb:[]},browser.files)[0],report=f.reports.find(report=>report.id===oldId),runId=f.expected.runId??100;
 f.expected.runId=runId;plan.suite=[...plan.suite.filter(path=>!old.files.includes(path)),file].sort();plan.units=plan.units.map(row=>row.id===oldId?unit:row);
 const journal='db/migrations/meta/_journal.json',journalHash=modelCreateHash('sha256').update(readModelSource(modelJoin(root,journal))).digest('hex');
 plan.singletonSources={[unit.id]:Object.fromEntries(singletonSources(unit,root).map(path=>[path,path===journal?journalHash:'c'.repeat(64)]))};
 const {fingerprint,...body}=plan;plan.fingerprint=modelCreateHash('sha256').update(JSON.stringify(body)).digest('hex');
 report.id=unit.id;report.files=unit.files;report.batches[0].result.testResults=[{name:report.cwd+'/'+file,status:'passed',assertionResults:[{status:'passed'}]}];
 report.batches[0].result.numTotalTests=1;report.batches[0].result.numPassedTests=1;
 const resource=report.databaseTerminalEvidence;resource.name=`aihr-ci-${runId}-1-${unit.id}`;report.batches[0].databaseEvidence=structuredClone(resource);
 report.singleton={schemaVersion:1,mode:'full-ci-singleton',candidate:plan.sha,controller:plan.controller,runId:String(runId),attempt:'1',unit:unit.id,fingerprint:plan.fingerprint,file,profile:unit.singleton.profile,sourceHashes:plan.singletonSources[unit.id],evidenceDirectory:'/tmp/model/aihr-ci',prerequisites:{kind:'fresh-job-postgres-cluster',workers:1,database:structuredClone(resource)}};
 for(const row of f.reports)row.fingerprint=plan.fingerprint;
 if(f.jobs)f.jobs.find(job=>job.name===`test (${oldId})`).name=`test (${unit.id})`;
 return f;
}
function fixture(){
 const expected={candidate:'a'.repeat(40),controller:'c'.repeat(40),baseline:'b'.repeat(40)};
 const suite=['test/db.test.ts','test/plain.test.ts'];const units=buildUnits(suite,{db:[suite[0]],nodb:[suite[1]]},['test/ui.browser.test.tsx']);
 const body={schemaVersion:2,policyVersion:CI_POLICY,sha:expected.candidate,controller:expected.controller,migrationBase:expected.baseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'},execution:CI_EXECUTION,suite,units};
 const expectedPlan={...body,fingerprint:hash(body)};
 const resource=()=>({schemaVersion:2,errors:{},profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,memoryLimit:2113929216,memorySwap:2113929216,memoryMax:2113929216,memorySwapMax:0,memoryPeak:1000000000,memoryEvents:{oom:0,oom_kill:0},state:{Running:true,OOMKilled:false,Dead:false},settings:{jit:'on',jitAvailable:true,serverVersionNum:'160015'}});
 const reports=units.map(u=>({schemaVersion:1,id:u.id,sha:expected.candidate,fingerprint:expectedPlan.fingerprint,cwd:'/candidate',files:u.files,exitCode:0,...(u.kind==='db'?{databaseTerminalEvidence:resource()}:{}),batches:[{exitCode:0,...(u.kind==='db'?{databaseEvidence:resource()}:{}),result:{success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numFailedTestSuites:0,testResults:[{name:'/candidate/'+u.files[0],status:'passed',assertionResults:[{status:'passed'}]}]}}]}));
 return {expectedPlan,reports,expected};
}
test('All green unit assessment is explicitly not release evidence and still requires fresh prerequisites',()=>{const f=fixture(),r=assessResumeCoverage(f);assert.equal(r.reusable.length,5);assert.equal(r.rerun.length,0);assert.equal(r.releaseAuthorized,false);assert.equal(r.requiresAuthenticatedArchives,true);assert.equal(r.requiresVersionedResumeWorkflowAndIndependentReleaseValidation,true);assert.equal(r.finalVerificationRequired,true);assert(r.freshPrerequisites.includes('build'));assert(r.freshPrerequisites.includes('typecheck'));assert.equal(r.result,undefined);assert.equal(r.tier,undefined);assert.equal(verifyReports(f.expectedPlan,f.reports).result,'PASS');
 const db=databaseModel(fixture());assert.throws(()=>assessResumeCoverage(db),/Explicit candidate root/);assert.throws(()=>assessResumeCoverage({...db,candidateRoot:modelRoot}),/Explicit candidate root/);assert.equal(assessResumeCoverage(db,modelRoot).reusable.length,5);assert.equal(assessResumeCoverage({...db,reports:[]}).rerun.length,5);assert.throws(()=>assessResumeCoverage(db,''),/Explicit candidate root/);const omitted=structuredClone(db);delete omitted.reports.find(report=>report.singleton).singleton;assert.equal(assessResumeCoverage(omitted).rerun.length,1);
});
test('A failed database unit is rerun while every passing unit remains visible in complete coverage',()=>{const f=fixture(),bad=f.reports.find(r=>r.id.startsWith('db-'));bad.exitCode=1;const r=assessResumeCoverage(f);assert.equal(r.rerun.length,1);assert.equal(r.rerun[0].id,bad.id);assert.equal(r.reusable.length,4);assert.equal(r.completeRequiredUnits.length,5);assert.equal(r.retainedFailuresMustRemainVisible,true);assert.throws(()=>verifyReports(f.expectedPlan,f.reports));});
test('Missing evidence is scheduled fresh; it never disappears from the complete manifest',()=>{const f=fixture(),removed=f.reports.pop();const r=assessResumeCoverage(f);assert.deepEqual(r.rerun,[{id:removed.id,reason:'Missing completed evidence'}]);assert.equal(r.completeRequiredUnits.length,5);assert.throws(()=>verifyReports(f.expectedPlan,f.reports));});
for(const field of ['candidate','controller','baseline'])test('Changed '+field+' refuses cross-identity reuse',()=>{const f=fixture();f.expected[field]='d'.repeat(40);assert.throws(()=>assessResumeCoverage(f),/Changed candidate/);});
test('Altered or foreign report provenance refuses rather than being silently selected',()=>{for(const mutate of [f=>f.reports[0].sha='d'.repeat(40),f=>f.reports[0].fingerprint='altered',f=>f.reports.push(f.reports[0]),f=>f.reports[0].id='foreign']){const f=fixture();mutate(f);assert.throws(()=>assessResumeCoverage(f));}});
test('Tampering with a complete expected plan refuses before any unit is assessed',()=>{for(const mutate of [f=>f.expectedPlan.units.pop(),f=>f.expectedPlan.suite.pop(),f=>f.expectedPlan.runtime.node='22.99.0',f=>f.expectedPlan.policyVersion='unknown']){const f=fixture();mutate(f);assert.throws(()=>assessResumeCoverage(f));}});
test('OOM, missing terminal resource data and skips are never reusable even when exit and headline counts pass',()=>{for(const mutate of [r=>r.databaseTerminalEvidence.memoryEvents.oom_kill=1,r=>delete r.databaseTerminalEvidence,r=>r.batches[0].result.numPendingTests=1,r=>r.batches[0].result.testResults[0].assertionResults[0].status='skipped',r=>r.batches[0].result.testResults[0].name='/candidate/test/foreign.test.ts',r=>r.batches[0].result.testResults[0].assertionResults=[]]){const f=fixture(),db=f.reports.find(r=>r.id.startsWith('db-'));mutate(db);const result=assessResumeCoverage(f);assert.equal(result.rerun.length,1);assert.equal(result.rerun[0].id,db.id);assert(!result.reusable.some(r=>r.id===db.id));assert.throws(()=>verifyReports(f.expectedPlan,f.reports));}});
