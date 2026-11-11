import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasMeasuredSampledZeroShape, inspectMeasuredPreflightProviderMetadata, inspectMeasuredWorkerDispatch,
  measuredPreflightScope, measuredWorkerCourse,
} from './measured-browser-worker-contract.mjs';

const repo = 'StradaverseHub/ai-hr';
const branch = 'claude/worker-compare-rc2-20261111';
const workflowPath = '.github/workflows/alpha-focused-checks.yml';
const sha = 'a'.repeat(40);
const archiveDigest = 'b'.repeat(64);
const repository = { id: 1333414856, full_name: repo, private: false, fork: false, default_branch: 'main' };
const at = clock => '2026-11-09T' + clock + 'Z';
const expected = {
  source: sha, upstreamRunId: 101, currentRunId: 102,
  currentRunStartedAt: at('10:32:00'), nowMs: Date.parse(at('10:33:00')),
};

function dispatch() {
  return {
    environment: {
      GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
      GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_ID: '1333414856', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW: 'alpha-focused-checks', GITHUB_JOB: 'resolve', GITHUB_RUN_ATTEMPT: '1',
      GITHUB_REF: 'refs/heads/' + branch, GITHUB_WORKFLOW_REF: repo + '/' + workflowPath + '@refs/heads/' + branch,
      GITHUB_WORKFLOW_SHA: sha, GITHUB_SHA: sha, AIHR_CI_CONTROL_HEAD: sha, GITHUB_RUN_ID: '102',
      STAGING_ENABLED: 'false', PRODUCTION_ENABLED: 'false',
    },
    event: {
      repository: { ...repository }, ref: branch,
      inputs: {
        candidate_ref: branch, expected_sha: sha, selected_tests: '[]',
        architecture_browser_development_preflight: 'false', measured_browser_course: 'serial-2-4-8',
        measured_browser_preflight_run: '101', employee_ascii_qualification: 'off',
        qualify_restricted_port_prerequisites: 'false', profile_database: 'false', duration_order: 'false',
        run_typecheck: 'false', run_native_typecheck: 'false', run_native_swift_models: 'false',
        run_native_bundle: 'false', run_build: 'false', model_eval: '', eval_budget_usd: '20', eval_allowed_providers: '',
      },
    },
  };
}

function modelMetadata() {
  const interval = (started, completed) => ({
    status: 'completed', conclusion: 'success', started_at: at(started), completed_at: at(completed),
  });
  const selectedSteps = [
    { number: 3, name: 'Verify the exact self-source before dependency installation', ...interval('10:02:00', '10:03:00') },
    { number: 7, name: 'Fictional two-worker functional browser preflight', ...interval('10:04:00', '10:28:00') },
    { number: 8, name: 'Adjudicate owned development browser settlement and evidence', ...interval('10:28:00', '10:28:20') },
    { number: 9, name: 'Publish sanitized functional browser development evidence', ...interval('10:28:21', '10:29:00') },
  ];
  const jobs = [
    { id: 2001, name: 'resolve', ...interval('10:00:01', '10:01:00'), steps: [
      { number: 4, name: 'Admit the fixed full-rendered development browser course', ...interval('10:00:15', '10:00:18') },
    ] },
    { id: 2002, name: 'selected-tests', ...interval('10:01:02', '10:30:00'), steps: selectedSteps },
    ...['worker-build', 'worker-cell (${{ matrix.workers }})', 'worker-aggregate',
      'typecheck', 'linux-build', 'native-typecheck', 'native-bundle', 'native-swift-models']
      .map((name, index) => ({ id: 2003 + index, name, status: 'completed', conclusion: 'skipped' })),
  ].map(row => ({ ...row, run_id: 101, head_sha: sha, run_attempt: 1 }));
  return {
    repository: { ...repository },
    workflow: { id: 395862645, path: workflowPath, state: 'active' },
    run: {
      id: 101, repository: { ...repository }, head_repository: { ...repository }, workflow_id: 395862645, path: workflowPath,
      head_branch: branch, head_sha: sha, event: 'workflow_dispatch', run_attempt: 1, status: 'completed', conclusion: 'success',
      run_started_at: at('10:00:00'), updated_at: at('10:30:01'),
    },
    jobInventory: { total_count: 10, jobs },
    artifactInventory: { total_count: 1, artifacts: [{
      id: 3001, name: 'architecture-browser-development-preflight-evidence', size_in_bytes: 54321,
      digest: 'sha256:' + archiveDigest, expired: false, created_at: at('10:28:25'), updated_at: at('10:28:26'),
      workflow_run: { id: 101, repository_id: 1333414856, head_repository_id: 1333414856, head_sha: sha, head_branch: branch },
    }] },
  };
}

