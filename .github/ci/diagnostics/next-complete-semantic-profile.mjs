/** Complete compiler-created identity evidence. Instrumented diagnostics never authorize release. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync, lstatSync, statfsSync, openSync, closeSync, copyFileSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const SOURCE = '34fe96c83a15591b8868dfddf5237533d479a0b6';
const BRANCH = 'codex/resignation-next-complete-profile-20261118';
const WORKFLOW = `StradaverseHub/ai-hr/.github/workflows/next-complete-semantic-profile.yml@refs/heads/${BRANCH}`;
const FILE_CAP = 2 * 1024 ** 3, TOTAL_CAP = 3 * 1024 ** 3, DISK_FLOOR = 10 * 1024 ** 3;
const CHUNK = 64 * 1024, RECORD_CAP = 32 * 1024 ** 2, KEY_CAP = 65536, FRONTIER_CAP = 4096;
const controller = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const env = process.env, source = realpathSync(process.cwd());
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 ** 2 }).trim();
const put = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const small = path => { assert(lstatSync(path).size <= RECORD_CAP, 'Bounded metadata exceeded'); return JSON.parse(readFileSync(path, 'utf8')); };
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    assert(!entry.isSymbolicLink(), 'Evidence symlink refused'); const p = join(dir, entry.name);
    return entry.isDirectory() ? files(p) : [p];
  });
}
async function digest(path) { const h = createHash('sha256'); for await (const chunk of createReadStream(path, { highWaterMark: CHUNK })) h.update(chunk); return h.digest('hex'); }
const [mode, arg] = process.argv.slice(2), out = resolve(arg ?? '');
assert(['compile', 'summarize'].includes(mode));
assert(out === join(realpathSync(env.RUNNER_TEMP), 'next-complete-semantic-profile-34fe'));

/** Streaming JSON object-array reader: hash ALL original bytes, never repair a tail or skip malformed records. */
export async function parseArray(path, visit, { chunkSize = CHUNK, deadline = Infinity } = {}) {
  const h = createHash('sha256'), decoder = new TextDecoder('utf-8', {fatal:true});
  let bytes = 0, count = 0, state = 'start', record = '', recordBytes = 0, quoted = false, escaped = false;
  let stack = [], reason = null, lastValidByteOffset = 0, consumedBytes = 0;
  function consume(text) {
    assert(Date.now() <= deadline, 'Summary time budget exhausted');
    for (const c of text) {
      const code=c.codePointAt(0),width=code<128?1:code<2048?2:code<65536?3:4;
      consumedBytes += width;
      if (reason) continue;
      if (state === 'record') {
        recordBytes += width;
        if (recordBytes > RECORD_CAP) { reason = 'single_record_limit'; record = ''; continue; }
        record += c;
        if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
        if (c === '"') { quoted = true; continue; }
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          const begin = stack.pop();
          if ((c === '}' && begin !== '{') || (c === ']' && begin !== '[')) { reason = 'invalid_nesting'; record = ''; continue; }
          if (!stack.length) {
            let value;
            try { value = JSON.parse(record); } catch { reason = 'malformed_record'; record = ''; continue; }
            count++; lastValidByteOffset = consumedBytes; record = ''; state = 'separator'; visit(value, count);
          }
        }
        continue;
      }
      if (/[\x20\t\r\n]/.test(c)) continue;
      if (state === 'start') { if (c === '[') state = 'first'; else reason = 'not_array'; }
      else if ((state === 'first' || state === 'next') && c === '{') { state = 'record'; record = '{'; recordBytes = 1; stack = ['{']; }
      else if (state === 'first' && c === ']') state = 'closed';
      else if (state === 'separator' && c === ',') state = 'next';
      else if (state === 'separator' && c === ']') state = 'closed';
      else reason = state === 'closed' ? 'data_after_array' : 'invalid_separator_or_element';
    }
  }
  for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) {
    bytes += chunk.length; h.update(chunk); assert(bytes <= FILE_CAP, 'Raw file exceeds admitted cap'); consume(decoder.decode(chunk,{stream:true}));
  }
  consume(decoder.decode());
  reason ??= state === 'closed' ? null : 'incomplete_tail';
  return { bytes, sha256: h.digest('hex'), count, complete: reason === null, reason, lastValidByteOffset, fileCapReached: bytes >= FILE_CAP };
}

