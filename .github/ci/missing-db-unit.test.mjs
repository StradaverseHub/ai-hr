import assert from 'node:assert/strict';
import test from 'node:test';
import {buildUnits, hash, requiredEvidence} from './manifest.mjs';
import {validateMissingDbReplacement, verifyMissingDbCoverage} from './missing-db-recovery-policy.mjs';
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

function replacementFixture() {
  const original = recoveryFixture();
  const {unitId, candidateBranch, originalPlan, currentPlan: replayPlan, annotations, now} = original;
  const unitJob = `test (${unitId})`;
  const evidenceName = `unit-${unitId}`;
  const controllerBranch = 'codex/producer';
  const replayRunId = 5000;
  const replay = {
    run: {...original.run, id: replayRunId, head_sha: replayPlan.controller, head_branch: controllerBranch,
      display_title: `DB unit recovery only · ${candidateBranch}`, conclusion: 'success', created_at: time(4), updated_at: time(1)},
    jobs: ['resolve', 'plan', 'typecheck', 'migrations', 'controller-tests', 'runner-diagnostics', 'build',
      'browser', 'verify', 'deployment-hold', unitJob].map((name, index) => ({
      ...original.jobs[0], id: 800 + index, name, run_id: replayRunId, head_sha: replayPlan.controller,
      head_branch: controllerBranch, started_at: time(3), completed_at: time(1),
      conclusion: ['resolve', 'plan', 'deployment-hold', unitJob].includes(name) ? 'success' : 'skipped',
      steps: [{name: name === 'plan' ? 'Authenticate the frozen missing database unit' : runUnit, conclusion: 'success'}],
    })),
    artifacts: ['missing-db-unit-inputs', evidenceName].map((name, index) => ({
      ...original.artifacts[0], id: 600 + index, name, created_at: time(2),
      workflow_run: {...original.artifacts[0].workflow_run, id: replayRunId, head_sha: replayPlan.controller, head_branch: controllerBranch},
    })),
  };
  const expectations = {replayRunId, controller: replayPlan.controller, controllerBranch, candidateBranch,
    unitId, after: original.run.updated_at};
  const replayJob = validateMissingDbReplacement(replay, expectations, now);
  const previousReports = fixture().reports;
  const reportsAt = plan => new Map(plan.units.map(unit => {
    const previous = previousReports.find(report => report.id.startsWith(unit.id.split('-')[0]));
    const report = structuredClone(previous);
    Object.assign(report, {id: unit.id, files: unit.files, fingerprint: plan.fingerprint});
    report.batches[0].result.testResults[0].name = report.cwd + '/' + unit.files[0];
    return [unit.id, report];
  }));
  const reports = reportsAt(originalPlan);
  reports.delete(unitId);
  const replacementReport = reportsAt(replayPlan).get(unitId);
  replacementReport.healthBefore = {ok: true};
  replacementReport.healthAfter = {ok: true};
  for (const db of [replacementReport.batches[0].databaseEvidence, replacementReport.databaseTerminalEvidence])
    Object.assign(db, {name: `aihr-ci-${replayRunId}-1-${unitId}`, capturedAt: time(2)});
  const assessment = {
    sourceRun: {id: original.run.id}, fingerprint: originalPlan.fingerprint,
    rerun: [{id: unitId, reason: 'Missing completed evidence'}],
    reusable: [...reports].map(([unit, report]) => ({id: unit, reportHash: hash(report), source: {runId: original.run.id}})),
  };
  const binding = validateMissingDbSource(original);
  return {source: original, replay, originalPlan, replayPlan, annotations, assessment, binding, reports, replacementReport,
    replayJob, candidateBranch, unitId, roleProfile: 'ordinary', now, expectations};
}

test('keeps retained test provenance and verifies the replacement with the original full-unit rules', () => {
  const data = replacementFixture();
  const result = verifyMissingDbCoverage(data);
  assert.equal(result.units.length, data.originalPlan.units.length);
  assert.equal(result.tests, data.originalPlan.units.length);
  assert.equal(result.units[0].source.runId, data.source.run.id);
  assert.equal(result.units.at(-1).source.runId, data.replay.run.id);
});

for (const [label, tamper] of [
  ['changed retained unit', data => { data.reports.values().next().value.exitCode = 1; }],
  ['foreign database', data => { data.replacementReport.databaseTerminalEvidence.name = 'other-db'; }],
  ['missing restricted role proof', data => { data.roleProfile = 'full_ci_disposable'; }],
  ['skipped assertion', data => { data.replacementReport.batches[0].result.testResults[0].assertionResults[0].status = 'pending'; }],
]) {
  test(`refuses ${label} when joining original and replacement evidence`, () => {
    const data = replacementFixture();
    tamper(data);
    assert.throws(() => verifyMissingDbCoverage(data));
  });
}

test('refuses a replay with an unexpected full-gate success or artifact provenance', () => {
  const {replay, expectations, now} = replacementFixture();
  replay.jobs.find(job => job.name === 'verify').conclusion = 'success';
  assert.throws(() => validateMissingDbReplacement(replay, expectations, now), /Unexpected replay job/);
  replay.jobs.find(job => job.name === 'verify').conclusion = 'skipped';
  replay.artifacts[0].workflow_run.head_sha = '0'.repeat(40);
  assert.throws(() => validateMissingDbReplacement(replay, expectations, now), /Foreign or malformed/);
});
