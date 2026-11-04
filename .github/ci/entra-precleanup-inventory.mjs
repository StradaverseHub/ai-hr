import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';

const originalRecords = [
  'activate-intent.json',
  'activate-result.json',
  'activated.json',
  'authorization.json',
  'runtime.json',
  'store.json',
  'verified.json',
];
import { createHash } from 'node:crypto';

const retainedTrees = ['next', 'packet'];

/** Check under the installer cleanup lock, before creating any recovery records. */
export function assertEntraPrecleanupInventory(directory, previousReadySha256) {
  const root = lstatSync(directory);
  assert(root.isDirectory() && (root.mode & 0o077) === 0, 'Private installer directory required');
  const previousReady = 'normal-cleanup-ready.json';
  const previous = previousReadySha256 ? [previousReady, 'audit'] : [];
  assert.deepEqual(
    readdirSync(directory).sort(),
    [...originalRecords, ...retainedTrees, 'normal-cleanup.lock', ...previous].sort(),
    'Unexpected installer records or missing retained data',
  );
  for (const entry of [...originalRecords, 'normal-cleanup.lock']) {
    const record = lstatSync(directory + '/' + entry);
    assert(record.isFile() && record.uid === root.uid && (record.mode & 0o077) === 0,
      'Private regular installer record required');
  }
  if (previousReadySha256) {
    const path = directory + '/' + previousReady;
    const record = lstatSync(path);
    assert(record.isFile() && record.uid === root.uid && record.size <= 32768 &&
      createHash('sha256').update(readFileSync(path)).digest('hex') === previousReadySha256,
      'Previous unconsumed READY record differs');
    const audit = lstatSync(directory + '/audit');
    assert(audit.isDirectory() && audit.uid === root.uid, 'Owned prior audit directory required');
  }
  for (const entry of retainedTrees) {
    const tree = lstatSync(directory + '/' + entry);
    assert(tree.isDirectory() && tree.uid === root.uid, 'Owned installer directory required');
  }
}
