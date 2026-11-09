/** Fixed stock TypeScript comparison for the real DB client boundary in the protected view. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, readSync, realpathSync, readlinkSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

const project = '/project';
const runtime = '/runtime/node';
const work = '/work/db-client';
const dependencyRoot = join(project, 'node_modules');
const original = join(project, 'tsconfig.json');
const product = '6c05efc24242b8a5f50933e7cbb6709a276b286d';
const apiSha = '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675';
const cliSha = 'e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419';
const mib = 1024 ** 2;
const maxFiles = 50_000;
const maxLogBytes = 16 * mib;
const maxSealBytes = 16 * mib;
const maxAggregateMs = 120_000;
const minAvailable = 6 * 1024 ** 3;
const childEnv = Object.freeze({PATH: '/runtime', HOME: '/nonexistent', TMPDIR: work, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'});
const producerPins = [
  ['db/client.ts', 22595, 'bdd700ea682bafbf0cad2c255b8dacb96c13d82dc7fa0ae9446d4a1da265cd3f'],
  ['db/admission.ts', 6632, '1ecfe8676616ade94e88c6ab31920c58966501cf1303784bd1a453945b1e284d'],
  ['db/background-read-admission.ts', 1684, '5357a7dfd902c0887672130a73215dd5ab677b3f57660bf1e7358748d3b9ff7e'],
  ['db/tenant-write-admission.ts', 699, 'f59d78e9ed34e01f74e655b736f386bc04165c72ca4471236cc8bfd2664e94e3'],
  ['db/workload.ts', 1171, 'bbbd5e108bf78c6320e7db6befac4845c190f967e1f367d7f525b0da1ca8a692'],
  ['db/capacity.ts', 1112, 'e3452749d6dc3f62de919c24af2f0667d71bd05b9606f9aec799bdd3afe70db3'],
  ['core/audit-chain-arming.ts', 4657, 'e8db2d54de0673f992af3773a7f5a3809c33f9367583b755c647b56c0f8b389d'],
  ['core/entitlement-types.ts', 15133, '46c4b47c2768ef56364fbb193518974a2453a97f313db7844e7def3df8b3cfbb'],
];
const realTests = [
  ['test/payroll-tax-basis-read.test.ts', 3467, 'b54ef6b8ba47b81417cc51d604e5a88c44da9777e4773f86718438d6ab2b6800'],
  ['test/personnel-import-browser-key.test.ts', 1361, 'e5944137437f38e32266107b979299890172104a01946d1a0298e93918b78ef6'],
  ['test/runner-control.test.ts', 1585, 'ccda127338241ba390106ca20d268f161558998989d9aaba4db7c73b43ed6ff4'],
];
const tracked = [
  ...producerPins, ...realTests,
  ['tsconfig.json', 676, '0ee72fb11a698bad9b18c39223569adf5758727272b35bfa99ec7bfa57c3530a'],
  ['tsconfig.build.json', 200, '1c989c374f21f205e7aeb51842cc6032307bc91075faf5a6feccc945fcda49bf'],
  ['pnpm-lock.yaml', 356104, '0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd'],
];
const asyncHooksProvider = join(dependencyRoot, '.pnpm/@types+node@20.19.41/node_modules/@types/node/async_hooks.d.ts');
const asyncHooksSha = '8c0bcd6c6b67b4b503c11e91a1fb91522ed585900eab2ab1f61bba7d7caa9d6f';
const dependencyAlias = join(work, 'node_modules');
const generatedNames = ['next-env.d.ts','.next/types/cache-life.d.ts','.next/types/root-params.d.ts',
  '.next/types/routes.d.ts','.next/types/validator.ts'];
const generatedPaths = generatedNames.map(name=>join(project,name));
const validator = generatedPaths.at(-1);
const cells = ['source-0','reference-0','reference-1','source-1'];
const phases = ['original-list-only','producer',...cells,'source-negative','reference-negative','missing-reference','owned-declarations-and-context'];
const packages = [
  ['drizzle-orm','drizzle-orm','index.d.ts','0.45.2','+postgres@3.4.9'],
  ['drizzle-orm/postgres-js','drizzle-orm','postgres-js/index.d.ts','0.45.2','+postgres@3.4.9'],
  ['drizzle-orm/pg-core','drizzle-orm','pg-core/index.d.ts','0.45.2','+postgres@3.4.9'],
  ['postgres','postgres','types/index.d.ts','3.4.9',null],
];
const probeSource = `import { withTenant, type Db, type Tx, type SessionContext } from '@/db/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { Sql } from 'postgres';
const table = pgTable('native_reference_contract', { id: text().notNull(), observed: integer() });
const ctx: SessionContext = { tenantId: 'fictional', grants: [{ role: 'hr_admin', companyId: null }] };
const selected = withTenant(ctx, async tx => {
  const [row] = await tx.select({ id: table.id, observed: table.observed }).from(table);
  return { kind: 'selected' as const, id: row.id, observed: row.observed };
});
const typed: Promise<{ kind: 'selected'; id: string; observed: number | null }> = selected;
const nested: Promise<{ kind: 'intact'; value: number }> = withTenant(ctx, async () => ({kind:'intact' as const,value:1}));
const store = new AsyncLocalStorage<Tx>();
const current: Tx | undefined = store.getStore();
declare const db: Db;
const nativeDb: PostgresJsDatabase<Record<string, never>> = db;
const nativeClient: Sql = db.$client;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Row = Awaited<typeof selected>;
export type NoAny = Assert<IsAny<Db | Tx | SessionContext | Row | Row['id'] | Row['observed']> extends false ? true : false>;
void [typed, nested, current, nativeDb, nativeClient, sql];
`;
const negatives = [
  [2322, "withTenant({tenantId:'fictional', entitlements:42}, async()=>true);"],
  [2322, 'const badGeneric: Promise<string> = withTenant(ctx, async()=>1);'],
  [2339, 'withTenant(ctx, async tx=>tx.select({bad:table.__aihr_missing_column__}).from(table));'],
  [2322, 'const badAmbient: AsyncLocalStorage<number> = new AsyncLocalStorage<string>();'],
];

const fields = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child);
};

function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function seal(path, check, maximum = maxSealBytes) {
  check();
  assert((within(project, path) || within(work, path)) && realpathSync(path) === path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, {bigint: true});
    assert(before.isFile() && before.size >= 0n && before.size <= BigInt(maximum));
    assert(within(dependencyRoot, path) ? before.nlink > 0n : before.nlink === 1n);
    const hash = createHash('sha256');
    const block = Buffer.allocUnsafe(65536);
    let bytes = 0;
    for (;;) {
      check();
      const size = readSync(fd, block, 0, block.length, null);
      if (size === 0) break;
      bytes += size;
      assert(bytes <= Number(before.size));
      hash.update(block.subarray(0, size));
    }
    const after = fstatSync(fd, {bigint: true});
    const named = lstatSync(path, {bigint: true});
    assert.equal(bytes, Number(before.size));
    assert(fields.every(key => before[key] === after[key] && after[key] === named[key]));
    return {path, bytes, sha256: hash.digest('hex'), identity: Object.fromEntries(fields.map(key => [key, String(before[key])]))};
  } finally { closeSync(fd); }
}

function checkView() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.versions.node, '22.23.3');
  assert.equal(process.pid, 1);
  assert.equal(process.argv[0], runtime);
  assert(process.getuid() > 0);
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).map(line => line.split(' '));
  for (const path of [project, dependencyRoot, join(project, '.next'), generatedPaths[0]]) {
    const rows = mounts.filter(fields => fields[4] === path);
    assert.equal(rows.length, 1, 'Expected one physical protected input mount');
    assert(rows[0][5].split(',').includes('ro'), 'Compiler input must be physically read-only');
  }
  assert(mounts.filter(fields => fields[4] === '/work' && fields[5].split(',').includes('rw')).length === 1);
  for (const path of ['/node_modules', '/work/node_modules', dependencyAlias]) assert(!exists(path));
}

function checkGenerated(expected, check) {
  assert.deepEqual(Object.keys(expected).sort(), [...generatedNames].sort());
  return generatedPaths.map((path,index)=>{
    const row = seal(path, check);
    assert(row.bytes>0 && row.bytes<=8*mib);
    assert.deepEqual({bytes:row.bytes,sha256:row.sha256}, expected[generatedNames[index]]);
    return row;
  });
}

function processStart(pid) {
  const line = readFileSync('/proc/' + pid + '/stat', 'utf8');
  assert(line.startsWith(pid + ' ('));
  const value = line.slice(line.lastIndexOf(') ') + 2).split(' ')[19];
  assert(/^[0-9]+$/.test(value));
  return value;
}

function cliChild(cli, args, deadline, signal) {
  signal?.throwIfAborted();
  const started = performance.now();
  assert(deadline - started > 2_000, 'No private compiler settlement reserve');
  return new Promise(resolve => {
    const child = spawn(runtime, ['--max-old-space-size=12288', cli, ...args], {
      cwd: project, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stopped = null, failure = null, exited = false, closed = false, bytes = 0, peakRss = 0, samples = 0;
    let startId, killer, drain;
    const chunks = [];
    const stop = reason => {
      stopped ??= reason;
      if (closed || exited) return;
      try { child.kill('SIGTERM'); } catch (error) { failure ??= error.code ?? 'KILL'; }
      killer ??= setTimeout(() => {
        if (!closed && !exited) try { child.kill('SIGKILL'); } catch (error) { failure ??= error.code ?? 'KILL'; }
      }, 700);
    };
    const timeout = setTimeout(() => stop('phase-deadline'), Math.max(1, deadline - performance.now() - 1_250));
    const abort = () => stop('aborted');
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    child.once('error', error => { failure ??= error.code ?? 'SPAWN'; stop('child-error'); });
    child.once('exit', () => {
      exited = true;
      clearInterval(sampler);
      clearTimeout(killer);
      drain = setTimeout(() => {
        if (!closed) {
          stopped ??= 'pipe-drain';
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
      }, Math.max(0, Math.min(500, deadline - performance.now())));
    });
    child.once('close', (exitCode, exitSignal) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(killer);
      clearTimeout(drain);
      clearInterval(sampler);
      signal?.removeEventListener('abort', abort);
      if (performance.now() > deadline) stopped ??= 'phase-deadline';
      resolve({exitCode, exitSignal, failure, stopped, elapsedMs: performance.now() - started, peakRss, samples, raw: Buffer.concat(chunks)});
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) { stop('missing-pipe'); continue; }
      stream.on('error', error => { failure ??= error.code ?? 'PIPE'; stop('pipe-error'); });
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= maxLogBytes) chunks.push(chunk);
        else stop('output-bound');
      });
    }
    if (child.pid > 1) {
      try { startId = processStart(child.pid); }
      catch { stop('missing-process-identity'); }
    }
    const sampler = setInterval(() => {
      if (exited || closed || startId === undefined) return;
      try {
        if (processStart(child.pid) !== startId) return;
        const rss = /^VmRSS:\s+([0-9]+) kB$/m.exec(readFileSync('/proc/' + child.pid + '/status', 'utf8'));
        if (rss && processStart(child.pid) === startId) {
          samples++;
          peakRss = Math.max(peakRss, Number(rss[1]) * 1024);
        }
      } catch { /* The verified child can exit between procfs reads. */ }
    }, 75);
  });
}

