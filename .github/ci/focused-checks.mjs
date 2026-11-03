/** Development evidence only. This never issues a release receipt or invokes deployment. */
import {execFileSync, spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync, constants, openSync, closeSync, fstatSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostHealth} from './host-health.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {reserveSharedEvalAllocation} from './eval/shared-allocation.mjs';
import {createNativeBudgetVerifier} from './eval/native-budget-verifier.mjs';
import {captureRequestedEval, loadEvalPlan, assertFocusedEvalContext, EVAL_CARRIERS} from './eval/contract.mjs';
import {restrictedPortRequest,executeDatabaseSetup,runRestrictedPortQualification,SOURCE_PINS} from './restricted-port-qualification.mjs';
import {capturePostgresEvidence, validatePostgresEvidence, postgresProfileFromEnv, V15_POSTGRES_PROFILE} from './postgres-evidence.mjs';

const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
const closed = 'postgres://nobody:nothing@127.0.0.1:1/no_database';
const databaseKeys = ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'];

export function parseSelection(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16_384) throw Error('Invalid selected-test manifest');
  const files = JSON.parse(value);
  if (!Array.isArray(files) || files.length < 1 || files.length > 64 || new Set(files).size !== files.length)
    throw Error('Select 1–64 distinct tracked test files');
  for (const file of files) {
    if (typeof file !== 'string' || !/^test\/[A-Za-z0-9_./-]+(?:\.test\.ts|\.dom\.test\.tsx)$/.test(file)
      || file.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid selected test path');
  }
  return files.slice().sort();
}

/** No classifier omissions, duplicates, foreign files or invented categories can bypass DB setup. */
export function partitionSelection(files, output) {
  const groups = {NODB: [], DB: []}, seen = new Set();
  for (const line of output.trim().split('\n')) {
    const [kind, file] = line.split('\t');
    if (!Object.hasOwn(groups, kind) || !files.includes(file) || seen.has(file)) throw Error('Invalid candidate classifier output');
    seen.add(file); groups[kind].push(file);
  }
  if (seen.size !== files.length) throw Error('Candidate classifier omitted selected tests');
  return {NODB: groups.NODB.sort(), DB: groups.DB.sort()};
}

/** A focused pass still requires every selected file/assertion to execute; skips are not passes. */
export function verifyFocusedResult(result, files, cwd, evalContext) {
  if (!result || result.success !== true || !Array.isArray(result.testResults)
    || result.numFailedTests !== 0 || result.numFailedTestSuites !== 0) throw Error('Focused test failure');
  const seen = new Set(); let assertions = 0;
  for (const suite of result.testResults) {
    const file = isAbsolute(suite.name ?? '') ? relative(cwd, suite.name) : suite.name;
    if (!files.includes(file) || seen.has(file) || suite.status !== 'passed'
      || !Array.isArray(suite.assertionResults) || suite.assertionResults.length === 0) throw Error('Incomplete selected suite coverage');
    seen.add(file);
    for (const assertion of suite.assertionResults) {
      if (assertion.status !== 'passed') throw Error('Skipped or failed selected assertion');
      assertions++;
    }
  }
  if (seen.size !== files.length || assertions === 0 || result.numTotalTests !== assertions
    || result.numPassedTests !== assertions) throw Error('Incomplete selected assertion coverage');
  const evaluation = assertFocusedEvalContext(evalContext, files);
  if (evaluation && typeof evalContext.onVerified === 'function') evalContext.onVerified(evaluation);
  return assertions;
}

/** The candidate classifier is source execution, but never a credential consumer.
 * Preserve its ordinary DB/resource/runtime environment without forwarding evaluation capabilities. */
export function classifierEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith('AIHR_EVAL_') && !key.startsWith('AI_SPEND_RECEIPT_')));
}

/** Must finish before any candidate subprocess. loadPlan only reads pinned source bytes. */
export function admitFocusedEvaluation({env, files, identity, loadPlan, budgetAdmission, budgetVerifier, nativeVerification = false}) {
  const request = captureRequestedEval(env, files, identity);
  if (!request) return {request: null, plan: null};
  const plan = loadPlan(request);
  if (typeof budgetAdmission !== 'function' || typeof budgetVerifier !== 'function')
    throw Error('Requested model evaluation: verified budget admission is unavailable');
  const admission = budgetAdmission({request, plan, identity});
  if (admission?.admitted !== true) throw Error('Requested model evaluation: verified budget admission is unavailable');
  return {request, plan, nativeScope: nativeVerification ? captureNativeBudgetScope(admission.nativeScope, request) : admission.nativeScope};
}

