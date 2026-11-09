/** Development evidence only. This never issues a release receipt or invokes deployment. */
import {execFileSync, spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostHealth} from './host-health.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {assertSingletonSelection} from './singleton-protocol.mjs';
import {restrictedPortRequest,executeDatabaseSetup,runRestrictedPortQualification,SOURCE_PINS} from './restricted-port-qualification.mjs';
import {capturePostgresEvidence, validatePostgresEvidence, postgresProfileFromEnv, V15_POSTGRES_PROFILE} from './postgres-evidence.mjs';
import {compilerProcIdentity,boundedCompilerBytes} from './diagnostics/native-reference/admission.mjs';
import {EMPLOYEE_LIFECYCLE_PROFILE} from './employee-lifecycle-profile.mjs';
import {employeeAsciiSelection,captureEmployeeAsciiCell,finishEmployeeAsciiCell} from './employee-ascii-runtime-qualification.mjs';

const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
export const [employeeBenchmarkFile,employeeNativeControlFile,employeeNativeFactoryFile,employeeAsciiPurposeFile,employeeAsciiPlanFile]=EMPLOYEE_LIFECYCLE_PROFILE.files.map(row=>row.file);
export const compilerReferenceFile='test/compiler-native-reference-fixture.test.ts';
export const compilerApplicationInventoryFile='test/compiler-native-application-inventory.test.ts';
const benchmarkSupervisor=fileURLToPath(new URL('./employee-benchmark-supervisor.py',import.meta.url));
const compilerSupervisor=fileURLToPath(new URL('./compiler-reference-supervisor.py',import.meta.url));
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
  if(files.includes(compilerApplicationInventoryFile)&&files.length!==1)throw Error('Application compiler inventory requires its sole closed selector');
  assertSingletonSelection(files);return files.slice().sort();
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
export function isEmployeeChoiceNativeFactory(files){return files.length===1&&files[0]===employeeNativeFactoryFile;}

export function isEmployeeChoiceAsciiPurpose(files){return files.length===1&&files[0]===employeeAsciiPurposeFile;}
export function isEmployeeChoiceAsciiPlan(files){return files.length===1&&files[0]===employeeAsciiPlanFile;}
export function isCompilerReferenceFixture(files){return files.length===1&&files[0]===compilerReferenceFile;}
export function isCompilerApplicationInventory(files){return files.length===1&&files[0]===compilerApplicationInventoryFile;}
function compilerPurpose(files){
 if(isCompilerReferenceFixture(files))return{selector:compilerReferenceFile,stage:'compiler-reference',manifest:'docs/qualification/compiler-native-date-library-reference-source-20261109.json',kind:'COMPILER_REFERENCE_OWNED_PROCESS_SOURCE_NOT_QUALIFICATION',preflight:'compiler-reference-preflight.json',preflightKind:'OWNED_COMPILER_REFERENCE_PREFLIGHT_NOT_RELEASE',journal:'compiler-supervisor.jsonl',purpose:'reference'};
 if(isCompilerApplicationInventory(files))return{selector:compilerApplicationInventoryFile,stage:'compiler-application-inventory',manifest:'docs/qualification/compiler-native-application-inventory-source-20261108.json',kind:'COMPILER_NATIVE_APPLICATION_INVENTORY_SOURCE_NOT_QUALIFICATION',preflight:'compiler-application-inventory-preflight.json',preflightKind:'OWNED_COMPILER_APPLICATION_INVENTORY_PREFLIGHT_NOT_RELEASE',journal:'compiler-application-inventory-supervisor.jsonl',purpose:'application'};
 throw Error('Sole closed native compiler purpose required');
}