function sampled(phase) {
  const intervalMs = phase === 'preflight' ? 250 : 1000;
  return {
    phase, intervalMs, maxGapUs: intervalMs * 2000, state: 'complete', reason: null, coveragePass: true, pass: true,
    blockingSamples: 0, observedBlockingSamples: 0, qualifiedSamples: 3,
    openingGapUs: 200000, interiorGapUs: 350000, tailGapUs: 225000,
  };
}

test('fixes the four equal-budget cell policies and keeps eight functional only', () => {
  assert.equal(measuredWorkerCourse('off', ''), null);
  const expectedProfiles = [
    ['preflight-2', '', 2, 2048, 8, 0, null, 30000, 200, false],
    ['steady-2', '101', 2, 2048, 8, 500, 10000, 300000, 2000, false],
    ['steady-4', '101', 4, 1024, 4, 500, 10000, 300000, 2000, false],
    ['functional-8', '101', 8, 512, 2, 0, null, 30000, 200, true],
  ];
  for (const [course, upstream, workers, heap, pool, steady, ramp, hold, claims, oversubscribed] of expectedProfiles) {
    const policy = measuredWorkerCourse(course, upstream);
    assert.deepEqual([policy.workers, policy.heapMiBPerWorker, policy.poolPerWorker, policy.steadyActors,
      policy.rampMs, policy.holdMs, policy.claimsPerActor, policy.oversubscribed],
    [workers, heap, pool, steady, ramp, hold, claims, oversubscribed]);
    assert.equal(policy.totalHeapMiB, 4096);
    assert.equal(policy.totalApplicationPool, 16);
    assert.equal(policy.waiterLimit, 2048);
    assert.equal(policy.effectiveCpus, 4);
    assert.equal(policy.fixtureActors, 500);
    assert.equal(policy.thinkMs, 1000);
  }
});

test('rejects open worker counts and absent, noncanonical or unsafe run IDs', () => {
  for (const course of ['steady-8', 'whole-system', 'toString', '', 2]) assert.throws(() => measuredWorkerCourse(course, '101'));
  for (const upstream of ['', '0', '01', '1.0', '1\n', ' 1', '+1', '9007199254740992', 101]) {
    assert.throws(() => measuredWorkerCourse('steady-2', upstream), /run ID/);
    assert.throws(() => measuredWorkerCourse('serial-2-4-8', upstream), /run ID/);
    assert.throws(() => measuredWorkerCourse('parallel-2-4-8', upstream), /run ID/);
  }
  assert.throws(() => measuredWorkerCourse('off', '101'));
  assert.throws(() => measuredWorkerCourse('preflight-2', '101'));
});

