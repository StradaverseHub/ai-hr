/** Fixed stock TypeScript comparison for the real Payroll TP1 route in the protected view. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, readSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

const project = '/project';
const runtime = '/runtime/node';
const work = '/work/tp1';
const dependencyRoot = join(project, 'node_modules');
const original = join(project, 'tsconfig.json');
const product = 'a1397fa78ed35188849445962d35bdf48087b7a4';
const route = 'app/payroll/transactions/tp1/[year]/page.tsx';
const page = join(project, route);
const apiSha = '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675';
const cliSha = 'e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419';
const mib = 1024 ** 2;
const maxFiles = 50_000;
const maxLogBytes = 16 * mib;
const maxSealBytes = 16 * mib;
const maxAggregateMs = 120_000;
const minAvailable = 6 * 1024 ** 3;
const childEnv = Object.freeze({PATH: '/runtime', HOME: '/nonexistent', TMPDIR: work, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'});
const datePins = [
  ['lib/calendar-date.ts', 359, '26402672f174dbfdac800d752d8e85e54c968a6b7ae87564d99dd87bdc251824'],
  ['lib/date-time-formatter.ts', 654, '922a5fa0788d66508f88ec0ba7d82cb89d4038465051d6d87c514601e89c37e9'],
  ['lib/hr-date.ts', 4757, 'bcd1a856837061eb50adf459e4c3512ccb0bd145967bfcf7bf496b1f46c84823'],
];
const tracked = [
  ...datePins,
  [route, 2545, 'a83f01f578f8997899fec34c7976a12648fb831107163fde97c37f4fbc7e7a84'],
  ['tsconfig.json', 676, '0ee72fb11a698bad9b18c39223569adf5758727272b35bfa99ec7bfa57c3530a'],
  ['pnpm-lock.yaml', 356104, '0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd'],
];
const authenticatedGenerated = {
  'next-env.d.ts': {bytes: 288, sha256: '1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b'},
  '.next/types/cache-life.d.ts': {bytes: 4585, sha256: '87384ad5954f65285fc17ba8ed39d010a8ef111edba114e493b0431d677e5faa'},
  '.next/types/root-params.d.ts': {bytes: 101, sha256: 'f3387dd7800eec3c34273f7a8efad13e864598c7e8f788d321e407390989bb59'},
  '.next/types/routes.d.ts': {bytes: 66088, sha256: '52aeb68060ebdc801316e0a6880c848ee0fbc87542c452b65d963c1dafbb7432'},
  '.next/types/validator.ts': {bytes: 616652, sha256: '860b54f3461834c458201cb58dbf3915fcafc89647b9a76abbe8d56242968124'},
};
const generatedPaths = Object.keys(authenticatedGenerated).map(name => join(project, name));
const validator = generatedPaths.at(-1);
const routeTypes = join(project, '.next/types/routes.d.ts');
const cells = ['source-0', 'reference-0', 'reference-1', 'source-1'];
const phases = ['original-list-only', 'producer', ...cells, 'missing-reference', 'owned-declarations-and-context'];
const probeSource = `import type Page from '@/app/payroll/transactions/tp1/[year]/page';
type Props = Parameters<typeof Page>[0];
type Actual = Awaited<Props['params']>;
type Generated = Awaited<PageProps<'/payroll/transactions/tp1/[year]'>['params']>;
type Search = Awaited<Props['searchParams']>;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
export type BothDirections = [
  Assert<[Actual] extends [Generated] ? true : false>,
  Assert<[Generated] extends [Actual] ? true : false>,
  Assert<IsAny<Actual | Generated | Actual['year'] | Generated['year']> extends false ? true : false>,
  Assert<[Search] extends [{ employmentId?: string }] ? true : false>,
  Assert<[{ employmentId?: string }] extends [Search] ? true : false>,
  Assert<keyof Search extends 'employmentId' ? true : false>,
  Assert<'employmentId' extends keyof Search ? true : false>,
  Assert<IsAny<Search | Search['employmentId']> extends false ? true : false>
];
`;

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
  for (const path of ['/node_modules', '/work/node_modules', join(work, 'node_modules')]) assert(!exists(path));
}

function checkGenerated(expected, check) {
  assert.deepEqual(expected, authenticatedGenerated, 'Fresh generated context differs from authenticated product');
  assert.deepEqual(readdirSync(join(project, '.next')).sort(), ['types']);
  assert.deepEqual(readdirSync(join(project, '.next/types')).sort(), generatedPaths.slice(1).map(path => path.split('/').at(-1)).sort());
  const records = generatedPaths.map(path => seal(path, check, 4 * mib));
  assert.deepEqual(Object.fromEntries(records.map(({path, bytes, sha256}) => [relative(project, path), {bytes, sha256}])), expected);
  return records;
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

function stockEdge(text, roots, check) {
  const names = new Set();
  const selected = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    check();
    if (!line) continue;
    if (line.startsWith('  ')) {
      assert(current);
      if (selected.has(current)) {
        const reasons = selected.get(current);
        assert(reasons.length < 400);
        reasons.push(line.slice(2));
      }
      continue;
    }
    assert(!/^\s/.test(line) && !line.includes('\0') && names.size < maxFiles);
    current = resolve(project, line);
    assert(within(project, current) && !names.has(current));
    names.add(current);
    if ([page, validator, generatedPaths[0]].includes(current)) selected.set(current, []);
  }
  assert(roots.every(path => names.has(path)), 'Native CLI omitted an original configured root');
  for (const path of [validator, generatedPaths[0]]) {
    assert(roots.includes(path) && selected.get(path)?.some(row => /^Matched by include pattern /.test(row)));
  }
  const reason = 'Imported via "../../app/payroll/transactions/tp1/[year]/page.js" from file \'.next/types/validator.ts\'';
  assert.equal(selected.get(page)?.filter(row => row === reason).length, 1, 'Missing exact generated TP1 route edge');
  return {configuredRoots: roots.length, configuredRootOrderSha256: sha(JSON.stringify(roots)), loadedFiles: names.size,
    loadedOrderSha256: sha(JSON.stringify([...names])), from: validator, to: page, reason, compilerSemanticsRequested: false};
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
  return {files, read, fileFor, moduleFor, packageAt, typeRoots, automaticTypes, packageRows};
}

function selectedContext(ts, program, observed, target, probe) {
  const checker = program.getTypeChecker();
  function importTo(from, name, selected) {
    const imports = observed.fileFor(from).statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === name);
    assert.equal(imports.length, 1);
    const declarations = checker.getSymbolAtLocation(imports[0].moduleSpecifier)?.declarations;
    assert(declarations?.length > 0 && declarations.every(node => realpathSync(node.getSourceFile().fileName) === selected),
      'Native module symbol selected a different declaration');
  }
  importTo(page, '@/lib/hr-date', target);
  importTo(probe, '@/app/payroll/transactions/tp1/[year]/page', page);
  const probeFile = observed.fileFor(probe);
  const generated = probeFile.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Generated');
  const reference = generated?.type.typeArguments?.[0]?.objectType;
  assert(reference && ts.isTypeReferenceNode(reference) && reference.typeName.getText(probeFile) === 'PageProps');
  const pageProps = checker.getSymbolAtLocation(reference.typeName)?.declarations;
  assert(pageProps?.length && pageProps.every(node => realpathSync(node.getSourceFile().fileName) === routeTypes),
    'Native PageProps symbol is not the fresh generated route declaration');
  const file = observed.fileFor(page);
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(file));
  assert.equal(exports.length, 1);
  const value = exports.find(symbol => symbol.name === 'default');
  assert(value?.valueDeclaration);
  const [signature, extra] = checker.getTypeOfSymbolAtLocation(value, value.valueDeclaration).getCallSignatures();
  assert(signature && !extra && signature.getParameters().length === 1);
  const [props] = signature.getParameters();
  const propsType = checker.getTypeOfSymbolAtLocation(props, value.valueDeclaration);
  const shape = Object.fromEntries(['params', 'searchParams'].map(name => {
    const member = propsType.getProperty(name);
    assert(member?.valueDeclaration);
    return [name, checker.typeToString(checker.getTypeOfSymbolAtLocation(member, member.valueDeclaration))];
  }));
  const resolved = observed.moduleFor(page, '@/lib/hr-date', false);
  const navigation = observed.packageAt(page, 'next/navigation', false);
  const jsxRuntime = observed.packageAt(page, 'react/jsx-runtime', true);
  assert.equal(navigation.target.packageId.name, 'next');
  assert.equal(navigation.target.packageId.version, '16.4.1');
  assert.equal(jsxRuntime.target.packageId.name, '@types/react');
  assert.equal(jsxRuntime.target.packageId.version, '19.2.16');
  assert.deepEqual([resolved.mode, navigation.mode, jsxRuntime.mode], [99, 99, 99]);
  return {typeRoots: observed.typeRoots, automaticTypes: observed.automaticTypes, navigation, jsxRuntime,
    packages: [...observed.packageRows.values()], generatedPageProps: routeTypes,
    signature: {...shape, result: checker.typeToString(signature.getReturnType())},
    alias: {selectedDeclaration: target, storedResolution: resolved.value.resolvedFileName, mode: resolved.mode}};
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

/** Called by the admitted protected PID 1 with the freshly sealed typegen output map. */
export async function runProtectedTp1Comparison({
  reportRoot = work, deadlineMs = performance.now() + maxAggregateMs, expectedGenerated, signal,
} = {}) {
  assert.equal(reportRoot, work);
  checkView();
  const started = performance.now();
  assert(Number.isFinite(deadlineMs) && deadlineMs - started > 2_000);
  const stop = Math.min(deadlineMs, started + maxAggregateMs);
  const check = () => {
    signal?.throwIfAborted();
    assert(performance.now() < stop, 'Protected TP1 comparison deadline exhausted');
  };
  mkdirSync(work, {mode: 0o700});
  assert.equal(realpathSync(work), work);
  const report = {kind: 'PROTECTED_TP1_DATE_REFERENCE_COMPARISON', product, complete: false,
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
    const roots = full.fileNames;
    assert(full.options.strict && full.options.noEmit);
    assert(roots.length > 0 && roots.length <= maxFiles && new Set(roots).size === roots.length);
    assert(roots.every(path => within(project, path) && !within(dependencyRoot, path)));
    const fullBuildInfo = join(work, 'original.tsbuildinfo');
    const stock = await run('original-list-only', ['-p', original, '--listFilesOnly', '--explainFiles',
      '--pretty', 'false', '--tsBuildInfoFile', fullBuildInfo], 40_000, fullBuildInfo);
    assert.deepEqual(diagnostics(stock.text), []);
    const edge = stockEdge(stock.text, roots, check);
    done('original-list-only', {edge, log: stock.log});

    const date = datePins.map(([name]) => join(project, name));
    const declarations = generatedPaths.slice(0, -1);
    const ordered = files => {
      const picked = roots.filter(path => files.includes(path));
      assert.equal(picked.length, files.length);
      return picked;
    };
    const typeRoots = ts.getEffectiveTypeRoots(full.options, ts.sys);
    assert.deepEqual(typeRoots, [join(dependencyRoot, '@types'), '/node_modules/@types']);
    const probe = write(join(work, 'tp1-contract.ts'), probeSource).path;
    function config(label, files, options, references = []) {
      assert(files.length <= 400 && new Set(files).size === files.length);
      const path = join(work, label + '.json');
      const buildInfo = join(work, label + '.tsbuildinfo');
      write(path, JSON.stringify({extends: original, files, include: [], exclude: [],
        references: references.map(path => ({path})), compilerOptions: {typeRoots, tsBuildInfoFile: buildInfo, ...options}}) + '\n');
      const parsed = parseConfig(ts, path);
      assert.deepEqual(parsed.fileNames, files);
      assert.deepEqual((parsed.projectReferences ?? []).map(row => row.path), references);
      assert.deepEqual(parsed.options, {...full.options, configFilePath: path, typeRoots, tsBuildInfoFile: buildInfo, ...options});
      return {path, buildInfo, parsed};
    }
    const producerFiles = ordered([...date, ...declarations]);
    function producer(label) {
      const emitted = join(work, label + '-output');
      mkdirSync(emitted, {mode: 0o700});
      const options = {noEmit: false, noEmitOnError: true, composite: true, declaration: true, emitDeclarationOnly: false,
        disableSourceOfProjectReferenceRedirect: true, rootDir: project, outDir: emitted};
      return {...config(label, producerFiles, options), emitted};
    }
    const built = producer('producer');
    const absent = producer('absent-producer');
    const expectedOutputs = built.parsed.fileNames.flatMap(path => ts.getOutputFileNames(built.parsed, path, false)).sort();
    assert.deepEqual(expectedOutputs, date.flatMap(path => ['.d.ts', '.js']
      .map(extension => join(built.emitted, relative(project, path).slice(0, -3) + extension))).sort());
    const producerResult = await run('producer', ['-p', built.path, '--pretty', 'false', '--listFiles', '--listEmittedFiles'],
      10_000, built.buildInfo);
    assert.deepEqual(diagnostics(producerResult.text), []);
    const nativeOutputs = producerResult.text.split(/\r?\n/).filter(line => line.startsWith('TSFILE: ')).map(line => line.slice(8)).sort();
    assert.deepEqual(nativeOutputs, [...expectedOutputs, built.buildInfo].sort());
    assert.deepEqual(emittedFiles(built.emitted, check), expectedOutputs);
    const outputs = nativeOutputs.map(path => seal(path, check));
    held.push(...outputs);
    const producerLoaded = fileList(producerResult.text);
    assert.deepEqual(producerLoaded.filter(path => !within(dependencyRoot, path)).sort(), [...producerFiles].sort());
    done('producer', {outputs, orderedFiles: producerLoaded, log: producerResult.log});

    const shared = [page, ...declarations];
    const sourceFiles = [...ordered([...shared, ...date]), probe];
    const referenceFiles = [...ordered(shared), probe];
    const leafOptions = {disableSourceOfProjectReferenceRedirect: true};
    const records = new Map();
    for (const phase of cells) {
      const reference = phase.startsWith('reference-');
      const cell = config(phase, reference ? referenceFiles : sourceFiles, leafOptions, reference ? [built.path] : []);
      const measured = await run(phase, ['-p', cell.path, '--noEmit', '--listFiles', '--pretty', 'false', '--extendedDiagnostics'],
        10_000, cell.buildInfo);
      assert.deepEqual(diagnostics(measured.text), []);
      const names = fileList(measured.text);
      if (exists(cell.buildInfo)) held.push(seal(cell.buildInfo, check));
      records.set(phase, {cell, names});
      done(phase, {config: cell.path, log: measured.log, metrics: metrics(measured.text, names), orderedFiles: names});
    }
    for (const [left, right] of [['source-0', 'source-1'], ['reference-0', 'reference-1']]) {
      assert.deepEqual(records.get(left).names, records.get(right).names, 'Repeated cold arm loaded a different context');
    }

    const negative = config('missing-reference', referenceFiles, leafOptions, [absent.path]);
    const refused = await run('missing-reference', ['-p', negative.path, '--noEmit', '--listFiles', '--pretty', 'false'],
      8_000, negative.buildInfo, true);
    const observedDiagnostics = diagnostics(refused.text);
    assert.equal(observedDiagnostics.length, 1);
    const {file, line, code} = observedDiagnostics[0];
    assert.deepEqual({file, line, code}, {file: page, line: 2, code: 6305});
    const refusedFiles = fileList(refused.text);
    assert(date.every(path => !refusedFiles.includes(path)), 'Missing reference fell back to source implementations');
    assert.deepEqual(emittedFiles(absent.emitted, check), []);
    assert(!exists(absent.buildInfo));
    if (exists(negative.buildInfo)) held.push(seal(negative.buildInfo, check));
    done('missing-reference', {diagnostics: observedDiagnostics, log: refused.log});

    const emittedDate = join(built.emitted, 'lib/hr-date.d.ts');
    const [sourceContext, referenceContext] = ['source-0', 'reference-0'].map((phase, index) => {
      verify();
      const {cell, names} = records.get(phase);
      const program = nativeProgram(ts, cell.parsed);
      const observed = observeProgram(ts, program, check);
      assert.deepEqual(observed.files.map(file => file.fileName), names, 'Stock CLI and default Program load orders differ');
      const loaded = observed.files.map(observed.read);
      const local = loaded.filter(row => !row.readOnlyDependency).map(row => row.path).sort();
      assert.deepEqual(local, [...shared, probe, ...(index ? [emittedDate] : date)].sort(), 'Unexpected owned input or producer fallback');
      assert(loaded.every(row => row.path !== validator));
      const selected = selectedContext(ts, program, observed, index ? emittedDate : join(project, 'lib/hr-date.ts'), probe);
      return {selected, loaded};
    });
    const {alias: sourceAlias, ...sourceSelected} = sourceContext.selected;
    const {alias: referenceAlias, ...referenceSelected} = referenceContext.selected;
    assert.deepEqual(referenceSelected, sourceSelected, 'Actual package or TP1 signature context differs across the boundary');
    assert.equal(sourceAlias.mode, referenceAlias.mode);
    const byPath = rows => new Map(rows.map(row => [row.path, row]));
    const sourceByPath = byPath(sourceContext.loaded);
    const referenceByPath = byPath(referenceContext.loaded);
    assert.equal(sourceByPath.size, sourceContext.loaded.length);
    assert.equal(referenceByPath.size, referenceContext.loaded.length);
    const sourceNames = new Set(records.get('source-0').names);
    assert(producerLoaded.every(path => sourceNames.has(path)), 'Producer introduced foreign package context');
    const intersection = [...sourceByPath.keys()].filter(path => referenceByPath.has(path));
    for (const path of intersection) assert.deepEqual(referenceByPath.get(path), sourceByPath.get(path));
    const sourceOnly = [...sourceByPath.keys()].filter(path => !referenceByPath.has(path));
    const referenceOnly = [...referenceByPath.keys()].filter(path => !sourceByPath.has(path));
    assert.deepEqual(sourceOnly.sort(), [...date].sort());
    assert.deepEqual(referenceOnly, [emittedDate]);

    const owned = expectedOutputs.filter(path => path.endsWith('.d.ts'));
    assert.equal(owned.length, date.length);
    const validation = config('owned-declarations', [...ordered(declarations), ...owned], {skipLibCheck: false});
    const program = nativeProgram(ts, validation.parsed);
    assert.equal(program.getCompilerOptions().skipLibCheck, false);
    const observed = observeProgram(ts, program, check);
    assert(observed.files.every(file => file.isDeclarationFile));
    const errors = [...program.getConfigFileParsingDiagnostics(), ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics()];
    for (const path of owned) {
      check();
      const file = observed.fileFor(path);
      assert(!program.isSourceFileFromExternalLibrary(file));
      errors.push(...program.getSemanticDiagnostics(file));
    }
    assert.deepEqual(errors, []);
    const validationLoaded = observed.files.map(observed.read);
    assert.deepEqual(validationLoaded.filter(row => !row.readOnlyDependency).map(row => row.path).sort(), [...declarations, ...owned].sort());
    verify();
    assert.deepEqual(logs.map(row => seal(row.path, check, maxLogBytes)), logs);
    done('owned-declarations-and-context', {probe, validation: {owned, externalSemanticRequested: false, loaded: validationLoaded},
      context: sourceSelected, sourceAlias, referenceAlias, sourceLoaded: sourceContext.loaded, referenceLoaded: referenceContext.loaded,
      overlap: {intersection: intersection.length, sourceOnly, referenceOnly}});
    assert.deepEqual(report.phases.map(row => row.phase), phases);
    assert.deepEqual(report.attempts.map(row => row.phase), phases.slice(0, -1));
    check();
    report.elapsedMs = performance.now() - started;
    report.complete = true;
    save();
    return report;
  } catch (error) {
    report.failure = {name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 2_048)};
    report.blocked = phases.filter(phase => !report.phases.some(row => row.phase === phase));
    report.elapsedMs = performance.now() - started;
    save();
    throw error;
  }
}