export function focusedBenchmarkStageFrontier(execute){
 let poisoned=false;
 return(name,options={})=>{
  if(poisoned&&['compiler-reference','compiler-application-inventory'].includes(name))throw Error('Uncertain compiler owner refuses new work');
  if(poisoned&&['reset','migrate','benchmark','native-controls','native-factory','ascii-purpose','ascii-plan'].includes(name))throw Error('Uncertain benchmark owner refuses new SQL work');
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
  const benchmark=isEmployeeChoiceBenchmark(files),nativeControls=isEmployeeChoiceNativeControls(files),nativeFactory=isEmployeeChoiceNativeFactory(files),asciiPurpose=isEmployeeChoiceAsciiPurpose(files),asciiPlan=isEmployeeChoiceAsciiPlan(files),compilerApplication=isCompilerApplicationInventory(files),compiler=isCompilerReferenceFixture(files)||compilerApplication,supervised=benchmark||nativeControls||nativeFactory||asciiPurpose||asciiPlan||compiler;
  const dir = resolve(destination), runnerTemp = realpathSync(process.env.RUNNER_TEMP);
  if (!relative(runnerTemp, dir) || relative(runnerTemp, dir).startsWith('../') || isAbsolute(relative(runnerTemp, dir)))
    throw Error('Evidence must use an owned directory under RUNNER_TEMP');
  mkdirSync(dir, {recursive: true});
  const stage=focusedBenchmarkStageFrontier((name,options={})=>spawnSync(compiler?'/usr/bin/python3':'python3',['-I','-B',compiler?compilerSupervisor:benchmarkSupervisor,JSON.stringify({stage:name,node:process.execPath,
    controller:resolve(fileURLToPath(new URL('../..',import.meta.url))),destination:dir})],{cwd,...options}));
  const metadata=supervised?name=>{const result=stage(name,{encoding:'utf8',maxBuffer:1024*1024});if(result.error||result.status!==0)throw Error('Supervised metadata refused');return result.stdout.trimEnd();}:undefined;
  assertCandidate(cwd,sha,metadata);
  checkedTrackedFiles(cwd, files,metadata);
  if(compiler){if(metadata('controller-head')!==controller||metadata('controller-status')!=='')throw Error('Compiler controller is not the clean exact SHA');}
  const classifier = 'scripts/gate-db-classify.ts';
  const classificationOptions={cwd,input:files.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024};
  const classification=supervised?stage('classifier',classificationOptions):null;
  if(supervised&&(classification.error||classification.status!==0))throw Error('Supervised classifier refused');
  const output=supervised?classification.stdout:execFileSync(process.execPath,['--import','tsx',classifier,'explain'],classificationOptions);
  const groups = partitionSelection(files, output);
  if(compiler){
    if(groups.DB.length||JSON.stringify(groups.NODB)!==JSON.stringify([compilerPurpose(files).selector]))throw Error('Closed compiler fixture requires actual NODB classification');
    const profile=compilerPurpose(files),control=resolve(fileURLToPath(new URL('../..',import.meta.url))),relativeManifest=profile.manifest;
    const raw=readFileSync(join(cwd,relativeManifest));if(!raw.equals(readFileSync(join(control,relativeManifest))))throw Error('Compiler source/controller declaration differs');
    const declaration=JSON.parse(raw);if(declaration.kind!==profile.kind)throw Error('Closed compiler source declaration required');
    for(const [path,wanted]of Object.entries(declaration.componentSources))if(hash(readFileSync(join(cwd,path)))!==wanted||hash(readFileSync(join(control,path)))!==wanted)throw Error('Compiler source/controller bytes differ');
    const self=compilerProcIdentity(process.pid);
    writeFileSync(join(dir,profile.preflight),JSON.stringify({version:1,kind:profile.preflightKind,source:sha,controller,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,actor:{pid:self.pid,start:self.start},sourceHashes:declaration.componentSources}),{flag:'wx',mode:0o600});
  }
  const qualifyPort = restrictedPortRequest(process.env.AIHR_QUALIFY_RESTRICTED_PORT, groups, process.env.AIHR_RESTRICTED_PORT_TYPECHECK);
  const postgresProfile = groups.DB.length ? assertFocusedPostgresProfile(process.env) : null;
  const asciiCell=captureEmployeeAsciiCell(files);
  if(asciiCell)assert.deepEqual(groups,{NODB:[],DB:files},'Actual ASCII cells require complete DB classification');

  const identity = focusedPlanIdentity({sha, controller, files, groups, classifierHash: hash(readFileSync(classifier)),
    execution: {workers: compilerApplication?1:2, postgres: postgresProfile, ...(qualifyPort?{restrictedPortPrerequisite:{version:2,sourcePins:SOURCE_PINS}}:{}),...(asciiCell?{employeeAsciiCell:asciiCell.cell}:{})}});
  const report = {kind: asciiCell?'EMPLOYEE_ASCII_RUNTIME_QUALIFICATION_ONLY':'FOCUSED_ONLY', releaseEligible: false, schemaVersion: 1, sha, controller,
    ...(asciiCell?{normalCompilerQualified:false,releaseAuthorized:false}:{}),
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
        const child = supervised?stage(compiler?compilerPurpose(files).stage:nativeFactory?'native-factory':nativeControls?'native-controls':asciiPurpose?'ascii-purpose':asciiPlan?'ascii-plan':'benchmark',{stdio:'inherit',env}):spawnSync('pnpm', args, {stdio: 'inherit', env});
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
    if(compiler){try{report.compilerSettlement=verifyCompilerSettlement(dir);}catch{report.exitCode=1;report.compilerSettlementRefused=true;}}
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
      const dispose=()=>{const stopped=supervised?stage('stop',{stdio:'inherit',env:pgEnv}):spawnSync('bash', [postgres, 'stop'], {stdio: 'inherit', env: pgEnv});if(asciiCell)report.qualificationDatabaseStopped=!stopped.error&&stopped.status===0;if(stopped.status !== 0) report.exitCode = 1;};
      if(supervised)finalizeFocusedBenchmark(terminal,dispose,()=>{report.exitCode=1;report.databaseTerminalCaptureError='terminal-persistence-refused';});else{terminal();dispose();}
    }
    report.endedAt = new Date().toISOString();
    report.healthAfter = hostHealth();
    if(asciiCell){
      report.employeeAsciiQualification={kind:'EMPLOYEE_ASCII_CELL_UNAVAILABLE_NOT_PROOF',complete:false,cell:asciiCell.cell,releaseAuthorized:false,normalNoDbVerified:false};
      if(report.exitCode===0){try{report.employeeAsciiQualification=finishEmployeeAsciiCell(asciiCell,report,dir);}catch{report.exitCode=1;report.employeeAsciiQualificationRefused=true;}}
    }
    writeFileSync(join(dir, 'focused.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Focused development checks\nCandidate: ${sha}\nController: ${controller}\nSelected files: ${files.length}\nExit: ${report.exitCode}\n\nFOCUSED ONLY — no release receipt, full coverage or deployment approval.\n`);
    };
    if(supervised)finalizeFocusedBenchmark(partial,cleanup,()=>{report.exitCode=1;report.partialEvidenceError='partial-persistence-refused';});else cleanup();
  }
  return report.exitCode;
}

/** Read-only native corroboration, never a stale-PID recovery/kill mechanism. */
export function verifyCompilerSettlement(destination){
  runnerOnly();const profile=compilerPurpose(parseSelection(process.env.AIHR_FOCUSED_TESTS));
  const dir=resolve(destination);if(dir!==join(realpathSync(process.env.RUNNER_TEMP),'aihr-focused'))throw Error('Fixed compiler evidence directory required');
  const raw=boundedCompilerBytes(join(dir,profile.journal),131072).toString('utf8'),lines=raw.trimEnd().split('\n');
  if(!raw.endsWith('\n')||!lines.length||lines.length>1000)throw Error('Complete compiler ownership stream required');
  const monitors=parseCompilerSettlementRows(raw,{source:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD,run:process.env.GITHUB_RUN_ID},profile.purpose);
  requireCompilerMonitorsAbsent(monitors);
  return{kind:'READ_ONLY_COMPILER_NATIVE_SETTLEMENT_NOT_RELEASE',source:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD,run:process.env.GITHUB_RUN_ID,operations:9,nativeMonitorsAbsent:monitors.length,releaseAuthorized:false};
}

/** Source-model parser only. A parsed stream ALONE never establishes native settlement. */
export function parseCompilerSettlementRows(raw,context,purpose='reference'){
  if(!['reference','application'].includes(purpose))throw Error('Closed compiler settlement purpose required');
  const terminal=purpose==='application'?'compiler-application-inventory':'compiler-reference';
  if(!context||!['source','controller'].every(key=>typeof context[key]==='string'&&/^[a-f0-9]{40}$/.test(context[key]))||typeof context.run!=='string'||!/^[1-9][0-9]{0,19}$/.test(context.run))throw Error('Exact compiler context required');
  if(typeof raw!=='string'||Buffer.byteLength(raw)>131072||!raw.endsWith('\n'))throw Error('Bounded complete compiler stream required');
  const lines=raw.trimEnd().split('\n');if(!lines.length||lines.length>1000)throw Error('Complete compiler stream required');
  const operations=new Map(),stages=new Set(),monitors=[];let previousOperation,owner;
  for(const line of lines){const row=JSON.parse(line);for(const [key,value]of Object.entries({source:context.source,controller:context.controller,run:context.run,attempt:'1'}))if(row[key]!==value)throw Error('Foreign compiler ownership stream');
    if(!/^[a-f0-9]{32}$/.test(row.operation??'')||row.releaseAuthorized!==false||!['stage-started','session-admitted','group-stop-before-reap','group-quiescent-then-reaped','stage-ended'].includes(row.kind))throw Error('Closed compiler operation required');
    if(previousOperation!==undefined&&previousOperation!==row.operation&&operations.has(row.operation))throw Error('Interleaved compiler operations');
    const rows=operations.get(row.operation)??[];rows.push(row);operations.set(row.operation,rows);previousOperation=row.operation;
  }
  const required=['git-head','git-status','git-tracked','controller-head','controller-status','classifier',terminal];
  if(JSON.stringify([...operations.values()].map(rows=>rows[0].stage))!==JSON.stringify([...required,'git-head','git-status']))throw Error('Compiler metadata/execution order differs');
  for(const rows of operations.values()){
    const first=rows[0];owner??=first.owner;if(JSON.stringify(owner)!==JSON.stringify(first.owner))throw Error('Compiler focused owner changed');if(first.kind!=='stage-started'||rows.filter(row=>row.kind==='stage-started').length!==1||!required.includes(first.stage)||rows.some(row=>row.stage!==first.stage||JSON.stringify(row.writer)!==JSON.stringify(first.writer)||JSON.stringify(row.owner)!==JSON.stringify(first.owner)))throw Error('Compiler stage chronology differs');
    for(const actor of [first.writer,first.owner])if(!actor||JSON.stringify(Object.keys(actor).sort())!==JSON.stringify(['pid','start'])||!Object.values(actor).every(value=>Number.isSafeInteger(value)&&value>1))throw Error('Compiler native actor identity differs');
    const once=kind=>{const found=rows.map((row,index)=>({row,index})).filter(value=>value.row.kind===kind);if(found.length!==1)throw Error('Incomplete compiler ownership chronology');return found[0];};
    const admitted=once('session-admitted'),stop=once('group-stop-before-reap'),reaped=once('group-quiescent-then-reaped'),end=once('stage-ended');
    if(!(admitted.index<stop.index&&stop.index<reaped.index&&reaped.index<end.index&&end.index===rows.length-1)
      ||stop.row.reason!=='complete'||end.row.reason!=='complete'||end.row.commandExit!==0||end.row.admitted!==true||end.row.reaped!==true||end.row.groupQuiescent!==true||end.row.escapedSession!==false||reaped.row.escapedSession!==false)throw Error('Compiler native settlement is uncertain');
    if(!Number.isSafeInteger(admitted.row.pid)||admitted.row.pid<=1||!Number.isSafeInteger(admitted.row.start)||admitted.row.start<=0)throw Error('Native compiler monitor identity absent');
    stages.add(first.stage);monitors.push({pid:admitted.row.pid,start:admitted.row.start});
  }
  if(required.some(stage=>!stages.has(stage)))throw Error('Missing compiler execution/ownership stage');
  return monitors;
}
/** Always inspects the actual native process table. This never sends a signal. */
export function requireCompilerMonitorsAbsent(monitors){
  if(!Array.isArray(monitors)||!monitors.length||monitors.length>1000)throw Error('Bounded native monitor set required');
  for(const row of monitors)if(!row||!Number.isSafeInteger(row.pid)||row.pid<=1||!Number.isSafeInteger(row.start)||row.start<=0)throw Error('Native monitor identity required');
  const until=performance.now()+1000;
  for(;;){let remaining=0;for(const row of monitors){try{if(compilerProcIdentity(row.pid).start===row.start)remaining++;}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}}
    if(!remaining)return;if(performance.now()>=until)throw Error('Compiler native monitor remains; no recovery signal permitted');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  }
}