/** Called only on a TRUSTED admission callback's result, never an env/receipt descriptor.
 * The independently provisioned tenant must be selected before candidate execution. */
export function captureNativeBudgetScope(value, request) {
  if (!value || Object.keys(value).sort().join(',') !== 'allocationNanos,maxAttempts,tenantId'
    || typeof value.tenantId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.tenantId)
    || value.tenantId === '00000000-0000-0000-0000-000000000000'
    || typeof request.budgetUsd !== 'number' || !Number.isFinite(request.budgetUsd)
    || request.budgetUsd <= 0 || request.budgetUsd > 15
    || value.allocationNanos !== BigInt(request.budgetUsd.toFixed(9).replace('.', '')).toString()
    || value.maxAttempts !== 1500) throw Error('Requested model evaluation: independent native scope is unavailable');
  return Object.freeze({...value});
}
/** Operator entry point. The review owner must verify provisioning and the full
 * profile bound before returning a native scope. Keep the ledger outside candidate access.
 * A single campaign directory must serve every profile and GitHub attempt.
 */
export function createSharedEvalAdmission({directory, verifyProvisioning}) {
  if (typeof verifyProvisioning !== 'function') throw Error('Independent eval provisioning review is required');
  return ({request, plan, identity}) => {
    const nativeScope = captureNativeBudgetScope(verifyProvisioning({request, plan, identity}), request);
    const attemptId = `run-${identity.runId}-attempt-${identity.attempt}`;
    reserveSharedEvalAllocation(directory, attemptId, nativeScope.allocationNanos);
    return {admitted: true, nativeScope};
  };
}

function readIndependentNativeLedger(scope) {
  const script = fileURLToPath(new URL('./eval/native-ledger-reader.mjs', import.meta.url));
  const env = Object.fromEntries(['PATH', 'HOME', 'RUNNER_TEMP', 'GITHUB_ACTIONS', 'CI', 'RUNNER_ENVIRONMENT', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawnSync(process.execPath, [script], {cwd: fileURLToPath(new URL('.', import.meta.url)), env,
    input: JSON.stringify({tenantId: scope.tenantId, maxAttempts: scope.maxAttempts}),
    encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024});
  if (child.error || child.status !== 0) throw Error('Independent native evaluation ledger unavailable');
  return JSON.parse(child.stdout);
}

function runnerOnly() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true' || process.platform !== 'linux'
    || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.GITHUB_REPOSITORY !== 'StradaverseHub/ai-hr'
    || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''))
    throw Error('Disposable standard GitHub runners only');
}

function assertCandidate(cwd, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '') || git(cwd, 'rev-parse', 'HEAD') !== sha
    || git(cwd, 'status', '--porcelain')) throw Error('Candidate is not the requested clean exact SHA');
}

function checkedTrackedFiles(cwd, files) {
  const records = execFileSync('git', ['ls-files', '--stage', '-z', '--', 'test'], {cwd, encoding: 'utf8'}).split('\0');
  const tracked = new Map(records.filter(Boolean).map(record => {
    const [entry, file] = record.split('\t'); return [file, entry.split(' ')];
  }));
  for (const file of files) {
    const entry = tracked.get(file);
    const target = relative(realpathSync(cwd), realpathSync(join(cwd, file)));
    if (!entry || !['100644', '100755'].includes(entry[0]) || entry[2] !== '0'
      || target.startsWith('../') || isAbsolute(target)) throw Error('Selection must contain tracked regular candidate files');
  }
}