function binding() {
  assert(process.platform === 'linux' && env.GITHUB_ACTIONS === 'true' && env.CI === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted');
  assert(env.GITHUB_REPOSITORY === 'StradaverseHub/ai-hr' && env.GITHUB_REPOSITORY_ID === '1333414856');
  assert(env.GITHUB_WORKFLOW_REF === WORKFLOW && env.GITHUB_WORKFLOW === 'next-complete-semantic-profile' && env.GITHUB_JOB === 'profile');
  assert(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert(env.AIHR_DIAG_SOURCE_SHA === SOURCE && /^[a-f0-9]{40}$/.test(env.AIHR_DIAG_CONTROLLER_SHA ?? ''));
  assert(env.GITHUB_SHA === env.AIHR_DIAG_CONTROLLER_SHA && env.AIHR_CI_CONTROL_HEAD === env.AIHR_DIAG_CONTROLLER_SHA);
  assert(source === join(realpathSync(env.GITHUB_WORKSPACE), 'source') && controller === join(realpathSync(env.GITHUB_WORKSPACE), 'automation'));
  assert(git(source, 'rev-parse', 'HEAD') === SOURCE && git(controller, 'rev-parse', 'HEAD') === env.AIHR_DIAG_CONTROLLER_SHA);
  git(controller, 'merge-base', '--is-ancestor', SOURCE, env.AIHR_DIAG_CONTROLLER_SHA);
  assert.deepEqual(git(controller, 'diff', '--name-only', SOURCE, env.AIHR_DIAG_CONTROLLER_SHA).split('\n'), [
    '.github/ci/diagnostics/next-complete-semantic-profile.mjs', '.github/ci/diagnostics/next-complete-semantic-shim.cjs', '.github/workflows/next-complete-semantic-profile.yml',
  ]);
  const event = small(env.GITHUB_EVENT_PATH);
  assert(!event.pull_request && event.repository?.full_name === env.GITHUB_REPOSITORY && event.repository?.id === 1333414856);
  if (env.GITHUB_EVENT_NAME === 'push') assert(event.ref === `refs/heads/${BRANCH}` && event.after === env.AIHR_DIAG_CONTROLLER_SHA && event.deleted !== true);
  else assert(event.inputs?.source_sha === SOURCE && event.inputs?.controller_sha === env.AIHR_DIAG_CONTROLLER_SHA);
}
function proc(pid) {
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' '); return { parentPid: Number(fields[1]), pgid: Number(fields[2]), starttime: fields[19] }; } catch { return null; }
}
const inputPins = {
  'next.config.ts': 'fc75ed3640614a6b08be4e32064f2c010cc5e5fb55779c039fa72e7550ce7c8e',
  'tsconfig.json': 'f5bc3a05bc19d85f6d1b7735e34bdd6b93f8f15741316108cc55d67ff4173785',
  'tsconfig.build.json': '1c989c374f21f205e7aeb51842cc6032307bc91075faf5a6feccc945fcda49bf',
  'pnpm-lock.yaml': '7c833cb438bd31a1e22045b1704ed1498a4922343828e2d302e3ef4a6cdfb99a',
};
const helperPins = {
  'next/dist/lib/typescript/runTypeCheckCli.js': 'ebec45a6082332d8bb4938ee2d382c63eeee46f95323e6d7e8d2d41d60252682',
  'next/dist/lib/typescript/runTypeScriptCli.js': '9462f0a83eb0c24e7cd1c33d22abade44e63664ff2897a74ddb88b70abe3c16a',
  'next/dist/lib/verify-typescript-setup.js': '5b5dd09d64ceb9fdab76d75d99fc9646341cdd07290ac88756103e7b9fce3db9',
  'next/dist/server/config-shared.js': 'cc8b6197fd97a12b0d9257c9d7d4288347053fc8712b021d03c3bfad7a19cdd3',
  'typescript/lib/tsc.js': '2cffde0b8c6760dfb0b5b0382bbb7e00ba6a8b2d981b9205b256a700a481d983',
  'typescript/lib/_tsc.js': 'e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419',
};

