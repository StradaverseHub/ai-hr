/** Produce one exact replacement unit. This admission cannot authorize staging. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {downloadCiArchives, readCiArchive} from './archive-downloads.mjs';
import {hash, ISOLATED_DB_FILES, requiredEvidence} from './manifest.mjs';
import {REPOSITORY, REPOSITORY_ID, WORKFLOW_ID, WORKFLOW_PATH} from './release-policy.mjs';

const jobStep = 'Run node ../automation/.github/ci/run-unit.mjs "$UNIT" "$RUNNER_TEMP/aihr-ci"';
const lostRunner = 'The hosted runner lost communication with the server.';
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function body(plan) {
  const {fingerprint, ...fields} = plan;
  assert(fingerprint === hash(fields), 'Invalid complete plan fingerprint');
  const {controller, ...execution} = fields;
  assert(sha(controller) && sha(execution.sha) && sha(execution.migrationBase), 'Exact source, baseline and controller required');
  return execution;
}

export function validateMissingDbSource({run, jobs, artifacts, originalPlan, currentPlan, annotations,
  sourceRunId, candidateBranch, unitId, now = Date.now()}) {
  assert.deepEqual(body(currentPlan), body(originalPlan), 'Source, baseline, coverage or execution changed');
  assert(positive(sourceRunId) && run.id === sourceRunId && run.repository?.id === REPOSITORY_ID &&
    run.head_repository?.id === REPOSITORY_ID && run.repository.full_name === REPOSITORY, 'Foreign original run');
  assert(run.workflow_id === WORKFLOW_ID && run.path === WORKFLOW_PATH && run.event === 'workflow_dispatch' &&
    ['main', 'alpha'].includes(run.head_branch) && run.head_sha === originalPlan.controller &&
    run.display_title === `Alpha CI · ${candidateBranch}` && run.run_attempt === 1 &&
    run.status === 'completed' && run.conclusion === 'failure', 'Original full gate must remain failed');
  const finished = Date.parse(run.updated_at);
  assert(finished >= now - 86_400_000 && finished <= now + 60_000, 'Original full gate is outside recovery freshness');

  const topology = requiredEvidence(originalPlan);
  const unit = originalPlan.units.find(item => item.id === unitId);
  assert(unit?.kind === 'db' && unit.files.length === 1 && ISOLATED_DB_FILES.includes(unit.files[0]),
    'Only an entire isolated database unit can be replaced');
  const failedJobName = `test (${unitId})`;
  const expectedJobs = new Map(topology.jobs.map(name => [name, [failedJobName, 'verify'].includes(name) ? 'failure' : 'success']));
  expectedJobs.set('runner-diagnostics', 'skipped');
  assert(jobs.length === expectedJobs.size && new Set(jobs.map(job => job.name)).size === jobs.length &&
    new Set(jobs.map(job => job.id)).size === jobs.length, 'Incomplete or repeated original jobs');
  for (const job of jobs) {
    assert(positive(job.id) && job.run_id === run.id && job.run_attempt === 1 && job.head_sha === run.head_sha &&
      job.head_branch === run.head_branch && job.status === 'completed' && expectedJobs.get(job.name) === job.conclusion,
    'Unexpected original job or conclusion');
  }
  const failedJob = jobs.find(job => job.name === failedJobName);
  const execution = failedJob.steps.find(step => step.name === jobStep);
  assert(execution?.status === 'in_progress' && execution.conclusion === null && execution.completed_at === null &&
    Date.parse(execution.started_at) >= Date.parse(failedJob.started_at) &&
    failedJob.steps.filter(step => step.name.startsWith('Run actions/upload-artifact@'))
      .some(step => step.status === 'pending' && step.started_at === null), 'Original runner did not disappear during execution');
  assert(annotations.some(annotation => annotation.annotation_level === 'failure' && annotation.message.startsWith(lostRunner)),
    'GitHub did not authenticate runner loss');

  const names = new Set(artifacts.map(artifact => artifact.name));
  assert(names.size === artifacts.length && topology.artifacts.every(name => {
    const missing = name === `unit-${unitId}` || name === 'gate-evidence';
    return names.has(name) !== missing;
  }), 'Original complete artifact inventory does not isolate the missing unit');
  const originalPlanArtifact = artifacts.find(artifact => artifact.name === 'gate-plan');
  const planJob = jobs.find(job => job.name === 'plan');
  assert(originalPlanArtifact.workflow_run?.id === run.id && originalPlanArtifact.workflow_run.head_sha === run.head_sha &&
    originalPlanArtifact.workflow_run.repository_id === REPOSITORY_ID &&
    originalPlanArtifact.workflow_run.head_repository_id === REPOSITORY_ID &&
    originalPlanArtifact.workflow_run.head_branch === run.head_branch && originalPlanArtifact.expired === false &&
    positive(originalPlanArtifact.id) && /^sha256:[a-f0-9]{64}$/.test(originalPlanArtifact.digest ?? '') &&
    Date.parse(originalPlanArtifact.created_at) >= Date.parse(planJob.started_at) &&
    Date.parse(originalPlanArtifact.created_at) <= Date.parse(planJob.completed_at) &&
    Date.parse(originalPlanArtifact.expires_at) > now, 'Original plan archive is foreign or expired');

  return {
    kind: 'MISSING_DB_UNIT_PRODUCER_INPUTS', releaseAuthorized: false, sourceRunId, sourceJobId: failedJob.id,
    sourceController: originalPlan.controller, sourceFingerprint: originalPlan.fingerprint,
    sourcePlanArtifact: {id: originalPlanArtifact.id, digest: originalPlanArtifact.digest},
    candidate: currentPlan.sha, baseline: currentPlan.migrationBase, controller: currentPlan.controller,
    fingerprint: currentPlan.fingerprint, unit: unit.id, files: unit.files,
  };
}

const api = path => JSON.parse(execFileSync('gh', ['api', `repos/${REPOSITORY}/${path}`],
  {encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024}));

function inventory(path, key) {
  const result = [];
  for (let page = 1; page <= 8; page++) {
    const payload = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = key ? payload[key] : payload;
    assert(Array.isArray(rows), 'Incomplete GitHub inventory');
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw Error('GitHub inventory exceeded the recovery bound');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {SOURCE_RUN, RECOVERY_UNIT, CANDIDATE_BRANCH, RUNNER_TEMP, GITHUB_OUTPUT, GITHUB_EVENT_NAME, GITHUB_RUN_ATTEMPT} = process.env;
  assert(GITHUB_EVENT_NAME === 'workflow_dispatch' && GITHUB_RUN_ATTEMPT === '1' && /^[1-9]\d*$/.test(SOURCE_RUN ?? '') &&
    /^db-[a-f0-9]{16}$/.test(RECOVERY_UNIT ?? ''), 'Use a first-attempt exact manual database recovery');
  const sourceRunId = Number(SOURCE_RUN);
  assert(positive(sourceRunId), 'Invalid original run ID');
  const currentPlan = JSON.parse(readFileSync(join(RUNNER_TEMP, 'ci-plan.json'), 'utf8'));
  const run = api(`actions/runs/${sourceRunId}`);
  const jobs = inventory(`actions/runs/${sourceRunId}/jobs?filter=all`, 'jobs');
  const artifacts = inventory(`actions/runs/${sourceRunId}/artifacts`, 'artifacts');
  const archive = artifacts.find(item => item.name === 'gate-plan');
  const job = jobs.find(item => item.name === `test (${RECOVERY_UNIT})`);
  assert(archive && positive(job?.id), 'Original plan or failed test job unavailable');
  const dir = mkdtempSync(join(RUNNER_TEMP, 'missing-unit-'));
  await downloadCiArchives([archive], dir);
  const archivePath = join(dir, 'gate-plan.zip');
  readCiArchive(archive, archivePath);
  const extracted = join(dir, 'plan');
  execFileSync('python3', [fileURLToPath(new URL('./extract-artifact.py', import.meta.url)), archivePath, extracted], {timeout: 30_000});
  assert.deepEqual(readdirSync(extracted), ['ci-plan.json'], 'Unexpected members in archived full plan');
  const originalPlan = JSON.parse(readFileSync(join(extracted, 'ci-plan.json'), 'utf8'));
  const annotations = inventory(`check-runs/${job.id}/annotations`, null);
  const binding = validateMissingDbSource({run, jobs, artifacts, originalPlan, currentPlan, annotations,
    sourceRunId, candidateBranch: CANDIDATE_BRANCH, unitId: RECOVERY_UNIT});
  writeFileSync(join(RUNNER_TEMP, 'missing-db-unit-inputs.json'), JSON.stringify(binding, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  appendFileSync(GITHUB_OUTPUT, `test_matrix=${JSON.stringify({unit: [binding.unit]})}\n`);
}
