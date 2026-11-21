/** Independently verify original and replacement evidence without granting a staging install. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {validateMissingDbReplacement, verifyMissingDbCoverage} from './missing-db-recovery-policy.mjs';
import {createPlan, hash} from './plan.mjs';
import {cleanHead, controllerRoot, sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY} from './release-policy.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {inspectFullCiRoleApplicability} from './run-unit.mjs';

const id = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const branch = value => typeof value === 'string' && /^codex\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..');
const api = path => JSON.parse(execFileSync('gh', ['api', `repos/${REPOSITORY}/${path}`],
  {encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 ** 2}));
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', timeout: 60_000}).trim();

function pages(path, key) {
  const all = [];
  for (let index = 1; index <= 10; index++) {
    const data = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${index}`);
    const rows = key ? data[key] : data;
    assert(Array.isArray(rows), 'Missing complete GitHub inventory');
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw Error('GitHub recovery inventory exceeds bound');
}

const ref = name => api('git/ref/heads/' + name.split('/').map(encodeURIComponent).join('/')).object?.sha;
const jobRows = runId => pages(`actions/runs/${runId}/jobs?filter=all`, 'jobs');
const save = (dir, artifact, data) => writeFileSync(join(dir, artifact), JSON.stringify(data, null, 2) + '\n',
  {flag: 'wx', mode: 0o600});

function planAt(candidatePath, controller, baseline) {
  const previous = process.env.AIHR_CI_CLASSIFIER_RUNTIME;
  process.env.AIHR_CI_CLASSIFIER_RUNTIME = 'native';
  try {
    const {fingerprint: _, ...body} = {...createPlan(candidatePath), controller, migrationBase: baseline,
      runtime: {node: '22.23.3', platform: 'linux', arch: 'x64'}};
    return {...body, fingerprint: hash(body)};
  } finally {
    if (previous === undefined) delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;
    else process.env.AIHR_CI_CLASSIFIER_RUNTIME = previous;
  }
}

function diagnostic(runId, controller) {
  assert(id(runId), 'Frozen controller-only diagnostic required');
  return validateRecoveryControllerDiagnostic({run: api(`actions/runs/${runId}`), jobs: jobRows(runId), controller});
}

export async function verifyMissingDbEvidence({candidatePath, sourceRunId, replayRunId, baseline, unitId,
  candidateBranch, producerBranch, producerController, producerDiagnosticRunId, verifierDiagnosticRunId}) {
  assert(id(sourceRunId) && id(replayRunId) && sourceRunId !== replayRunId && sha(baseline) &&
    /^db-[a-f0-9]{16}$/.test(unitId) && branch(candidateBranch) && branch(producerBranch) && sha(producerController),
  'Exact source, replacement, branch and baseline identities required');
  candidatePath = resolve(candidatePath);
  const candidate = cleanHead(candidatePath), verificationController = cleanHead(controllerRoot);
  assert.equal(git(candidatePath, 'remote', 'get-url', 'origin').toLowerCase(),
    `https://github.com/${REPOSITORY.toLowerCase()}.git`, 'Unexpected source origin');
  git(candidatePath, 'merge-base', '--is-ancestor', baseline, candidate);

  const originalRun = api(`actions/runs/${sourceRunId}`);
  const originalController = originalRun.head_sha;
  assert(sha(originalController), 'Original controller identity unavailable');
  git(candidatePath, 'merge-base', '--is-ancestor', originalController, candidate);
  git(controllerRoot, 'merge-base', '--is-ancestor', originalController, producerController);
  git(controllerRoot, 'merge-base', '--is-ancestor', producerController, verificationController);
  assert.deepEqual(git(controllerRoot, 'diff', '--name-only', originalController, producerController).split('\n').sort(),
    ['.github/ci/missing-db-unit.mjs', '.github/ci/missing-db-unit.test.mjs', '.github/workflows/alpha-staging.yml'],
  'Replay controller touched the original runtime or test machinery');

  const checkRefs = () => {
    assert(ref(candidateBranch) === candidate && ref(producerBranch) === producerController, 'Frozen replay refs changed');
    const main = ref('main'), alpha = ref('alpha');
    assert(main === alpha && [originalController, candidate].includes(main), 'Canonical integration refs changed');
  };
  checkRefs();
  const producerDiagnostic = diagnostic(producerDiagnosticRunId, producerController);
  const verificationDiagnostic = diagnostic(verifierDiagnosticRunId, verificationController);
  const oldPlan = planAt(candidatePath, originalController, baseline);
  const newPlan = planAt(candidatePath, producerController, baseline);
  const expectations = {replayRunId, controller: producerController, controllerBranch: producerBranch,
    candidateBranch, unitId, after: originalRun.updated_at};

  const replayMetadata = {run: api(`actions/runs/${replayRunId}`), jobs: jobRows(replayRunId),
    artifacts: pages(`actions/runs/${replayRunId}/artifacts`, 'artifacts')};
  const replayJob = validateMissingDbReplacement(replayMetadata, expectations);
  const dir = mkdtempSync(join(tmpdir(), 'aihr-missing-db-proof-'));
  const source = await collectRecoveryEvidence(sourceRunId, dir, {prefetchDirectory: process.env.AIHR_CI_PREFETCH_DIR || undefined});
  const replay = await collectRecoveryEvidence(replayRunId, join(dir, 'replay'));
  assert.deepEqual(source.run, originalRun, 'Original run changed during retrieval');
  assert.deepEqual({run: replay.run, jobs: replay.jobs, artifacts: replay.artifacts}, replayMetadata,
    'Replay metadata changed during retrieval');

  const assessment = assessResumeSource({...source, expectedPlan: oldPlan,
    expected: {candidate, controller: originalController, baseline, runId: sourceRunId}});
  const originalFailure = assessment.observations.find(unit => unit.id === unitId);
  assert(id(originalFailure?.jobId), 'Original failed job unavailable');
  const annotations = pages(`check-runs/${originalFailure.jobId}/annotations`, null);
  const input = replay.parsed.get('missing-db-unit-inputs');
  assert.deepEqual([...input.keys()].sort(), ['ci-plan.json', 'missing-db-unit-inputs.json']);
  assert.deepEqual(input.get('ci-plan.json'), newPlan, 'Replacement plan differs from independently reconstructed plan');
  const coverage = verifyMissingDbCoverage({source, replay, originalPlan: oldPlan, replayPlan: newPlan, annotations,
    assessment, binding: input.get('missing-db-unit-inputs.json'), replayJob, candidateBranch, unitId,
    roleProfile: inspectFullCiRoleApplicability(
      path => readFileSync(join(candidatePath, path), 'utf8'),
      path => git(candidatePath, 'ls-files', '--', path) === path,
    ),
    reports: new Map(oldPlan.units.filter(unit => unit.id !== unitId).map(({id}) => [
      id, source.parsed.get(`unit-${id}`)?.get(`unit-${id}.json`),
    ])),
    replacementReport: replay.parsed.get(`unit-${unitId}`)?.get(`unit-${unitId}.json`),
  });
  const build = await sourceBoundBuild({candidatePath, dir, jobs: source.jobs,
    p: {candidate, controller: originalController, baseline, runId: sourceRunId, controllerBranch: originalRun.head_branch}});
  assert(cleanHead(candidatePath) === candidate && cleanHead(controllerRoot) === verificationController, 'Source changed during verification');
  checkRefs();

  const certificate = {kind: 'AUTHENTICATED_MISSING_DB_EVIDENCE', releaseAuthorized: false,
    originalConclusion: source.run.conclusion, originalFailure, replayConclusion: replay.run.conclusion,
    producerDiagnostic, verificationDiagnostic, coverage, build};
  save(dir, 'missing-db-verification.json', certificate);
  return {kind: certificate.kind, releaseAuthorized: false, sourceRunId, replayRunId, candidate, baseline,
    retainedUnits: coverage.units.length - 1, replacement: coverage.units.at(-1), tests: coverage.tests,
    fingerprint: hash(certificate), evidenceDirectory: dir};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidatePath, options] = process.argv.slice(2);
  if (!candidatePath || !options) throw Error('Usage: node --import tsx missing-db-recovery.mjs CANDIDATE_WORKTREE JSON_OPTIONS');
  verifyMissingDbEvidence({...JSON.parse(options), candidatePath}).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
