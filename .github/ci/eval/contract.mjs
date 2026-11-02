/** Development model evaluation contract. No provider dispatch, pricing, keys or release authority.
 * The controller supplies current identities and trusted budget verification; receipts supply neither. */
import {createHash} from 'node:crypto';
import {constants, openSync, readFileSync, closeSync, fstatSync, lstatSync} from 'node:fs';
import {join} from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const fail = message => { throw Error('Requested model evaluation: ' + message); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const strings = value => Array.isArray(value) && value.length > 0 && value.every(x => typeof x === 'string' && ID.test(x)) && new Set(value).size === value.length;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const EVAL_SCHEMA_VERSION = 1;
export const EVAL_MODEL = 'openai/gpt-6-luna';
const commonSources = ['test/assistant-production-baseline-corpus.ts', 'test/explainer-corpus.ts',
  'test/harness-sensitive-corpus.ts', 'test/assistant-behaviour-score.ts', 'test/assistant-corpus-review.ts'];
export const EVAL_CARRIERS = Object.freeze({
  'test/assistant-model-ceiling.eval.test.ts': Object.freeze({planPath: 'test/eval-plans/assistant-model-ceiling.json',
    receiptFile: 'assistant-model-ceiling.receipt.json', defaultRepeats: 3,
    sets: Object.freeze({baseline: 20, complex: 38, parity: 16, explainer: 16, sensitive: 90})}),
  'test/review/teras-review-model.eval.test.ts': Object.freeze({planPath: 'test/eval-plans/teras-review-model.json',
    receiptFile: 'teras-review-model.receipt.json', defaultRepeats: 1,
    sets: Object.freeze({baseline: 20, complex: 38, parity: 16, explainer: 16, sensitive: 90, unseen: 58})}),
});

export function captureEvalIdentity(value) {
  if (!exact(value, ['sourceSha', 'controllerSha', 'runId', 'attempt', 'runtime']) || !SHA.test(value.sourceSha)
    || !SHA.test(value.controllerSha) || typeof value.runId !== 'string' || !/^\d+$/.test(value.runId)
    || typeof value.attempt !== 'string' || !/^[1-9]\d*$/.test(value.attempt)
    || !exact(value.runtime, ['node', 'platform', 'arch'])
    || Object.values(value.runtime).some(x => typeof x !== 'string' || !x || x.length > 80)) fail('invalid execution identity');
  return freeze(structuredClone(value));
}
/** Null means ordinary CI, whose no-secret assertion remains useful and inert. */
export function captureRequestedEval(env, files, identity) {
  const model = env.AIHR_EVAL_MODEL?.trim() ?? '';
  const requested = model !== '' || env.AIHR_EVAL_REQUESTED === 'true';
  if (!requested) return null;
  if (model !== EVAL_MODEL || env.AIHR_EVAL_PROVIDER && env.AIHR_EVAL_PROVIDER !== 'openrouter') fail('unapproved provider/model');
  if (!Array.isArray(files) || files.length !== 1 || !Object.hasOwn(EVAL_CARRIERS, files[0])) fail('select exactly one known evaluation carrier');
  if (typeof env.AIHR_EVAL_OPENROUTER_KEY !== 'string' || !env.AIHR_EVAL_OPENROUTER_KEY.trim()) fail('evaluation key is unavailable');
  if ((env.AIHR_EVAL_PATH ?? 'production') !== 'production') fail('production path is compulsory');
  const budgetText = env.AIHR_EVAL_BUDGET_USD;
  if (typeof budgetText !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(budgetText)) fail('invalid allocation');
  const budgetUsd = Number(budgetText);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 15) fail('allocation must be positive and at most USD15');
  const allowedProviders = (env.AIHR_EVAL_ALLOWED_PROVIDERS ?? '').split(',').map(x => x.trim());
  if (!allowedProviders.length || allowedProviders.some(x => !/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(x))
    || new Set(allowedProviders).size !== allowedProviders.length) fail('explicit distinct upstream providers are required');
  const repeatsText = env.AIHR_EVAL_REPEATS ?? String(EVAL_CARRIERS[files[0]].defaultRepeats);
  if (!/^[1-5]$/.test(repeatsText)) fail('invalid repeat plan');
  const profileId = env.AIHR_EVAL_PROFILE;
  if (typeof profileId !== 'string' || !ID.test(profileId)) fail('explicit evaluation profile is required');
  return freeze({provider: 'openrouter', model, path: 'production', budgetUsd,
    allowedProviders: Object.freeze(allowedProviders), carrier: files[0], profileId,
    repeats: Number(repeatsText), identity: Object.freeze(captureEvalIdentity(identity))});
}

function readOwnedFile(root, path, maxBytes) {
  if (!/^(?:test|docs\/reviews)\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(x => !x || x === '.' || x === '..')) fail('invalid plan source path');
  const parts = path.split('/'); let current = root;
  for (const part of parts.slice(0, -1)) { current = join(current, part); const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('nonregular plan source parent'); }
  const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail('nonregular or oversized plan source'); return readFileSync(fd); }
  finally { closeSync(fd); }
}

