import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCommittedBlobs} from './repair-impact.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40);
const blob = (id, value) => Buffer.concat([Buffer.from(`${id} blob ${Buffer.byteLength(value)}\n`), Buffer.from(value), Buffer.from('\n')]);
test('Git blob parser binds exact requested identities and UTF-8 byte lengths', () => {
  assert.deepEqual([...decodeCommittedBlobs([a, b], Buffer.concat([blob(a, 'alpha'), blob(b, '中文\nend')]))], [[a, 'alpha'], [b, '中文\nend']]);
});
test('Missing, reordered, duplicated, non-blob, truncated and appended input refuse', () => {
  for (const [ids, bytes] of [
    [[a, b], blob(a, 'alpha')], [[a, b], Buffer.concat([blob(b, 'beta'), blob(a, 'alpha')])],
    [[a, a], Buffer.concat([blob(a, 'alpha'), blob(a, 'alpha')])],
    [[a], Buffer.from(`${a} commit 0\n\n`)], [[a], blob(a, 'alpha').subarray(0, -2)],
    [[a], Buffer.concat([blob(a, 'alpha'), Buffer.from('unexpected')])],
  ]) assert.throws(() => decodeCommittedBlobs(ids, bytes));
});