function testEnvironment(kind, profileDirectory) {
  const env = {...process.env, VITEST_MAX_WORKERS: '2', VITEST_MAX_WORKERS_NODB: '2', TEST_DB_NAMESPACE: 'aifocus'};
  delete env.AIHR_EVAL_REHEARSAL_TENANT;
  delete env.AIHR_EVAL_RETAIN_NATIVE_LEDGER; // Only trusted admission below can request retention.
  const urls = [
    'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev', 'postgres://postgres@127.0.0.1:5433/ai_hr_dev',
    'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test', 'postgres://postgres@127.0.0.1:5433/ai_hr_test',
  ];
  databaseKeys.forEach((key, index) => { env[key] = kind === 'DB' ? urls[index] : closed; });
  if (kind === 'NODB') env.GATE_NODB_PROOF = '1';
  if (kind === 'DB' && process.env.AIHR_FOCUSED_PROFILE === 'true') env.AIHR_TEST_PROFILE_DIR = profileDirectory;
  return env;
}

export function assertFocusedPostgresProfile(env) {
  const profile = postgresProfileFromEnv(env);
  assert.deepEqual(profile, V15_POSTGRES_PROFILE, 'Focused DB checks require the exact v15 PostgreSQL profile');
  return profile;
}

// This identity includes the execution profile, separately from the selected-file hash.
export function focusedPlanIdentity({sha, controller, files, groups, classifierHash, execution}) {
  const plan = {policyVersion: CI_POLICY, sha, controller, files, groups, classifierHash, execution};
  return {...plan, fingerprint: hash(JSON.stringify(plan))};
}

