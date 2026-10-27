/** Preserve actual passed/failed file outcomes without changing a failed browser unit to PASS. */
import assert from 'node:assert/strict';
import {relative} from 'node:path';
import {installHash,installJson} from './ci-install-grant.mjs';
export function inspectPartialBrowserReport(plan,report){
 const unit=plan.units.find(u=>u.id===report?.id);
 assert(unit?.kind==='browser'&&['chromium','firefox','webkit'].includes(unit.engine),'Exact source browser unit required');
 assert(report.schemaVersion===1&&report.sha===plan.sha&&report.fingerprint===plan.fingerprint
  &&installJson(report.files)===installJson(unit.files)&&[0,1].includes(report.exitCode),'Browser source or outcome differs');
 assert(report.healthBefore?.ok===true&&report.healthAfter?.ok===true&&!report.error,'Browser environment or controller failed');
 assert(Array.isArray(report.batches)&&report.batches.length===1,'One complete original browser batch required');
 const batch=report.batches[0],raw=batch.result;
 assert([0,1].includes(batch.exitCode)&&batch.exitCode===report.exitCode,'Original process outcome must be preserved');
 assert(Array.isArray(raw?.testResults)&&raw.testResults.length===unit.files.length,'Complete original browser inventory required');
 for(const k of ['numPendingTests','numPendingTestSuites','numTodoTests'])assert((raw[k]??0)===0,'Skipped or pending browser coverage');
 const rows=[],seen=new Set();let passed=0,failed=0;
 for(const file of raw.testResults){
  assert(typeof file.name==='string'&&typeof report.cwd==='string','Actual browser source path required');
  const path=relative(report.cwd,file.name).split('\\').join('/');
  assert(unit.files.includes(path)&&!seen.has(path),'Foreign or duplicate browser file');seen.add(path);
  assert(Array.isArray(file.assertionResults)&&file.assertionResults.length>0,'Empty browser test file');
  const assertions=file.assertionResults;assert(assertions.every(a=>['passed','failed'].includes(a.status)),'Nonterminal browser assertion');
  const good=assertions.filter(a=>a.status==='passed').length,bad=assertions.length-good;
  assert(file.status===(bad?'failed':'passed'),'Browser file outcome contradicts assertions');
  passed+=good;failed+=bad;
  rows.push({path,state:bad?'FAILED':'PASSED',passingAssertions:good,failedAssertions:bad,engine:unit.engine,
   originCandidate:plan.sha,batchProcessExitCode:batch.exitCode,rawFileHash:installHash(installJson(file))});
 }
 assert(raw.numPassedTests===passed&&raw.numFailedTests===failed&&raw.numTotalTests===passed+failed,'Browser raw assertion counts differ');
 assert(raw.success===(failed===0)&&report.exitCode===(failed?1:0),'Original browser process and case outcomes differ');
 assert(seen.size===unit.files.length,'Missing original browser file');
 return {kind:'COMPLETE_BROWSER_FILE_OUTCOMES_NOT_UNIT_OR_RELEASE_PASS',releaseAuthorized:false,
  candidate:plan.sha,controller:plan.controller,fingerprint:plan.fingerprint,unit:unit.id,engine:unit.engine,
  originalUnitExitCode:report.exitCode,passingAssertions:passed,failedAssertions:failed,
  passingFiles:rows.filter(r=>r.state==='PASSED').length,failedFiles:rows.filter(r=>r.state==='FAILED').length,
  files:rows,rawReportSha256:installHash(installJson(report))};
}
