/** Development evidence only. This never issues a release receipt or invokes deployment. */
import {execFileSync, spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostHealth} from './host-health.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {restrictedPortRequest,executeDatabaseSetup,runRestrictedPortQualification,SOURCE_PINS} from './restricted-port-qualification.mjs';
import {capturePostgresEvidence, validatePostgresEvidence, postgresProfileFromEnv, V15_POSTGRES_PROFILE} from './postgres-evidence.mjs';

const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
export const employeeBenchmarkFile='test/employee-choice-native-purpose-plan.test.ts';
export const employeeNativeControlFile='test/employee-choice-benchmark-owner-native.test.ts';
const benchmarkSupervisor=fileURLToPath(new URL('./employee-benchmark-supervisor.py',import.meta.url));
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
export function verifyFocusedResult(result, files, cwd) {
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
  return assertions;
}

export function isEmployeeChoiceBenchmark(files){return files.length===1&&files[0]===employeeBenchmarkFile;}
export function isEmployeeChoiceNativeControls(files){return files.length===1&&files[0]===employeeNativeControlFile;}

export function focusedBenchmarkStageFrontier(execute){
 let poisoned=false;
 return(name,options={})=>{
  if(poisoned&&['reset','migrate','benchmark','native-controls'].includes(name))throw Error('Uncertain benchmark owner refuses new SQL work');
  try{const result=execute(name,options);if(result.error||result.status!==0)poisoned=true;return result;}catch(error){poisoned=true;throw error;}
 };
}
export function finalizeFocusedBenchmark(partial,cleanup,refused){
 let unavailable=false,refusalCallbackFailed=false;
 try{partial();}catch{unavailable=true;try{refused();}catch{refusalCallbackFailed=true;}}
 try{cleanup();}catch(error){if(unavailable)throw new AggregateError([Error('Partial focused evidence persistence refused'),error],'Focused evidence and cleanup both refused');throw error;}
 if(refusalCallbackFailed)throw Error('Focused evidence refusal reporting failed after mandatory cleanup');
}

function runnerOnly() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true' || process.platform !== 'linux'
    || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.GITHUB_REPOSITORY !== 'StradaverseHub/ai-hr'
    || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''))
    throw Error('Disposable standard GitHub runners only');
}

function assertCandidate(cwd, sha, metadata) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '') || (metadata?metadata('git-head'):git(cwd, 'rev-parse', 'HEAD')) !== sha
    || (metadata?metadata('git-status'):git(cwd, 'status', '--porcelain'))) throw Error('Candidate is not the requested clean exact SHA');
}

