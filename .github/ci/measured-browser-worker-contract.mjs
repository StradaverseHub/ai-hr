/** Dormant controller data model. No reader or successful model result confers admission. */
import assert from 'node:assert/strict';

const REPOSITORY = 'StradaverseHub/ai-hr';
const REPOSITORY_ID = 1333414856;
const WORKFLOW_ID = 395862645;
const WORKFLOW_PATH = '.github/workflows/alpha-focused-checks.yml';
const BRANCH = 'codex/architecture-five-item-browser-convergence-20261109';
const REF = 'refs/heads/' + BRANCH;
const ARTIFACT = 'architecture-browser-development-preflight-evidence';
const maximumArchiveBytes = 64 * 1024 ** 2;
const freshnessMs = 24 * 60 * 60 * 1000;
const jobs = ['resolve', 'selected-tests', 'typecheck', 'linux-build', 'native-typecheck', 'native-bundle', 'native-swift-models'];
const preflightSteps = [
  'Verify the exact self-source before dependency installation',
  'Fictional two-worker functional browser preflight',
  'Adjudicate owned development browser settlement and evidence',
  'Publish sanitized functional browser development evidence',
];
const courseProfiles = Object.freeze({
  'preflight-2': Object.freeze({ suite: 'workflow-preflight', workers: 2, heapMiBPerWorker: 2048, poolPerWorker: 8, steadyActors: 0, rampMs: null, holdMs: 30000, claimsPerActor: 200, oversubscribed: false }),
  'steady-2': Object.freeze({ suite: 'whole-system', workers: 2, heapMiBPerWorker: 2048, poolPerWorker: 8, steadyActors: 500, rampMs: 10000, holdMs: 300000, claimsPerActor: 2000, oversubscribed: false }),
  'steady-4': Object.freeze({ suite: 'whole-system', workers: 4, heapMiBPerWorker: 1024, poolPerWorker: 4, steadyActors: 500, rampMs: 10000, holdMs: 300000, claimsPerActor: 2000, oversubscribed: false }),
  'functional-8': Object.freeze({ suite: 'workflow-preflight', workers: 8, heapMiBPerWorker: 512, poolPerWorker: 2, steadyActors: 0, rampMs: null, holdMs: 30000, claimsPerActor: 200, oversubscribed: true }),
});
const commonProfile = Object.freeze({
  effectiveCpus: 4,
  minimumHostMemoryBytes: 15 * 1024 ** 3,
  maximumHostMemoryBytes: 17 * 1024 ** 3,
  totalHeapMiB: 4096,
  totalApplicationPool: 16,
  waiterLimit: 2048,
  fixtureActors: 500,
  attendanceDays: 180,
  thinkMs: 1000,
  nodeVersion: '24.22.1',
  postgresProfile: 2,
});
const id = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function runId(value) {
  assert(typeof value === 'string' && /^[1-9][0-9]{0,15}(?![\s\S])/.test(value) && id(Number(value)), 'Measured worker run ID refused');
  return Number(value);
}

/** Interpret the closed course choice independently of the historical diagnostic. */
export function measuredWorkerCourse(course, upstream) {
  if (course === 'off') {
    assert(upstream === '', 'An inactive worker course cannot name a preflight');
    return null;
  }
  assert(typeof course === 'string' && Object.hasOwn(courseProfiles, course), 'Unknown measured worker course');
  if (course === 'preflight-2') assert(upstream === '', 'Preflight must be independent');
  return Object.freeze({
    course,
    upstreamRunId: course === 'preflight-2' ? null : runId(upstream),
    ...commonProfile,
    ...courseProfiles[course],
  });
}

function exactFields(value, expected) {
  return record(value) && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, expectedValue]) => Object.hasOwn(value, key) && value[key] === expectedValue);
}

function repositoryIdentity(value) {
  return value?.id === REPOSITORY_ID && value?.full_name === REPOSITORY;
}

function publicRepository(value) {
  return repositoryIdentity(value) && value.private === false && value.fork === false && value.default_branch === 'main';
}

