import assert from 'node:assert/strict';
import {DB_BATCH_FILES, hash} from './manifest.mjs';
import {validateMissingDbSource} from './missing-db-unit.mjs';
import {REPOSITORY, REPOSITORY_ID, WORKFLOW_ID, WORKFLOW_PATH} from './release-policy.mjs';
import {verifyUnitReport} from './verify-shards.mjs';

const id = value => Number.isSafeInteger(value) && value > 0;
const time = value => Date.parse(value);
const useStep = 'Run node ../automation/.github/ci/run-unit.mjs "$UNIT" "$RUNNER_TEMP/aihr-ci"';
const isolatedJobs = ['resolve', 'plan', 'typecheck', 'migrations', 'controller-tests', 'runner-diagnostics',
  'build', 'browser', 'verify', 'deployment-hold'];

export function validateMissingDbReplacement({run, jobs, artifacts}, expected, now = Date.now()) {
  assert(id(expected.replayRunId) && run.id === expected.replayRunId && run.repository?.id === REPOSITORY_ID &&
    run.repository.full_name === REPOSITORY && run.head_repository?.id === REPOSITORY_ID,
  'Replay must come from the original repository');
  assert(run.workflow_id === WORKFLOW_ID && run.path === WORKFLOW_PATH && run.event === 'workflow_dispatch' &&
    run.head_sha === expected.controller && run.head_branch === expected.controllerBranch &&
    run.display_title === `DB unit recovery only · ${expected.candidateBranch}` &&
    run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1,
  'Expected a successful first-attempt one-unit replay');
  const created = time(run.created_at), completed = time(run.updated_at);
  assert(created >= time(expected.after) && created <= completed && completed <= now + 60_000 &&
    now - created < 86_400_000, 'Replay chronology differs');

  const unitJobName = `test (${expected.unitId})`;
  const executed = ['resolve', 'plan', unitJobName, 'deployment-hold'];
  assert(jobs.length === isolatedJobs.length + 1 && new Set(jobs.map(job => job.name)).size === jobs.length &&
    new Set(jobs.map(job => job.id)).size === jobs.length, 'Replay job inventory differs');
  for (const job of jobs) {
    assert(id(job.id) && job.run_id === run.id && job.run_attempt === 1 && job.head_sha === run.head_sha &&
      job.head_branch === run.head_branch && job.status === 'completed' &&
      (isolatedJobs.includes(job.name) || job.name === unitJobName) &&
      job.conclusion === (executed.includes(job.name) ? 'success' : 'skipped'), 'Unexpected replay job or outcome');
  }
  const producer = jobs.find(job => job.name === unitJobName);
  const planJob = jobs.find(job => job.name === 'plan');
  assert(producer.steps.some(step => step.name === useStep && step.conclusion === 'success') &&
    planJob.steps.some(step => step.name === 'Authenticate the frozen missing database unit' && step.conclusion === 'success'),
  'Full gate runner or replay admission did not execute');

  const expectedArtifacts = new Map([['missing-db-unit-inputs', planJob], [`unit-${expected.unitId}`, producer]]);
  assert(artifacts.length === expectedArtifacts.size && new Set(artifacts.map(a => a.name)).size === artifacts.length &&
    new Set(artifacts.map(a => a.id)).size === artifacts.length, 'Exact replay archives required');
  for (const artifact of artifacts) {
    const job = expectedArtifacts.get(artifact.name), owner = artifact.workflow_run;
    assert(job && id(artifact.id) && id(artifact.size_in_bytes) && artifact.size_in_bytes <= 64 * 1024 ** 2 &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') && artifact.expired === false &&
      owner?.id === run.id && owner.repository_id === REPOSITORY_ID && owner.head_repository_id === REPOSITORY_ID &&
      owner.head_sha === run.head_sha && owner.head_branch === run.head_branch, 'Foreign or malformed replay archive');
    assert(time(job.started_at) >= created && time(job.completed_at) <= completed &&
      time(artifact.created_at) >= time(job.started_at) && time(artifact.created_at) <= time(job.completed_at) &&
      time(artifact.expires_at) > now, 'Replay archive outside its producer job');
  }
  return producer;
}

export function verifyMissingDbCoverage({source, replay, originalPlan, replayPlan, annotations, assessment, binding,
  reports, replacementReport, replayJob, candidateBranch, unitId, roleProfile, now = Date.now()}) {
  const expected = validateMissingDbSource({...source, originalPlan, currentPlan: replayPlan,
    annotations, candidateBranch, sourceRunId: source.run.id, unitId, now});
  assert.deepEqual(binding, expected, 'Replacement binding differs from authenticated original failure');
  assert(assessment.sourceRun.id === source.run.id && assessment.fingerprint === originalPlan.fingerprint,
    'Retained evidence belongs to a different gate');
  assert.deepEqual(assessment.rerun, [{id: unitId, reason: 'Missing completed evidence'}], 'Additional missing coverage');
  const unaffected = originalPlan.units.filter(unit => unit.id !== unitId);
  assert.equal(assessment.reusable.length, unaffected.length, 'Incomplete retained coverage');
  assert.equal(reports.size, unaffected.length, 'Unexpected retained report inventory');
  const units = unaffected.map(unit => {
    const report = reports.get(unit.id);
    const retained = assessment.reusable.find(row => row.id === unit.id);
    assert(retained?.source && retained.reportHash === hash(report), 'Retained report provenance changed');
    return {...verifyUnitReport(originalPlan, report), reportHash: retained.reportHash, source: retained.source};
  });
  assert(replacementReport?.id === unitId && replacementReport.batches?.length === 1 &&
    replacementReport.healthBefore?.ok === true && replacementReport.healthAfter?.ok === true && !replacementReport.error,
  'Exact healthy replacement unit required');
  const expectedDb = `aihr-ci-${replay.run.id}-1-${unitId}`;
  const [batch] = replacementReport.batches;
  for (const db of [batch.databaseEvidence, replacementReport.databaseTerminalEvidence]) {
    assert(db?.name === expectedDb && time(db.capturedAt) >= time(replayJob.started_at) &&
      time(db.capturedAt) <= time(replayJob.completed_at), 'Replacement database was not job owned');
  }
  const prerequisites = batch.rolePrerequisites;
  if (roleProfile === 'full_ci_disposable') {
    assert(prerequisites?.mode === roleProfile && prerequisites.unit === unitId && prerequisites.offset === 0 &&
      prerequisites.planFingerprint === replayPlan.fingerprint && prerequisites.batchSize === DB_BATCH_FILES &&
      String(prerequisites.postgresVersionNumber) === batch.databaseEvidence.settings.serverVersionNum,
    'Replacement omitted the original restricted role prerequisites');
    assert.deepEqual(prerequisites.batchFiles, expected.files, 'Restricted role prerequisites belong to different coverage');
  } else {
    assert(roleProfile === 'ordinary' && prerequisites === undefined, 'Unexpected database role profile');
  }
  // Both report types undergo the full gate's existing file, assertion, PDF and PostgreSQL checks.
  const replacement = verifyUnitReport(replayPlan, replacementReport);
  const artifact = replay.artifacts.find(row => row.name === `unit-${unitId}`);
  units.push({...replacement, reportHash: hash(replacementReport), source: {
    runId: replay.run.id, attempt: 1, jobId: replayJob.id, artifactId: artifact.id, digest: artifact.digest,
  }});
  return {units, tests: units.reduce((sum, unit) => sum + unit.tests, 0), binding: expected};
}
