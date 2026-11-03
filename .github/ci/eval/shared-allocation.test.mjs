import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reserveSharedEvalAllocation} from './shared-allocation.mjs';

function ledger(t) {
  const directory = mkdtempSync(join(tmpdir(), 'eval-allocation-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test('Retains full holds across profiles and rejects replays and excess allocation', t => {
  const directory = ledger(t);
  reserveSharedEvalAllocation(directory, 'reviewer-1', '8000000000');
  assert.throws(() => reserveSharedEvalAllocation(directory, 'reviewer-1', '1'), /already reserved/);
  reserveSharedEvalAllocation(directory, 'ceiling-1', '7000000000');
  assert.throws(() => reserveSharedEvalAllocation(directory, 'reviewer-2', '1'), /exhausted/);
});

test('Competing controller processes cannot both reserve more than the campaign cap', async t => {
  const directory = ledger(t);
  const moduleUrl = new URL('./shared-allocation.mjs', import.meta.url);
  const reserve = attempt => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {reserveSharedEvalAllocation} from ${JSON.stringify(moduleUrl.href)};
      reserveSharedEvalAllocation(process.argv[1], process.argv[2], '8000000000');`,
      directory, attempt], {stdio: 'ignore'});
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  const outcomes = await Promise.all([reserve('one'), reserve('two')]);
  assert.deepEqual(outcomes.sort(), [0, 1]);
  assert.throws(() => reserveSharedEvalAllocation(directory, 'retry', '8000000000'), /exhausted/);
});

test('Refuses an interrupted write or stale lock instead of restoring funds', t => {
  const directory = ledger(t);
  const lock = join(directory, '.lock');
  mkdirSync(lock);
  assert.throws(() => reserveSharedEvalAllocation(directory, 'next', '1'), {code: 'EEXIST'});
  rmSync(lock, {recursive: true});
  writeFileSync(join(directory, 'interrupted'), '');
  assert.throws(() => reserveSharedEvalAllocation(directory, 'next', '1'), /Invalid shared eval reservation amount/);
});

test('Trusted admission refuses missing review and reserves before returning scope', async t => {
  const {createSharedEvalAdmission} = await import('../focused-checks.mjs');
  const directory = ledger(t);
  const request = {budgetUsd: 8};
  const identity = {runId: '123', attempt: '1'};
  const scope = {tenantId: '10000000-0000-0000-0000-000000000001', allocationNanos: '8000000000', maxAttempts: 1500};
  const admit = createSharedEvalAdmission({
    directory,
    verifyProvisioning: ({plan}) => plan.reviewed ? scope : null,
  });
  assert.throws(() => admit({request, identity, plan: {reviewed: false}}), /scope is unavailable/);
  assert.deepEqual(admit({request, identity, plan: {reviewed: true}}), {admitted: true, nativeScope: scope});
  assert.throws(() => admit({request, identity, plan: {reviewed: true}}), /already reserved/);
  assert.throws(() => admit({request, identity: {...identity, attempt: '2'}, plan: {reviewed: true}}), /exhausted/);
});