/** Model the exact future resolve-job event, before candidate execution. */
export function inspectMeasuredWorkerDispatch(environment, event) {
  const source = environment?.GITHUB_WORKFLOW_SHA;
  assert(sha(source), 'Measured worker workflow SHA refused');
  const expectedEnvironment = {
    GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_ID: String(REPOSITORY_ID), GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW: 'alpha-focused-checks', GITHUB_JOB: 'resolve', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF: REF, GITHUB_WORKFLOW_REF: REPOSITORY + '/' + WORKFLOW_PATH + '@' + REF,
    GITHUB_SHA: source, AIHR_CI_CONTROL_HEAD: source, STAGING_ENABLED: 'false', PRODUCTION_ENABLED: 'false',
  };
  assert(Object.entries(expectedEnvironment).every(([key, value]) => environment[key] === value), 'Measured worker event environment refused');
  assert(publicRepository(event?.repository) && [REF, BRANCH].includes(event.ref) && record(event.inputs), 'Measured worker dispatch identity refused');
  const inputs = { model_eval: '', eval_allowed_providers: '', measured_browser_preflight_run: '', ...event.inputs };
  const course = inputs.measured_browser_course;
  const upstream = inputs.measured_browser_preflight_run;
  const expected = {
    candidate_ref: BRANCH, expected_sha: source, selected_tests: '[]',
    architecture_browser_development_preflight: 'false', measured_browser_course: course,
    measured_browser_preflight_run: upstream, employee_ascii_qualification: 'off',
    qualify_restricted_port_prerequisites: 'false', profile_database: 'false', duration_order: 'false',
    run_typecheck: 'false', run_native_typecheck: 'false', run_native_swift_models: 'false',
    run_native_bundle: 'false', run_build: 'false', model_eval: '', eval_budget_usd: '20', eval_allowed_providers: '',
  };
  assert(exactFields(inputs, expected), 'Measured worker dispatch inputs refused');
  const profile = measuredWorkerCourse(course, upstream);
  const currentRunId = runId(environment.GITHUB_RUN_ID);
  assert(profile && profile.upstreamRunId !== currentRunId, 'Inactive or same-run measured worker prerequisite refused');
  return Object.freeze({ kind: 'MEASURED_WORKER_DISPATCH_SHAPE_ONLY', source, currentRunId, profile });
}

function time(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), 'Invalid measured worker provider time');
  const milliseconds = Date.parse(value);
  const canonical = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
  assert(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === canonical, 'Invalid measured worker provider time');
  return milliseconds;
}

function successfulInterval(row, lower, upper) {
  const started = time(row.started_at);
  const completed = time(row.completed_at);
  assert(row.status === 'completed' && row.conclusion === 'success'
    && lower <= started && started <= completed && completed <= upper, 'Measured worker successful interval refused');
  return { started, completed };
}