function parseConfig(ts, path) {
  const raw = ts.readConfigFile(path, ts.sys.readFile);
  assert.equal(raw.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(path), undefined, path);
  assert.deepEqual(parsed.errors, []);
  return parsed;
}

const diagnosticPattern = /^(.+)\(([0-9]+),([0-9]+)\): error TS([0-9]+):/gm;
function diagnostics(text) {
  const rows = [...text.matchAll(diagnosticPattern)].map(([, file, line, column, code]) =>
    ({file: resolve(project, file), line: Number(line), column: Number(column), code: Number(code)}));
  assert.equal(rows.length, [...text.matchAll(/error TS[0-9]+:/g)].length, 'Unowned native TypeScript diagnostic');
  return rows;
}

function fileList(text) {
  const names = text.split(/\r?\n/).filter(line => line.startsWith('/') && !/\([0-9]+,[0-9]+\): error TS/.test(line));
  assert(names.length > 0 && names.length <= maxFiles && new Set(names).size === names.length);
  assert(names.every(path => within(project, path) || within(work, path)));
  return names;
}

function metrics(text, names) {
  const read = expression => {
    const found = [...text.matchAll(expression)];
    assert.equal(found.length, 1, 'Missing or duplicate stock extended diagnostic');
    const value = Number(found[0][1]);
    assert(Number.isSafeInteger(value) && value > 0);
    return value;
  };
  const files = read(/^Files:[ \t]+([0-9]+)\r?$/gm);
  assert.equal(files, names.length);
  return {files, compilerHeapUsedRoundedKB: read(/^Memory used:[ \t]+([0-9]+)K\r?$/gm)};
}

