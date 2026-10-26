import test from 'node:test';
import assert from 'node:assert/strict';
import {assessResumeSource} from './resume-source.mjs';
import {fixture, put, remove, time} from './resume-test-fixtures.mjs';

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

test('supplemental compiler graph is authenticated but never supplies test-unit or compiler-release authority',()=>{
 const f=fixture(),producer={kind:'WHOLE_PROJECT_COMPILER_CACHE_STATE_NOT_TEST_OR_RELEASE',releaseAuthorized:false,source:f.expected.candidate,controller:f.expected.controller,
 runId:String(f.run.id),attempt:'1',exitCode:0,sourceRestored:true,controllerRestored:true,cacheRemoved:true};
 put(f,'whole-compiler-state-v1','producer.json',producer,{'compiler-log.json':'{}','envelope.json':'{}','state.json':'{}','swap-cleanup.json':'{}'});
 const cache=f.artifacts.find(a=>a.name==='whole-compiler-state-v1'),job=f.jobs.find(j=>j.name==='typecheck');job.conclusion='success';cache.created_at=job.started_at;
 const result=assessResumeSource(f);assert.equal(result.reusable.length,5);assert.equal(result.releaseAuthorized,false);assert(result.freshPrerequisites.includes('typecheck'));
 const bytes=Buffer.from(f.archives.get(cache.name));bytes[bytes.length-1]^=1;f.archives.set(cache.name,bytes);assert.throws(()=>assessResumeSource(f));
});
