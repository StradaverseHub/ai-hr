/** Refuse omitted, repeated, skipped, failed, foreign-revision or zero-test evidence. */
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlan, hash} from './plan.mjs';
export function verifyReports(plan, reports) {
  if (reports.length !== plan.units.length) throw Error('Expected exactly one report per CI unit');
  const seen = new Set(); let tests = 0;
  for (const report of reports) {
    const unit = plan.units.find(u => u.id === report.id);
    if (!unit || seen.has(report.id)) throw Error('Unknown or duplicated CI unit');
    seen.add(report.id);
    if (report.schemaVersion !== 1 || report.sha !== plan.sha || report.fingerprint !== plan.fingerprint
      || JSON.stringify(report.files) !== JSON.stringify(unit.files) || report.exitCode !== 0 || !Array.isArray(report.batches)) throw Error('Stale, failed or altered CI unit');
    const files = [];
    for (const batch of report.batches) {
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
  }
  return {schemaVersion: 1, sha: plan.sha, controller: plan.controller, migrationBase: plan.migrationBase, result: 'PASS', tier: 'ci', suiteFiles: plan.suite.length,
    browserFiles: plan.units.filter(u => u.kind === 'browser').reduce((n, u) => n + u.files.length, 0),
    tests, fingerprint: plan.fingerprint, reports: reports.map(r => ({id: r.id, hash: hash(r)}))};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, output] = process.argv.slice(2);
  if (!dir || !output) throw Error('Usage: verify-shards.mjs <report-directory> <receipt-output>');
  const reports = readdirSync(dir).filter(f => /^unit-.+\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const receipt = verifyReports(createPlan(), reports);
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  console.log(`CI complete: ${receipt.suiteFiles} suite files, ${receipt.browserFiles} browser files, ${receipt.tests} passing assertions.`);
}
