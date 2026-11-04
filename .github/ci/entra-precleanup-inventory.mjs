import assert from 'node:assert/strict';
import { lstatSync, readdirSync } from 'node:fs';

const originalRecords = [
  'activate-intent.json',
  'activate-result.json',
  'activated.json',
  'authorization.json',
  'runtime.json',
  'store.json',
  'verified.json',
];
const retainedTrees = ['next', 'packet'];

/** Check under the installer cleanup lock, before creating any recovery records. */
export function assertEntraPrecleanupInventory(directory) {
  const root = lstatSync(directory);
  assert(root.isDirectory() && (root.mode & 0o077) === 0, 'Private installer directory required');
  assert.deepEqual(
    readdirSync(directory).sort(),
    [...originalRecords, ...retainedTrees, 'normal-cleanup.lock'].sort(),
    'Unexpected installer records or missing retained data',
  );
  for (const entry of [...originalRecords, 'normal-cleanup.lock']) {
    const record = lstatSync(directory + '/' + entry);
    assert(record.isFile() && record.uid === root.uid && (record.mode & 0o077) === 0,
      'Private regular installer record required');
  }
  for (const entry of retainedTrees) {
    const tree = lstatSync(directory + '/' + entry);
    assert(tree.isDirectory() && tree.uid === root.uid, 'Owned installer directory required');
  }
}
