/** Offline source-integrity assessment. Never a receipt, API authentication or release authority. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {requiredEvidence} from './manifest.mjs';
import {assessResumeCoverage} from './resume-assessment.mjs';
import {COMPILER_STATE_ARTIFACT,COMPILER_PACKET_MEMBERS} from './compiler-cache-protocol.mjs';
import {REPOSITORY, REPOSITORY_ID, WORKFLOW_ID, WORKFLOW_PATH, verifyArtifactBytes} from './release-policy.mjs';

const fail = message => {throw Error('Resume source refused: ' + message);};
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const terminal = new Set(['success', 'failure', 'cancelled', 'timed_out', 'skipped']);
const maxArchiveBytes = 64 * 1024 ** 2;
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const jobName = unit => unit.kind === 'browser' ? `browser (${unit.engine})` : `test (${unit.id})`;

/** Digest check precedes bounded JSON-only extraction; no caller-supplied extracted object is trusted. */
function archiveJson(artifact, bytes, filename, members = null) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== artifact.size_in_bytes || bytes.length > maxArchiveBytes)
    fail('archive byte size mismatch: ' + artifact.name);
  verifyArtifactBytes(artifact, bytes);
  const temporary = mkdtempSync(join(tmpdir(), 'aihr-resume-source-'));
  try {
    const archive = join(temporary, 'source.zip');
    const extracted = join(temporary, 'json');
    writeFileSync(archive, bytes, {flag: 'wx', mode: 0o600});
    execFileSync('python3', [fileURLToPath(new URL('./extract-artifact.py', import.meta.url)), archive, extracted],
      {timeout: 10000, stdio: 'pipe'});
    if(members&&!isDeepStrictEqual(readdirSync(extracted).sort(),members))fail('supplemental compiler packet members differ');
    return JSON.parse(readFileSync(join(extracted, filename), 'utf8'));
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
}

