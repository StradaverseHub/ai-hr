import assert from 'node:assert/strict';
import test from 'node:test';
import {buildUnits, hash, requiredEvidence} from './manifest.mjs';
import {validateMissingDbSource} from './missing-db-unit.mjs';
import {fixture, time} from './resume-test-fixtures.mjs';

const path = 'test/system-label-exchange-browser.test.ts';
const runUnit = 'Run node ../automation/.github/ci/run-unit.mjs "$UNIT" "$RUNNER_TEMP/aihr-ci"';
const rebuild = ({fingerprint: _, ...fields}, delta) => {
  const body = {...fields, ...delta};
  return {...body, fingerprint: hash(body)};
};

function recoveryFixture() {
  const {expectedPlan, run, jobs, artifacts, now} = fixture();
  const suite = ['test/plain.test.ts', path];
  const units = buildUnits(suite, {db: [path], nodb: [suite[0]]}, ['test/ui.browser.test.tsx']);
  const unitId = units.find(unit => unit.kind === 'db').id;
  const originalPlan = rebuild(expectedPlan, {suite, units});
  const currentPlan = rebuild(originalPlan, {controller: 'd'.repeat(40)});
  const topology = requiredEvidence(originalPlan);
  const candidateBranch = 'codex/exact-candidate';
  run.display_title = `Alpha CI · ${candidateBranch}`;
  const originalJobs = topology.jobs.map((name, index) => ({
    ...jobs[0], id: 200 + index, name, conclusion: name === 'verify' || name === `test (${unitId})` ? 'failure' : 'success',
  }));
  originalJobs.push({...jobs[0], id: 900, name: 'runner-diagnostics', conclusion: 'skipped'});
  originalJobs.find(job => job.name === `test (${unitId})`).steps = [
    {name: runUnit, status: 'in_progress', conclusion: null, started_at: time(12), completed_at: null},
    {name: 'Run actions/upload-artifact@pinned', status: 'pending', started_at: null},
  ];
  return {
    run, jobs: originalJobs, originalPlan, currentPlan, candidateBranch, unitId, now, sourceRunId: run.id,
    artifacts: topology.artifacts.filter(name => ![`unit-${unitId}`, 'gate-evidence'].includes(name))
      .map((name, index) => ({...artifacts[0], name, id: 500 + index})),
    annotations: [{annotation_level: 'failure', message: 'The hosted runner lost communication with the server.'}],
  };
}

test('bind only the complete original isolated test to a separate producer', () => {
  const input = recoveryFixture();
  const binding = validateMissingDbSource(input);
  assert.equal(input.run.conclusion, 'failure');
  assert.equal(binding.releaseAuthorized, false);
  assert.equal(binding.sourceFingerprint, input.originalPlan.fingerprint);
  assert.equal(binding.fingerprint, input.currentPlan.fingerprint);
  assert.deepEqual(binding.files, [path]);
});

for (const [description, tamper] of [
  ['incomplete job inventory', data => data.jobs.pop()],
  ['superseding attempt', data => { data.run.run_attempt = 2; }],
  ['additional failure', data => { data.jobs.find(job => job.name === 'migrations').conclusion = 'failure'; }],
  ['missing runner-loss annotation', data => { data.annotations = []; }],
  ['completed failed test', data => { data.jobs.find(job => job.steps).steps[0].status = 'completed'; }],
  ['present failed report', data => data.artifacts.push({name: `unit-${data.unitId}`})],
  ['missing unaffected report', data => { data.artifacts.pop(); }],
  ['different database execution', data => { data.currentPlan = rebuild(data.currentPlan, {execution: {...data.currentPlan.execution, workers: 1}}); }],
  ['different baseline', data => { data.currentPlan = rebuild(data.currentPlan, {migrationBase: '9'.repeat(40)}); }],
  ['foreign plan archive', data => { data.artifacts[0].workflow_run.id++; }],
]) {
  test(`refuse ${description} before selecting a replacement`, () => {
    const input = recoveryFixture();
    tamper(input);
    assert.throws(() => validateMissingDbSource(input));
  });
}
