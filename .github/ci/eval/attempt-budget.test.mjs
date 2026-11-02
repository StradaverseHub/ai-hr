/** Fictional bounds only. No native certificate, HTTP, environment key or live price is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAttemptBudget} from './attempt-budget.mjs';

const binding = (requestId = 'attempt_1') => ({requestId, requestDigest: 'a'.repeat(64),
  configurationDigest: 'b'.repeat(64), request: Object.freeze({question: 'Fictional question'})});
const fictionalReview = ceilingNanos => input => ({requestId: input.requestId,
  requestDigest: input.requestDigest, configurationDigest: input.configurationDigest, ceilingNanos});
const budget = (overrides = {}) => createAttemptBudget({allocationNanos: 15_000_000_000n,
  maxAttempts: 10, resolveReviewedRequest: fictionalReview(6_000_000_000n), ...overrides});

test('accepts exact positive nano-USD up to15 and rejects lossy or absent allocations before dispatch', () => {
  for (const allocationNanos of [undefined, null, '', '15', 15, NaN, Infinity, -1n, 0n, 15_000_000_001n]) {
    assert.throws(() => budget({allocationNanos}));
  }
  assert.equal(budget({allocationNanos: 1n}).snapshot().remainingNanos, 1n);
  assert.equal(budget().snapshot().remainingNanos, 15_000_000_000n);
  for (const maxAttempts of [0, -1, NaN, Infinity, 1.5, '2']) assert.throws(() => budget({maxAttempts}));
  assert.throws(() => budget({resolveReviewedRequest: undefined}));
});

test('reserves the full reviewed bound BEFORE sending the same request and shares it across turns', async () => {
  const allocation = budget();
  const first = binding('turn1'), second = binding('turn2');
  await allocation.dispatch(first, request => {
    assert.equal(request, first.request);
    assert.deepEqual(allocation.snapshot(), {allocationNanos: 15_000_000_000n, reservedNanos: 6_000_000_000n,
      remainingNanos: 9_000_000_000n, attempts: 1, maxAttempts: 10});
    return 'first reply';
  });
  assert.equal(await allocation.dispatch(second, () => 'second reply'), 'second reply');
  let calls = 0;
  await assert.rejects(allocation.dispatch(binding('turn3'), () => { calls++; }));
  assert.equal(calls, 0);
  assert.equal(allocation.snapshot().reservedNanos, 12_000_000_000n);
});

test('concurrent dispatches cannot exceed one lifetime allowance while prior work is pending', async () => {
  const allocation = budget({allocationNanos: 10n, resolveReviewedRequest: fictionalReview(6n)});
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const first = allocation.dispatch(binding('first'), () => { calls++; return pending; });
  await assert.rejects(allocation.dispatch(binding('second'), () => { calls++; }));
  assert.equal(calls, 1);
  assert.equal(allocation.snapshot().remainingNanos, 4n);
  finish('done');
  assert.equal(await first, 'done');
  assert.equal(allocation.snapshot().remainingNanos, 4n);
});

test('throw, rejection and abort retain the entire attempted ceiling and consume request identity', async () => {
  for (const failure of [() => { throw Error('HTTP failure'); }, () => Promise.reject(Error('aborted'))]) {
    const allocation = budget({allocationNanos: 10n, resolveReviewedRequest: fictionalReview(6n)});
    await assert.rejects(allocation.dispatch(binding(), failure));
    assert.equal(allocation.snapshot().reservedNanos, 6n);
    await assert.rejects(allocation.dispatch(binding(), () => 'retry'));
    await assert.rejects(allocation.dispatch(binding('next'), () => 'next'));
    assert.equal(allocation.snapshot().attempts, 1);
  }
});

test('unknown, invalid, zero or claimed settled costs and credits never release an attempted allocation', async () => {
  for (const result of [undefined, {}, {cost: null}, {cost: -1}, {cost: NaN}, {cost: Infinity},
    {cost: 0}, {cost: '0'}, {cost: 1, credit: 100}, {settled: true, refund: 6}]) {
    const allocation = budget({allocationNanos: 10n, resolveReviewedRequest: fictionalReview(6n)});
    assert.equal(await allocation.dispatch(binding(), () => result), result);
    assert.equal(allocation.snapshot().remainingNanos, 4n);
    await assert.rejects(allocation.dispatch(binding('later'), () => 'overspend'));
  }
});

test('elapsed lifecycle and month rollover do not replenish a completed attempt', async () => {
  const allocation = budget({allocationNanos: 10n, resolveReviewedRequest: fictionalReview(6n)});
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-11-30T15:59:59Z');
    await allocation.dispatch(binding(), () => ({cost: 0}));
    Date.now = () => Date.parse('2026-12-01T00:00:01Z');
    await assert.rejects(allocation.dispatch(binding('new_month'), () => 'new allowance'));
    assert.equal(allocation.snapshot().remainingNanos, 4n);
  } finally { Date.now = originalNow; }
});

test('replayed request IDs and the total attempt ceiling refuse even when money remains', async () => {
  const allocation = budget({maxAttempts: 2, resolveReviewedRequest: fictionalReview(1n)});
  await allocation.dispatch(binding('one'), () => null);
  await assert.rejects(allocation.dispatch(binding('one'), () => null));
  await allocation.dispatch(binding('two'), () => null);
  let sent = false;
  await assert.rejects(allocation.dispatch(binding('three'), () => { sent = true; }));
  assert.equal(sent, false);
  assert.equal(allocation.snapshot().attempts, 2);
  assert.equal(allocation.snapshot().reservedNanos, 2n);
});

test('missing, async, scalar, mismatched or malformed reviewed bindings refuse without spending or sending', async () => {
  const valid = fictionalReview(1n)(binding());
  for (const proof of [undefined, 1n, Promise.resolve(valid), {...valid, ceilingNanos: 0n},
    {...valid, ceilingNanos: -1n}, {...valid, ceilingNanos: 1}, {...valid, ceilingNanos: 16_000_000_000n},
    {...valid, requestId: 'other'}, {...valid, requestDigest: 'c'.repeat(64)},
    {...valid, configurationDigest: 'd'.repeat(64)}, {...valid, extra: true}]) {
    const allocation = budget({resolveReviewedRequest: () => proof});
    let sent = false;
    await assert.rejects(allocation.dispatch(binding(), () => { sent = true; }));
    assert.equal(sent, false);
    assert.equal(allocation.snapshot().reservedNanos, 0n);
    assert.equal(allocation.snapshot().attempts, 0);
  }
});

test('malformed request identity never reaches the trusted resolver', async () => {
  let reviews = 0;
  const allocation = budget({resolveReviewedRequest: input => { reviews++; return fictionalReview(1n)(input); }});
  for (const input of [null, {...binding(), requestId: ''}, {...binding(), requestId: 'private identity'},
    {...binding(), requestDigest: 'not a digest'}, {...binding(), configurationDigest: null},
    {...binding(), ceilingNanos: 1n}]) await assert.rejects(allocation.dispatch(input, () => null));
  assert.equal(reviews, 0);
  assert.equal(allocation.snapshot().attempts, 0);
});

test('resolver failure preserves allocation and resolver re-entry cannot admit a second attempt', async () => {
  const refused = budget({resolveReviewedRequest: () => { throw Error('native review unavailable'); }});
  await assert.rejects(refused.dispatch(binding(), () => null), /native review unavailable/);
  assert.equal(refused.snapshot().reservedNanos, 0n);
  let nested, sends = 0;
  const allocation = budget({resolveReviewedRequest: input => {
    if (input.requestId === 'outer') nested = allocation.dispatch(binding('inner'), () => { sends++; });
    return fictionalReview(1n)(input);
  }});
  await allocation.dispatch(binding('outer'), () => { sends++; });
  await assert.rejects(nested);
  assert.equal(sends, 1);
  assert.equal(allocation.snapshot().attempts, 1);
});