/** The plan is a fixed tracked test-owned file, never a receipt-provided list of completed cases.
 * Controller's exact clean candidate check binds these bytes to its independently resolved source SHA. */
export function loadEvalPlan(request, root) {
  const carrier = EVAL_CARRIERS[request.carrier]; if (!carrier) fail('unknown carrier');
  const raw = readOwnedFile(root, carrier.planPath, 4 * 1024 * 1024);
  let value; try { value = JSON.parse(raw); } catch { fail('malformed test-owned plan'); }
  return validateEvalPlan(value, request, {planHash: hash(raw), readSource: path => readOwnedFile(root, path, 4 * 1024 * 1024)});
}
export function validateEvalPlan(value, request, {planHash, readSource}) {
  if (!exact(value, ['schemaVersion', 'carrier', 'profileId', 'model', 'repeats', 'reviewId', 'sources', 'cases'])
    || value.schemaVersion !== EVAL_SCHEMA_VERSION || value.carrier !== request.carrier || value.profileId !== request.profileId
    || value.model !== request.model || value.repeats !== request.repeats || !HASH.test(planHash)
    || typeof value.reviewId !== 'string' || !/^docs\/reviews\/[A-Za-z0-9_./-]+\.md#[A-Za-z0-9_-]+$/.test(value.reviewId)) fail('plan/configuration mismatch');
  if (!Array.isArray(value.sources) || value.sources.length > 32) fail('invalid source/rubric bindings');
  const paths = new Set();
  for (const row of value.sources) {
    if (!exact(row, ['path', 'sha256']) || typeof row.path !== 'string' || !HASH.test(row.sha256) || paths.has(row.path)) fail('invalid source binding');
    paths.add(row.path); if (hash(readSource(row.path)) !== row.sha256) fail('stale corpus, fixture or rubric source');
  }
  const required = [...commonSources, request.carrier, value.reviewId.split('#')[0],
    ...(request.carrier.includes('/review/') ? ['test/review/teras-review-unseen-corpus.ts'] : [])];
  if (required.some(path => !paths.has(path))) fail('missing corpus, fixture or independent review binding');
  const sets = EVAL_CARRIERS[request.carrier].sets;
  const expected = Object.values(sets).reduce((a, b) => a + b, 0) * request.repeats;
  if (!Array.isArray(value.cases) || value.cases.length !== expected) fail('incomplete test-owned case manifest');
  const ids = new Set(), counts = new Map(), tuples = new Map(), previousRows = new Map();
  for (const row of value.cases) {
    if (!exact(row, ['id', 'set', 'conversationId', 'turnId', 'repeat', 'requiresModel', 'dependsOn', 'quality'])
      || !Object.hasOwn(sets, row.set) || typeof row.conversationId !== 'string' || !ID.test(row.conversationId)
      || typeof row.turnId !== 'string' || !ID.test(row.turnId)
      || !Number.isInteger(row.repeat) || row.repeat < 0 || row.repeat >= request.repeats || typeof row.requiresModel !== 'boolean'
      || row.id !== `${row.set}:${row.conversationId}:${row.turnId}:${row.repeat}` || ids.has(row.id)
      || !exact(row.quality, ['kind', 'criteria']) || !['deterministic', 'human_review'].includes(row.quality.kind)
      || !strings(row.quality.criteria) || row.dependsOn !== null && !ids.has(row.dependsOn)) fail('invalid case identity, dependency or rubric');
    if (row.dependsOn !== null) {
      const previous = previousRows.get(row.dependsOn);
      if (previous.repeat !== row.repeat || previous.conversationId !== row.conversationId || previous.set !== row.set) fail('foreign case dependency');
    }
    ids.add(row.id); previousRows.set(row.id, row); const group = row.set + ':' + row.repeat; counts.set(group, (counts.get(group) ?? 0) + 1);
    const tuple = row.set + ':' + row.conversationId + ':' + row.turnId;
    tuples.set(tuple, (tuples.get(tuple) ?? 0) + 1);
  }
  for (const [set, count] of Object.entries(sets)) for (let repeat = 0; repeat < request.repeats; repeat++) if (counts.get(set + ':' + repeat) !== count) fail('missing planned set/repeat');
  if ([...tuples.values()].some(n => n !== request.repeats) || !value.cases.some(row => row.requiresModel)) fail('incomplete repeated/model case population');
  return freeze({...structuredClone(value), planHash, corpusReviewDigest: digest(value.sources)});
}

const TERMINAL = new Set(['completed', 'error', 'budget_refused', 'dependency_unavailable', 'unrun', 'aborted']);
export function createEvalLedger(plan) {
  const planned = new Map(plan.cases.map(row => [row.id, row])), started = new Set(), outcomes = new Map(); let finalized = false;
  return Object.freeze({
    start(id) {
      const row = planned.get(id);
      if (finalized || !row || started.has(id) || outcomes.has(id)) fail('duplicate, foreign or late case start');
      if (row.dependsOn !== null && outcomes.get(row.dependsOn)?.status !== 'completed') fail('continuation predecessor is unavailable');
      started.add(id);
    },
    finish(outcome) {
      if (finalized || !object(outcome) || !planned.has(outcome.id) || outcomes.has(outcome.id) || !TERMINAL.has(outcome.status)
        || outcome.status === 'completed' && !started.has(outcome.id)) fail('invalid terminal outcome');
      outcomes.set(outcome.id, structuredClone(outcome));
    },
    finalize(reason = 'not executed') {
      if (finalized) fail('ledger already finalized'); finalized = true;
      return plan.cases.map(row => outcomes.get(row.id) ?? {id: row.id, status: started.has(row.id) ? 'aborted' : 'unrun', reason});
    },
  });
}

/** Trusted verifier must inspect actual reservation/attempt evidence and its source bindings.
 * No receipt-declared 'paid', hash shape, env price or status string grants budget authority. */
export function verifyEvalReceipt(receipt, {request, plan, identity, budgetVerifier}) {
  if (!object(receipt) || receipt.schemaVersion !== EVAL_SCHEMA_VERSION || !same(receipt.request, request)
    || !same(request.identity, captureEvalIdentity(identity)) || receipt.planHash !== plan.planHash
    || receipt.corpusReviewDigest !== plan.corpusReviewDigest || !same(receipt.files, [request.carrier])
    || !same(receipt.plannedCaseIds, plan.cases.map(row => row.id)) || receipt.productionReviewed !== true
    || receipt.path !== 'production') fail('missing, stale or mismatched measurement receipt');
  if (!Array.isArray(receipt.outcomes) || receipt.outcomes.length !== plan.cases.length) fail('incomplete planned outcomes');
  const seen = new Map(); let requiresHumanReview = false, qualityPassed = true, safetyPassed = true, providerCalls = 0;
  for (let index = 0; index < plan.cases.length; index++) {
    const expected = plan.cases[index], row = receipt.outcomes[index];
    if (!object(row) || row.id !== expected.id || seen.has(row.id) || !TERMINAL.has(row.status)) fail('duplicate, foreign or reordered outcome');
    if (row.status !== 'completed') fail('measurement is incomplete: ' + row.status);
    if (expected.dependsOn !== null && seen.get(expected.dependsOn)?.status !== 'completed') fail('missing completed predecessor');
    if (!Number.isSafeInteger(row.providerCalls) || row.providerCalls < 0 || expected.requiresModel && row.providerCalls === 0) fail('missing model execution evidence');
    providerCalls += row.providerCalls;
    if (!exact(row.security, ['passed', 'findings']) || typeof row.security.passed !== 'boolean' || !Array.isArray(row.security.findings)) fail('missing safety result');
    safetyPassed &&= row.security.passed && row.security.findings.length === 0;
    if (!Array.isArray(row.criteria) || row.criteria.length !== expected.quality.criteria.length) fail('missing quality criteria');
    for (let i = 0; i < expected.quality.criteria.length; i++) {
      const criterion = row.criteria[i];
      if (!exact(criterion, ['id', 'status']) || criterion.id !== expected.quality.criteria[i]
        || !['met', 'missed', 'review_required'].includes(criterion.status)) fail('invalid quality result');
      if (criterion.status !== 'met') qualityPassed = false;
      requiresHumanReview ||= criterion.status === 'review_required';
    }
    // The existing partly observable rubric cannot self-certify its unobserved meaning.
    if (expected.quality.kind === 'human_review') { requiresHumanReview = true; qualityPassed = false; }
    seen.set(row.id, row);
  }
  if (providerCalls === 0 || typeof budgetVerifier !== 'function'
    || budgetVerifier(receipt.budget, {request, plan, identity, outcomes: receipt.outcomes}) !== true) fail('verified reservation/attempt evidence is unavailable');
  const summary = Object.freeze({executionComplete: true, safetyPassed, qualityPassed, requiresHumanReview,
    budgetVerified: true, providerCalls, measurementPassed: safetyPassed && qualityPassed && !requiresHumanReview,
    releaseEligible: false});
  return summary;
}

export function assertFocusedEvalContext(context, files) {
  if (!context || context.requested !== true) return null;
  const {request, plan, receipt, identity, budgetVerifier} = context;
  if (!request || !plan || !same(files, [request.carrier]) || !EVAL_CARRIERS[request.carrier]) fail('wrong selected evaluation carrier');
  const summary = verifyEvalReceipt(receipt, {request, plan, identity, budgetVerifier});
  if (typeof context.onAssessment === 'function') context.onAssessment(summary);
  if (!summary.measurementPassed) fail(summary.requiresHumanReview ? 'quality requires independent human review' : 'safety or quality criteria were not met');
  return summary;
}