test('models only the exact same-source dispatch and first resolve job', () => {
  const { environment, event } = dispatch();
  const model = inspectMeasuredWorkerDispatch(environment, event);
  assert.equal(model.kind, 'MEASURED_WORKER_DISPATCH_SHAPE_ONLY');
  assert.equal(model.source, sha);
  assert.equal(model.currentRunId, 102);
  assert.equal(model.profile.upstreamRunId, 101);
  assert.equal(model.profile.course, 'serial-2-4-8');
  // The parallel course consumes the same authenticated preflight; the harness smoke never does.
  const parallel = dispatch();
  parallel.event.inputs.measured_browser_course = 'parallel-2-4-8';
  assert.equal(inspectMeasuredWorkerDispatch(parallel.environment, parallel.event).profile.course, 'parallel-2-4-8');
  for (const upstream of ['', '102']) {
    const missing = dispatch();
    missing.event.inputs.measured_browser_course = 'parallel-2-4-8';
    missing.event.inputs.measured_browser_preflight_run = upstream;
    assert.throws(() => inspectMeasuredWorkerDispatch(missing.environment, missing.event));
  }
  const smoke = dispatch();
  smoke.event.inputs.measured_browser_course = 'parallel-smoke';
  assert.throws(() => inspectMeasuredWorkerDispatch(smoke.environment, smoke.event), /course refused/);
  for (const patch of [
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_JOB: 'selected-tests' }, { GITHUB_SHA: 'c'.repeat(40) },
    { GITHUB_WORKFLOW_SHA: sha + '\n' }, { STAGING_ENABLED: 'true' }, { PRODUCTION_ENABLED: 'true' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/main' },
  ]) assert.throws(() => inspectMeasuredWorkerDispatch({ ...environment, ...patch }, event));
  for (const patch of [
    { expected_sha: 'c'.repeat(40) }, { candidate_ref: 'main' }, { model_eval: 'anything' },
    { eval_allowed_providers: 'openrouter' }, { architecture_browser_development_preflight: 'true' },
    { run_build: 'true' }, { worker_count: '8' }, { measured_browser_preflight_run: '102' },
    ...['steady-2', 'steady-4', 'functional-8', 'off'].map(course => ({ measured_browser_course: course })),
    { selected_tests: '["test/fake.test.ts"]' },
  ]) assert.throws(() => inspectMeasuredWorkerDispatch(environment, { ...event, inputs: { ...event.inputs, ...patch } }));
  assert.throws(() => inspectMeasuredWorkerDispatch(environment, { ...event, repository: { ...repository, private: true } }));
});

test('accepts an omitted empty run input only for the independent preflight course', () => {
  const { environment, event } = dispatch();
  delete event.inputs.measured_browser_preflight_run;
  delete event.inputs.model_eval;
  delete event.inputs.eval_allowed_providers;
  assert.throws(() => inspectMeasuredWorkerDispatch(environment, event));
  event.inputs.measured_browser_course = 'preflight-2';
  assert.equal(inspectMeasuredWorkerDispatch(environment, event).profile.upstreamRunId, null);
});

test('models provider provenance without minting a prerequisite', () => {
  assert.deepEqual(inspectMeasuredPreflightProviderMetadata(modelMetadata(), expected), {
    kind: 'MEASURED_PREFLIGHT_PROVIDER_METADATA_SHAPE_ONLY', runId: 101, resolveJobId: 2001, selectedJobId: 2002,
    artifactId: 3001, archiveSha256: archiveDigest, archiveBytes: 54321,
  });
});

test('refuses provider identity, wrong source, stale or nonterminal upstreams', () => {
  const mutations = [
    row => { row.repository.private = true; }, row => { row.workflow.path = 'other'; },
    row => { row.workflow.state = 'disabled_manually'; }, row => { row.run.head_branch = 'main'; },
    row => { row.run.head_sha = 'c'.repeat(40); }, row => { row.run.run_attempt = 2; },
    row => { row.run.head_repository.id += 1; }, row => { row.run.conclusion = 'failure'; },
    row => { row.run.status = 'in_progress'; }, row => { row.run.run_started_at = '2026-11-08T10:00:00Z'; },
    row => { row.run.updated_at = at('10:35:00'); },
  ];
  for (const mutate of mutations) {
    const row = modelMetadata();
    mutate(row);
    assert.throws(() => inspectMeasuredPreflightProviderMetadata(row, expected));
  }
  assert.throws(() => inspectMeasuredPreflightProviderMetadata(modelMetadata(), { ...expected, currentRunId: 101 }));
});

