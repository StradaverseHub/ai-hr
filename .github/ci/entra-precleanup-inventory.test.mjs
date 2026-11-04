import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertEntraPrecleanupInventory } from './entra-precleanup-inventory.mjs';

test('requires the locked, untouched installer inventory and both owned trees', t => {
  const directory = mkdtempSync(join(tmpdir(), 'entra-precleanup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['activate-intent.json', 'activate-result.json', 'activated.json',
    'authorization.json', 'runtime.json', 'store.json', 'verified.json', 'normal-cleanup.lock']) {
    writeFileSync(join(directory, name), '{}', { mode: 0o600 });
  }
  for (const name of ['next', 'packet']) mkdirSync(join(directory, name), { mode: 0o700 });
  assert.doesNotThrow(() => assertEntraPrecleanupInventory(directory));

  const prior = join(directory, 'normal-cleanup-ready.json');
  writeFileSync(prior, '{}', { mode: 0o600 });
  assert.throws(() => assertEntraPrecleanupInventory(directory), /Unexpected installer records/);
  rmSync(prior);
  rmSync(join(directory, 'next'), { recursive: true });
  symlinkSync(join(directory, 'packet'), join(directory, 'next'));
  assert.throws(() => assertEntraPrecleanupInventory(directory), /Owned installer directory/);
});
