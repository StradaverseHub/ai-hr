/** Refuse omitted, repeated, skipped, failed, foreign-revision or zero-test evidence. */
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {createPlan, hash} from './plan.mjs';
import {validatePdfSetupProof} from './pdf-tools.mjs';
import {employeeLifecycleUnit} from './employee-lifecycle-profile.mjs';
import {verifyEmployeeLifecycleUnit} from './employee-lifecycle-witness.mjs';
import {collectEmployeeLifecycleWitness} from './employee-lifecycle-api.mjs';
import {readUnitReportDirectories} from './unit-report-directories.mjs';
import {nativeWorkloadDatabaseUnit,NATIVE_WORKLOAD_DATABASE_CASE,NATIVE_WORKLOAD_DATABASE_MEMBER_MAX,validateSingletonBinding} from './singleton-protocol.mjs';
function verifyWorkloadDatabase(report,raw,tests){
  const refused=()=>{throw Error('Native workload database member or settlement refused');};
  if(tests!==1||report.batches[0].result.testResults[0].assertionResults[0].title!==NATIVE_WORKLOAD_DATABASE_CASE
    ||report.workloadDatabaseSettlementRefused!==undefined||!Buffer.isBuffer(raw)||raw.length===0||raw.length>NATIVE_WORKLOAD_DATABASE_MEMBER_MAX)refused();
  const binding=report.singleton,{build,workloadDatabase}=binding.prerequisites;
  const name=binding.prerequisites.database.name;
  if(report.batches[0].databaseEvidence.name!==name||report.databaseTerminalEvidence.name!==name)refused();
  const {containerIdentitySha256,systemIdentifierSha256}=workloadDatabase;
  const close={kind:'NATIVE_WORKLOAD_DATABASE_SETTLEMENT',containerIdentitySha256,systemIdentifierSha256,
    containerAbsent:true,processAbsent:true,cgroupAbsent:true,privateFilesRemoved:true,complete:true};
  if(!isDeepStrictEqual(report.workloadDatabaseClose,close))refused();
  let member;
  try{member=JSON.parse(raw.toString('utf8'));}catch{refused();}
  const expected={kind:'NATIVE_WORKLOAD_DATABASE_CUSTODY_COMPONENT_ONLY',source:binding.candidate,controller:binding.controller,
    runId:binding.runId,attempt:binding.attempt,fingerprint:binding.fingerprint,unit:binding.unit,
    buildArtifactId:build.artifactId,buildProducerJobId:build.producerJobId,buildArchiveSha256:build.archiveSha256,
    systemIdentifierSha256,containerIdentitySha256,authenticatedRoles:3,connectionRefusals:8,privilegeRefusals:5,clientClosures:3,releaseEligible:false};
  if(!isDeepStrictEqual(member,expected)||!Buffer.from(JSON.stringify(member)+'\n').equals(raw))refused();
  return createHash('sha256').update(raw).digest('hex');
}
export function verifyUnitReport(plan, report, witness, candidateRoot) {
  const unit = plan.units.find(u => u.id === report?.id);
  if (!unit) throw Error('Unknown CI unit');
  let tests = 0;
  if (report.schemaVersion !== 1 || report.sha !== plan.sha || report.fingerprint !== plan.fingerprint
    || JSON.stringify(report.files) !== JSON.stringify(unit.files) || report.exitCode !== 0 || !Array.isArray(report.batches)) throw Error('Stale, failed or altered CI unit');
  if(plan.pdfTooling&&unit.kind!=='browser')validatePdfSetupProof(plan,unit,report.pdfToolSetup);
  if(unit.kind==='db')validatePostgresEvidence(report.databaseTerminalEvidence,plan.execution);
  if(unit.singleton){
    validateSingletonBinding(report.singleton,plan,unit,witness,candidateRoot);
    if(unit.kind==='db')validatePostgresEvidence(report.singleton.prerequisites.database,plan.execution);
    if(report.batches.length!==1)throw Error('Singleton must retain one complete invocation');
  }else if(report.singleton!==undefined)throw Error('Unplanned singleton proof');
  const files = [];
  for (const batch of report.batches) {
    if(unit.kind==='db')validatePostgresEvidence(batch.databaseEvidence,plan.execution);
    const result = batch.result;
    if (batch.exitCode !== 0 || result?.success !== true || result.numFailedTests !== 0 || result.numFailedTestSuites !== 0
      || (result.numPendingTests ?? 0) !== 0 || (result.numPendingTestSuites ?? 0) !== 0 || (result.numTodoTests ?? 0) !== 0
      || !Number.isSafeInteger(result.numTotalTests) || result.numTotalTests < 1 || result.numPassedTests !== result.numTotalTests
      || !Array.isArray(result.testResults) || !result.testResults.length) throw Error('Incomplete, skipped or failing Vitest batch');
    let assertions = 0;
    for (const file of result.testResults) {
      if (file.status !== 'passed' || !Array.isArray(file.assertionResults) || !file.assertionResults.length
        || file.assertionResults.some(a => a.status !== 'passed')) throw Error('Incomplete or non-passing test file');
      assertions += file.assertionResults.length;
      const path = relative(report.cwd, file.name).split('\\').join('/');
      if (!unit.files.includes(path) || files.includes(path)) throw Error('Foreign or repeated test file');
      files.push(path);
    }
    if (assertions !== result.numTotalTests) throw Error('Reported assertion totals do not match executed tests');
    tests += assertions;
  }
  if (JSON.stringify(files.sort()) !== JSON.stringify([...unit.files].sort())) throw Error('Unit omitted required test files');
  const employee=employeeLifecycleUnit(unit)?verifyEmployeeLifecycleUnit(plan,unit,report,witness):null;
  if(!employee&&report.employeeLifecycle!==undefined)throw Error('Unplanned employee lifecycle proof');
  const workloadDatabaseSha256=nativeWorkloadDatabaseUnit(unit)?verifyWorkloadDatabase(report,witness?.workloadDatabases?.get(unit.id),tests):null;
  return {id: unit.id, tests, files: files.slice(),...(employee?{employeeLifecycle:employee}:{}),...(workloadDatabaseSha256?{workloadDatabaseSha256}:{})};
}
export function verifyReports(plan, reports, witness, candidateRoot) {
  if (!Array.isArray(reports) || reports.length !== plan.units.length) throw Error('Expected exactly one report per CI unit');
  const seen = new Set(),employees=[],reportHashes=[]; let tests = 0;
  for (const report of reports) {
    if (seen.has(report?.id)) throw Error('Unknown or duplicated CI unit');
    const verified = verifyUnitReport(plan, report, witness, candidateRoot); seen.add(verified.id); tests += verified.tests;if(verified.employeeLifecycle)employees.push(verified.employeeLifecycle);
    const {workloadDatabaseSha256}=verified;
    reportHashes.push({id:report.id,hash:hash(report),...(workloadDatabaseSha256?{workloadDatabaseSha256}:{})});
  }
  return {schemaVersion: 1, policyVersion: plan.policyVersion, sha: plan.sha, controller: plan.controller, migrationBase: plan.migrationBase, result: 'PASS', tier: 'ci', suiteFiles: plan.suite.length,
    browserFiles: plan.units.filter(u => u.kind === 'browser').reduce((n, u) => n + u.files.length, 0),
    tests, fingerprint: plan.fingerprint,...(employees.length?{employeeLifecycles:employees.sort((a,b)=>a.unit.localeCompare(b.unit))}:{}), reports: reportHashes.sort((a,b)=>a.id.localeCompare(b.id))};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, output] = process.argv.slice(2);
  if (!dir || !output) throw Error('Usage: verify-shards.mjs <report-directory> <receipt-output>');
  const candidateRoot=resolve(process.cwd()),plan=createPlan(candidateRoot);
  const entries=[...readUnitReportDirectories(resolve(dir),plan.units,{mode:'full'})];
  const reports=entries.map(entry=>entry.report),workloadDatabases=new Map(entries.filter(entry=>entry.workloadDatabaseBytes).map(entry=>[entry.report.id,entry.workloadDatabaseBytes]));
  const employeeUnits=await collectEmployeeLifecycleWitness(plan,plan.units);
  const receipt = verifyReports(plan, reports, {runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,employeeUnits,workloadDatabases},candidateRoot);
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  console.log(`CI complete: ${receipt.suiteFiles} suite files, ${receipt.browserFiles} browser files, ${receipt.tests} passing assertions.`);
}
