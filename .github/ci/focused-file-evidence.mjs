/** Exact file outcomes from a focused repair, preserving failed process/run status.
 * A passing file inside a failing batch is not a passing batch or release receipt.
 */
import assert from 'node:assert/strict';
import {relative,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {hash} from './manifest.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
export function inspectFocusedFiles({report,results,expected,postgresExecution}){
 assert(report?.schemaVersion===1&&report.kind==='FOCUSED_ONLY'&&report.releaseEligible===false,'Expected authentic focused-only report');
 assert(report.sha===expected.candidate&&report.controller===expected.controller&&report.runId===String(expected.runId)&&report.attempt==='1','Focused origin differs');
 assert(isDeepStrictEqual(report.runtime,expected.runtime)&&isDeepStrictEqual(report.files,expected.files)&&isDeepStrictEqual(report.groups,expected.groups),'Focused source/runtime/selection differs');
 assert(report.manifestHash===hash(JSON.stringify(expected.files))&&report.classifierHash===expected.classifierHash,'Focused manifest/classifier differs');
 assert(report.healthBefore?.ok===true&&report.healthAfter?.ok===true&&!report.error&&!report.databaseTelemetryError,'Unhealthy/incomplete focused environment');
 assert(results instanceof Map&&Array.isArray(report.batches),'Raw focused results required');
 const kinds=['NODB','DB'].filter(k=>expected.groups[k].length);
 assert(isDeepStrictEqual(report.batches.map(b=>b.kind),kinds)&&results.size===kinds.length&&kinds.every(k=>results.has(k)),'Incomplete focused batch inventory');
 if(kinds.includes('DB'))validatePostgresEvidence(report.databaseTerminalEvidence,postgresExecution);
 const files=[];let failures=0;
 for(const batch of report.batches){
  const selected=expected.groups[batch.kind],raw=results.get(batch.kind);
  assert(isDeepStrictEqual(batch.files,selected)&&Array.isArray(raw?.testResults)&&raw.testResults.length===selected.length,'Missing selected raw test files');
  const seen=new Set();let passed=0,failed=0,failedFiles=0;
  for(const suite of raw.testResults){
   assert(typeof suite.name==='string','Invalid raw file identity');
   // The pinned hosted workflow checks out this repository under the standard source directory.
   const cwd='/home/runner/work/ai-hr/ai-hr/source';
   assert(report.cwd===undefined||report.cwd===cwd,'Unexpected focused checkout');
   const path=isAbsolute(suite.name)?relative(cwd,suite.name):suite.name;
   assert(selected.includes(path)&&!seen.has(path)&&Array.isArray(suite.assertionResults)&&suite.assertionResults.length>0,'Foreign/repeated/empty selected file');seen.add(path);
   const bad=suite.assertionResults.filter(a=>a.status==='failed').length,good=suite.assertionResults.filter(a=>a.status==='passed').length;
   assert(bad+good===suite.assertionResults.length,'Skipped/pending/todo assertions cannot be carried');
   assert(suite.status===(bad?'failed':'passed'),'File summary contradicts assertions');
   passed+=good;failed+=bad;if(bad)failedFiles++;
   files.push({path,state:bad?'FAILED':'PASSED',passingAssertions:good,failedAssertions:bad,rawFileHash:hash(suite),originCandidate:report.sha,batchKind:batch.kind,batchProcessExitCode:batch.processExitCode});
  }
  assert(seen.size===selected.length&&raw.numPassedTests===passed&&raw.numFailedTests===failed&&raw.numTotalTests===passed+failed&&raw.success===(failed===0),'Raw aggregate contradicts executed assertions');
  for(const key of ['numPendingTests','numPendingTestSuites','numTodoTests'])assert((raw[key]??0)===0,'Nonexecuted focused coverage');
  assert(Number.isSafeInteger(raw.numFailedTestSuites)&&raw.numFailedTestSuites>=0&&(raw.numFailedTestSuites>0)===(failedFiles>0),'Raw suite failure summary differs');
  assert(batch.signal===null&&batch.processExitCode===(failed?1:0)&&batch.exitCode===(failed?1:0),'Unknown/abnormal batch exit cannot be carried');
  if(!failed)assert(batch.assertions===passed&&!batch.error,'Passing batch completion differs');
  else assert(batch.error==='Selected test process failed','Failure not explained by actual failing assertions');
  failures+=failed;
 }
 assert(report.exitCode===(failures?1:0),'Focused final exit differs from complete observed outcomes');
 return {kind:'FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE',releaseAuthorized:false,originalFocusedExitCode:report.exitCode,files,passingFiles:files.filter(f=>f.state==='PASSED').length,failedFiles:files.filter(f=>f.state==='FAILED').length};
}
