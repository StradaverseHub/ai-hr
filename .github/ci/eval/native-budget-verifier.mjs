/** Pure monetary evidence comparison, not a provider certificate or native read authority.
 * readNativeEvidence MUST be controller-owned: independently admitted context, complete tenant
 * ledger and no candidate-selected IDs. A candidate JSON/status/hash can never replace it.
 * Case labels/POST counts below are consistency checks, not independent network observations.
 */
import {captureEvalIdentity, EVAL_MODEL} from './contract.mjs';

const MAX = 15_000_000_000n;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const require = condition => { if (!condition) throw Error('Native evaluation budget evidence refused.'); };
const nanos = value => {
  require(typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value));
  return BigInt(value);
};
function allocationOf(request) {
  const value = request.budgetUsd;
  require(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 15);
  const decimal = value.toFixed(9);
  require(Number(decimal) === value);
  const allocation = BigInt(decimal.replace('.', ''));
  require(allocation > 0n && allocation <= MAX);
  return allocation;
}
function sameIdentity(a, b) {
  const left = captureEvalIdentity(a), right = captureEvalIdentity(b);
  return ['sourceSha', 'controllerSha', 'runId', 'attempt'].every(key => left[key] === right[key])
    && ['node', 'platform', 'arch'].every(key => left.runtime[key] === right.runtime[key]);
}
const attemptKeys = ['caseId', 'evaluationId', 'requestId', 'runId', 'capabilityDigest', 'requestDigest',
  'configurationDigest', 'ceilingNanos', 'postCount'];
const rowKeys = ['runId', 'tenantId', 'rootId', 'featureId', 'capabilityDigest', 'requestDigest',
  'configurationDigest', 'reservedNanos', 'confirmedNanos', 'spendState', 'provider', 'model',
  'operation', 'runState', 'receiptDigest', 'generationId'];

/** Missing reader refuses at construction. Failed/async/incomplete readback returns strict false.
 * The reader receives expected source/run/plan identity only, never candidate tenant/run selectors.
 * It must query the entire independently provisioned fictional tenant's native population.
 */