async function compile() {
  binding(); assert(!existsSync(out)); mkdirSync(out, { mode: 0o700 });
  const started = Date.now(), report = { kind: 'NEXT_COMPLETE_SEMANTIC_DIAGNOSTIC', releaseEligible: false, source: SOURCE, controller: env.AIHR_DIAG_CONTROLLER_SHA, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, stages: [], semanticCheckSucceeded: false, exitCode: 1 };
  let active = null, timer, monitor, cleanup = Promise.resolve(), refusal = null;
  const owned = new Map();
  const driverIdentity = {role:'compile-driver',cleanupGroup:false,pid:process.pid,...proc(process.pid),source:SOURCE,controller:report.controller,run:report.run,attempt:report.attempt};
  put(join(out,'compile-driver-identity.json'),driverIdentity);
  function registerShims() {
    for (const stage of ['showConfig', 'semantic']) {
      const path = join(out, `shim-${stage}-identity.json`); if (!existsSync(path)) continue;
      const id = small(path), live = proc(id.pid);
      assert(id.source === SOURCE && id.controller === report.controller && String(id.run) === report.run && String(id.attempt) === report.attempt);
      const helper = owned.get(id.driverPid);
      assert(helper?.role === 'helper' && id.driverStarttime === helper.starttime && id.parentPid === helper.pid);
      assert(id.pgid === id.pid && Number.isInteger(id.pid) && id.pid > 1);
      if (live && live.starttime === id.starttime && live.pgid === id.pid) owned.set(id.pid, { ...id });
    }
  }
  async function stop(reason) {
    if (refusal) return cleanup; refusal = reason;
    cleanup = (async () => {
      try { registerShims(); } catch (error) { report.registrationError = String(error); }
      const groups = [...owned.values(), ...(active ? [active] : [])];
      const send = signal => { for (const id of groups) { const live = proc(id.pid); if (live?.starttime === id.starttime && live.pgid === id.pid) try { process.kill(-id.pid, signal); } catch {} } };
      send('SIGTERM'); await new Promise(done => setTimeout(done, 5000)); send('SIGKILL');
    })();
    return cleanup;
  }
  const onTerm = () => { void stop('outer_SIGTERM'); };
  process.once('SIGTERM', onTerm);
  async function run(label, args, role) {
    assert(!refusal && Date.now() - started < 880000, 'No stage duration remains');
    const fd = openSync(join(out, `${label}.log`), 'wx', 0o600), begin = Date.now();
    const child = spawn(process.execPath, args, { cwd: source, env: childEnv, detached: true, stdio: ['ignore', fd, fd] });
    const id = proc(child.pid); assert(id && id.pgid === child.pid); active = { pid: child.pid, starttime: id.starttime };
    const identity={role,cleanupGroup:true,pid:child.pid,...id,source:SOURCE,controller:report.controller,run:report.run,attempt:report.attempt};
    owned.set(child.pid,identity);put(join(out,`owned-${role}-identity.json`),identity);
    let result;
    try { result = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); }); }
    finally { await cleanup; active = null; closeSync(fd); }
    report.stages.push({ label, args, ...result, elapsedMs: Date.now() - begin });
    assert(!refusal && result.code === 0 && result.signal === null, `${label} failed`);
  }
  const closed = 'postgres://ai_hr_app@127.0.0.1:1/no_database';
  const childEnv = { ...env, NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=12288', NEXT_TELEMETRY_DISABLED: '1', AIHR_DIAG_OUT: out, AIHR_DIAG_DRIVER_PID: String(process.pid), AIHR_DIAG_DRIVER_STARTTIME: proc(process.pid).starttime, DATABASE_URL: closed, MIGRATION_DATABASE_URL: closed, TEST_DATABASE_URL: closed, TEST_MIGRATION_DATABASE_URL: closed };
  try {
    assert(env.NODE_OPTIONS === '--max-old-space-size=12288');
    assert(git(source, 'status', '--porcelain', '--untracked-files=all') === '' && git(controller, 'status', '--porcelain', '--untracked-files=all') === '');
    assert(!existsSync(join(source, '.next')), 'Cold source required');
    assert(!Object.keys(env).some(key => (key.startsWith('AIHR_SYSTEM_TESTING_') || key.startsWith('AIHR_NEXT_BUILD_') || key === 'AUTH_SESSION_KEY') && env[key]));
    const disk = statfsSync(out); assert(disk.bavail * disk.bsize >= DISK_FLOOR, '10GiB initial free disk required');
    const meminfo = readFileSync('/proc/meminfo', 'utf8'); assert(Number(/^MemTotal:\s+(\d+)/m.exec(meminfo)?.[1]) >= 12 * 1024 ** 2);
    put(join(out, 'initial-meminfo.txt'), meminfo);
    const require = createRequire(join(source, 'package.json'));
    assert(process.versions.node === '20.20.2' && require('next/package.json').version === '16.4.1' && require('typescript/package.json').version === '5.9.3');
    report.runtime = { node: process.versions.node, next: require('next/package.json').version, typescript: require('typescript/package.json').version, platform: process.platform, arch: process.arch };
    report.inputs = {}; for (const [p, expected] of Object.entries(inputPins)) { const actual = await digest(join(source, p)); assert(actual === expected, `Input pin mismatch: ${p}`); report.inputs[p] = actual; }
    for (const p of ['package.json', 'next-env.d.ts', '.github/ci/build-heap.mjs']) report.inputs[p] = await digest(join(source, p));
    report.helpers = {}; for (const [p, expected] of Object.entries(helperPins)) { const actual = await digest(require.resolve(p)); assert(actual === expected, `Installed helper mismatch: ${p}`); report.helpers[p] = actual; }
    for (const p of ['next/dist/bin/next', 'next/dist/cli/next-typegen.js', 'typescript/lib/typescript.js']) report.helpers[p] = await digest(require.resolve(p));
    report.controllerFiles = {}; for (const p of git(controller, 'diff', '--name-only', SOURCE, report.controller).split('\n')) report.controllerFiles[p] = await digest(join(controller, p));
    childEnv.AIHR_DIAG_REAL_TSC = require.resolve('typescript/lib/tsc.js');
    timer = setTimeout(() => { void stop('900sec_total_minus_20sec_reserve'); }, Math.max(1, 880000 - (Date.now() - started)));
    const telemetry = openSync(join(out, 'resource-telemetry.jsonl'), 'wx', 0o600); closeSync(telemetry);
    monitor = setInterval(() => {
      try {
        registerShims(); const all = files(out), sizes = all.map(p => lstatSync(p).size), diskNow = statfsSync(out);
        if (sizes.some(n => n >= FILE_CAP) || sizes.reduce((a, b) => a + b, 0) >= TOTAL_CAP) void stop('artifact_cap');
        if (diskNow.bavail * diskNow.bsize < 1024 ** 3) void stop('disk_exhaustion_guard');
        const rows = [...owned.keys(), ...(active ? [active.pid] : [])].map(pid => {
          try { return { pid, status: readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').filter(line => /^(Name|VmRSS|VmHWM|VmSwap|PPid):/.test(line)) }; } catch { return { pid, exited: true }; }
        });
        writeFileSync(join(out, 'resource-telemetry.jsonl'), JSON.stringify({ elapsedMs: Date.now() - started, processes: rows, meminfo: readFileSync('/proc/meminfo', 'utf8').split('\n').filter(line => /^(MemAvailable|SwapTotal|SwapFree):/.test(line)) }) + '\n', { flag: 'a' });
      } catch (error) { report.monitorError = String(error); void stop('monitor_integrity_failure'); }
    }, 1000);
    await run('actual-next-typegen', [require.resolve('next/dist/bin/next'), 'typegen'], 'typegen');
    assert(git(source, 'diff', '--name-only') === '', 'typegen changed tracked source');
    const generated = join(source, '.next/types'); assert(existsSync(generated));
    report.generated = []; for (const p of files(generated)) { const name = relative(generated, p); report.generated.push({ path: name, bytes: lstatSync(p).size, sha256: await digest(p) }); const target = join(out, 'generated-types', name); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(p, target); }
    assert(report.generated.length > 0); report.nextEnv = await digest(join(source, 'next-env.d.ts')); copyFileSync(join(source, 'next-env.d.ts'), join(out, 'next-env.d.ts'));
    // Short-lived configuration-only process exits before the one semantic helper.
    const capture = `const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const {createRequire}=require('node:module');const r=createRequire(${JSON.stringify(join(source,'package.json'))});const source=${JSON.stringify(source)},out=${JSON.stringify(out)};const put=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\\n',{flag:'wx',mode:384});(async()=>{const raw=r('next/dist/server/config');const config=await(raw.default??raw)(r('next/dist/shared/lib/constants').PHASE_PRODUCTION_BUILD,source);assert(config.typescript.tsconfigPath==='tsconfig.build.json'&&config.typescript.ignoreBuildErrors===false&&config.experimental.useTypeScriptCli===true&&config.distDir==='.next');put('production-config-selection.json',{tsconfigPath:config.typescript.tsconfigPath,ignoreBuildErrors:config.typescript.ignoreBuildErrors,useTypeScriptCli:config.experimental.useTypeScriptCli,distDir:config.distDir});const ts=r('typescript'),host={...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{throw Error('Config parse failed')}};const parsed=ts.getParsedCommandLineOfConfigFile(path.join(source,'tsconfig.build.json'),{},host);assert(parsed&&!parsed.errors.length&&parsed.options.strict&&parsed.options.noEmit&&!parsed.options.noCheck);const{configFile,configFilePath,...options}=parsed.options;put('original-effective-options.json',options);put('original-effective-roots.json',parsed.fileNames.map(p=>path.relative(source,p)));put('ambient-types.json',{effectiveTypeRoots:ts.getEffectiveTypeRoots(parsed.options,host),automaticTypeDirectiveNames:ts.getAutomaticTypeDirectiveNames(parsed.options,host).sort()});})().catch(e=>{console.error(e);process.exitCode=1});`;
    await run('capture-original-configuration',['-e',capture],'configuration');
    assert(!existsSync(join(source, '.next/cache/.tsbuildinfo')));
    const invocation = { baseDir: source, tsConfigPath: join(source, 'tsconfig.build.json'), cacheDir: join(source, '.next/cache'), tscPath: join(controller, '.github/ci/diagnostics/next-complete-semantic-shim.cjs') };
    put(join(out, 'next-cli-helper-invocation.json'), invocation);
    const code = `const fs=require('node:fs'),assert=require('node:assert/strict');const stat=pid=>{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')};assert(process.ppid===${process.pid}&&stat(process.ppid)[19]===${JSON.stringify(driverIdentity.starttime)});process.env.AIHR_DIAG_DRIVER_PID=String(process.pid);process.env.AIHR_DIAG_DRIVER_STARTTIME=stat(process.pid)[19];const {createRequire}=require('node:module');const r=createRequire(${JSON.stringify(join(source, 'package.json'))});r('next/dist/lib/typescript/runTypeCheckCli').runTypeCheckCli(${JSON.stringify(invocation)}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1});`;
    await run('actual-next-runTypeCheckCli', ['-e', code], 'helper');
    const outcome = small(join(out, 'shim-semantic-outcome.json')); report.compilerOutcome = outcome;
    assert(outcome.exitCode === 0 && outcome.signal === null, 'Actual compiler failed');
    assert(git(source, 'diff', '--name-only') === '');
    for (const [p, expected] of Object.entries(report.inputs)) assert(await digest(join(source, p)) === expected, `Input changed: ${p}`);
    assert(await digest(join(source, 'next-env.d.ts')) === report.nextEnv);
    assert.deepEqual(files(generated).map(p => relative(generated, p)), report.generated.map(row => row.path));
    for (const row of report.generated) assert(await digest(join(generated, row.path)) === row.sha256);
    report.unchangedInputs = true; report.semanticCheckSucceeded = true; report.exitCode = 0;
  } catch (error) { report.error = String(error); }
  finally {
    clearTimeout(timer); clearInterval(monitor); await cleanup; process.removeListener('SIGTERM', onTerm);
    report.refusal = refusal; report.elapsedMs = Date.now() - started;
    for (const stage of ['showConfig', 'semantic']) { const p = join(out, `shim-${stage}-outcome.json`); if (existsSync(p)) report[`${stage}Outcome`] = small(p); }
    report.resourceComparability = 'TRACE_RETAINS_TYPES_INSTRUMENTED_12GIB_NOT_8GIB_PRODUCTION_ACCEPTANCE';
    put(join(out, 'compile-report.json'), report);
  }
  process.exitCode = report.exitCode;
}

async function summarize() {
  binding(); assert(existsSync(out)); assert(env.NODE_OPTIONS === '--max-old-space-size=512');
  const deadline = Date.now() + 115000;
  const summary = { kind: 'COMPLETE_TRACE_SUMMARY_NOT_RELEASE', releaseEligible: false, source: SOURCE, controller: env.AIHR_DIAG_CONTROLLER_SHA, integrity: false, limits: { chunkBytes: CHUNK, recordBytes: RECORD_CAP, cataloguePasses: 3, frontier: FRONTIER_CAP, depth: 4, groupKeys: KEY_CAP }, overflow: [], limitations: ['Types are compiler-created identities, not heap dominators or retained bytes.', 'Nested event durations overlap; totals are not exclusive CPU or GC allocation measurements.', 'Instrumented 12GiB diagnostic cannot establish 8GiB production readiness.'] };
  const overflow = name => { if (!summary.overflow.includes(name)) summary.overflow.push(name); };
  const top = (rows, row, key = 'durationMicroseconds') => { rows.push(row); rows.sort((a, b) => b[key] - a[key]); if (rows.length > 100) rows.pop(); };
  const grouped = (map, key) => { if (typeof key !== 'string' || key.length > 1024) { overflow('group_key_length'); return; } if (map.has(key)) map.set(key, map.get(key) + 1); else if (map.size < KEY_CAP) map.set(key, 1); else overflow('group_keys'); };
  try {
    const controlsDir = join(out, 'synthetic-parser-controls'); mkdirSync(controlsDir, { mode: 0o700 });
    const cases = [
      { name: 'split-escapes-unicode', text: '[{"name":"α😀\\\"\\\\{[}"},{"name":"ok"}]', count: 2, complete: true },
      { name: 'empty', text: ' [ ] \n', count: 0, complete: true },
      { name: 'partial-tail', text: '[{"name":"ok"},{"name":', count: 1, complete: false },
      { name: 'malformed-middle', text: '[{"name":"ok"},{bad},{"name":"untrusted"}]', count: 1, complete: false },
      { name: 'trailing-comma', text: '[{"name":"ok"},]', count: 1, complete: false },
    ];
    summary.parserControls = [];
    for (const row of cases) { const p = join(controlsDir, row.name + '.json'); put(p, row.text); const values = []; const result = await parseArray(p, value => values.push(value), { chunkSize: 1, deadline }); assert(result.count === row.count && result.complete === row.complete); if (row.name === 'split-escapes-unicode') assert(values[0].name === 'α😀"\\{[}'); summary.parserControls.push({ name: row.name, ...result }); }
    const require = createRequire(join(controller, 'package.json'));
    const { validateOriginalArgs } = require('./.github/ci/diagnostics/next-complete-semantic-shim.cjs');
    const project = join(source, 'tsconfig.build.json');
    const show = ['--showConfig', '--project', project, '--pretty', 'false'];
    const semantic = ['--project', project, '--noEmit', '--declarationMap', 'false', '--emitDeclarationOnly', 'false', '--tsBuildInfoFile', join(source, '.next/cache/.tsbuildinfo')];
    assert(validateOriginalArgs(show, { source, out }).mode === 'showConfig'); assert(validateOriginalArgs(semantic, { source, out }).mode === 'semantic');
    for (const args of [[...show, '--noCheck'], [...semantic, '--noCheck'], [...semantic, '--generateTrace', '/tmp/other'], semantic.slice(0, -2), semantic.map(v => v === project ? '/tmp/other.json' : v), [...semantic, '--pretty', 'true'], [...semantic, '--noEmit']]) assert.throws(() => validateOriginalArgs(args, { source, out }));
    summary.argumentControls = 'passed_pure_validation_no_compiler';
    const compilePath = join(out, 'compile-report.json'); summary.compile = existsSync(compilePath) ? small(compilePath) : { semanticCheckSucceeded: false, error: 'compile report absent; abrupt termination possible' };
    const time = join(realpathSync(env.RUNNER_TEMP), 'next-complete-semantic-profile-34fe-time.txt'); if (existsSync(time)) copyFileSync(time, join(out, 'external-time.txt'));
    const traceDir = join(out, 'trace');
    const tracePaths = existsSync(traceDir) ? files(traceDir).filter(p => /^trace(?:\.[0-9-]+)?\.json$/.test(p.split('/').at(-1))) : [];
    assert(tracePaths.length === 1, 'Expected exactly one genuine trace file');
    const tracePath = tracePaths[0], catalogPath = join(traceDir, 'types' + tracePath.split('/').at(-1).slice(5));
    const frames = new Map(), fileRows = new Map(), relations = [], expressions = [];
    let badFrames = 0, relationCount = 0, expressionCount = 0;
    summary.trace = await parseArray(tracePath, event => {
      if (!Number.isFinite(event.ts) || typeof event.name !== 'string') return;
      const key = `${event.pid}:${event.tid}`, stack = frames.get(key) ?? [];
      const fileEvent = event.name === 'checkSourceFile' || event.name === 'checkSourceFileNodes';
      if (fileEvent && event.ph === 'B') {
        if(typeof event.args?.path!=='string') {badFrames++;return;}
        if (stack.length >= FRONTIER_CAP) { overflow('file_frame_depth'); return; }
        if (!frames.has(key) && frames.size >= KEY_CAP) { overflow('thread_keys'); return; }
        stack.push({ name: event.name, path: event.args?.path, ts: event.ts }); frames.set(key, stack);
      } else if (fileEvent && event.ph === 'E') {
        const begin = stack.at(-1);
        if (!begin || begin.name !== event.name || begin.path !== event.args?.path || event.ts < begin.ts) { badFrames++; return; }
        stack.pop(); const duration = event.ts - begin.ts;
        if (!fileRows.has(begin.path) && fileRows.size >= KEY_CAP) { overflow('file_group_keys'); return; }
        const row = fileRows.get(begin.path) ?? { path: begin.path, completedChecks: 0, totalMicroseconds: 0, maxMicroseconds: 0 };
        row.completedChecks++; row.totalMicroseconds += duration; row.maxMicroseconds = Math.max(row.maxMicroseconds, duration); fileRows.set(begin.path, row);
      }
      if (event.ph === 'X' && Number.isFinite(event.dur) && event.dur >= 0) {
        if (event.cat === 'checkTypes' && Number.isSafeInteger(event.args?.sourceId) && Number.isSafeInteger(event.args?.targetId)) { relationCount++; top(relations, { name: event.name, ts: event.ts, durationMicroseconds: event.dur, sourceId: event.args.sourceId, targetId: event.args.targetId, observedOpenFileContext: stack.at(-1)?.path ?? null }); }
        if (/Expression/.test(event.name)) { expressionCount++; top(expressions, { name: event.name, durationMicroseconds: event.dur, path: event.args?.path ?? stack.at(-1)?.path ?? null, pos: event.args?.pos, end: event.args?.end, kind: event.args?.kind, positionEncoding: 'UTF16_code_units_original_compiler_offsets' }); }
      }
    }, { deadline });
    summary.fileFrames = { badEnds: badFrames, open: [...frames].flatMap(([thread, stack]) => stack.map(row => ({ thread, ...row }))) };
    summary.completedFiles = [...fileRows.values()].sort((a, b) => b.totalMicroseconds - a.totalMicroseconds).slice(0, 100);
    summary.top100Relations = relations; summary.relationCount = relationCount; summary.top100Expressions = expressions; summary.expressionCount = expressionCount;
    const needed = new Set(relations.flatMap(row => [row.sourceId, row.targetId]).filter(Number.isSafeInteger)), requested = new Map([...needed].map(id => [id, 0])), resolved = new Map();
    const symbols = new Map(), declarations = new Map(), targets = new Map();
    const referenceKeys = ['instantiatedType', 'typeArguments', 'aliasTypeArguments', 'unionTypes', 'intersectionTypes', 'conditionalCheckType', 'conditionalExtendsType', 'conditionalTrueType', 'conditionalFalseType', 'indexedAccessObjectType', 'indexedAccessIndexType', 'substitutionBaseType', 'substitutionConstraintType', 'keyofType', 'reverseMappedSourceType', 'reverseMappedMappedType', 'reverseMappedConstraintType'];
    function references(type) { return referenceKeys.flatMap(key => Array.isArray(type[key]) ? type[key] : [type[key]]).filter(id => Number.isSafeInteger(id) && id > 0); }
    let catalogue;
    for (let pass = 0; pass < 3; pass++) {
      const pending = new Map([...requested].filter(([id]) => !resolved.has(id))), discovered = new Map();
      const result = await parseArray(catalogPath, type => {
        assert(Number.isSafeInteger(type.id) && type.id > 0, 'Catalogue record lacks genuine positive type id');
        if (pass === 0) { grouped(symbols, type.symbolName ?? '(anonymous)'); grouped(declarations, type.firstDeclaration?.path ?? '(no declaration)'); if (type.instantiatedType !== undefined) grouped(targets, String(type.instantiatedType)); }
        if (!pending.has(type.id)) return;
        const depth = pending.get(type.id), refs = references(type);
        // Preserve only bounded selected records; never retain the entire catalogue.
        const display = typeof type.display === 'string' ? type.display : null;
        const selected={id:type.id,symbolName:type.symbolName,recursionId:type.recursionId,firstDeclaration:type.firstDeclaration,referenceLocation:type.referenceLocation,instantiatedType:type.instantiatedType,flags:type.flags,display:display?.slice(0,4096),displayTruncated:!!display&&display.length>4096};
        for(const key of referenceKeys) if(type[key]!==undefined) { if(Array.isArray(type[key])&&type[key].length>256) { selected[key]=type[key].slice(0,256);overflow('selected_type_links'); } else selected[key]=type[key]; }
        if(JSON.stringify(selected).length>16384) { overflow('selected_type_record'); resolved.set(type.id,{id:type.id,recordOmitted:true,reason:'selected_record_limit'}); } else resolved.set(type.id,selected);
        if (depth < 4) for (const id of refs) if (!requested.has(id) && !discovered.has(id)) {
          if (requested.size + discovered.size < FRONTIER_CAP) discovered.set(id, depth + 1); else overflow('requested_type_frontier');
        }
      }, { deadline });
      if (pass === 0) catalogue = result; else assert(result.sha256 === catalogue.sha256 && result.bytes === catalogue.bytes && result.complete === catalogue.complete, 'Catalogue changed during extraction');
      for (const [id, depth] of discovered) requested.set(id, depth);
      if (![...requested.keys()].some(id => !resolved.has(id))) break;
    }
    // Closure links found after the final admitted pass remain explicit unresolved evidence.
    summary.catalogue = catalogue;
    summary.requestedTypes = [...requested].map(([id, depth]) => ({ id, depth, record: resolved.get(id) ?? null }));
    summary.unresolvedTypeIds = [...requested.keys()].filter(id => !resolved.has(id));
    summary.unresolvedRelationTypeIds = [...needed].filter(id => !resolved.has(id));
    const ranking = map => [...map].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 100);
    summary.typeGroups = { symbols: ranking(symbols), declarationPaths: ranking(declarations), instantiatedTargetIds: ranking(targets), completeRankings: !summary.overflow.some(name=>name.startsWith('group_')) };
    const diagnostics = {};
    for (const name of ['shim-semantic.stdout.log', 'shim-semantic.stderr.log']) {
      const p = join(out, name); if (!existsSync(p)) continue;
      let tail = ''; const decoder = new StringDecoder('utf8');
      const consume = text => { const lines = (tail + text).split('\n'); tail = lines.pop(); assert(Buffer.byteLength(tail) <= RECORD_CAP, 'Diagnostic log line too long'); for (const line of lines) { const match = /^(Types|Instantiations|Assignability cache size|Identity cache size|Subtype cache size|Strict subtype cache size|Check time|Total time|Memory used):\s*(.+)$/.exec(line.trim()); if (match) diagnostics[match[1]] = match[2]; } };
      for await (const chunk of createReadStream(p, { highWaterMark: CHUNK })) { assert(Date.now() < deadline); consume(decoder.write(chunk)); } consume(decoder.end() + '\n');
    }
    summary.extendedDiagnostics = diagnostics;
    summary.compilerOutcome = existsSync(join(out, 'shim-semantic-outcome.json')) ? small(join(out, 'shim-semantic-outcome.json')) : null;
    summary.productionRssReferenceCrossed=Number.isFinite(summary.compilerOutcome?.peakObservedRssKiB)&&summary.compilerOutcome.peakObservedRssKiB>12582912;
    summary.rawManifest = []; let total = 0;
    for (const p of files(out)) { assert(Date.now() < deadline); const bytes = lstatSync(p).size; total += bytes; summary.rawManifest.push({ path: relative(out, p), bytes, sha256: await digest(p) }); if (bytes >= FILE_CAP) overflow('raw_file_cap'); }
    if (total >= TOTAL_CAP) overflow('aggregate_cap');
    summary.integrity = summary.trace.complete && catalogue.complete && !summary.trace.fileCapReached && !catalogue.fileCapReached && badFrames === 0 && summary.fileFrames.open.length === 0 && summary.unresolvedTypeIds.length === 0 && summary.overflow.length === 0;
    summary.success = summary.integrity && summary.compile.semanticCheckSucceeded === true && summary.compile.unchangedInputs === true && summary.compilerOutcome?.exitCode === 0 && summary.compilerOutcome?.signal === null;
  } catch (error) { summary.error = String(error); summary.success = false; }
  put(join(out, 'complete-summary.json'), summary);
  console.log(JSON.stringify({ source: SOURCE, success: summary.success === true, integrity: summary.integrity, error: summary.error, releaseEligible: false }));
  process.exitCode = summary.success ? 0 : 1;
}
if (mode === 'compile') await compile(); else await summarize();