function nativeProgram(ts, parsed) {
  const program = ts.createProgram({rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences});
  assert.deepEqual(program.getRootFileNames(), parsed.fileNames);
  return program;
}

function observeProgram(ts, program, check) {
  const files = program.getSourceFiles();
  assert(files.length > 0 && files.length <= maxFiles);
  const configured = new Set(program.getRootFileNames());
  const records = new Map();
  let totalBytes = 0;
  function read(file) {
    if (!records.has(file)) {
      const logical = resolve(file.fileName);
      const path = realpathSync(logical);
      const record = seal(path, check);
      const decoded = ts.sys.readFile(logical);
      assert.equal(decoded, file.text, 'Default native Program read differs from sealed input');
      assert.deepEqual(seal(path, check), record);
      const external = program.isSourceFileFromExternalLibrary(file);
      const defaultLibrary = program.isSourceFileDefaultLibrary(file);
      const readOnlyDependency = within(dependencyRoot, path);
      if (readOnlyDependency) assert((external || defaultLibrary) && !configured.has(logical));
      totalBytes += record.bytes;
      assert(totalBytes <= 1024 * mib);
      records.set(file, {...record, logicalPath: logical, loadedTextSha256: sha(file.text), loadedTextCodeUnits: file.text.length,
        readOnlyDependency, declaration: file.isDeclarationFile, external, defaultLibrary,
        languageVariant: file.languageVariant, languageVersion: file.languageVersion, impliedNodeFormat: file.impliedNodeFormat ?? null});
    }
    return records.get(file);
  }
  function fileFor(path) {
    const file = program.getSourceFile(path);
    assert(file && realpathSync(file.fileName) === path, 'Expected native SourceFile absent');
    return file;
  }
  const packageRows = new Map();
  function target(value) {
    assert(value?.packageId);
    const file = program.getSourceFile(value.resolvedFileName);
    assert(file?.isDeclarationFile && program.isSourceFileFromExternalLibrary(file));
    const {path, bytes, sha256} = read(file);
    const {name, version, subModuleName, peerDependencies} = value.packageId;
    const manifest = realpathSync(join(file.packageJsonScope.packageDirectory, 'package.json'));
    assert(within(dependencyRoot, manifest));
    if (!packageRows.has(manifest)) {
      const before = seal(manifest, check);
      const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
      assert.equal(metadata.name, name);
      assert.equal(metadata.version, version);
      assert.deepEqual(seal(manifest, check), before);
      packageRows.set(manifest, before);
    }
    return {path, bytes, sha256, packageId: {name, version, subModuleName, peerDependencies: peerDependencies ?? null}};
  }
  function moduleFor(path, name, synthetic) {
    const file = fileFor(path);
    const indices = file.imports.flatMap((literal, index) =>
      literal.text === name && (literal.pos === -1 && literal.end === -1) === synthetic ? [index] : []);
    assert.equal(indices.length, 1);
    const [index] = indices;
    const value = program.getResolvedModuleFromModuleSpecifier(file.imports[index], file)?.resolvedModule;
    assert(value, 'Missing stored native module resolution');
    return {value, mode: program.getModeForResolutionAtIndex(file, index) ?? null};
  }
  function packageAt(path, name, synthetic) {
    const {value, mode} = moduleFor(path, name, synthetic);
    return {mode, target: target(value)};
  }
  const options = program.getCompilerOptions();
  const typeRoots = ts.getEffectiveTypeRoots(options, ts.sys);
  const automaticNames = program.getAutomaticTypeDirectiveNames();
  assert.deepEqual(automaticNames, ts.getAutomaticTypeDirectiveNames(options, ts.sys));
  assert(automaticNames.length > 0 && automaticNames.length <= 64 && new Set(automaticNames).size === automaticNames.length);
  const automaticTypes = automaticNames.map(name => ({name, target: target(program.getAutomaticTypeDirectiveResolutions()
    .get(name, undefined)?.resolvedTypeReferenceDirective)}));
  return {files, read, fileFor, moduleFor, packageAt, target, typeRoots, automaticTypes, packageRows};
}

