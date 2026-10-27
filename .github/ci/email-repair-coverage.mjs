/** Full original outcomes plus two repaired contracts. Original failed jobs remain failed. */
import assert from 'node:assert/strict';
import {relative} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {EMAIL,EMAIL_REPAIRED_FILES} from './email-repair-source.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {validatePdfSetupProof} from './pdf-tools.mjs';
export function inspectEmailUnitFiles(plan,report){
 const unit=plan.units.find(u=>u.id===report?.id);
 assert(unit&&report.schemaVersion===1&&report.sha===plan.sha&&report.fingerprint===plan.fingerprint&&isDeepStrictEqual(report.files,unit.files),'Exact original unit required');
 assert(report.healthBefore?.ok===true&&report.healthAfter?.ok===true&&!report.error&&!report.databaseTelemetryError,'Original runner/controller failure');
 assert([0,1].includes(report.exitCode)&&Array.isArray(report.batches)&&report.batches.length>0,'Complete original batch outcome required');
 if(unit.kind!=='browser')validatePdfSetupProof(plan,unit,report.pdfToolSetup);
 if(unit.kind==='db')validatePostgresEvidence(report.databaseTerminalEvidence,plan.execution);
 const rows=[],seen=new Set();let failures=0;
 for(const batch of report.batches){
  if(unit.kind==='db')validatePostgresEvidence(batch.databaseEvidence,plan.execution);
  const raw=batch.result;assert(Array.isArray(raw?.testResults)&&raw.testResults.length>0,'Missing original raw files');
  let good=0,bad=0,failedFiles=0;
  for(const file of raw.testResults){
   assert(typeof file.name==='string'&&report.cwd==='/home/runner/work/ai-hr/ai-hr/source','Exact hosted checkout required');
   const path=relative(report.cwd,file.name).split('\\').join('/');assert(unit.files.includes(path)&&!seen.has(path),'Foreign or repeated original file');seen.add(path);
   assert(Array.isArray(file.assertionResults)&&file.assertionResults.length>0&&file.assertionResults.every(a=>['passed','failed'].includes(a.status)),'Empty or skipped assertions');
   const failed=file.assertionResults.filter(a=>a.status==='failed').length,passed=file.assertionResults.length-failed;
   assert.equal(file.status,failed?'failed':'passed');good+=passed;bad+=failed;if(failed)failedFiles++;
   rows.push({path,state:failed?'FAILED':'PASSED',passingAssertions:passed,failedAssertions:failed,originCandidate:plan.sha,unit:unit.id,...(unit.engine?{engine:unit.engine}:{}),batchProcessExitCode:batch.exitCode,rawFileHash:installHash(installJson(file))});
  }
  assert(raw.numPassedTests===good&&raw.numFailedTests===bad&&raw.numTotalTests===good+bad&&raw.success===(bad===0),'Original assertion totals differ');
  for(const key of ['numPendingTests','numPendingTestSuites','numTodoTests'])assert((raw[key]??0)===0,'Original nonexecuted coverage');
  assert(Number.isSafeInteger(raw.numFailedTestSuites)&&(raw.numFailedTestSuites>0)===(failedFiles>0),'Original suite outcome differs');
  assert.equal(batch.exitCode,bad?1:0,'Original batch process outcome differs');failures+=bad;
 }
 assert.equal(report.exitCode,failures?1:0);assert.deepEqual([...seen].sort(),unit.files.slice().sort());
 return {unit:unit.id,kind:unit.kind,originalUnitExitCode:report.exitCode,files:rows,rawReportSha256:installHash(installJson(report))};
}
export function assessEmailCoverage({sourceProof,originalPlan,candidatePlan,originalSnapshot,units,repair,compiler}){
 const {proofSha256,...source}=sourceProof??{};
 assert(proofSha256===installHash(installJson(source))&&source.kind==='EXACT_EMAIL_TEST_CONTRACT_REPAIR_NOT_RELEASE'&&source.original===EMAIL.original&&source.candidate===EMAIL.candidate&&source.applicationSqlAndJournalUnchanged===true&&source.releaseAuthorized===false,'Exact source repair proof required');
 assert(originalPlan.sha===EMAIL.original&&candidatePlan.sha===EMAIL.candidate&&originalPlan.controller===EMAIL.controller&&candidatePlan.controller===EMAIL.controller&&originalPlan.migrationBase===EMAIL.ciBaseline&&candidatePlan.migrationBase===EMAIL.ciBaseline,'Exact source plans required');
 for(const key of ['runtime','execution','suite','units','pdfTooling'])assert(isDeepStrictEqual(originalPlan[key],candidatePlan[key]),'Changed original execution or coverage: '+key);
 assert(isDeepStrictEqual(candidatePlan.runtime,{node:'22.23.3',platform:'linux',arch:'x64'}));
 const {run,jobs}=originalSnapshot;assert(run.id===EMAIL.fullRun&&run.conclusion==='failure'&&run.head_sha===EMAIL.controller&&run.head_branch===EMAIL.controllerBranch,'Original failed run remains failed');
 assert.deepEqual(jobs.filter(j=>!['success','skipped'].includes(j.conclusion)).map(j=>j.name).sort(),['test (db-c3c5226458939268)','test (nodb-8bdb44999773d9ff)','verify']);
 for(const name of ['resolve','plan','controller-tests','migrations','typecheck','build'])assert(jobs.some(j=>j.name===name&&j.conclusion==='success'),'Original prerequisite missing: '+name);
 assert(Array.isArray(units)&&units.length===originalPlan.units.length&&new Set(units.map(u=>u.unit)).size===units.length,'Complete original unit inventory required');
 const ordinary=[],browser=[];
 for(const required of originalPlan.units){const actual=units.find(u=>u.unit===required.id);assert(actual&&isDeepStrictEqual(actual.files.map(f=>f.path).sort(),required.files.slice().sort()),'Omitted original unit member');
  const job=jobs.find(j=>j.name===(required.kind==='browser'?'browser ('+required.engine+')':'test ('+required.id+')'));assert(job&&job.conclusion===(actual.originalUnitExitCode?'failure':'success'),'Original unit process/job mismatch');
  for(const file of actual.files)(required.kind==='browser'?browser:ordinary).push(file);
 }
 assert.deepEqual(ordinary.filter(f=>f.state==='FAILED').map(f=>f.path).sort(),EMAIL_REPAIRED_FILES);assert(browser.every(f=>f.state==='PASSED'),'Unexpected original browser failure');
 assert(repair.kind==='AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE'&&repair.origin.runId===EMAIL.repairRun&&repair.origin.candidate===EMAIL.candidate&&repair.origin.controller===EMAIL.controller&&repair.origin.baseline===EMAIL.ciBaseline&&repair.originalFocusedExitCode===0&&repair.failedFiles===0,'Exact passing repair origin required');
 assert.deepEqual(repair.files.map(f=>f.path).sort(),EMAIL_REPAIRED_FILES);assert(repair.files.every(f=>f.state==='PASSED'&&f.failedAssertions===0&&f.passingAssertions>0));
 const replaced=new Map(repair.files.map(f=>[f.path,{...f,origin:repair.origin}]));
 const final=ordinary.map(f=>replaced.get(f.path)??f);
 assert(final.length===candidatePlan.suite.length&&new Set(final.map(f=>f.path)).size===candidatePlan.suite.length&&final.every(f=>f.state==='PASSED'&&f.failedAssertions===0&&f.passingAssertions>0),'Every required ordinary file must pass');
 const expectedBrowser=candidatePlan.units.filter(u=>u.kind==='browser').flatMap(u=>u.files.map(path=>u.engine+'\0'+path));
 assert.deepEqual(browser.map(f=>f.engine+'\0'+f.path).sort(),expectedBrowser.sort());assert.equal(new Set(expectedBrowser).size,expectedBrowser.length);
 assert(compiler?.kind==='AUTHENTICATED_EMAIL_REPAIR_WHOLE_COMPILER'&&compiler.candidate===EMAIL.candidate&&compiler.conclusion==='success'&&isDeepStrictEqual(compiler.runtime,candidatePlan.runtime)&&/^[a-f0-9]{64}$/.test(compiler.reportSha256??''),'Fresh repaired-test whole compiler required');
 const body={format:1,kind:'COMBINED_EMAIL_FULL_RUN_AND_TEST_CONTRACT_REPAIR',policy:'email-test-contract-repair/v1',candidate:EMAIL.candidate,original:EMAIL.original,sourceProofSha256:proofSha256,originalRun:{runId:EMAIL.fullRun,conclusion:'failure'},ordinaryFiles:final,browserFiles:browser,wholeCompiler:compiler,originalFailures:ordinary.filter(f=>f.state==='FAILED'),fullGatePassCreated:false,createsNewFullPassBaseline:false,releaseAuthorized:false,postDeployAcceptanceRequired:true};
 return {...body,acceptanceSha256:installHash(installJson(body))};
}
