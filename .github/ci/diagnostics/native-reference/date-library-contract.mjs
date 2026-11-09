/** Fixed source and configuration contract for the unregistered date-library pilot.
 * Input observations must come from the future admitted native owner. This module
 * reads no files, starts no process, and grants no compiler or release authority.
 */
import assert from 'node:assert/strict';
import {posix} from 'node:path';

const producer = Object.freeze(['lib/calendar-date.ts', 'lib/date-time-formatter.ts', 'lib/hr-date.ts']);
const consumer = 'test/hr-date-formatter.test.ts';
const roots = [...producer, consumer];
const pin = (path, bytes, sha256) => Object.freeze({path, bytes, sha256});

export const DATE_LIBRARY_SOURCE_PINS = Object.freeze([
  pin(producer[0], 359, '26402672f174dbfdac800d752d8e85e54c968a6b7ae87564d99dd87bdc251824'),
  pin(producer[1], 654, '922a5fa0788d66508f88ec0ba7d82cb89d4038465051d6d87c514601e89c37e9'),
  pin(producer[2], 4757, 'bcd1a856837061eb50adf459e4c3512ccb0bd145967bfcf7bf496b1f46c84823'),
  pin(consumer, 897, '5230b82c74eeb158c346a0d43c7f35ec8d06d8c0f6d96933e6679ea4567c9a59'),
  pin('tsconfig.json', 676, '0ee72fb11a698bad9b18c39223569adf5758727272b35bfa99ec7bfa57c3530a'),
  pin('pnpm-lock.yaml', 356104, '0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd'),
]);

export function assertDateLibrarySources(source, controller) {
  assert.deepEqual(source, DATE_LIBRARY_SOURCE_PINS, 'Date-library candidate source differs');
  assert.deepEqual(controller, DATE_LIBRARY_SOURCE_PINS, 'Date-library controller source differs');
}

function absolute(path) {
  return typeof path === 'string' && path.length < 4096 && !/[\\\x00-\x1f\x7f]/.test(path)
    && posix.isAbsolute(path) && posix.normalize(path) === path && (path === '/' || !path.endsWith('/'));
}

function assertTypeRoots(source, observed) {
  assert(absolute(source) && posix.basename(source) === 'source', 'Canonical candidate root required');
  assert(Array.isArray(observed) && observed.length > 0 && observed.length <= 32, 'Bounded native type roots required');
  let directory = source;
  for (const [index, path] of observed.entries()) {
    assert.equal(path, posix.join(directory, 'node_modules/@types'), 'Native type-root ancestry differs');
    if (directory === '/') {
      assert.equal(index, observed.length - 1, 'Native type-root ancestry repeats');
      return;
    }
    directory = posix.dirname(directory);
  }
  assert.fail('Native type-root ancestry is incomplete');
}

/** Build only the private restricted base. Existing composite config ownership
 * supplies output/buildinfo/references later; no caller overrides are admitted.
 */
export function dateLibraryBaseConfig(source, configuredRoots, effectiveTypeRoots) {
  assertTypeRoots(source, effectiveTypeRoots);
  assert(Array.isArray(configuredRoots) && configuredRoots.length <= 50_000, 'Bounded native configured roots required');
  const selected = new Set(roots.map(path => posix.join(source, path)));
  const files = configuredRoots.filter(path => selected.has(path));
  assert(files.length === selected.size && new Set(files).size === selected.size, 'Exact date-library configured roots required');
  const consumerPath = posix.join(source, consumer);
  return {
    base: {
      extends: posix.join(source, 'tsconfig.json'),
      files,
      include: [],
      compilerOptions: {typeRoots: [...effectiveTypeRoots]},
    },
    producer: files.filter(path => path !== consumerPath),
    consumer: consumerPath,
  };
}

function assertContextTarget(source, target, expectedPackage) {
  assert(target && absolute(target.path) && target.path.startsWith(posix.join(source, 'node_modules/.pnpm') + '/'),
    'Canonical installed date-library declaration required');
  assert.deepEqual(Object.keys(target).sort(), ['bytes', 'packageId', 'path', 'sha256']);
  assert(/\.d\.[cm]?ts$/.test(target.path) && Number.isSafeInteger(target.bytes) && target.bytes > 0
    && target.bytes <= 512 * 1024 ** 2 && typeof target.sha256 === 'string' && target.sha256.length === 64
    && /^[0-9a-f]+$/.test(target.sha256), 'Complete date-library declaration seal required');
  const id = target.packageId;
  assert(id && typeof id.name === 'string'
    && typeof id.version === 'string' && id.version.length > 0 && id.version.length <= 128
    && typeof id.subModuleName === 'string' && id.subModuleName.length <= 4096
    && (id.peerDependencies === null || typeof id.peerDependencies === 'string' && id.peerDependencies.length <= 4096),
  'Complete native date-library package identity required');
  assert.deepEqual(Object.keys(id).sort(), ['name', 'peerDependencies', 'subModuleName', 'version']);
  assert.equal(id.name, expectedPackage, 'Native date-library package name differs');
  assert(target.path.endsWith('/node_modules/' + id.name + '/' + id.subModuleName),
    'Native date-library declaration does not match its package identity');
}

/** Compare context common to the restricted baseline and real Vitest consumer.
 * The producer has no authored Vitest import and uses separate native checks.
 */
export function assertDateLibraryConsumerContext(source, original, observed) {
  for (const context of [original, observed]) {
    assert(context && typeof context === 'object', 'Date-library context observation required');
    assert.deepEqual(Object.keys(context).sort(), ['automaticTypes', 'jsxRuntime', 'typeRoots', 'vitest']);
    assertTypeRoots(source, context.typeRoots);
    const automatic = context.automaticTypes;
    assert(Array.isArray(automatic) && automatic.length > 0 && automatic.length <= 64, 'Bounded automatic type roster required');
    assert.equal(new Set(automatic.map(row => row?.name)).size, automatic.length, 'Duplicate automatic type identity');
    for (const row of automatic) {
      assert(typeof row?.name === 'string' && /^[a-z0-9_-]+$/.test(row.name) && row.name.length <= 128,
        'Automatic type identity differs');
      assert.deepEqual(Object.keys(row).sort(), ['name', 'target']);
      assertContextTarget(source, row.target, '@types/' + row.name);
    }
    for (const [row, expectedPackage] of [[context.jsxRuntime, '@types/react'], [context.vitest, 'vitest']]) {
      assert(row && [1, 99, null].includes(row.mode), 'Native module resolution mode required');
      assert.deepEqual(Object.keys(row).sort(), ['mode', 'target']);
      assertContextTarget(source, row.target, expectedPackage);
    }
  }
  assert.deepEqual(observed, original, 'Date-library native consumer context differs');
}