function emittedFiles(dir, check) {
  const names = [];
  function visit(path) {
    for (const name of readdirSync(path)) {
      check();
      const current = join(path, name);
      const stat = lstatSync(current);
      if (stat.isDirectory()) visit(current);
      else {
        assert(stat.isFile());
        names.push(current);
      }
      assert(names.length <= 6);
    }
  }
  visit(dir);
  return names.sort();
}

function assertDependencyAlias() {
  assert(lstatSync(dependencyAlias).isSymbolicLink());
  assert.equal(readlinkSync(dependencyAlias),dependencyRoot);
  assert.equal(realpathSync(dependencyAlias),dependencyRoot);
  assert(!exists('/node_modules')&&!exists('/work/node_modules'));
}

function importStatement(ts,observed,path,name) {
  const declarations=observed.fileFor(path).statements.filter(node=>ts.isImportDeclaration(node)&&node.moduleSpecifier.text===name);
  assert.equal(declarations.length,1);
  return declarations[0];
}

function assertNativeImport(ts,checker,observed,path,name,selected) {
  const declaration=importStatement(ts,observed,path,name);
  const matches=checker.getSymbolAtLocation(declaration.moduleSpecifier)?.declarations;
  assert(matches?.length>0&&matches.every(node=>realpathSync(node.getSourceFile().fileName)===selected),
    'Native module symbol selected a different declaration');
  return declaration;
}

function assertAmbient(ts,checker,observed,path) {
  const name='node:async_hooks';
  const declaration=assertNativeImport(ts,checker,observed,path,name,asyncHooksProvider);
  const file=observed.fileFor(path);
  const indices=file.imports.flatMap((literal,index)=>literal===declaration.moduleSpecifier?[index]:[]);
  assert.equal(indices.length,1);
  assert.equal(checker.getAmbientModules().filter(symbol=>symbol.name==='"'+name+'"').length,1);
  const element=declaration.importClause.namedBindings.elements.find(row=>row.name.text==='AsyncLocalStorage');
  const alias=checker.getSymbolAtLocation(element.name);
  assert(alias.flags&ts.SymbolFlags.Alias);
  const symbol=checker.getAliasedSymbol(alias);
  assert.equal(symbol.name,'AsyncLocalStorage');
  assert(symbol.declarations?.length&&symbol.declarations.every(node=>realpathSync(node.getSourceFile().fileName)===asyncHooksProvider));
  const sealed=observed.read(observed.fileFor(asyncHooksProvider));
  assert.equal(sealed.sha256,asyncHooksSha);
  return {module:name,symbol:symbol.name,providerSha256:sealed.sha256,providerBytes:sealed.bytes};
}

