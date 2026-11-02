/** Pure contract regressions. All sources, reservations and model observations below are fictional. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {captureRequestedEval, validateEvalPlan, createEvalLedger, verifyEvalReceipt,
  assertFocusedEvalContext, loadEvalPlan, EVAL_CARRIERS, EVAL_MODEL} from './contract.mjs';
const carrier = 'test/assistant-model-ceiling.eval.test.ts';
const identity = {sourceSha: 'a'.repeat(40), controllerSha: 'c'.repeat(40), runId: '100', attempt: '1',
  runtime: {node: '22.23.3', platform: 'linux', arch: 'x64'}};
const env = {AIHR_EVAL_MODEL: EVAL_MODEL, AIHR_EVAL_OPENROUTER_KEY: 'fictional-not-a-real-key',
  AIHR_EVAL_PATH: 'production', AIHR_EVAL_BUDGET_USD: '15', AIHR_EVAL_ALLOWED_PROVIDERS: 'azure',
  AIHR_EVAL_REPEATS: '1', AIHR_EVAL_PROFILE: 'frozen-fixture'};
const request = () => captureRequestedEval(env, [carrier], identity);
const sha = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const req = request(), sourcePaths = [carrier, 'test/assistant-production-baseline-corpus.ts', 'test/explainer-corpus.ts',
    'test/harness-sensitive-corpus.ts', 'test/assistant-behaviour-score.ts', 'test/assistant-corpus-review.ts', 'docs/reviews/fixture-review.md'];
  const readSource = path => Buffer.from('independently pinned fictional source:' + path);
  const value = {schemaVersion: 1, carrier, profileId: req.profileId, model: req.model, repeats: 1,
    reviewId: 'docs/reviews/fixture-review.md#independent-rubric', sources: sourcePaths.map(path => ({path, sha256: sha(readSource(path))})),
    cases: []};
  // Explicit known set populations, not a count read from the implementation under test.
  for (const [set, count] of [['baseline', 20], ['complex', 38], ['parity', 16], ['explainer', 16], ['sensitive', 90]]) {
    for (let index = 0; index < count; index++) value.cases.push({id: `${set}:conversation:turn${index}:0`, set,
      conversationId: 'conversation', turnId: 'turn' + index, repeat: 0, requiresModel: set !== 'sensitive', dependsOn: null,
      quality: {kind: 'deterministic', criteria: ['literal-fixture-fact']}});
  }
  const options = {planHash: 'b'.repeat(64), readSource};
  const plan = validateEvalPlan(value, req, options);
  const receipt = {schemaVersion: 1, request: req, files: [carrier], planHash: plan.planHash,
    corpusReviewDigest: plan.corpusReviewDigest, plannedCaseIds: plan.cases.map(row => row.id),
    productionReviewed: true, path: 'production', budget: {reservedNanos: '15000000000', custody: 'fixture-only'},
    outcomes: plan.cases.map(row => ({id: row.id, status: 'completed', providerCalls: row.requiresModel ? 1 : 0,
      security: {passed: true, findings: []}, criteria: [{id: 'literal-fixture-fact', status: 'met'}]}))};
  const context = {request: req, plan, identity, budgetVerifier: budget => budget?.custody === 'fixture-only'};
  return {req, value, options, plan, receipt, context};
}
test('ordinary CI remains inert, but explicit requested eval without model refuses', () => {
  assert.equal(captureRequestedEval({}, [carrier], identity), null);
  assert.throws(() => captureRequestedEval({AIHR_EVAL_REQUESTED: 'true'}, [carrier], identity));
});
test('admission captures exact approved model/allocation/identity without retaining key material', () => {
  const req = request(); assert.equal(req.model, EVAL_MODEL); assert.equal(req.budgetUsd, 15);
  assert.equal(JSON.stringify(req).includes(env.AIHR_EVAL_OPENROUTER_KEY), false);
  assert.deepEqual(req.identity, identity);
});
for (const [name, changes] of [
  ['missing key', {AIHR_EVAL_OPENROUTER_KEY: ''}], ['wrong model', {AIHR_EVAL_MODEL: 'other/model'}],
  ['wrong provider', {AIHR_EVAL_PROVIDER: 'openai'}], ['transport bypass', {AIHR_EVAL_PATH: 'transport'}],
  ['direct bypass', {AIHR_EVAL_PATH: 'direct'}], ['empty upstream', {AIHR_EVAL_ALLOWED_PROVIDERS: ''}],
  ['duplicate upstream', {AIHR_EVAL_ALLOWED_PROVIDERS: 'azure,azure'}], ['negative budget', {AIHR_EVAL_BUDGET_USD: '-1'}],
  ['zero budget', {AIHR_EVAL_BUDGET_USD: '0'}], ['over approval', {AIHR_EVAL_BUDGET_USD: '15.000000001'}],
  ['nonfinite budget', {AIHR_EVAL_BUDGET_USD: 'Infinity'}], ['missing budget', {AIHR_EVAL_BUDGET_USD: undefined}],
  ['invalid repeat', {AIHR_EVAL_REPEATS: '0'}], ['missing profile', {AIHR_EVAL_PROFILE: ''}],
]) test('admission refuses ' + name + ' before any dispatcher exists', () => {
  assert.throws(() => captureRequestedEval({...env, ...changes}, [carrier], identity));
});
test('admission refuses arbitrary selections, two independent carriers and stale execution identity', () => {
  for (const files of [['test/ordinary.test.ts'], Object.keys(EVAL_CARRIERS), []]) assert.throws(() => captureRequestedEval(env, files, identity));
  assert.throws(() => captureRequestedEval(env, [carrier], {...identity, sourceSha: 'invented'}));
});
test('fixed plan source and corpus identities validate all180 planned cases', () => {
  const {plan} = fixture(); assert.equal(plan.cases.length, 180); assert.equal(plan.cases.filter(row => row.set === 'sensitive').length, 90);
});
for (const [name, mutate] of [
  ['empty sensitive set', v => { v.cases = v.cases.filter(row => row.set !== 'sensitive'); }],
  ['one omitted case', v => { v.cases.pop(); }], ['duplicate id', v => { v.cases[1] = v.cases[0]; }],
  ['wrong repeat', v => { v.cases[0].repeat = 1; }], ['foreign dependency', v => { v.cases[0].dependsOn = 'unknown'; }],
  ['missing review source', v => { v.sources.pop(); }], ['stale source hash', v => { v.sources[0].sha256 = 'e'.repeat(64); }],
  ['wrong profile', v => { v.profileId = 'other'; }], ['wrong carrier', v => { v.carrier = 'test/review/teras-review-model.eval.test.ts'; }],
]) test('test-owned plan refuses ' + name, () => {
  const {req, value, options} = fixture(); mutate(value); assert.throws(() => validateEvalPlan(value, req, options));
});
test('ledger preserves every planned denominator and cannot rerun/replace a terminal case', () => {
  const {plan} = fixture(), ledger = createEvalLedger(plan), id = plan.cases[0].id;
  ledger.start(id); ledger.finish({id, status: 'error', reason: 'original failure'});
  assert.throws(() => ledger.start(id)); assert.throws(() => ledger.finish({id, status: 'completed'}));
  const outcomes = ledger.finalize('budget unavailable'); assert.equal(outcomes.length, 180);
  assert.equal(outcomes[0].status, 'error'); assert.equal(outcomes.filter(row => row.status === 'unrun').length, 179);
  assert.throws(() => ledger.start(plan.cases[1].id)); assert.throws(() => ledger.finalize());
});
test('failed continuation predecessor cannot silently become a fresh successful case', () => {
  const {value, req, options} = fixture(); value.cases[1].dependsOn = value.cases[0].id;
  const plan = validateEvalPlan(value, req, options), ledger = createEvalLedger(plan);
  ledger.start(plan.cases[0].id); ledger.finish({id: plan.cases[0].id, status: 'error'});
  assert.throws(() => ledger.start(plan.cases[1].id));
  ledger.finish({id: plan.cases[1].id, status: 'dependency_unavailable'});
  assert.equal(ledger.finalize()[1].status, 'dependency_unavailable');
});
test('complete fixture qualifies only with independent budget verification, never release authority', () => {
  const {receipt, context} = fixture(), summary = verifyEvalReceipt(receipt, context);
  assert.equal(summary.measurementPassed, true); assert.equal(summary.providerCalls, 90); assert.equal(summary.releaseEligible, false);
  assert.throws(() => verifyEvalReceipt(receipt, {...context, budgetVerifier: undefined}));
  assert.throws(() => verifyEvalReceipt(receipt, {...context, budgetVerifier: () => false}));
});
for (const status of ['error', 'budget_refused', 'dependency_unavailable', 'unrun', 'aborted']) test('receipt refuses partial outcome ' + status, () => {
  const {receipt, context} = fixture(); receipt.outcomes[0].status = status;
  assert.throws(() => verifyEvalReceipt(receipt, context));
});
for (const [name, mutate] of [
  ['no receipt', () => null], ['stale plan', r => { r.planHash = 'e'.repeat(64); return r; }],
  ['stale review', r => { r.corpusReviewDigest = 'e'.repeat(64); return r; }],
  ['wrong source', r => { r.request.identity.sourceSha = 'e'.repeat(40); return r; }],
  ['missing outcome', r => { r.outcomes.pop(); return r; }], ['reordered outcomes', r => { r.outcomes.reverse(); return r; }],
  ['zero model calls', r => { r.outcomes.forEach(row => { row.providerCalls = 0; }); return r; }],
  ['review bypass', r => { r.productionReviewed = false; return r; }],
  ['missing criterion', r => { r.outcomes[0].criteria = []; return r; }],
]) test('receipt refuses ' + name, () => {
  const {receipt, context} = fixture(); const changed = structuredClone(receipt);
  assert.throws(() => verifyEvalReceipt(mutate(changed), context));
});
test('known safety failure and quality miss cannot be promoted by successful execution', () => {
  const {receipt, context} = fixture(); receipt.outcomes[0].security = {passed: false, findings: ['independent leak witness']};
  receipt.outcomes[1].criteria[0].status = 'missed'; const summary = verifyEvalReceipt(receipt, context);
  assert.equal(summary.executionComplete, true); assert.equal(summary.safetyPassed, false); assert.equal(summary.qualityPassed, false);
  assert.throws(() => assertFocusedEvalContext({requested: true, ...context, receipt}, [carrier]));
});
test('partly observable rubric stays review-required even if model claims every criterion met', () => {
  const {value, req, options, receipt, context} = fixture(); value.cases[0].quality.kind = 'human_review';
  const reviewedPlan = validateEvalPlan(value, req, options);
  const summary = verifyEvalReceipt(receipt, {...context, plan: reviewedPlan}); assert.equal(summary.requiresHumanReview, true); assert.equal(summary.measurementPassed, false);
});

function diskFixture(t) {
  const data = fixture(), root = mkdtempSync(join(tmpdir(), 'aihr-eval-contract-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const source of data.value.sources) {
    const path = join(root, source.path); mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, data.options.readSource(source.path));
  }
  const path = join(root, EVAL_CARRIERS[carrier].planPath);
  mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, JSON.stringify(data.value));
  return {...data, root, path};
}
test('fixed disk plan binds actual corpus bytes and deeply freezes the approved case plan', t => {
  const {req, root} = diskFixture(t), plan = loadEvalPlan(req, root);
  assert.equal(plan.cases.length, 180); assert.equal(Object.isFrozen(plan.cases[0].quality.criteria), true);
  assert.throws(() => { plan.cases.pop(); });
});
test('disk plan refuses stale actual corpus content, not merely a receipt-supplied hash', t => {
  const {req, root} = diskFixture(t); writeFileSync(join(root, carrier), 'changed fixture');
  assert.throws(() => loadEvalPlan(req, root));
});
test('fixed plan path cannot be replaced by a symlink', t => {
  const {req, root, path} = diskFixture(t); const other = join(root, 'other.json');
  writeFileSync(other, '{}'); unlinkSync(path); symlinkSync(other, path);
  assert.throws(() => loadEvalPlan(req, root));
});
test('bound corpus path cannot be replaced by a symlink', t => {
  const {req, root} = diskFixture(t), path = join(root, carrier), other = join(root, 'other.ts');
  writeFileSync(other, 'foreign'); unlinkSync(path); symlinkSync(other, path);
  assert.throws(() => loadEvalPlan(req, root));
});
test('a receipt-authored paid status or plausible hash cannot replace trusted reservation evidence', () => {
  const {receipt, context} = fixture(); receipt.budget = {status: 'paid', digest: 'f'.repeat(64), spentUsd: 0};
  assert.throws(() => verifyEvalReceipt(receipt, context));
});
test('a fixed zero-call sensitive case is complete without inventing a paid call', () => {
  const {receipt, context} = fixture();
  assert.equal(receipt.outcomes.find(row => row.id.startsWith('sensitive:')).providerCalls, 0);
  assert.equal(verifyEvalReceipt(receipt, context).measurementPassed, true);
});
