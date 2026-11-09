/** Pure controls for the unregistered contract. No compiler or child process. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  DATE_LIBRARY_SOURCE_PINS,
  assertDateLibraryConsumerContext,
  assertDateLibrarySources,
  dateLibraryBaseConfig,
} from './date-library-contract.mjs';

const source = '/workspace/ai-hr/source';
const typeRoots = [
  '/workspace/ai-hr/source/node_modules/@types', '/workspace/ai-hr/node_modules/@types',
  '/workspace/node_modules/@types', '/node_modules/@types',
];
const calendar = source + '/lib/calendar-date.ts';
const clock = source + '/lib/hr-date.ts';
const formatter = source + '/lib/date-time-formatter.ts';
const consumer = source + '/test/hr-date-formatter.test.ts';
const configured = [source + '/next-env.d.ts', formatter, consumer, calendar, clock];

function contextTarget(name, subModuleName) {
  return {
    path: source + '/node_modules/.pnpm/fictional-package/node_modules/' + name + '/' + subModuleName,
    bytes: 60,
    sha256: 'a'.repeat(64),
    packageId: {name, version: '1.0.0', subModuleName, peerDependencies: null},
  };
}

function context() {
  return {
    typeRoots: [...typeRoots],
    automaticTypes: [
      {name: 'node', target: contextTarget('@types/node', 'index.d.ts')},
      {name: 'react', target: contextTarget('@types/react', 'index.d.ts')},
    ],
    jsxRuntime: {mode: 99, target: contextTarget('@types/react', 'jsx-runtime.d.ts')},
    vitest: {mode: 99, target: contextTarget('vitest', 'dist/index.d.ts')},
  };
}

test('exact date pilot pins agree with all six actual checkout source bytes', () => {
  const rows = DATE_LIBRARY_SOURCE_PINS.map(({path}) => {
    const data = readFileSync(new URL('../../../../' + path, import.meta.url));
    return {path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')};
  });
  assertDateLibrarySources(rows, structuredClone(rows));
  assert.deepEqual(rows.map(row => row.path), [
    'lib/calendar-date.ts', 'lib/date-time-formatter.ts', 'lib/hr-date.ts', 'test/hr-date-formatter.test.ts',
    'tsconfig.json', 'pnpm-lock.yaml',
  ]);
});

test('candidate or controller drift, omission and substitution cannot establish custody', () => {
  const altered = structuredClone(DATE_LIBRARY_SOURCE_PINS);
  altered[2].sha256 = '0'.repeat(64);
  assert.throws(() => assertDateLibrarySources(altered, DATE_LIBRARY_SOURCE_PINS), /candidate source differs/);
  assert.throws(() => assertDateLibrarySources(DATE_LIBRARY_SOURCE_PINS, altered), /controller source differs/);
  assert.throws(() => assertDateLibrarySources(DATE_LIBRARY_SOURCE_PINS.slice(1), DATE_LIBRARY_SOURCE_PINS), /candidate source differs/);
  assert.throws(() => assertDateLibrarySources(DATE_LIBRARY_SOURCE_PINS, [...DATE_LIBRARY_SOURCE_PINS, altered[2]]), /controller source differs/);
});

test('private base retains native selected root order and only carries the original type roots', () => {
  const plan = dateLibraryBaseConfig(source, configured, typeRoots);
  assert.deepEqual(plan, {
    base: {extends: source + '/tsconfig.json', files: [formatter, consumer, calendar, clock], include: [],
      compilerOptions: {typeRoots}},
    producer: [formatter, calendar, clock],
    consumer,
  });
  assert.notEqual(plan.base.compilerOptions.typeRoots, typeRoots);
});

test('missing, duplicated or foreign consumer and producer roots refuse', () => {
  for (const input of [configured.slice(0, -1), [...configured, calendar],
    configured.map(path => path === consumer ? '/outside/test/hr-date-formatter.test.ts' : path)]) {
    assert.throws(() => dateLibraryBaseConfig(source, input, typeRoots), /configured roots required/);
  }
});

test('private config cannot replace native automatic type ancestry with temp context', () => {
  for (const input of [[], typeRoots.slice(0, -1), [typeRoots[0], ...typeRoots],
    [typeRoots[1], typeRoots[0], ...typeRoots.slice(2)], ['/private/tmp/node_modules/@types', ...typeRoots.slice(1)]]) {
    assert.throws(() => dateLibraryBaseConfig(source, configured, input), /type.root/);
  }
  assert.throws(() => dateLibraryBaseConfig('/workspace/./ai-hr/source', configured, typeRoots), /Canonical candidate root/);
});

test('automatic type order and selected Vitest peer identity must match the native baseline', () => {
  assertDateLibraryConsumerContext(source, context(), context());
  for (const mutate of [
    row => row.automaticTypes.reverse(),
    row => row.automaticTypes.pop(),
    row => { row.vitest.target.packageId.peerDependencies = '+vite@9.0.0'; },
    row => { row.vitest.mode = 1; },
    row => { row.jsxRuntime.target.sha256 = 'b'.repeat(64); },
    row => { row.vitest.target.bytes += 1; },
  ]) {
    const changed = context();
    mutate(changed);
    assert.throws(() => assertDateLibraryConsumerContext(source, context(), changed), /native consumer context differs/);
  }
});

test('matching but incomplete or out-of-realm native context does not pass', () => {
  for (const [mutate, reason] of [
    [row => { row.vitest.target.path = source + '/fake-vitest.d.ts'; }, /Canonical installed/],
    [row => { row.jsxRuntime.target.path = source + '/node_modules/.pnpm/../fake.d.ts'; }, /Canonical installed/],
    [row => { row.automaticTypes.push(row.automaticTypes[0]); }, /Duplicate automatic/],
    [row => { row.automaticTypes[0].target.packageId.version = ''; }, /Complete native/],
    [row => { row.jsxRuntime.mode = undefined; }, /resolution mode/],
    [row => { row.jsxRuntime.target.packageId.subModuleName = 'different.d.ts'; }, /does not match its package identity/],
    [row => { row.vitest.target.sha256 = ''; }, /declaration seal required/],
  ]) {
    const invalid = context();
    mutate(invalid);
    assert.throws(() => assertDateLibraryConsumerContext(source, invalid, structuredClone(invalid)), reason);
  }
});