export function createNativeBudgetVerifier({readNativeEvidence} = {}) {
  require(typeof readNativeEvidence === 'function');
  return function verifyNativeBudget(budget, {request, plan, identity, outcomes} = {}) {
    try {
      require(object(request) && request.provider === 'openrouter' && request.model === EVAL_MODEL
        && request.path === 'production' && sameIdentity(request.identity, identity));
      const requestedAllocation = allocationOf(request);
      require(object(plan) && HASH.test(plan.planHash) && HASH.test(plan.corpusReviewDigest)
        && request.carrier === plan.carrier && request.profileId === plan.profileId
        && Array.isArray(plan.cases) && plan.cases.length > 0 && plan.cases.length <= 5000);
      const expected = Object.freeze({identity: captureEvalIdentity(identity), planHash: plan.planHash,
        corpusReviewDigest: plan.corpusReviewDigest, carrier: request.carrier, profileId: request.profileId});
      const evidence = readNativeEvidence(expected);
      if (evidence && typeof evidence.then === 'function') {
        // The async owner query must be awaited by the controller before this sync verifier.
        Promise.resolve(evidence).catch(() => {});
        return false;
      }
      require(exact(evidence, ['identity', 'evaluationId', 'tenantId', 'planHash', 'corpusReviewDigest',
        'allocationNanos', 'maxAttempts', 'rows']) && sameIdentity(evidence.identity, identity)
        && evidence.evaluationId === `${identity.runId}:${identity.attempt}:${plan.planHash}`
        && typeof evidence.tenantId === 'string' && UUID.test(evidence.tenantId)
        && evidence.planHash === plan.planHash && evidence.corpusReviewDigest === plan.corpusReviewDigest);
      const allocation = nanos(evidence.allocationNanos);
      require(allocation > 0n && allocation <= requestedAllocation && Number.isSafeInteger(evidence.maxAttempts)
        && evidence.maxAttempts > 0 && evidence.maxAttempts <= 1500 && Array.isArray(evidence.rows)
        && evidence.rows.length <= evidence.maxAttempts);
      require(exact(budget, ['kind', 'identity', 'evaluationId', 'tenantId', 'snapshot', 'attempts'])
        && budget.kind === 'native_owned_no_refund_lifetime_reservations' && sameIdentity(budget.identity, identity)
        && budget.evaluationId === evidence.evaluationId && budget.tenantId === evidence.tenantId
        && Array.isArray(budget.attempts) && budget.attempts.length === evidence.rows.length);
      const snapshot = budget.snapshot;
      require(exact(snapshot, ['allocationNanos', 'reservedNanos', 'remainingNanos', 'attempts', 'maxAttempts'])
        && nanos(snapshot.allocationNanos) === allocation && snapshot.maxAttempts === evidence.maxAttempts
        && Number.isSafeInteger(snapshot.attempts) && snapshot.attempts === budget.attempts.length);

      const cases = new Set(plan.cases.map(row => row.id));
      require(cases.size === plan.cases.length && Array.isArray(outcomes) && outcomes.length === cases.size);
      const calls = new Map();
      for (const row of outcomes) {
        require(object(row) && cases.has(row.id) && !calls.has(row.id)
          && Number.isSafeInteger(row.providerCalls) && row.providerCalls >= 0);
        calls.set(row.id, row.providerCalls);
      }
      const native = new Map(), roots = new Map(), generations = new Set(), receipts = new Set();
      let reserved = 0n;
      for (const row of evidence.rows) {
        require(exact(row, rowKeys) && typeof row.runId === 'string' && UUID.test(row.runId) && !native.has(row.runId)
          && row.tenantId === evidence.tenantId && typeof row.rootId === 'string' && UUID.test(row.rootId)
          && row.featureId === 'hr_assistant' && row.provider === 'openrouter' && row.model === EVAL_MODEL
          && row.operation === 'conversation' && ['pending', 'completed', 'failed'].includes(row.runState)
          && [row.capabilityDigest, row.requestDigest, row.configurationDigest].every(x => typeof x === 'string' && HASH.test(x)));
        const ceiling = nanos(row.reservedNanos);
        require(ceiling > 0n); reserved += ceiling;
        require(reserved <= allocation);
        if (row.spendState === 'held') {
          require(row.confirmedNanos === null && row.receiptDigest === null && row.generationId === null);
        } else {
          require(row.spendState === 'confirmed' && row.runState !== 'pending' && nanos(row.confirmedNanos) <= ceiling
            && typeof row.receiptDigest === 'string' && HASH.test(row.receiptDigest) && !receipts.has(row.receiptDigest)
            && typeof row.generationId === 'string' && /^gen-[A-Za-z0-9_-]{1,240}$/.test(row.generationId)
            && !generations.has(row.generationId));
          receipts.add(row.receiptDigest); generations.add(row.generationId);
        }
        native.set(row.runId, row);
      }
      const runIds = new Set(), requestIds = new Set(), perCase = new Map();
      for (const attempt of budget.attempts) {
        require(exact(attempt, attemptKeys) && cases.has(attempt.caseId)
          && attempt.evaluationId === evidence.evaluationId && typeof attempt.requestId === 'string'
          && /^native_[1-9]\d*$/.test(attempt.requestId) && !requestIds.has(attempt.requestId)
          && !runIds.has(attempt.runId) && attempt.postCount === 1);
        const row = native.get(attempt.runId);
        require(row && attempt.capabilityDigest === row.capabilityDigest && attempt.requestDigest === row.requestDigest
          && attempt.configurationDigest === row.configurationDigest && nanos(attempt.ceilingNanos) === nanos(row.reservedNanos));
        // Several requests in one question legitimately share its root, never another case's.
        require(!roots.has(row.rootId) || roots.get(row.rootId) === attempt.caseId);
        roots.set(row.rootId, attempt.caseId); runIds.add(attempt.runId); requestIds.add(attempt.requestId);
        perCase.set(attempt.caseId, (perCase.get(attempt.caseId) ?? 0) + 1);
      }
      require(runIds.size === native.size && [...calls].every(([id, count]) => count === (perCase.get(id) ?? 0))
        && nanos(snapshot.reservedNanos) === reserved && nanos(snapshot.remainingNanos) === allocation - reserved);
      return true;
    } catch {
      // Read errors or unknown/ambiguous monetary evidence never become a successful zero.
      return false;
    }
  };
}