export function cleanupCompilerReference(destination){
  const proof=verifyCompilerSettlement(destination);writeFileSync(join(resolve(destination),'compiler-settlement.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});return 0;
}

export function cleanupEmployeeChoiceBenchmark(destination){
  runnerOnly();
  const files=parseSelection(process.env.AIHR_FOCUSED_TESTS);if(!isEmployeeChoiceBenchmark(files)&&!isEmployeeChoiceNativeControls(files)&&!isEmployeeChoiceNativeFactory(files)&&!isEmployeeChoiceAsciiPurpose(files)&&!isEmployeeChoiceAsciiPlan(files))throw Error('Sole employee benchmark/control cleanup required');
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
    employeeAsciiSelection(files);
    appendFileSync(process.env.GITHUB_OUTPUT, `tests=${JSON.stringify(files)}\n`);
  } else if (command === 'run' && process.argv.length === 4) process.exitCode = runFocused(process.argv[3]);
  else if(command === 'compiler-settled' && process.argv.length === 4)process.exitCode=cleanupCompilerReference(process.argv[3]);
  else if(command === 'cleanup' && process.argv.length === 4) process.exitCode=cleanupEmployeeChoiceBenchmark(process.argv[3]);
  else throw Error('Usage: focused-checks.mjs selection | run <owned-evidence-directory> | cleanup <fixed-benchmark-evidence-directory>');
}
