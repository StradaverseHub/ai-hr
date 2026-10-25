import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {assessResumeSource} from './resume-source.mjs';
import {buildUnits, hash, requiredEvidence, CI_EXECUTION} from './manifest.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {REPOSITORY, REPOSITORY_ID, WORKFLOW_ID, WORKFLOW_PATH, digest} from './release-policy.mjs';

const now = Date.parse('2026-10-25T13:00:00Z');
const time = minutes => new Date(now - minutes * 60000).toISOString();
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
function fixture() {
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
  const resource = () => ({schemaVersion: 1, memoryLimit: 2147483648, memoryMax: 2147483648, memoryPeak: 1000000000,
    memoryEvents: {oom_kill: 0}, state: {Running: true, OOMKilled: false, Dead: false},
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
function put(f, name, filename, value, extra = {}) {
  const bytes = zip({[filename]: JSON.stringify(value), ...extra});
  const previous = f.artifacts.find(a => a.name === name);
  const artifact = {id: previous?.id ?? 2000 + f.artifacts.length, name, size_in_bytes: bytes.length, digest: digest(bytes),
    expired: false, created_at: time(10), expires_at: time(-60), workflow_run: {id: f.run.id,
      repository_id: REPOSITORY_ID, head_repository_id: REPOSITORY_ID, head_sha: f.expected.controller, head_branch: 'main'}};
  if (previous) f.artifacts.splice(f.artifacts.indexOf(previous), 1, artifact); else f.artifacts.push(artifact);
  f.archives.set(name, bytes);
}
function remove(f, name) { f.artifacts.splice(f.artifacts.findIndex(a => a.name === name), 1); f.archives.delete(name); }

test('Verified raw archives produce a non-authoritative assessment, preserving a failed whole run', () => {
  const f = fixture(), before = structuredClone(f.run), r = assessResumeSource(f);
  assert.equal(r.reusable.length, 5); assert.equal(r.rerun.length, 0);
  assert.equal(r.releaseAuthorized, false); assert.equal(r.result, undefined);
  assert.equal(r.apiSnapshotsAuthenticatedByThisTool, false);
  assert.equal(r.requiresFreshGitHubApiRevalidation, true); assert.equal(r.requiresLatestFailureHistoryValidation, true);
  assert.equal(r.sourceRun.conclusion, 'failure'); assert.deepEqual(f.run, before);
  for (const unit of r.reusable) {assert.equal(unit.source.runId, 100); assert(unit.source.jobId > 0); assert.match(unit.source.digest, /^sha256:/);}
  assert.equal(r.observations.length, f.expectedPlan.units.length); assert(r.freshPrerequisites.includes('build'));
});
test('A failed producing job overrides a green payload; it is never selected from an earlier green', () => {
  const f = fixture(), unit = f.expectedPlan.units.find(u => u.kind === 'db');
  f.jobs.find(j => j.name === `test (${unit.id})`).conclusion = 'failure';
  const r = assessResumeSource(f); assert.equal(r.reusable.length, 4);
  assert.deepEqual(r.rerun, [{id: unit.id, reason: 'Producing job did not pass: failure'}]);
  assert.equal(r.observations.find(o => o.id === unit.id).conclusion, 'failure');
});
test('Missing unit artifacts remain required fresh; incomplete job inventory cannot hide a failure', () => {
  const f = fixture(), unit = f.expectedPlan.units[0]; remove(f, 'unit-' + unit.id);
  const r = assessResumeSource(f); assert.equal(r.rerun[0].id, unit.id); assert.equal(r.completeRequiredUnits.length, 5);
  f.jobs.pop(); assert.throws(() => assessResumeSource(f), /omitted job/);
});
test('Bad database and skipped assertion evidence is never reusable after archive integrity checks', () => {
  for (const mutate of [r => r.databaseTerminalEvidence.memoryEvents.oom_kill = 1,
    r => r.batches[0].result.testResults[0].assertionResults[0].status = 'skipped']) {
    const f = fixture(), report = f.reports.find(r => r.id.startsWith('db-')); mutate(report);
    put(f, 'unit-' + report.id, `unit-${report.id}.json`, report);
    const r = assessResumeSource(f); assert.equal(r.rerun.length, 1); assert.equal(r.rerun[0].id, report.id);
  }
});
for (const [name, mutate] of [
  ['repository', f => f.run.repository.id = 9], ['workflow', f => f.run.workflow_id = 9],
  ['controller', f => f.run.head_sha = f.expected.candidate], ['fork', f => f.run.head_repository.id = 9],
  ['event', f => f.run.event = 'pull_request'], ['controller branch', f => f.run.head_branch = 'feature'],
  ['candidate', f => f.expected.candidate = 'd'.repeat(40)], ['run attempt', f => f.run.run_attempt = 2],
  ['job attempt', f => f.jobs[0].run_attempt = 2], ['unfinished run', f => f.run.status = 'in_progress'],
  ['old run', f => f.now += 25 * 60 * 60 * 1000], ['future time', f => f.run.updated_at = time(-2)],
  ['job identity', f => f.jobs[0].run_id = 9], ['duplicate job', f => f.jobs.push(f.jobs[0])],
  ['bootstrap failure', f => f.jobs[0].conclusion = 'failure'], ['job time', f => f.jobs[0].completed_at = time(21)],
  ['expired artifact', f => f.artifacts[0].expired = true], ['artifact run', f => f.artifacts[0].workflow_run.id = 9],
  ['artifact controller', f => f.artifacts[0].workflow_run.head_sha = f.expected.candidate],
  ['artifact id', f => f.artifacts[1].id = f.artifacts[0].id], ['artifact time', f => f.artifacts[0].created_at = time(20)],
  ['archive digest', f => {const a = f.artifacts[0]; const bytes = Buffer.from(f.archives.get(a.name)); bytes[bytes.length - 1] ^= 1; f.archives.set(a.name, bytes);}],
]) test('Refuse mismatched ' + name, () => {const f = fixture(); mutate(f); assert.throws(() => assessResumeSource(f));});
test('Archived plan and report identity are independently checked', () => {
  for (const change of [f => {const p = structuredClone(f.expectedPlan); p.runtime.node = '22.99.0'; put(f, 'gate-plan', 'ci-plan.json', p);},
    f => {const r = structuredClone(f.reports[0]); r.id = f.reports[1].id; put(f, 'unit-' + f.reports[0].id, `unit-${f.reports[0].id}.json`, r);}]) {
    const f = fixture(); change(f); assert.throws(() => assessResumeSource(f));
  }
});
test('Authenticated archive bytes still cannot contain traversal or executable files', () => {
  for (const name of ['../escape.json', 'payload.sh']) {
    const f = fixture(); put(f, 'gate-plan', 'ci-plan.json', f.expectedPlan, {[name]: '{}'});
    assert.throws(() => assessResumeSource(f));
  }
});
test('A skipped optional diagnostics job is allowed, but cannot conceal extra executed work', () => {
  const f = fixture(); f.jobs.push({...f.jobs[0], id: 9999, name: 'runner-diagnostics', conclusion: 'skipped'});
  assert.equal(assessResumeSource(f).reusable.length, 5);
  f.jobs.at(-1).conclusion = 'success'; assert.throws(() => assessResumeSource(f), /unexpected job/);
});