/** Called by the admitted protected PID 1 with the freshly sealed typegen output map. */
export async function runProtectedDbClientComparison({
  reportRoot = work, deadlineMs = performance.now() + maxAggregateMs, expectedGenerated, signal,
} = {}) {
  assert.equal(reportRoot, work);
  checkView();
  const started = performance.now();
  assert(Number.isFinite(deadlineMs) && deadlineMs - started > 2_000);
  const stop = Math.min(deadlineMs, started + maxAggregateMs);
  const check = () => {
    signal?.throwIfAborted();
    assert(performance.now() < stop, 'Protected DB client comparison deadline exhausted');
  };
  mkdirSync(work, {mode: 0o700});
  assert.equal(realpathSync(work), work);
  const report = {kind: 'PROTECTED_DB_CLIENT_REFERENCE_COMPARISON', product, complete: false,
    ordinaryCompilerQualified: false, releaseAuthorized: false, applicationAmbientEquivalenceQualified: false,
    originalApplicationFiveNegativesQualified: false, generatedValidatorSemanticRequested: false,
    plannedPhases: phases, phases: [], attempts: []};
  function save() {
    const raw = JSON.stringify(report, null, 2) + '\n';
    assert(Buffer.byteLength(raw) <= maxLogBytes);
    writeFileSync(join(work, 'report.next.json'), raw, {flag: 'wx', mode: 0o600});
    renameSync(join(work, 'report.next.json'), join(work, 'report.json'));
  }
  function done(phase, details) {
    check();
    report.phases.push({phase, ...details});
    save();
  }
  save();
  try {
    const generated = checkGenerated(expectedGenerated, check);
    report.generated = expectedGenerated;
    const pins = tracked.map(([name, bytes, digest]) => {
      const record = seal(join(project, name), check);
      assert.deepEqual([record.bytes, record.sha256], [bytes, digest]);
      return record;
    });
    const require = createRequire(join(project, 'package.json'));
    const api = realpathSync(require.resolve('typescript'));
    const cli = realpathSync(join(dirname(api), '_tsc.js'));
    assert(within(dependencyRoot, api) && within(dependencyRoot, cli));
    const tools = [seal(api, check), seal(cli, check)];
    assert.deepEqual(tools.map(row => row.sha256), [apiSha, cliSha]);
    const ts = require(api);
    assert.equal(ts.version, '5.9.3');
    report.tools = {typescript: ts.version, node: process.versions.node, inputs: tools};
    const held = [...pins, ...tools];
    const logs = [];
    const verify = () => {
      check();
      assert.deepEqual(checkGenerated(expectedGenerated, check), generated);
      assert.deepEqual(held.map(row => seal(row.path, check)), held);
    };
    function write(path, contents) {
      check();
      writeFileSync(path, contents, {flag: 'wx', mode: 0o600});
      const record = seal(path, check);
      held.push(record);
      return record;
    }
    async function run(phase, args, slotMs, buildInfo, negative = false) {
      verify();
      assert(!exists(buildInfo), 'Cold native compiler state required');
      const availableMemory = process.availableMemory();
      assert(Number.isSafeInteger(availableMemory) && availableMemory >= minAvailable, 'Insufficient protected cgroup headroom');
      const {raw, ...result} = await cliChild(cli, args, Math.min(stop, performance.now() + slotMs), signal);
      const path = join(work, phase + '.log');
      writeFileSync(path, raw, {flag: 'wx', mode: 0o600});
      const log = seal(path, () => {}, maxLogBytes);
      logs.push(log);
      report.attempts.push({phase, availableMemory, ...result, log});
      save();
      assert.equal(result.exitSignal, null);
      assert.equal(result.failure, null);
      assert.equal(result.stopped, null);
      assert(result.samples > 0 && result.peakRss > 0 && result.elapsedMs > 0, 'Native compiler process was not sampled');
      if (negative) assert(Number.isInteger(result.exitCode) && result.exitCode > 0);
      else assert.equal(result.exitCode, 0);
      verify();
      return {text: raw.toString('utf8'), log};
    }

    const full = parseConfig(ts, original);
    const build = parseConfig(ts, join(project, 'tsconfig.build.json'));
    const roots = full.fileNames;
    assert(full.options.strict && full.options.noEmit && !full.projectReferences?.length);
    assert(roots.length > 9000 && roots.length <= maxFiles && new Set(roots).size === roots.length);
    assert(roots.every(path => within(project,path) && !within(dependencyRoot,path)));
    assert(roots.includes(validator));
    const originalSet = new Set(roots), buildSet = new Set(build.fileNames);
    assert(build.fileNames.every(path=>originalSet.has(path)));
    const complement = roots.filter(path=>!buildSet.has(path));
    const heavy = new Set(complement.slice(Math.floor(complement.length / 2)));
    const tests = realTests.map(([name])=>join(project,name));
    assert(tests.every(path=>heavy.has(path)), 'Fixed real tests must be members of the actual second tooling slice');
    const fullBuildInfo = join(work, 'original.tsbuildinfo');
    const stock = await run('original-list-only', ['-p', original, '--listFilesOnly', '--pretty', 'false',
      '--tsBuildInfoFile', fullBuildInfo], 40_000, fullBuildInfo);
    assert.deepEqual(diagnostics(stock.text), []);
    const loaded = fileList(stock.text), loadedSet = new Set(loaded);
    assert(roots.every(path=>loadedSet.has(path)));
    done('original-list-only', {configuredRoots:roots.length, loadedFiles:loaded.length, validatorObserved:true,
      secondToolingRoots:heavy.size, secondToolingSeal:sha(JSON.stringify([...heavy])), compilerSemanticsRequested:false});

    const producerModules = producerPins.map(([name])=>join(project,name));
    const declarations = generatedPaths.slice(0,-1);
    const ordered = files => {
      const picked = roots.filter(path=>files.includes(path));
      assert.equal(picked.length, files.length);
      return picked;
    };
    const typeRoots = ts.getEffectiveTypeRoots(full.options, ts.sys);
    assert.deepEqual(typeRoots,[join(dependencyRoot,'@types'),'/node_modules/@types']);
    assert(!exists(dependencyAlias));
    symlinkSync(dependencyRoot,dependencyAlias,'dir');
    assertDependencyAlias();
    const provider = seal(asyncHooksProvider,check);
    assert.equal(provider.sha256,asyncHooksSha);
    held.push(provider);
    const probe = write(join(work,'db-client-contract.ts'),probeSource).path;
    const negativeProbe = write(join(work,'db-client-negative.ts'),probeSource+negatives.map(row=>row[1]).join('\n')+'\n').path;
    const missingProbe = write(join(work,'missing-db-client.ts'),"import type { SessionContext } from '@/db/client';\nexport type Context = SessionContext;\n").path;

    function config(label, files, options, references=[]) {
      assert(files.length<=400 && new Set(files).size===files.length);
      const path = join(work,label+'.json'), buildInfo = join(work,label+'.tsbuildinfo');
      write(path,JSON.stringify({extends:original,files,include:[],exclude:[],references:references.map(path=>({path})),
        compilerOptions:{typeRoots,tsBuildInfoFile:buildInfo,...options}})+'\n');
      const parsed = parseConfig(ts,path);
      assert.deepEqual(parsed.fileNames,files);
      assert.deepEqual((parsed.projectReferences??[]).map(row=>row.path),references);
      assert.deepEqual(parsed.options,{...full.options,configFilePath:path,typeRoots,tsBuildInfoFile:buildInfo,...options});
      return {path,buildInfo,parsed};
    }
    const producerFiles = ordered([...producerModules,...declarations]);
    function producer(label) {
      const emitted = join(work,label+'-output');
      mkdirSync(emitted,{mode:0o700});
      return {...config(label,producerFiles,{noEmit:false,noEmitOnError:true,composite:true,declaration:true,emitDeclarationOnly:true,
        disableSourceOfProjectReferenceRedirect:true,rootDir:project,outDir:emitted}),emitted};
    }
    const built = producer('producer'), absent = producer('absent-producer');
    const expectedOutputs = producerModules.map(path=>join(built.emitted,relative(project,path).replace(/\.ts$/,'.d.ts'))).sort();
    assert.deepEqual(built.parsed.fileNames.flatMap(path=>ts.getOutputFileNames(built.parsed,path,false)).sort(),expectedOutputs);
    const producerResult = await run('producer',['-p',built.path,'--pretty','false','--listFiles','--listEmittedFiles'],
      13_000,built.buildInfo);
    assert.deepEqual(diagnostics(producerResult.text),[]);
    const nativeOutputs = producerResult.text.split(/\r?\n/).filter(line=>line.startsWith('TSFILE: ')).map(line=>line.slice(8)).sort();
    assert.deepEqual(nativeOutputs,[...expectedOutputs,built.buildInfo].sort());
    assert.deepEqual(emittedFiles(built.emitted,check),expectedOutputs);
    const outputs = nativeOutputs.map(path=>seal(path,check));
    held.push(...outputs);
    const producerLoaded = fileList(producerResult.text);
    assert.deepEqual(producerLoaded.filter(path=>!within(dependencyRoot,path)).sort(),[...producerFiles].sort());
    done('producer',{outputs,orderedFiles:producerLoaded});

    const shared = [...tests,...declarations], leafOptions = {disableSourceOfProjectReferenceRedirect:true};
    const sourceFiles = ordered([...shared,...producerModules]), referenceFiles = ordered(shared);
    const records = new Map();
    for (const phase of cells) {
      const reference = phase.startsWith('reference-');
      const cell = config(phase,[...(reference?referenceFiles:sourceFiles),probe],leafOptions,reference?[built.path]:[]);
      const measured = await run(phase,['-p',cell.path,'--noEmit','--listFiles','--pretty','false','--extendedDiagnostics'],
        12_000,cell.buildInfo);
      assert.deepEqual(diagnostics(measured.text),[]);
      const names = fileList(measured.text);
      if (exists(cell.buildInfo)) held.push(seal(cell.buildInfo,check));
      records.set(phase,{cell,names});
      done(phase,{metrics:metrics(measured.text,names),orderedFiles:names});
    }
    for (const [left,right] of [['source-0','source-1'],['reference-0','reference-1']]) {
      assert.deepEqual(records.get(left).names,records.get(right).names,'Repeated cold arm changed its native loaded order');
    }
    const negativeDiagnostics = [];
    for (const reference of [false,true]) {
      const phase = reference?'reference-negative':'source-negative';
      const cell = config(phase,[...(reference?referenceFiles:sourceFiles),negativeProbe],leafOptions,reference?[built.path]:[]);
      const measured = await run(phase,['-p',cell.path,'--noEmit','--pretty','false','--listFiles'],12_000,cell.buildInfo,true);
      const rows = diagnostics(measured.text);
      assert.deepEqual(rows.map(({file,line,code})=>({file,line,code})),negatives.map(([code],index)=>
        ({file:negativeProbe,line:probeSource.split('\n').length+index,code})));
      assert.equal(fileList(measured.text).includes(join(project,'db/client.ts')),!reference);
      negativeDiagnostics.push(rows);
      if (exists(cell.buildInfo)) held.push(seal(cell.buildInfo,check));
      done(phase,{diagnostics:rows});
    }
    assert.deepEqual(negativeDiagnostics[0],negativeDiagnostics[1]);
    const missing = config('missing-reference',[...ordered(declarations),missingProbe],leafOptions,[absent.path]);
    const refused = await run('missing-reference',['-p',missing.path,'--noEmit','--pretty','false','--listFiles'],8_000,missing.buildInfo,true);
    const refusedDiagnostics = diagnostics(refused.text);
    assert.deepEqual(refusedDiagnostics.map(({file,line,code})=>({file,line,code})),[{file:missingProbe,line:1,code:6305}]);
    assert(producerModules.every(path=>!fileList(refused.text).includes(path)));
    assert.deepEqual(emittedFiles(absent.emitted,check),[]);
    assert(!exists(absent.buildInfo));
    if (exists(missing.buildInfo)) held.push(seal(missing.buildInfo,check));
    done('missing-reference',{diagnostics:refusedDiagnostics});

    const clientSource = join(project,'db/client.ts'), clientOutput = join(built.emitted,'db/client.d.ts');
    function nativeContext(phase,target) {
      verify();assertDependencyAlias();
      const {cell,names} = records.get(phase);
      const program = nativeProgram(ts,cell.parsed), observed = observeProgram(ts,program,check);
      assert.deepEqual(observed.files.map(file=>file.fileName),names);
      const loaded = observed.files.map(observed.read);
      const checker = program.getTypeChecker();
      for (const [file,name] of [[probe,'@/db/client'],...tests.map(path=>[path,'../db/client'])]) {
        assertNativeImport(ts,checker,observed,file,name,target);
        assert.equal(observed.moduleFor(file,name,false).mode,99);
      }
      const packageIds = packages.map(([specifier,name,subModuleName,version,peerDependencies])=>{
        const selected = observed.packageAt(probe,specifier,false);
        assert.equal(selected.mode,99);
        assert.deepEqual(selected.target.packageId,{name,subModuleName,version,peerDependencies});
        return {specifier,...selected};
      });
      const ambient = [assertAmbient(ts,checker,observed,probe)];
      const nodeTypes = observed.automaticTypes.find(row=>row.name==='node');
      assert(nodeTypes?.target.packageId.version==='20.19.41');
      const declared = [];
      if (target===clientSource) {
        for (const path of ['db/workload.ts','db/background-read-admission.ts']) {
          ambient.push(assertAmbient(ts,checker,observed,join(project,path)));
        }
        for (const specifier of ['drizzle-orm','drizzle-orm/postgres-js','postgres']) {
          const {specifier:_,...same} = packageIds.find(row=>row.specifier===specifier);
          assert.deepEqual(observed.packageAt(clientSource,specifier,false),same);
        }
      } else {
        for (const path of loaded.filter(row=>expectedOutputs.includes(row.path)).map(row=>row.path)) {
          const file = observed.fileFor(path);
          for (const [index,literal] of (file.imports??[]).entries()) {
            const value = program.getResolvedModuleFromModuleSpecifier(literal,file)?.resolvedModule;
            assert(value, 'Unresolved reference declaration edge');
            if (literal.text.startsWith('.')) {
              const stored=realpathSync(value.resolvedFileName);
              const selected=producerModules.includes(stored)
                ? join(built.emitted,relative(project,stored).replace(/\.ts$/,'.d.ts')) : stored;
              assert(expectedOutputs.includes(selected));
              const declarations=checker.getSymbolAtLocation(literal)?.declarations;
              assert(declarations?.length&&declarations.every(node=>realpathSync(node.getSourceFile().fileName)===selected),
                'Emitted declaration edge selected an unowned module');
              assert(observed.fileFor(selected).isDeclarationFile);
            } else {
              const binding = packageIds.find(row=>row.specifier===literal.text);
              assert(binding, 'Unexpected package in emitted declaration');
              const target = observed.target(value);
              assert.deepEqual(target,binding.target);
              declared.push({specifier:literal.text,mode:program.getModeForResolutionAtIndex(file,index)??null});
            }
          }
        }
        assert(['drizzle-orm/postgres-js','postgres'].every(name=>declared.some(row=>row.specifier===name)));
      }
      return {loaded,packageIds,ambient,declared,automaticTypes:observed.automaticTypes,typeRoots:observed.typeRoots};
    }
    const a = nativeContext('source-0',clientSource), b = nativeContext('reference-0',clientOutput);
    assert.deepEqual(a.packageIds,b.packageIds);
    assert.deepEqual(a.automaticTypes,b.automaticTypes);
    assert.deepEqual(a.typeRoots,b.typeRoots);
    assert(a.ambient.every(value=>JSON.stringify(value)===JSON.stringify(b.ambient[0])));
    const aMap = new Map(a.loaded.map(row=>[row.path,row])), bMap = new Map(b.loaded.map(row=>[row.path,row]));
    assert.equal(aMap.size,a.loaded.length);assert.equal(bMap.size,b.loaded.length);
    const common = [...aMap.keys()].filter(path=>bMap.has(path));
    for (const path of common) {
      const {logicalPath:beforeLogical,...before} = aMap.get(path);
      const {logicalPath:afterLogical,...after} = bMap.get(path);
      assert.deepEqual(before,after);
      assert.equal(realpathSync(beforeLogical),realpathSync(afterLogical));
    }
    const sourceOnly = [...aMap.keys()].filter(path=>!bMap.has(path)).sort();
    const referenceOnly = [...bMap.keys()].filter(path=>!aMap.has(path)).sort();
    assert.deepEqual(sourceOnly,[...producerModules].sort());
    assert(referenceOnly.includes(clientOutput)&&referenceOnly.every(path=>expectedOutputs.includes(path)));
    assert(producerModules.every(path=>!bMap.has(path)));
    assert(!aMap.has(validator)&&!bMap.has(validator));

    const validation = config('owned-declarations',[...ordered(declarations),...expectedOutputs],{skipLibCheck:false});
    const program = nativeProgram(ts,validation.parsed), observed = observeProgram(ts,program,check);
    assert(observed.files.every(file=>file.isDeclarationFile));
    const errors = [...program.getConfigFileParsingDiagnostics(),...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),...program.getSyntacticDiagnostics()];
    for (const path of expectedOutputs) {
      check(); const file = observed.fileFor(path);
      assert(!program.isSourceFileFromExternalLibrary(file));
      errors.push(...program.getSemanticDiagnostics(file));
    }
    assert.deepEqual(errors,[]);
    assert.deepEqual(observed.files.map(observed.read).filter(row=>!row.readOnlyDependency).map(row=>row.path).sort(),
      [...declarations,...expectedOutputs].sort());
    verify();assertDependencyAlias();
    assert.deepEqual(logs.map(row=>seal(row.path,check,maxLogBytes)),logs);
    done('owned-declarations-and-context',{sourceOnly,referenceOnly,commonInputCount:common.length,
      sourceAlias:clientSource,referenceAlias:clientOutput,packageIds:a.packageIds,automaticTypes:a.automaticTypes,
      ambient:a.ambient,emittedPackageUses:b.declared,ownedDeclarations:expectedOutputs,externalSemanticRequested:false,
      matchedNegativeCodes:negativeDiagnostics[0].map(row=>row.code)});
    assert.deepEqual(report.phases.map(row=>row.phase),phases);
    assert.deepEqual(report.attempts.map(row=>row.phase),phases.slice(0,-1));
    check();report.elapsedMs=performance.now()-started;report.complete=true;save();
  } catch (error) {
    report.failure={code:typeof error.code==='string'?error.code:null};save();throw error;
  }
}