export function runFocused(destination, {evalBudgetAdmission, evalBudgetVerifier} = {}) {
  runnerOnly();
  const cwd = process.cwd(), sha = process.env.AIHR_CI_HEAD, controller = process.env.AIHR_CI_CONTROL_HEAD;
  assertCandidate(cwd, sha);
  if (!/^[0-9a-f]{40}$/.test(controller ?? '')) throw Error('Missing exact focused controller identity');
  const files = parseSelection(process.env.AIHR_FOCUSED_TESTS);
  checkedTrackedFiles(cwd, files);
  const dir = resolve(destination), runnerTemp = realpathSync(process.env.RUNNER_TEMP);
  if (!relative(runnerTemp, dir) || relative(runnerTemp, dir).startsWith('../') || isAbsolute(relative(runnerTemp, dir)))
    throw Error('Evidence must use an owned directory under RUNNER_TEMP');
  mkdirSync(dir, {recursive: true});
  const evalIdentity = {sourceSha: sha, controllerSha: controller,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    runtime: {node: process.versions.node, platform: process.platform, arch: process.arch}};
  const report = {kind: 'FOCUSED_ONLY', releaseEligible: false, schemaVersion: 1, sha, controller,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    runtime: evalIdentity.runtime, startedAt: new Date().toISOString(),
    files, manifestHash: hash(JSON.stringify(files)), batches: [], exitCode: 1};
  const pgEnv = {...process.env, AIHR_CI_UNIT: 'db-1'};
  let touchedDatabase = false, postgresProfile = null;
  let evalRequest = null, evalPlan = null, nativeScope = null, nativeRows = null;
  const budgetVerifier = evalBudgetVerifier ?? createNativeBudgetVerifier({readNativeEvidence(expected) {
    if (!nativeScope || !nativeRows) throw Error('Independent native evaluation scope unavailable');
    return {identity: expected.identity, evaluationId: `${expected.identity.runId}:${expected.identity.attempt}:${expected.planHash}`,
      tenantId: nativeScope.tenantId, planHash: expected.planHash, corpusReviewDigest: expected.corpusReviewDigest,
      allocationNanos: nativeScope.allocationNanos, maxAttempts: nativeScope.maxAttempts,
      rows: nativeRows};
  }});
  try {
    if (process.env.AIHR_EVAL_MODEL?.trim() || process.env.AIHR_EVAL_REQUESTED === 'true')
      report.evaluation = {requested: true, status: 'admission_refused', executionComplete: false,
        measurementPassed: false, safetyPassed: null, qualityPassed: null, requiresHumanReview: null,
        budgetVerified: false, releaseEligible: false};
    const admission = admitFocusedEvaluation({env: process.env, files,
      identity: evalIdentity, loadPlan: request => loadEvalPlan(request, cwd),
      budgetAdmission: evalBudgetAdmission, budgetVerifier, nativeVerification: !evalBudgetVerifier});
    ({request: evalRequest, plan: evalPlan} = admission);
    if (evalRequest && !evalBudgetVerifier) nativeScope = admission.nativeScope;
    if (evalRequest) report.evaluation = {...report.evaluation, request: evalRequest,
      planHash: evalPlan.planHash, corpusReviewDigest: evalPlan.corpusReviewDigest,
      plannedCaseIds: evalPlan.cases.map(row => row.id), status: 'admitted_not_measured'};

    // All requested monetary admission precedes this first candidate subprocess, even classification.
    const classifier = 'scripts/gate-db-classify.ts';
    const output = execFileSync(process.execPath, ['--import', 'tsx', classifier, 'explain'], {
      cwd, input: files.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: classifierEnvironment(process.env),
    });
    const groups = partitionSelection(files, output);
    const qualifyPort = restrictedPortRequest(process.env.AIHR_QUALIFY_RESTRICTED_PORT, groups, process.env.AIHR_RESTRICTED_PORT_TYPECHECK);
    postgresProfile = groups.DB.length ? assertFocusedPostgresProfile(process.env) : null;
    Object.assign(report, focusedPlanIdentity({sha, controller, files, groups, classifierHash: hash(readFileSync(classifier)),
      execution: {workers: 2, postgres: postgresProfile, ...(qualifyPort?{restrictedPortPrerequisite:{version:2,sourcePins:SOURCE_PINS}}:{})}}));
    report.healthBefore = hostHealth();
    if (!report.healthBefore.ok) throw Error('Runner disk headroom below shared resource guard');
    for (const kind of ['NODB', 'DB']) {
      const selected = groups[kind];
      if (!selected.length) continue;
      const batch = {kind, files: selected, exitCode: 1, startedAt: new Date().toISOString()}; report.batches.push(batch);
      try {
        const env = testEnvironment(kind, join(dir, 'harness-profile'));
        if (evalRequest) Object.assign(env, {AIHR_EVAL_REQUESTED: 'true', AIHR_EVAL_PATH: 'production',
          AIHR_EVAL_PLAN_HASH: evalPlan.planHash, AIHR_EVAL_CORPUS_REVIEW_DIGEST: evalPlan.corpusReviewDigest,
          ...(nativeScope ? {AIHR_EVAL_RETAIN_NATIVE_LEDGER: 'true'} : {})});
        if (!evalRequest && kind === 'DB' && files.length === 1 && files[0] === 'test/ai-eval-native-witness.test.ts') {
          const tenantId = randomUUID();
          for (const key of Object.keys(env)) {
            if (key.startsWith('AIHR_EVAL_') || key.startsWith('AI_SPEND_RECEIPT_')) delete env[key];
          }
          env.AIHR_EVAL_REHEARSAL_TENANT = tenantId;
          report.provisioningRehearsal = {tenantId, transport: 'fictional', paidAdmission: false};
        }
        if (kind === 'DB') {
          if (!hostHealth().ok) throw Error('Runner disk headroom below guard before DB batch');
          touchedDatabase = true;
          if (qualifyPort) batch.prerequisiteQualification = {enabled:true,status:'pending'};
          executeDatabaseSetup(qualifyPort, {
            reset(){if (spawnSync('bash', [postgres, 'reset'], {stdio: 'inherit', env: pgEnv}).status !== 0) throw Error('Owned PostgreSQL setup failed');},
            before(){runRestrictedPortQualification(cwd,'before',dir,env);},
            migrate(){if (spawnSync('pnpm', ['db:migrate'], {stdio: 'inherit', env}).status !== 0) throw Error('Candidate migration failed');},
            after(){runRestrictedPortQualification(cwd,'after',dir,env);},
          });
          if (qualifyPort) batch.prerequisiteQualification.status = 'passed';
        }
        const resultPath = join(dir, `${kind.toLowerCase()}.vitest.json`);
        const args = ['exec', 'vitest', 'run'];
        if (kind === 'NODB') args.push('--config', 'vitest.nodb.config.ts');
        args.push(...selected, '--reporter=default', '--reporter=json', '--outputFile.json=' + resultPath);
        const child = spawnSync('pnpm', args, {stdio: 'inherit', env});
        batch.processExitCode = child.status; batch.signal = child.signal;
        // Preserve native holds even when the paid trial failed; qualification runs only AFTER capture.
        if (evalRequest && nativeScope && kind === 'DB') {
          nativeRows = Object.freeze(readIndependentNativeLedger(nativeScope).map(row => Object.freeze(row)));
          const nativeBytes = JSON.stringify({identity: evalIdentity, scope: nativeScope, rows: nativeRows}) + '\n';
          writeFileSync(join(dir, 'native-ledger.json'), nativeBytes, {flag: 'wx', mode: 0o600});
          report.evaluation.nativeLedgerHash = hash(nativeBytes);
        }
        if (child.error || child.status !== 0) throw Error('Selected test process failed');
        let evalContext;
        if (evalRequest) {
          const receiptPath = join(dir, EVAL_CARRIERS[evalRequest.carrier].receiptFile);
          const fd = openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          let receiptBytes;
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
              throw Error('Requested model evaluation: invalid measurement receipt file');
            receiptBytes = readFileSync(fd);
          } finally { closeSync(fd); }
          const receipt = JSON.parse(receiptBytes);
          evalContext = {requested: true, request: evalRequest, plan: evalPlan, receipt,
            identity: evalIdentity, budgetVerifier,
            onAssessment(summary) { report.evaluation = {...report.evaluation, ...summary,
              status: summary.measurementPassed ? 'measurement_passed' : summary.requiresHumanReview ? 'review_required' : 'measurement_failed'}; }};
          report.evaluation.receiptHash = hash(receiptBytes);
        }
        batch.assertions = verifyFocusedResult(JSON.parse(readFileSync(resultPath, 'utf8')), selected, cwd, evalContext);

        batch.exitCode = 0;
      } catch (error) { batch.error = error instanceof Error ? error.message : 'Focused batch failed'; if(batch.prerequisiteQualification?.status==='pending')batch.prerequisiteQualification.status='failed'; }
      finally { batch.endedAt = new Date().toISOString(); }
    }
    assertCandidate(cwd, sha);
    report.exitCode = report.batches.every(batch => batch.exitCode === 0) ? 0 : 1;
  } catch (error) { report.error = error instanceof Error ? error.message : 'Focused checks failed'; }
  finally {
    if (touchedDatabase) {
      try {
        report.databaseTerminalEvidence = capturePostgresEvidence('db-1', postgresProfile);
        validatePostgresEvidence(report.databaseTerminalEvidence, {postgres: postgresProfile});
      } catch (error) { report.databaseTelemetryError = String(error); report.exitCode = 1; }
      const stats = spawnSync('bash', [postgres, 'stats'], {encoding: 'utf8', env: pgEnv});
      if (stats.status !== 0) report.exitCode = 1;
      writeFileSync(join(dir, 'postgres-stats.txt'), (stats.stdout ?? '') + (stats.stderr ?? ''), {flag: 'wx'});
      // Stats validates container ownership before these read-only diagnostics; preserve before stop.
      if (stats.status === 0) {
        const name = `aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-db-1`;
        for (const [file, args] of [['postgres.log', ['logs', name]], ['postgres-state.json', ['inspect', '--format', '{{json .State}}', name]]]) {
          const result = spawnSync('docker', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
          writeFileSync(join(dir, file), (result.stdout ?? '') + (result.stderr ?? ''), {flag: 'wx'});
        }
      }
      if (spawnSync('bash', [postgres, 'stop'], {stdio: 'inherit', env: pgEnv}).status !== 0) report.exitCode = 1;
    }
    report.endedAt = new Date().toISOString();
    report.healthAfter = hostHealth();
    writeFileSync(join(dir, 'focused.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Focused development checks\nCandidate: ${sha}\nController: ${controller}\nSelected files: ${files.length}\nExit: ${report.exitCode}\n\nFOCUSED ONLY — no release receipt, full coverage or deployment approval.\n`);
  }
  return report.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'selection' && process.argv.length === 3) {
    const files = parseSelection(process.env.AIHR_FOCUSED_TESTS);
    appendFileSync(process.env.GITHUB_OUTPUT, `tests=${JSON.stringify(files)}\n`);
  } else if (command === 'run' && process.argv.length === 4) process.exitCode = runFocused(process.argv[3]);
  else throw Error('Usage: focused-checks.mjs selection | run <owned-evidence-directory>');
}