/** Validate metadata structure only. The caller still owns actual API and archive provenance. */
export function inspectMeasuredPreflightProviderMetadata(values, expected) {
  const { repository, workflow, run, jobInventory, artifactInventory } = values;
  const { source, upstreamRunId, currentRunId, currentRunStartedAt, nowMs } = expected;
  assert(sha(source) && id(upstreamRunId) && id(currentRunId) && upstreamRunId !== currentRunId
    && Number.isSafeInteger(nowMs) && nowMs > 0, 'Measured worker prerequisite expectation refused');
  const currentStart = time(currentRunStartedAt);
  assert(currentStart <= nowMs + 60000, 'Measured worker current run time refused');
  assert(publicRepository(repository) && workflow?.id === WORKFLOW_ID && workflow?.path === WORKFLOW_PATH
    && workflow?.state === 'active', 'Measured worker prerequisite repository/workflow refused');
  assert(run?.id === upstreamRunId && repositoryIdentity(run.repository) && repositoryIdentity(run.head_repository)
    && run.workflow_id === WORKFLOW_ID && run.path === WORKFLOW_PATH && run.head_branch === BRANCH && run.head_sha === source
    && run.event === 'workflow_dispatch' && run.run_attempt === 1 && run.status === 'completed' && run.conclusion === 'success',
  'Measured worker prerequisite run refused');
  const began = time(run.run_started_at);
  const updated = time(run.updated_at);
  assert(nowMs - freshnessMs <= began && began <= updated && updated <= currentStart, 'Measured worker prerequisite freshness refused');

  const rows = jobInventory?.jobs;
  assert(jobInventory?.total_count === jobs.length && Array.isArray(rows) && rows.length === jobs.length, 'Measured worker prerequisite job inventory refused');
  const byName = new Map(rows.map(row => [row?.name, row]));
  assert(byName.size === jobs.length && jobs.every(name => byName.has(name))
    && new Set(rows.map(row => row?.id)).size === jobs.length, 'Measured worker prerequisite duplicate or foreign job');
  for (const row of rows) {
    assert(id(row.id) && row.run_id === upstreamRunId && row.head_sha === source && row.run_attempt === 1 && row.status === 'completed',
      'Measured worker prerequisite job identity refused');
    if (!['resolve', 'selected-tests'].includes(row.name)) assert(row.conclusion === 'skipped', 'Measured worker prerequisite included another course');
  }
  const resolve = byName.get('resolve');
  const selected = byName.get('selected-tests');
  const resolveTime = successfulInterval(resolve, began, updated);
  const selectedTime = successfulInterval(selected, resolveTime.completed, updated);
  assert(Array.isArray(selected.steps) && selected.steps.length <= 64, 'Measured worker prerequisite steps refused');
  let previousNumber = 0;
  let previousCompleted = selectedTime.started;
  let uploadStarted;
  for (const name of preflightSteps) {
    const matches = selected.steps.filter(row => row?.name === name);
    assert(matches.length === 1 && id(matches[0].number) && matches[0].number > previousNumber, 'Measured worker prerequisite step order refused');
    const interval = successfulInterval(matches[0], previousCompleted, selectedTime.completed);
    previousNumber = matches[0].number;
    previousCompleted = interval.completed;
    if (name === preflightSteps.at(-1)) uploadStarted = interval.started;
  }
  const artifacts = artifactInventory?.artifacts;
  assert(artifactInventory?.total_count === 1 && Array.isArray(artifacts) && artifacts.length === 1, 'Measured worker prerequisite artifact inventory refused');
  const artifact = artifacts[0];
  const provenance = artifact?.workflow_run;
  assert(artifact?.name === ARTIFACT && id(artifact.id) && artifact.expired === false
    && id(artifact.size_in_bytes) && artifact.size_in_bytes <= maximumArchiveBytes
    && typeof artifact.digest === 'string' && artifact.digest.startsWith('sha256:') && digest(artifact.digest.slice(7))
    && provenance?.id === upstreamRunId && provenance.repository_id === REPOSITORY_ID && provenance.head_repository_id === REPOSITORY_ID
    && provenance.head_sha === source && provenance.head_branch === BRANCH, 'Measured worker prerequisite artifact identity refused');
  const created = time(artifact.created_at);
  const artifactUpdated = time(artifact.updated_at);
  assert(uploadStarted <= created && created <= selectedTime.completed
    && created <= artifactUpdated && artifactUpdated <= nowMs + 60000, 'Measured worker prerequisite artifact chronology refused');
  return Object.freeze({
    kind: 'MEASURED_PREFLIGHT_PROVIDER_METADATA_SHAPE_ONLY',
    runId: upstreamRunId,
    resolveJobId: resolve.id,
    selectedJobId: selected.id,
    artifactId: artifact.id,
    archiveSha256: artifact.digest.slice(7),
    archiveBytes: artifact.size_in_bytes,
  });
}

/** A validated shape describes sampled counts within the named window only. */
export function hasMeasuredSampledZeroShape(lock, phase) {
  const interval = phase === 'preflight' ? 250 : phase === 'loaded' ? 1000 : null;
  if (interval === null || !record(lock)) return false;
  const maxGapUs = interval * 2000;
  return exactFields(lock, {
    phase, intervalMs: interval, maxGapUs, state: 'complete', reason: null, coveragePass: true, pass: true,
    blockingSamples: 0, observedBlockingSamples: 0, qualifiedSamples: lock.qualifiedSamples,
    openingGapUs: lock.openingGapUs, interiorGapUs: lock.interiorGapUs, tailGapUs: lock.tailGapUs,
  }) && Number.isSafeInteger(lock.qualifiedSamples) && lock.qualifiedSamples >= 2 && lock.qualifiedSamples <= 4096
    && [lock.openingGapUs, lock.interiorGapUs, lock.tailGapUs].every(gap => Number.isSafeInteger(gap) && gap >= 0 && gap <= maxGapUs);
}

/** Recognize the historical partial-scope receipt without granting full-preflight authority. */
export function measuredPreflightScope(measurement) {
  return measurement?.kind === 'DEVELOPMENT_BROWSER_PREFLIGHT_MEASUREMENT_V1' && measurement.version === 1
    && measurement.suite === 'workflow-preflight' && measurement.complete === true && measurement.releaseEligible === false
    && hasMeasuredSampledZeroShape(measurement.locks?.preflight, 'preflight') ? 'functional-diagnostic-only' : 'unqualified';
}
