/** Single-process evaluation lifetime allocation, NOT price/capability certification.
 * The caller supplies a trusted native-bound synchronous resolver, never an env/API price.
 * Every admitted attempt consumes its FULL independently reviewed ceiling permanently:
 * receipts, credits, failures, clocks and month rollover cannot replenish this allocation.
 * One instance must own the entire run; another process/retry needs separate shared admission.
 */
const MAX_ALLOCATION = 15_000_000_000n;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const refuse = () => { throw new Error('Evaluation attempt allocation unavailable.'); };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

/** resolveReviewedRequest receives the captured request/binding and must return exactly
 * {requestId, requestDigest, configurationDigest, ceilingNanos}. Its trusted ownership is a
 * caller obligation: matching hashes/shape alone do not prove any provider billing ceiling.
 * The send callback receives that same captured request. This module never interprets costs.
 */
export function createAttemptBudget({allocationNanos, maxAttempts, resolveReviewedRequest}) {
  if (typeof allocationNanos !== 'bigint' || allocationNanos <= 0n || allocationNanos > MAX_ALLOCATION
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || typeof resolveReviewedRequest !== 'function') refuse();
  let reservedNanos = 0n;
  const attempts = new Set();
  // Refuse resolver re-entry as well as async resolvers; no admission can interleave reservation.
  let resolving = false;
  return Object.freeze({
    snapshot() {
      return Object.freeze({allocationNanos, reservedNanos, remainingNanos: allocationNanos - reservedNanos,
        attempts: attempts.size, maxAttempts});
    },
    async dispatch(input, send) {
      if (resolving || !exact(input, ['requestId', 'requestDigest', 'configurationDigest', 'request'])
          || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)
          || !digest(input.requestDigest) || !digest(input.configurationDigest) || typeof send !== 'function') refuse();
      const captured = Object.freeze({...input});
      if (attempts.has(captured.requestId) || attempts.size >= maxAttempts) refuse();
      let reviewed;
      resolving = true;
      try { reviewed = resolveReviewedRequest(captured); }
      finally { resolving = false; }
      if (!exact(reviewed, ['requestId', 'requestDigest', 'configurationDigest', 'ceilingNanos'])
          || reviewed.requestId !== captured.requestId || reviewed.requestDigest !== captured.requestDigest
          || reviewed.configurationDigest !== captured.configurationDigest
          || typeof reviewed.ceilingNanos !== 'bigint' || reviewed.ceilingNanos <= 0n
          || reviewed.ceilingNanos > allocationNanos - reservedNanos) refuse();
      reservedNanos += reviewed.ceilingNanos;
      attempts.add(captured.requestId);
      // No await before reservation; throws, rejects and ambiguous settlement retain it in full.
      return send(captured.request);
    },
  });
}