function checkedTrackedFiles(cwd, files, metadata) {
  const records = (metadata?metadata('git-tracked'):execFileSync('git', ['ls-files', '--stage', '-z', '--', 'test'], {cwd, encoding: 'utf8'})).split('\0');
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

export function runFocused(destination) {
  runnerOnly();
  const cwd = process.cwd(), sha = process.env.AIHR_CI_HEAD, controller = process.env.AIHR_CI_CONTROL_HEAD;
  if (!/^[0-9a-f]{40}$/.test(controller ?? '')) throw Error('Missing exact focused controller identity');
  const files = parseSelection(process.env.AIHR_FOCUSED_TESTS);
  const benchmark=isEmployeeChoiceBenchmark(files),nativeControls=isEmployeeChoiceNativeControls(files),supervised=benchmark||nativeControls;
  const dir = resolve(destination), runnerTemp = realpathSync(process.env.RUNNER_TEMP);
  if (!relative(runnerTemp, dir) || relative(runnerTemp, dir).startsWith('../') || isAbsolute(relative(runnerTemp, dir)))
    throw Error('Evidence must use an owned directory under RUNNER_TEMP');
  mkdirSync(dir, {recursive: true});
  const stage=focusedBenchmarkStageFrontier((name,options={})=>spawnSync('python3',['-I','-B',benchmarkSupervisor,JSON.stringify({stage:name,node:process.execPath,
    controller:resolve(fileURLToPath(new URL('../..',import.meta.url))),destination:dir})],{cwd,...options}));
  const metadata=supervised?name=>{const result=stage(name,{encoding:'utf8',maxBuffer:1024*1024});if(result.error||result.status!==0)throw Error('Supervised metadata refused');return result.stdout.trimEnd();}:undefined;
  assertCandidate(cwd,sha,metadata);
  checkedTrackedFiles(cwd, files,metadata);
  const classifier = 'scripts/gate-db-classify.ts';
  const classificationOptions={cwd,input:files.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024};
  const classification=supervised?stage('classifier',classificationOptions):null;
  if(supervised&&(classification.error||classification.status!==0))throw Error('Supervised classifier refused');
  const output=supervised?classification.stdout:execFileSync(process.execPath,['--import','tsx',classifier,'explain'],classificationOptions);
  const groups = partitionSelection(files, output);
  const qualifyPort = restrictedPortRequest(process.env.AIHR_QUALIFY_RESTRICTED_PORT, groups, process.env.AIHR_RESTRICTED_PORT_TYPECHECK);
  const postgresProfile = groups.DB.length ? assertFocusedPostgresProfile(process.env) : null;

  const identity = focusedPlanIdentity({sha, controller, files, groups, classifierHash: hash(readFileSync(classifier)),
    execution: {workers: 2, postgres: postgresProfile, ...(qualifyPort?{restrictedPortPrerequisite:{version:2,sourcePins:SOURCE_PINS}}:{})}});
  const report = {kind: 'FOCUSED_ONLY', releaseEligible: false, schemaVersion: 1, sha, controller,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    runtime: {node: process.versions.node, platform: process.platform, arch: process.arch},
    startedAt: new Date().toISOString(), ...identity, manifestHash: hash(JSON.stringify(files)), batches: [], exitCode: 1};
  const pgEnv = {...process.env, AIHR_CI_UNIT: 'db-1'};
  let touchedDatabase = false;
  try {
    report.healthBefore = hostHealth();
    if (!report.healthBefore.ok) throw Error('Runner disk headroom below shared resource guard');
    for (const kind of ['NODB', 'DB']) {
      const selected = groups[kind];
      if (!selected.length) continue;
      const batch = {kind, files: selected, exitCode: 1, startedAt: new Date().toISOString()}; report.batches.push(batch);
      try {
        const env = testEnvironment(kind, join(dir, 'harness-profile'));
        if (kind === 'DB') {
          if (!hostHealth().ok) throw Error('Runner disk headroom below guard before DB batch');
          touchedDatabase = true;
          if (qualifyPort) batch.prerequisiteQualification = {enabled:true,status:'pending'};
          executeDatabaseSetup(qualifyPort, {
            reset(){if ((supervised?stage('reset',{stdio:'inherit',env:pgEnv}):spawnSync('bash', [postgres, 'reset'], {stdio: 'inherit', env: pgEnv})).status !== 0) throw Error('Owned PostgreSQL setup failed');},
            before(){runRestrictedPortQualification(cwd,'before',dir,env);},
            migrate(){if ((supervised?stage('migrate',{stdio:'inherit',env}):spawnSync('pnpm', ['db:migrate'], {stdio: 'inherit', env})).status !== 0) throw Error('Candidate migration failed');},
            after(){runRestrictedPortQualification(cwd,'after',dir,env);},
          });
          if (qualifyPort) batch.prerequisiteQualification.status = 'passed';
        }
        const resultPath = join(dir, `${kind.toLowerCase()}.vitest.json`);
        const args = ['exec', 'vitest', 'run'];
        if (kind === 'NODB') args.push('--config', 'vitest.nodb.config.ts');
        args.push(...selected, '--reporter=default', '--reporter=json', '--outputFile.json=' + resultPath);
        const child = supervised?stage(nativeControls?'native-controls':'benchmark',{stdio:'inherit',env}):spawnSync('pnpm', args, {stdio: 'inherit', env});
        batch.processExitCode = child.status; batch.signal = child.signal;
        if (child.error || child.status !== 0) throw Error('Selected test process failed');
        batch.assertions = verifyFocusedResult(JSON.parse(readFileSync(resultPath, 'utf8')), selected, cwd);
        batch.exitCode = 0;
      } catch (error) { batch.error = error instanceof Error ? error.message : 'Focused batch failed'; if(batch.prerequisiteQualification?.status==='pending')batch.prerequisiteQualification.status='failed'; }
      finally { batch.endedAt = new Date().toISOString(); }
    }
    assertCandidate(cwd, sha,metadata);
    report.exitCode = report.batches.every(batch => batch.exitCode === 0) ? 0 : 1;
  } catch (error) { report.error = error instanceof Error ? error.message : 'Focused checks failed'; }
  finally {
    const partial=()=>writeFileSync(join(dir,'focused-partial.json'),JSON.stringify({...report,kind:'FOCUSED_PARTIAL_ONLY',complete:false,exitCode:1,endedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
    const cleanup=()=>{
    if (touchedDatabase) {
      const terminal=()=>{
      try {
        if(supervised){const terminal=stage('evidence',{encoding:'utf8',maxBuffer:2*1024*1024,env:pgEnv});if(terminal.error||terminal.status!==0)throw Error('Supervised terminal evidence refused');report.databaseTerminalEvidence=JSON.parse(terminal.stdout);}
        else report.databaseTerminalEvidence = capturePostgresEvidence('db-1', postgresProfile);
        validatePostgresEvidence(report.databaseTerminalEvidence, {postgres: postgresProfile});
      } catch (error) { report.databaseTelemetryError = String(error); report.exitCode = 1; }
      const stats = supervised?stage('stats',{encoding:'utf8',env:pgEnv}):spawnSync('bash', [postgres, 'stats'], {encoding: 'utf8', env: pgEnv});
      if (stats.status !== 0) report.exitCode = 1;
      writeFileSync(join(dir, 'postgres-stats.txt'), (stats.stdout ?? '') + (stats.stderr ?? ''), {flag: 'wx'});
      // Stats validates container ownership before these read-only diagnostics; preserve before stop.
      if (stats.status === 0) {
        const name = `aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-db-1`;
        for (const [file, args] of [['postgres.log', ['logs', name]], ['postgres-state.json', ['inspect', '--format', '{{json .State}}', name]]]) {
          const result = supervised?stage(file==='postgres.log'?'logs':'inspect',{encoding:'utf8',maxBuffer:16*1024*1024}):spawnSync('docker', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
          writeFileSync(join(dir, file), (result.stdout ?? '') + (result.stderr ?? ''), {flag: 'wx'});
        }
      }
      };
      const dispose=()=>{if ((supervised?stage('stop',{stdio:'inherit',env:pgEnv}):spawnSync('bash', [postgres, 'stop'], {stdio: 'inherit', env: pgEnv})).status !== 0) report.exitCode = 1;};
      if(supervised)finalizeFocusedBenchmark(terminal,dispose,()=>{report.exitCode=1;report.databaseTerminalCaptureError='terminal-persistence-refused';});else{terminal();dispose();}
    }
    report.endedAt = new Date().toISOString();
    report.healthAfter = hostHealth();
    writeFileSync(join(dir, 'focused.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Focused development checks\nCandidate: ${sha}\nController: ${controller}\nSelected files: ${files.length}\nExit: ${report.exitCode}\n\nFOCUSED ONLY — no release receipt, full coverage or deployment approval.\n`);
    };
    if(supervised)finalizeFocusedBenchmark(partial,cleanup,()=>{report.exitCode=1;report.partialEvidenceError='partial-persistence-refused';});else cleanup();
  }
  return report.exitCode;
}

export function cleanupEmployeeChoiceBenchmark(destination){
  runnerOnly();
  const files=parseSelection(process.env.AIHR_FOCUSED_TESTS);if(!isEmployeeChoiceBenchmark(files)&&!isEmployeeChoiceNativeControls(files))throw Error('Sole employee benchmark/control cleanup required');
  const dir=resolve(destination),expected=join(realpathSync(process.env.RUNNER_TEMP),'aihr-focused');
  if(dir!==expected)throw Error('Fixed benchmark cleanup evidence directory required');
  mkdirSync(dir,{recursive:true});
  const result=spawnSync('python3',['-I','-B',benchmarkSupervisor,JSON.stringify({stage:'stop',node:process.execPath,
    controller:resolve(fileURLToPath(new URL('../..',import.meta.url))),destination:dir})],{stdio:'inherit'});
  return result.error||result.status!==0?1:0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'selection' && process.argv.length === 3) {
    const files = parseSelection(process.env.AIHR_FOCUSED_TESTS);
    appendFileSync(process.env.GITHUB_OUTPUT, `tests=${JSON.stringify(files)}\n`);
  } else if (command === 'run' && process.argv.length === 4) process.exitCode = runFocused(process.argv[3]);
  else if(command === 'cleanup' && process.argv.length === 4) process.exitCode=cleanupEmployeeChoiceBenchmark(process.argv[3]);
  else throw Error('Usage: focused-checks.mjs selection | run <owned-evidence-directory> | cleanup <fixed-benchmark-evidence-directory>');
}