test('requires all ten terminal jobs and the actual selected step order', () => {
  const mutations = [
    row => { row.jobInventory.total_count = 9; },
    // A preflight run that executed a parallel worker job is not an independent preflight.
    row => { row.jobInventory.jobs[3].conclusion = 'success'; },
    row => { row.jobInventory.jobs[3].name = 'worker-cell (2)'; },
    row => { row.jobInventory.jobs.pop(); row.jobInventory.total_count = 9; }, row => { row.jobInventory.jobs[2].name = 'resolve'; },
    row => { row.jobInventory.jobs[2].id = 2002; }, row => { row.jobInventory.jobs[1].head_sha = 'd'.repeat(40); },
    row => { row.jobInventory.jobs[0].steps = []; },
    row => { row.jobInventory.jobs[0].steps[0].conclusion = 'skipped'; },
    row => { row.jobInventory.jobs[0].steps.push({ ...row.jobInventory.jobs[0].steps[0] }); },
    row => { row.jobInventory.jobs[1].started_at = at('10:00:20'); },
    row => { row.jobInventory.jobs[1].steps[2].conclusion = 'skipped'; },
    row => { row.jobInventory.jobs[1].steps[2].number = 6; },
    row => { row.jobInventory.jobs[1].steps[2].started_at = at('10:27:00'); },
    row => { row.jobInventory.jobs[2].conclusion = 'success'; },
  ];
  for (const mutate of mutations) {
    const row = modelMetadata();
    mutate(row);
    assert.throws(() => inspectMeasuredPreflightProviderMetadata(row, expected));
  }
});

test('refuses unrelated, unbounded or mistimed artifact metadata', () => {
  const mutations = [
    artifact => { artifact.expired = true; }, artifact => { artifact.size_in_bytes = 64 * 1024 ** 2 + 1; },
    artifact => { artifact.digest += '\n'; }, artifact => { artifact.workflow_run.id = 102; },
    artifact => { artifact.workflow_run.head_sha = 'c'.repeat(40); }, artifact => { artifact.name = 'other'; },
    artifact => { artifact.created_at = at('10:28:01'); }, artifact => { artifact.created_at = at('10:31:00'); },
  ];
  for (const mutate of mutations) {
    const row = modelMetadata();
    mutate(row.artifactInventory.artifacts[0]);
    assert.throws(() => inspectMeasuredPreflightProviderMetadata(row, expected));
  }
  const row = modelMetadata();
  row.artifactInventory.artifacts.push({ ...row.artifactInventory.artifacts[0] });
  assert.throws(() => inspectMeasuredPreflightProviderMetadata(row, expected));
});

test('distinguishes measured sampled zero from positive, unknown and missed windows', () => {
  assert(hasMeasuredSampledZeroShape(sampled('preflight'), 'preflight'));
  assert(hasMeasuredSampledZeroShape(sampled('loaded'), 'loaded'));
  for (const patch of [
    { blockingSamples: null }, { observedBlockingSamples: 1 }, { state: 'missed' }, { qualifiedSamples: 1 },
    { openingGapUs: 500001 }, { interiorGapUs: null }, { tailGapUs: 500001 }, { blockingSamples: false },
    { loggedZero: true },
  ]) assert.equal(hasMeasuredSampledZeroShape({ ...sampled('preflight'), ...patch }, 'preflight'), false);
  assert.equal(hasMeasuredSampledZeroShape({ ...sampled('loaded'), tailGapUs: 2000001 }, 'loaded'), false);
  assert.equal(hasMeasuredSampledZeroShape(sampled('preflight'), 'loaded'), false);
});

test('keeps the current complete diagnostic and any caller labels outside full admission', () => {
  const old = {
    kind: 'DEVELOPMENT_BROWSER_PREFLIGHT_MEASUREMENT_V1', version: 1, suite: 'workflow-preflight',
    complete: true, releaseEligible: false, locks: { preflight: sampled('preflight') },
  };
  assert.equal(measuredPreflightScope(old), 'functional-diagnostic-only');
  assert.equal(measuredPreflightScope({ ...old, fullFunctional: true }), 'functional-diagnostic-only');
  assert.equal(measuredPreflightScope({ ...old, complete: false }), 'unqualified');
  assert.equal(measuredPreflightScope({ ...old, kind: 'DEVELOPMENT_BROWSER_FULL_PREFLIGHT_CERTIFICATE_V1' }), 'unqualified');
});
