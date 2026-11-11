import {execFileSync} from 'node:child_process';
import {buildUnits, hash, requiredEvidence, CI_EXECUTION} from './manifest.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {REPOSITORY, REPOSITORY_ID, WORKFLOW_ID, WORKFLOW_PATH, digest} from './release-policy.mjs';

export const now = Date.parse('2026-10-25T13:00:00Z');
export const time = minutes => new Date(now - minutes * 60000).toISOString();
const archiveCache = new Map();
function zip(entries) {
  const input = JSON.stringify(entries);
  if (archiveCache.has(input)) return archiveCache.get(input);
  const bytes = execFileSync('python3', ['-c',
    'import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,v)) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],
    {input});
  archiveCache.set(input, bytes);
  return bytes;
}
export function fixture() {
  const expected = {candidate: 'a'.repeat(40), controller: 'c'.repeat(40), baseline: 'b'.repeat(40), runId: 100};
  const suite = ['test/db.test.ts', 'test/plain.test.ts'];
  const units = buildUnits(suite, {db: [suite[0]], nodb: [suite[1]]}, ['test/ui.browser.test.tsx']);
  const body = {schemaVersion: 2, policyVersion: CI_POLICY, sha: expected.candidate, controller: expected.controller,
    migrationBase: expected.baseline, runtime: {node: '22.23.3', platform: 'linux', arch: 'x64'}, execution: CI_EXECUTION, suite, units};
  const expectedPlan = {...body, fingerprint: hash(body)};
  const run = {id: 100, repository: {id: REPOSITORY_ID, full_name: REPOSITORY}, head_repository: {id: REPOSITORY_ID},
    workflow_id: WORKFLOW_ID, path: WORKFLOW_PATH, event: 'workflow_dispatch', head_branch: 'main', head_sha: expected.controller,
    status: 'completed', conclusion: 'failure', run_attempt: 1, created_at: time(20), updated_at: time(5)};
  const jobs = requiredEvidence(expectedPlan).jobs.map((name, i) => ({id: 1000 + i, name, run_id: 100, run_attempt: 1,
    head_sha: expected.controller, head_branch: 'main', status: 'completed', conclusion: name === 'verify' ? 'failure' : 'success',
    started_at: time(19), completed_at: time(6)}));
  const resource = () => ({schemaVersion: 2, errors: {}, profileVersion: 2, configuredCapBytes: 2113929216, peakBudgetBytes: 2147483648, memoryLimit: 2113929216, memorySwap: 2113929216, memoryMax: 2113929216, memorySwapMax: 0, memoryPeak: 1000000000,
    memoryEvents: {oom: 0, oom_kill: 0}, state: {Running: true, OOMKilled: false, Dead: false},
    settings: {jit: 'on', jitAvailable: true, serverVersionNum: '160015'}});
  const reports = units.map(unit => ({schemaVersion: 1, id: unit.id, sha: expected.candidate, fingerprint: expectedPlan.fingerprint,
    cwd: '/candidate', files: unit.files, exitCode: 0, ...(unit.kind === 'db' ? {databaseTerminalEvidence: resource()} : {}),
    batches: [{exitCode: 0, ...(unit.kind === 'db' ? {databaseEvidence: resource()} : {}), result: {success: true,
      numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numFailedTestSuites: 0,
      testResults: [{name: '/candidate/' + unit.files[0], status: 'passed', assertionResults: [{status: 'passed'}]}]}}]}));
  const artifacts = [], archives = new Map();
  const f = {expected, expectedPlan, run, jobs, reports, artifacts, archives, now};
  put(f, 'gate-plan', 'ci-plan.json', expectedPlan);
  for (const report of reports) put(f, 'unit-' + report.id, `unit-${report.id}.json`, report);
  return f;
}
export function put(f, name, filename, value, extra = {}) {
  const bytes = zip({[filename]: JSON.stringify(value), ...extra});
  const previous = f.artifacts.find(a => a.name === name);
  const artifact = {id: previous?.id ?? 2000 + f.artifacts.length, name, size_in_bytes: bytes.length, digest: digest(bytes),
    expired: false, created_at: time(10), expires_at: time(-60), workflow_run: {id: f.run.id,
      repository_id: REPOSITORY_ID, head_repository_id: REPOSITORY_ID, head_sha: f.expected.controller, head_branch: 'main'}};
  if (previous) f.artifacts.splice(f.artifacts.indexOf(previous), 1, artifact); else f.artifacts.push(artifact);
  f.archives.set(name, bytes);
}
export function remove(f, name) { f.artifacts.splice(f.artifacts.findIndex(a => a.name === name), 1); f.archives.delete(name); }

