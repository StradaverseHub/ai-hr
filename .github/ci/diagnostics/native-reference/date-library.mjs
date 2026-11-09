/** Fixed date-library diagnostic inside the already-admitted reference family. */
import assert from 'node:assert/strict';
import {lstatSync, mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {admitCompilerReference, boundedCompilerBytes, compilerProcIdentity, readCompilerReferenceClock} from './admission.mjs';
import {APPLICATION_INPUT_LIMITS, observeLoadedNativeInput, stableNativeInput, withinInputRoot} from './application-inputs.mjs';
import {assertNativeParsedConfig, NATIVE_REFERENCE_OVERRIDES, writeNativeReferenceConfigs} from './config.mjs';
import {
  assertDateLibraryConsumerContext, assertDateLibrarySources, dateLibraryBaseConfig, DATE_LIBRARY_SOURCE_PINS,
} from './date-library-contract.mjs';
import {planNativeReferences, REFERENCE_LIMITS} from './graph.mjs';
import {assertArtifactBudget, emittedTree, outputOwnership} from './outputs.mjs';
import {nativeReferenceProcess, requireNativeSuccess} from './process.mjs';
import {compilerOwner, parsedConfig} from './worker.mjs';

const fixture = '.github/ci/diagnostics/native-reference/fixture.mjs';
const dateSource = '.github/ci/diagnostics/native-reference/date-library.mjs';
const contractSource = '.github/ci/diagnostics/native-reference/date-library-contract.mjs';
const inputSource = '.github/ci/diagnostics/native-reference/application-inputs.mjs';
const phases = Object.freeze(['original-context', 'restricted-stock', 'native-solution', 'missing-reference',
  'producer', 'consumer', 'owned-declarations', 'source-api-control', 'reference-api-control']);
const cliPhases = phases.filter(phase => !['original-context', 'owned-declarations'].includes(phase));
const dateLimitNs = 120_000_000_000n;
const settlementNs = 2_000_000_000n;
const markerName = 'owner.json';
const reportName = 'report.json';
const childEnvKeys = ['PATH', 'HOME', 'RUNNER_TEMP', 'GITHUB_WORKSPACE', 'GITHUB_ACTIONS', 'CI',
  'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'GITHUB_REPOSITORY', 'GITHUB_WORKFLOW', 'GITHUB_JOB',
  'GITHUB_EVENT_NAME', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID', 'AIHR_CI_HEAD', 'AIHR_CI_CONTROL_HEAD',
  'AIHR_FOCUSED_TESTS', 'AIHR_FOCUSED_EVIDENCE_DIR'];
const identity = ({pid, start}) => ({pid, start});

function currentDateOwner() {
  const proof = admitCompilerReference('fixture');
  const clock = readCompilerReferenceClock(proof);
  assert.equal(proof.sourceHead, proof.controllerHead, 'Date source and controller must be the same frozen commit');
  for (const path of [dateSource, contractSource, inputSource]) {
    assert(proof.sourceHashes[path], 'Date diagnostic source closure is unregistered');
  }
  const root = join(proof.destination, 'compiler-native-reference');
  assert.equal(realpathSync(root), root);
  return {proof, clock, root, out: join(root, 'date-library')};
}

function stopAt(start, clock) {
  const whole = BigInt(clock.startNs) + BigInt(REFERENCE_LIMITS.aggregateMs) * 1_000_000n;
  const date = start + dateLimitNs;
  return date < whole ? date : whole;
}

function deadline(stop) {
  return performance.now() + Number(stop - process.hrtime.bigint()) / 1e6;
}

function marker(proof, clock, parent, start) {
  return {version: 1, kind: 'OWNED_DATE_REFERENCE_CHILD', source: proof.sourceHead,
    controller: proof.controllerHead, run: proof.run, attempt: proof.attempt,
    clockStartNs: clock.startNs, parent, startNs: String(start)};
}

function privateJson(out, name, maximum) {
  const directory = lstatSync(out);
  assert(directory.isDirectory() && directory.uid === process.getuid() && (directory.mode & 0o7777) === 0o700);
  const {bytes, record} = stableNativeInput(join(out, name), {root: out, maximum});
  assert.equal(BigInt(record.identity.uid), BigInt(process.getuid()));
  assert.equal(BigInt(record.identity.mode) & 0o7777n, 0o600n);
  return JSON.parse(bytes);
}

export async function startDateLibraryChild(signal) {
  const start = process.hrtime.bigint();
  const {proof, clock, root, out} = currentDateOwner();
  assert.deepEqual(identity(proof.ancestors[1]), clock.wrapper, 'Only the admitted outer fixture may start the date child');
  signal.throwIfAborted();
  const stop = stopAt(start, clock);
  assert(stop - process.hrtime.bigint() > 2n * settlementNs, 'Date child settlement reserve unavailable');
  mkdirSync(out, {mode: 0o700});
  const owner = marker(proof, clock, proof.self, start);
  writeFileSync(join(out, markerName), JSON.stringify(owner) + '\n', {flag: 'wx', mode: 0o600});
  const log = join(out, 'child.log');
  const env = Object.fromEntries(childEnvKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const result = await nativeReferenceProcess([join(proof.source, fixture)], {
    cwd: proof.source, env: {...env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'}, deadline: deadline(stop), log, signal,
    checkBudget: () => assertArtifactBudget(root),
  });
  writeFileSync(join(out, 'launcher.json'), JSON.stringify({owner, child: result}) + '\n', {flag: 'wx', mode: 0o600});
  assertArtifactBudget(root);
  signal.throwIfAborted();
  requireNativeSuccess(result);
  const report = privateJson(out, reportName, REFERENCE_LIMITS.logBytes);
  assert.equal(report.kind, 'NATIVE_DATE_LIBRARY_REFERENCE_DIAGNOSTIC');
  assert.deepEqual(report.owner, owner);
  assert.equal(report.complete, true);
  assert.equal(report.ordinaryCompilerQualified, false);
  assert.equal(report.releaseAuthorized, false);
  assert.equal(report.nextTypegenRun, false);
  assert.equal(report.applicationAmbientEquivalenceQualified, false);
  assert.deepEqual(report.plannedPhases, phases);
  assert.deepEqual(report.phases.map(row => row.phase), phases);
  assert.deepEqual(report.attempts.map(row => row.phase), cliPhases);
  assert(process.hrtime.bigint() < stop, 'Date child exceeded its owned budget');
  assertArtifactBudget(root);
  return {status: 'complete', path: 'date-library/report.json', child: result};
}

function admittedDateChild() {
  const {proof, clock, root, out} = currentDateOwner();
  const parent = proof.ancestors[1];
  assert.equal(parent.pid, process.ppid);
  assert.deepEqual(identity(proof.ancestors[2]), clock.wrapper, 'Date fixture must be the sole nested reference role');
  const parentPath = '/proc/' + parent.pid;
  const actual = boundedCompilerBytes(join(parentPath, 'cmdline'), 65_536, {proc: true});
  assert.deepEqual(actual, Buffer.from([process.execPath, '--max-old-space-size=12288', join(proof.source, fixture), ''].join('\0')));
  assert.equal(realpathSync(join(parentPath, 'exe')), realpathSync(process.execPath));
  assert.equal(realpathSync(out), out);
  const owner = privateJson(out, markerName, 4096);
  assert(typeof owner.startNs === 'string' && /^[1-9][0-9]{0,19}$/.test(owner.startNs));
  const start = BigInt(owner.startNs);
  assert(start >= BigInt(clock.startNs) && start <= process.hrtime.bigint());
  assert.deepEqual(owner, marker(proof, clock, identity(parent), start));
  const current = compilerProcIdentity(parent.pid);
  for (const key of ['pid', 'parent', 'group', 'session', 'start']) assert.equal(current[key], parent[key]);
  return {proof, root, out, owner, parent, stop: stopAt(start, clock)};
}

function inputPins(proof, check) {
  const observe = root => DATE_LIBRARY_SOURCE_PINS.map(({path, bytes}) => {
    const row = stableNativeInput(join(root, path), {root, maximum: bytes, check}).record;
    return {path, row, bytes: row.bytes, sha256: row.sha256};
  });
  const source = observe(proof.source), controller = observe(proof.controller);
  const pins = values => values.map(({path, bytes, sha256}) => ({path, bytes, sha256}));
  assertDateLibrarySources(pins(source), pins(controller));
  return {source, controller};
}

function nativeProgram(ts, config) {
  const parsed = parsedConfig(ts, config);
  const program = ts.createProgram({rootNames: parsed.fileNames, options: parsed.options,
    projectReferences: parsed.projectReferences});
  assert.deepEqual(program.getRootFileNames(), parsed.fileNames);
  return program;
}

function observeProgram(owner, program, source, outputRoot, check) {
  const {ts} = owner;
  const dependencyRoot = join(source, 'node_modules');
  assert.equal(realpathSync(dependencyRoot), dependencyRoot);
  const configured = new Set(program.getRootFileNames());
  const files = program.getSourceFiles();
  assert(files.length > 0 && files.length <= APPLICATION_INPUT_LIMITS.files);
  const records = new Map();
  let bytes = 0;
  const read = file => {
    check();
    if (!records.has(file)) {
      const path = realpathSync(file.fileName);
      const row = withinInputRoot(source, path)
        ? observeLoadedNativeInput(ts, program, file, {source, dependencyRoot, configured, check})
        : stableNativeInput(path, {root: outputRoot, check}).record;
      if (!withinInputRoot(source, path)) assert.equal(ts.sys.readFile(path), file.text);
      bytes += row.bytes;
      assert(bytes <= REFERENCE_LIMITS.totalBytes, 'Date native input byte bound');
      records.set(file, row);
    }
    return records.get(file);
  };
  const packageRows = new Map();
  const target = value => {
    assert(value?.packageId, 'Actual native package resolution required');
    const file = program.getSourceFile(value.resolvedFileName);
    assert(file?.isDeclarationFile && program.isSourceFileFromExternalLibrary(file));
    const {path, bytes, sha256} = read(file);
    const {name, version, subModuleName, peerDependencies} = value.packageId;
    const manifest = join(file.packageJsonScope.packageDirectory, 'package.json');
    if (!packageRows.has(manifest)) {
      const row = stableNativeInput(manifest, {root: dependencyRoot, readOnlyDependency: true, check});
      const metadata = JSON.parse(row.bytes);
      assert.equal(metadata.name, name);
      assert.equal(metadata.version, version);
      packageRows.set(manifest, row.record);
    }
    return {path, bytes, sha256, packageId: {name, version, subModuleName, peerDependencies: peerDependencies ?? null}};
  };
  const fileFor = path => {
    const file = program.getSourceFile(path);
    assert(file && realpathSync(file.fileName) === path, 'Date file was not natively loaded');
    return file;
  };
  // These are the read-only stores of the exact pinned TS5.9.3 Program, not a
  // new resolution. The public default host and compiler options stay intact.
  const moduleFor = (path, name, synthetic) => {
    const file = fileFor(path);
    const indices = file.imports.flatMap((literal, index) =>
      literal.text === name && (literal.pos === -1 && literal.end === -1) === synthetic ? [index] : []);
    assert.equal(indices.length, 1, 'Exact native date module occurrence required');
    const index = indices[0];
    const value = program.getResolvedModuleFromModuleSpecifier(file.imports[index], file)?.resolvedModule;
    assert(value, 'Missing native date module resolution');
    return {value, mode: program.getModeForResolutionAtIndex(file, index) ?? null};
  };
  const options = program.getCompilerOptions();
  const typeRoots = ts.getEffectiveTypeRoots(options, ts.sys);
  const names = program.getAutomaticTypeDirectiveNames();
  assert.deepEqual(names, ts.getAutomaticTypeDirectiveNames(options, ts.sys));
  assert(names.length > 0 && names.length <= 64 && new Set(names).size === names.length);
  const automaticTypes = names.map(name => ({name, target: target(program.getAutomaticTypeDirectiveResolutions()
    .get(name, undefined)?.resolvedTypeReferenceDirective)}));
  const packageAt = (file, name, synthetic) => {
    const row = moduleFor(file, name, synthetic);
    return {mode: row.mode, target: target(row.value)};
  };
  return {files, read, fileFor, moduleFor, typeRoots, automaticTypes, packageAt, packageRows};
}

function context(observed, selected, consumer) {
  const jsxByFile = selected.map(file => ({file, ...observed.packageAt(file, 'react/jsx-runtime', true)}));
  const {mode, target} = jsxByFile.find(row => row.file === consumer);
  return {jsxByFile, consumer: {typeRoots: observed.typeRoots, automaticTypes: observed.automaticTypes,
    jsxRuntime: {mode, target}, vitest: observed.packageAt(consumer, 'vitest', false)}};
}

/** Compare declarations actually selected at the fixed input identifiers. The
 * whole original Program is never asked for all semantic diagnostics. */
function selectedSymbols(ts, program, files, check) {
  const checker = program.getTypeChecker();
  const declarations = symbol => symbol?.declarations?.map(node => ({
    path: realpathSync(node.getSourceFile().fileName), pos: node.pos, end: node.end,
  })) ?? [];
  return files.flatMap(path => {
    const file = program.getSourceFile(path);
    assert(file);
    const rows = [];
    function visit(node) {
      check();
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        const alias = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : undefined;
        rows.push({path, pos: node.pos, end: node.end, declarations: declarations(symbol), aliased: declarations(alias)});
        assert(rows.length <= APPLICATION_INPUT_LIMITS.metadataEntries);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    return rows;
  });
}

function originalContext(owner, source, out, check) {
  const program = nativeProgram(owner.ts, join(source, 'tsconfig.json'));
  const observed = observeProgram(owner, program, source, out, check);
  const roots = program.getRootFileNames();
  assert(roots.every(path => path !== join(source, 'next-env.d.ts') && !withinInputRoot(join(source, '.next'), path)),
    'Date diagnostic only admits the checked-in configured context');
  const plan = dateLibraryBaseConfig(source, roots, observed.typeRoots);
  const inputs = plan.base.files.map(path => observed.read(observed.fileFor(path)));
  const actual = context(observed, plan.base.files, plan.consumer);
  const symbols = selectedSymbols(owner.ts, program, plan.base.files, check);
  return {plan, inputs, actual, symbols, options: {...program.getCompilerOptions()}, packages: [...observed.packageRows.values()]};
}

function importsTo(owner, program, from, name, expected) {
  const {ts} = owner;
  const file = program.getSourceFile(from);
  assert(file, 'Actual date consumer absent');
  const imports = file.statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === name);
  assert.equal(imports.length, 1);
  const declarations = program.getTypeChecker().getSymbolAtLocation(imports[0].moduleSpecifier)?.declarations;
  assert(declarations?.length > 0 && declarations.every(node => realpathSync(node.getSourceFile().fileName) === expected),
    'Native date module symbol resolved to a different source');
}

export async function runDateLibraryChild(signal) {
  const {proof, root, out, owner: binding, parent, stop} = admittedDateChild();
  const {source} = proof;
  const report = {kind: 'NATIVE_DATE_LIBRARY_REFERENCE_DIAGNOSTIC', owner: binding, complete: false,
    ordinaryCompilerQualified: false, releaseAuthorized: false, nextTypegenRun: false,
    applicationAmbientEquivalenceQualified: false, plannedPhases: phases, phases: [], attempts: []};
  const check = () => {
    signal.throwIfAborted();
    assert(process.ppid === parent.pid && process.hrtime.bigint() < stop - settlementNs, 'Date child work frontier closed');
  };
  const save = (flag = 'w') => {
    const raw = JSON.stringify(report, null, 2) + '\n';
    assert(Buffer.byteLength(raw) <= REFERENCE_LIMITS.logBytes);
    writeFileSync(join(out, reportName), raw, {flag, mode: 0o600});
    assertArtifactBudget(root);
  };
  const done = (phase, details = {}) => { check(); report.phases.push({phase, ...details}); save(); };
  check(); save('wx');
  try {
    const pins = inputPins(proof, check);
    const verifyInputs = () => assert.deepEqual(inputPins(proof, check), pins, 'Held date source identity changed');
    const owner = compilerOwner(source);
    report.compiler = {typescript: owner.version, apiSha256: owner.apiSha256, cliSha256: owner.cliSha256};
    const stock = originalContext(owner, source, out, check);
    done('original-context', {inputs: stock.inputs, ...stock.actual, options: stock.options,
      packages: stock.packages, symbols: stock.symbols});
    const {plan} = stock, {ts} = owner;
    const base = join(out, 'base.json');
    const privateConfig = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
    privateConfig(base, {...plan.base, compilerOptions: {...plan.base.compilerOptions, tsBuildInfoFile: join(out, 'base.tsbuildinfo')}});
    const env = {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C', TZ: 'UTC', RUNNER_TEMP: process.env.RUNNER_TEMP};
    const seal = path => stableNativeInput(path, {root: out, check}).record;
    async function cli(phase, args, expectedFailure = false) {
      check(); verifyInputs();
      const config = seal(args[1]);
      const log = join(out, phase + '.log');
      const result = await nativeReferenceProcess([owner.cli, ...args, '--pretty', 'false'], {
        cwd: source, env, deadline: deadline(stop - settlementNs), log, signal,
        checkBudget: () => assertArtifactBudget(root),
      });
      report.attempts.push({phase, ...result});
      save();
      if (expectedFailure) {
        assert(Number.isInteger(result.code) && result.code > 0);
        assert.equal(result.signal, null); assert.equal(result.stoppedBecause, null); assert.equal(result.error, null);
      } else requireNativeSuccess(result);
      verifyInputs();
      assert.deepEqual(seal(config.path), config, 'Date compiler configuration changed during execution');
      const text = stableNativeInput(log, {root: out, maximum: REFERENCE_LIMITS.logBytes, check}).bytes.toString('utf8');
      return {result, text};
    }
    const list = text => text.split(/\r?\n/).filter(line => line.startsWith('/')).map(path => realpathSync(path));
    const diagnostics = text => {
      const rows = [...text.matchAll(/^(.+)\(([0-9]+),[0-9]+\): error TS([0-9]+):/gm)]
        .map(match => ({file: resolve(source, match[1]), line: Number(match[2]), code: Number(match[3])}));
      assert.equal(rows.length, [...text.matchAll(/error TS[0-9]+:/g)].length, 'Unowned date compiler diagnostic');
      return rows;
    };
    const sameFileList = (observed, text) => {
      const api = observed.files.map(file => realpathSync(file.fileName));
      assert.deepEqual(list(text), api, 'Ordered date CLI and default Program membership differs');
      return observed.files.map(observed.read);
    };
    const baselineResult = await cli('restricted-stock', ['-p', base, '--noEmit', '--listFiles']);
    const baseline = nativeProgram(ts, base);
    assert.deepEqual(baseline.getRootFileNames(), plan.base.files);
    const restrictedOptions = {...stock.options, configFilePath: base,
      typeRoots: plan.base.compilerOptions.typeRoots, tsBuildInfoFile: join(out, 'base.tsbuildinfo')};
    assert.deepEqual({...baseline.getCompilerOptions()}, restrictedOptions, 'Unexpected restricted compiler option change');
    const restricted = observeProgram(owner, baseline, source, out, check);
    const actual = context(restricted, plan.base.files, plan.consumer);
    assertDateLibraryConsumerContext(source, stock.actual.consumer, actual.consumer);
    assert.deepEqual(actual.jsxByFile, stock.actual.jsxByFile);
    assert.deepEqual([...restricted.packageRows.values()], stock.packages);
    const restrictedSymbols = selectedSymbols(ts, baseline, plan.base.files, check);
    assert.deepEqual(restrictedSymbols, stock.symbols, 'Selected original native symbol declarations changed');
    const allBaseline = sameFileList(restricted, baselineResult.text);
    assert.deepEqual(plan.base.files.map(path => restricted.read(restricted.fileFor(path))), stock.inputs);
    const baselineExternal = allBaseline.filter(row => row.readOnlyDependency);
    assert.deepEqual(allBaseline.filter(row => !row.readOnlyDependency).map(row => row.path).sort(), [...plan.base.files].sort());
    done('restricted-stock', {result: baselineResult.result, files: allBaseline, context: actual, selectedSymbolsMatch: true});
    const files = plan.base.files.map(path => ({...restricted.read(restricted.fileFor(path)), id: relative(source, path), kind: 'implementation'}));
    const edges = [];
    for (const path of plan.base.files) {
      for (const statement of restricted.fileFor(path).statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const name = statement.moduleSpecifier.text;
        const selected = realpathSync(restricted.moduleFor(path, name, false).value.resolvedFileName);
        if (name === 'vitest') assert.equal(selected, actual.consumer.vitest.target.path);
        else {
          assert(plan.producer.includes(selected) && name.startsWith('.'), 'Unexpected date implementation edge');
          edges.push({from: relative(source, path), to: relative(source, selected)});
        }
      }
    }
    assert.equal(edges.length, 3);
    const graph = planNativeReferences({files, edges, roots: files.map(row => row.id),
      buildRoots: [relative(source, join(source, 'lib/hr-date.ts'))]}, {roots: 3, ownedClosure: 3});
    assert.deepEqual(graph.projects.map(project => project.configuredRoots), [plan.producer.map(path => relative(source, path)), [relative(source, plan.consumer)]]);
    assert.deepEqual(graph.projects.map(project => project.dependencies), [[], [0]]);
    const layouts = ['projects', 'missing'].map(name => {
      const output = join(out, name); mkdirSync(output, {mode: 0o700});
      return writeNativeReferenceConfigs({base, source, output, plan: graph, files});
    });
    const [layout, missing] = layouts;
    const outputs = outputOwnership(graph, files);
    const configPaths = [base, ...layouts.flatMap(row => [row.solution, ...row.projects.map(project => project.config)])];
    const configSeals = configPaths.map(seal);
    const verifyConfigs = () => assert.deepEqual(configPaths.map(seal), configSeals);
    for (const project of layout.projects) {
      const parsed = parsedConfig(ts, project.config);
      assertNativeParsedConfig(parsed, project.files, graph.limits);
      assert.deepEqual({...parsed.options}, {...restrictedOptions, ...NATIVE_REFERENCE_OVERRIDES,
        configFilePath: project.config, rootDir: source, outDir: layout.emitted, tsBuildInfoFile: project.buildInfo});
      const expected = outputs.filter(row => row.projects.includes(project.index)).map(row => join(layout.emitted, row.path));
      assert.deepEqual(parsed.fileNames.flatMap(path => ts.getOutputFileNames(parsed, path, false)).sort(), expected.sort());
    }
    const solution = await cli('native-solution', ['-b', layout.solution, '--dry', '--verbose']);
    const order = [...solution.text.matchAll(/^\s+\* (.+)$/gm)].map(row => resolve(source, row[1]));
    assert.deepEqual(order, [...layout.projects.map(row => row.config), layout.solution]);
    verifyConfigs(); done('native-solution', {result: solution.result, order, outputOwnership: outputs});
    const absent = await cli('missing-reference', ['-p', missing.projects[1].config], true);
    assert.deepEqual(diagnostics(absent.text), [{file: plan.consumer, line: 2, code: 6305}]);
    assert.deepEqual(emittedTree(missing.emitted), []);
    verifyConfigs(); done('missing-reference', {result: absent.result, diagnostics: diagnostics(absent.text)});
    const emittedSeals = [];
    for (const [index, phase] of ['producer', 'consumer'].entries()) {
      const project = layout.projects[index];
      assert.deepEqual(emittedSeals.map(row => seal(row.path)), emittedSeals);
      const built = await cli(phase, ['-p', project.config, '--listFiles', '--listEmittedFiles']);
      const current = built.text.split(/\r?\n/).filter(line => line.startsWith('TSFILE: ')).map(line => realpathSync(line.slice(8))).sort();
      const expected = [project.buildInfo, ...outputs.filter(row => row.projects.includes(index)).map(row => join(layout.emitted, row.path))].sort();
      assert.deepEqual(current, expected);
      assert.deepEqual(emittedSeals.map(row => seal(row.path)), emittedSeals);
      emittedSeals.push(...current.map(seal));
      const program = nativeProgram(ts, project.config);
      const observed = observeProgram(owner, program, source, out, check);
      const loaded = sameFileList(observed, built.text);
      const allowed = [...project.files];
      if (index === 1) {
        const declaration = join(layout.emitted, 'lib/hr-date.d.ts');
        allowed.push(declaration);
        importsTo(owner, program, plan.consumer, '../lib/hr-date', declaration);
        const next = context(observed, [plan.consumer], plan.consumer);
        assertDateLibraryConsumerContext(source, actual.consumer, next.consumer);
        assert.deepEqual([...observed.packageRows.values()], stock.packages);
        assert.deepEqual(loaded.filter(row => row.readOnlyDependency), baselineExternal);
      } else {
        assert.deepEqual(observed.typeRoots, restricted.typeRoots);
        assert.deepEqual(observed.automaticTypes, restricted.automaticTypes);
        for (const original of actual.jsxByFile.filter(row => plan.producer.includes(row.file))) {
          const {file, ...expected} = original;
          assert.deepEqual(observed.packageAt(file, 'react/jsx-runtime', true), expected);
        }
      }
      assert.deepEqual(loaded.filter(row => !row.readOnlyDependency).map(row => row.path).sort(), allowed.sort());
      verifyConfigs(); done(phase, {result: built.result, loaded, emitted: current});
    }
    assert.deepEqual(emittedTree(layout.emitted).map(row => row.path).sort(), outputs.map(row => join(layout.emitted, row.path)).sort());
    const owned = emittedSeals.filter(row => /\.d\.[cm]?ts$/.test(row.path)).map(row => row.path);
    assert.equal(owned.length, plan.base.files.length);
    const declarationConfig = join(out, 'owned-declarations.json');
    privateConfig(declarationConfig, {extends: base, files: owned, include: [], compilerOptions: {skipLibCheck: false}});
    const declarations = nativeProgram(ts, declarationConfig);
    assert.equal(declarations.getCompilerOptions().skipLibCheck, false);
    assert.deepEqual(declarations.getRootFileNames(), owned);
    const observedDeclarations = observeProgram(owner, declarations, source, out, check);
    assert(observedDeclarations.files.every(file => file.isDeclarationFile));
    const declarationDiagnostics = [...declarations.getOptionsDiagnostics(), ...declarations.getGlobalDiagnostics(),
      ...declarations.getSyntacticDiagnostics()];
    for (const path of owned) {
      const file = observedDeclarations.fileFor(path);
      assert(!declarations.isSourceFileFromExternalLibrary(file));
      declarationDiagnostics.push(...declarations.getSemanticDiagnostics(file));
    }
    assert.deepEqual(declarationDiagnostics, []);
    done('owned-declarations', {files: owned.map(seal), config: seal(declarationConfig)});
    const probe = join(out, 'alias-probe.ts');
    writeFileSync(probe, "import {todayInKualaLumpur} from '@/lib/hr-date';\ntodayInKualaLumpur(new Date(0));\ntodayInKualaLumpur('not a Date');\n",
      {flag: 'wx', mode: 0o600});
    for (const [index, phase] of ['source-api-control', 'reference-api-control'].entries()) {
      const path = join(out, phase + '.json');
      const references = index === 0 ? [] : [{path: layout.projects[0].config}];
      privateConfig(path, {extends: base, files: [probe], include: [], references,
        compilerOptions: {disableSourceOfProjectReferenceRedirect: true, tsBuildInfoFile: join(out, phase + '.tsbuildinfo')}});
      const negative = await cli(phase, ['-p', path, '--noEmit'], true);
      assert.deepEqual(diagnostics(negative.text), [{file: probe, line: 3, code: 2345}]);
      const program = nativeProgram(ts, path);
      const target = index === 0 ? join(source, 'lib/hr-date.ts') : join(layout.emitted, 'lib/hr-date.d.ts');
      importsTo(owner, program, probe, '@/lib/hr-date', target);
      if (index === 1) assert(!plan.producer.some(path => program.getSourceFile(path)), 'Alias producer implementation fallback');
      done(phase, {result: negative.result, diagnostics: diagnostics(negative.text), target});
    }
    verifyInputs(); verifyConfigs();
    assert.deepEqual(emittedSeals.map(row => seal(row.path)), emittedSeals);
    assert.deepEqual(report.phases.map(row => row.phase), phases);
    assert.deepEqual(report.attempts.map(row => row.phase), cliPhases);
    assert.deepEqual(identity(compilerProcIdentity(parent.pid)), identity(parent));
    check(); report.complete = true;
  } catch (error) {
    report.failure = {name: error.name, message: error.message};
    report.blocked = phases.filter(phase => !report.phases.some(row => row.phase === phase));
    try { save(); } catch (retentionError) { throw new AggregateError([error, retentionError], 'Date diagnostic and report both refused'); }
    throw error;
  }
  save();
}