/** Input snapshots must ultimately be fetched/revalidated independently through authenticated GitHub APIs. */
export function assessResumeSource({expectedPlan, expected, run, jobs, artifacts, archives, now = Date.now()}) {
  // Validate complete source-derived coverage before looking at downloaded evidence.
  const empty = assessResumeCoverage({expectedPlan, expected, reports: []});
  const topology = requiredEvidence(expectedPlan);
  if (!positiveId(expected.runId) || !Number.isFinite(now)) fail('invalid expected run/time');
  if (run?.id !== expected.runId || run.repository?.id !== REPOSITORY_ID
    || run.repository?.full_name !== REPOSITORY || run.head_repository?.id !== REPOSITORY_ID)
    fail('foreign run/repository');
  const allowedEvent = run.event === 'workflow_dispatch'
    || (run.event === 'push' && run.head_branch === 'alpha' && expected.candidate === expected.controller);
  if (run.workflow_id !== WORKFLOW_ID || run.path !== WORKFLOW_PATH || !allowedEvent
    || !['main', 'alpha'].includes(run.head_branch) || run.head_sha !== expected.controller)
    fail('untrusted workflow/controller');
  // A failed whole run may contain useful units, but rerun attempts are not supported by this version.
  if (run.status !== 'completed' || !['success', 'failure'].includes(run.conclusion) || run.run_attempt !== 1)
    fail('source is not a completed first attempt');
  const created = timestamp(run.created_at), finished = timestamp(run.updated_at);
  if (!Number.isFinite(created) || !Number.isFinite(finished) || created > finished
    || now - created > 24 * 60 * 60 * 1000 || finished > now + 60000)
    fail('expired or invalid run time');

  if (!Array.isArray(jobs)) fail('missing complete job inventory');
  const byName = new Map(), jobIds = new Set();
  for (const job of jobs) {
    if (!positiveId(job?.id) || jobIds.has(job.id) || byName.has(job.name)
      || job.run_id !== run.id || job.run_attempt !== 1 || job.head_sha !== expected.controller
      || job.head_branch !== run.head_branch || job.status !== 'completed' || !terminal.has(job.conclusion))
      fail('duplicate, foreign, rerun or incomplete job');
    if (!topology.jobs.includes(job.name) && !(job.name === 'runner-diagnostics' && job.conclusion === 'skipped'))
      fail('unexpected job');
    if (job.conclusion !== 'skipped') {
      const start = timestamp(job.started_at), end = timestamp(job.completed_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < created || end < start || end > finished)
        fail('invalid job time');
    }
    jobIds.add(job.id); byName.set(job.name, job);
  }
  for (const name of topology.jobs) if (!byName.has(name)) fail('omitted job: ' + name);
  for (const name of ['resolve', 'plan', 'controller-tests'])
    if (byName.get(name).conclusion !== 'success') fail('source bootstrap failed: ' + name);
  if (run.conclusion === 'success' && topology.jobs.some(name => byName.get(name).conclusion !== 'success'))
    fail('successful run contradicts job inventory');

  if (!Array.isArray(artifacts) || !(archives instanceof Map) || archives.size !== artifacts.length)
    fail('missing complete artifact/archive inventory');
  const artifactByName = new Map(), artifactIds = new Set();
  for (const artifact of artifacts) {
    const w = artifact?.workflow_run;
    if ((!topology.artifacts.includes(artifact?.name) && artifact?.name !== COMPILER_STATE_ARTIFACT) || artifactByName.has(artifact.name)
      || !positiveId(artifact.id) || artifactIds.has(artifact.id) || artifact.expired !== false
      || !positiveId(artifact.size_in_bytes) || artifact.size_in_bytes > maxArchiveBytes
      || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || !archives.has(artifact.name))
      fail('invalid, foreign, duplicate or expired artifact');
    if (w?.id !== run.id || w.repository_id !== REPOSITORY_ID || w.head_repository_id !== REPOSITORY_ID
      || w.head_sha !== expected.controller || w.head_branch !== run.head_branch)
      fail('artifact run/controller mismatch');
    const when = timestamp(artifact.created_at), expires = timestamp(artifact.expires_at);
    if (!Number.isFinite(when) || !Number.isFinite(expires) || when < created || when > finished || expires <= now)
      fail('invalid artifact time');
    artifactIds.add(artifact.id); artifactByName.set(artifact.name, artifact);
  }
  const planArtifact = artifactByName.get('gate-plan');
  if (!planArtifact) fail('missing archived plan');

  function fromJob(artifact, name, filename, members = null) {
    const job = byName.get(name), when = timestamp(artifact.created_at);
    if (!job || job.conclusion === 'skipped' || when < timestamp(job.started_at) || when > timestamp(job.completed_at))
      fail('artifact outside producing job: ' + artifact.name);
    return archiveJson(artifact, archives.get(artifact.name), filename, members);
  }
  const supplemental = artifactByName.get(COMPILER_STATE_ARTIFACT);
  if(supplemental){
    const producer=fromJob(supplemental,'typecheck','producer.json',COMPILER_PACKET_MEMBERS);
    if(byName.get('typecheck').conclusion!=='success'||producer.kind!=='WHOLE_PROJECT_COMPILER_CACHE_STATE_NOT_TEST_OR_RELEASE'||producer.releaseAuthorized!==false
      ||producer.source!==expected.candidate||producer.controller!==expected.controller||producer.runId!==String(run.id)||producer.attempt!=='1'
      ||producer.exitCode!==0||producer.sourceRestored!==true||producer.controllerRestored!==true||producer.cacheRemoved!==true)
      fail('supplemental compiler cache identity differs');
    // It never supplies a reusable test unit or waives fresh compiler/build prerequisites.
  }
  const plan = fromJob(planArtifact, 'plan', 'ci-plan.json');
  if (!isDeepStrictEqual(plan, expectedPlan)) fail('archived plan differs from independently reconstructed plan');
  const reports = [];
  for (const unit of plan.units) {
    const artifact = artifactByName.get('unit-' + unit.id);
    if (artifact) {
      const report = fromJob(artifact, jobName(unit), `unit-${unit.id}.json`);
      if (report?.id !== unit.id) fail('archive contains another unit report');
      reports.push(report);
    }
  }
  // A receipt in a successful source is checked for byte integrity, never consumed as release authority here.
  const receiptArtifact = artifactByName.get('gate-evidence');
  if (receiptArtifact) fromJob(receiptArtifact, 'verify', 'ci-receipt.json');
  if (run.conclusion === 'success' && topology.artifacts.some(name => !artifactByName.has(name)))
    fail('successful run omitted expected artifacts');
  const assessment = assessResumeCoverage({expectedPlan, expected, reports});
  const reusable = [], rerun = [...assessment.rerun];
  for (const unit of assessment.reusable) {
    const original = plan.units.find(item => item.id === unit.id), job = byName.get(jobName(original));
    if (job.conclusion !== 'success') {
      rerun.push({id: unit.id, reason: 'Producing job did not pass: ' + job.conclusion});
      continue;
    }
    const artifact = artifactByName.get('unit-' + unit.id);
    reusable.push({...unit, source: {runId: run.id, attempt: 1, jobId: job.id,
      artifactId: artifact.id, digest: artifact.digest}});
  }
  const observations = plan.units.map(unit => {
    const job = byName.get(jobName(unit)), artifact = artifactByName.get('unit-' + unit.id);
    return {id: unit.id, jobId: job.id, conclusion: job.conclusion,
      artifact: artifact ? {id: artifact.id, digest: artifact.digest} : null};
  });
  if (reusable.length + rerun.length !== empty.completeRequiredUnits.length) fail('incomplete source assessment');
  return {...assessment, kind: 'OFFLINE_RESUME_SOURCE_INTEGRITY_ASSESSMENT_NOT_RELEASE_EVIDENCE',
    releaseAuthorized: false, apiSnapshotsAuthenticatedByThisTool: false, requiresFreshGitHubApiRevalidation: true,
    requiresLatestFailureHistoryValidation: true, sourceRun: {id: run.id, attempt: 1, conclusion: run.conclusion},
    reusable, rerun, observations};
}
