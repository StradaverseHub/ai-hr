/** Structural comparison with explicitly FAKE independent projections. No SQL/network/provider,
 * real monetary certification or native read authority is established by these unit fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeBudgetVerifier} from './native-budget-verifier.mjs';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = {sourceSha: 'a'.repeat(40), controllerSha: 'c'.repeat(40), runId: '123', attempt: '1',
  runtime: {node: '22.23.3', platform: 'linux', arch: 'x64'}};
function fixture() {
  const request = {provider: 'openrouter', model: 'openai/gpt-6-luna', path: 'production', budgetUsd: 15,
    carrier: 'test/assistant-model-ceiling.eval.test.ts', profileId: 'fake-native-ledger', identity: structuredClone(identity)};
  const plan = {carrier: request.carrier, profileId: request.profileId, planHash: 'b'.repeat(64), corpusReviewDigest: 'd'.repeat(64), cases: [{id: 'case-a'}, {id: 'case-b'}, {id: 'fixed-zero-call'}]};
  const rows = [1, 2].map(index => ({runId: uuid(index), tenantId: uuid(99), rootId: uuid(index + 10),
    featureId: 'hr_assistant', capabilityDigest: 'e'.repeat(64), requestDigest: 'f'.repeat(64),
    configurationDigest: '1'.repeat(64), reservedNanos: '6000000000', confirmedNanos: null,
    spendState: 'held', provider: 'openrouter', model: request.model, operation: 'conversation',
    runState: 'completed', receiptDigest: null, generationId: null}));
  const evidence = {identity: structuredClone(identity), evaluationId: `${identity.runId}:${identity.attempt}:${plan.planHash}`, tenantId: uuid(99),
    planHash: plan.planHash, corpusReviewDigest: plan.corpusReviewDigest, allocationNanos: '15000000000', maxAttempts: 10, rows};
  const budget = {kind: 'native_owned_no_refund_lifetime_reservations', identity: structuredClone(identity),
    evaluationId: evidence.evaluationId, tenantId: evidence.tenantId,
    snapshot: {allocationNanos: '15000000000', reservedNanos: '12000000000', remainingNanos: '3000000000', attempts: 2, maxAttempts: 10},
    attempts: rows.map((row, i) => ({caseId: i === 0 ? 'case-a' : 'case-b', evaluationId: evidence.evaluationId,
      requestId: `native_${i + 1}`, runId: row.runId, capabilityDigest: row.capabilityDigest,
      requestDigest: row.requestDigest, configurationDigest: row.configurationDigest, ceilingNanos: row.reservedNanos, postCount: 1}))};
  const context = {request, plan, identity: structuredClone(identity), outcomes: [
    {id: 'case-a', status: 'completed', providerCalls: 1}, {id: 'case-b', status: 'completed', providerCalls: 1},
    {id: 'fixed-zero-call', status: 'completed', providerCalls: 0}]};
  const verify = createNativeBudgetVerifier({readNativeEvidence: () => evidence});
  return {request, plan, evidence, budget, context, verify};
}
test('missing native read authority refuses; a candidate paid/hash claim grants nothing', () => {
  assert.throws(() => createNativeBudgetVerifier());
  const {budget, context} = fixture();
  assert.equal(createNativeBudgetVerifier({readNativeEvidence: () => ({status: 'paid', digest: 'a'.repeat(64)})})(budget, context), false);
});
test('two equal prompts remain distinct native runs and retain both full reservations', () => {
  const {verify, budget, context} = fixture();
  assert.equal(budget.attempts[0].requestDigest, budget.attempts[1].requestDigest);
  assert.equal(verify(budget, context), true);
});
test('reader receives independent expected scope only, never candidate tenant or selected run IDs', () => {
  const {evidence, budget, context} = fixture(); let received;
  const verify = createNativeBudgetVerifier({readNativeEvidence: expected => { received = expected; return evidence; }});
  assert.equal(verify(budget, context), true);
  assert.deepEqual(Object.keys(received).sort(), ['carrier', 'corpusReviewDigest', 'identity', 'planHash', 'profileId']);
  assert.equal(JSON.stringify(received).includes(evidence.tenantId), false);
  assert.equal(JSON.stringify(received).includes(evidence.rows[0].runId), false);
});
test('native read failure refuses without substituting zero exposure', () => {
  const {budget, context} = fixture();
  assert.equal(createNativeBudgetVerifier({readNativeEvidence() { throw Error('Fake SQL unavailable'); }})(budget, context), false);
});
for (const [name, change] of [
  ['candidate omitted native run', f => { f.budget.attempts.pop(); f.budget.snapshot.attempts = 1; }],
  ['independent tenant has extra native run', f => { f.evidence.rows.push({...f.evidence.rows[0], runId: uuid(3)}); }],
  ['duplicate native row', f => { f.evidence.rows[1] = f.evidence.rows[0]; }],
  ['candidate duplicates native run', f => { f.budget.attempts[1].runId = f.budget.attempts[0].runId; }],
  ['candidate reuses lifetime request ID', f => { f.budget.attempts[1].requestId = f.budget.attempts[0].requestId; }],
  ['foreign tenant', f => { f.evidence.rows[0].tenantId = uuid(98); }],
  ['candidate chooses another tenant', f => { f.budget.tenantId = uuid(98); }],
  ['foreign evaluation', f => { f.budget.attempts[0].evaluationId = 'different_evaluation'; }],
  ['replayed source', f => { f.evidence.identity.sourceSha = 'e'.repeat(40); }],
  ['replayed controller', f => { f.evidence.identity.controllerSha = 'e'.repeat(40); }],
  ['replayed run', f => { f.evidence.identity.runId = '124'; }],
  ['replayed attempt', f => { f.evidence.identity.attempt = '2'; }],
  ['replayed runtime', f => { f.evidence.identity.runtime.node = 'other'; }],
  ['stale independent plan', f => { f.evidence.planHash = 'e'.repeat(64); }],
  ['stale independent corpus review', f => { f.evidence.corpusReviewDigest = 'e'.repeat(64); }],
  ['copied capability', f => { f.budget.attempts[0].capabilityDigest = '0'.repeat(64); }],
  ['copied request', f => { f.budget.attempts[0].requestDigest = '0'.repeat(64); }],
  ['copied configuration', f => { f.budget.attempts[0].configurationDigest = '0'.repeat(64); }],
  ['understated attempt ceiling', f => { f.budget.attempts[0].ceilingNanos = '1'; }],
  ['missing POST', f => { f.budget.attempts[0].postCount = 0; }],
  ['two POSTs under one allocation', f => { f.budget.attempts[0].postCount = 2; }],
  ['outcome hides a POST', f => { f.context.outcomes[0].providerCalls = 0; }],
  ['unknown case', f => { f.budget.attempts[0].caseId = 'unplanned'; }],
  ['duplicate outcome', f => { f.context.outcomes[1] = f.context.outcomes[0]; }],
  ['omitted outcome', f => { f.context.outcomes.pop(); }],
  ['cross-case root replay', f => { f.evidence.rows[1].rootId = f.evidence.rows[0].rootId; }],
  ['wrong provider', f => { f.evidence.rows[0].provider = 'other'; }],
  ['wrong model', f => { f.evidence.rows[0].model = 'other/model'; }],
  ['wrong operation', f => { f.evidence.rows[0].operation = 'draft'; }],
  ['wrong feature', f => { f.evidence.rows[0].featureId = 'other'; }],
  ['blocked model run with claimed POST', f => { f.evidence.rows[0].runState = 'blocked'; }],
  ['negative native ceiling', f => { f.evidence.rows[0].reservedNanos = '-1'; }],
  ['exponent amount', f => { f.evidence.rows[0].reservedNanos = '6e9'; }],
  ['unsafe numeric amount', f => { f.evidence.rows[0].reservedNanos = 6000000000; }],
  ['snapshot refund', f => { f.budget.snapshot.reservedNanos = '1'; f.budget.snapshot.remainingNanos = '14999999999'; }],
  ['replenished allocation', f => { f.budget.snapshot.allocationNanos = '20000000000'; }],
  ['native authority exceeds approval', f => { f.evidence.allocationNanos = '20000000000'; }],
  ['snapshot counters invented', f => { f.budget.snapshot.attempts = 1; }],
  ['different attempt ceiling', f => { f.budget.snapshot.maxAttempts = 11; }],
  ['breach', f => { f.evidence.rows[0].spendState = 'breach'; }],
  ['unknown native state', f => { f.evidence.rows[0].spendState = 'paid'; }],
  ['unknown held charge disguised as zero', f => { f.evidence.rows[0].confirmedNanos = '0'; }],
]) test('refuses ' + name, () => {
  const f = fixture(); change(f); assert.equal(f.verify(f.budget, f.context), false);
});
test('same case may legitimately use multiple native runs sharing one question root', () => {
  const {verify, budget, context, evidence} = fixture();
  budget.attempts[1].caseId = 'case-a'; evidence.rows[1].rootId = evidence.rows[0].rootId;
  context.outcomes[0].providerCalls = 2; context.outcomes[1].providerCalls = 0;
  assert.equal(verify(budget, context), true);
});
test('held failed attempt retains full bound even though its case cannot qualify execution PASS', () => {
  const {verify, budget, context, evidence} = fixture(); evidence.rows[0].runState = 'failed';
  context.outcomes[0].status = 'error'; assert.equal(verify(budget, context), true);
  budget.snapshot.reservedNanos = '6000000000'; budget.snapshot.remainingNanos = '9000000000';
  assert.equal(verify(budget, context), false);
});
function confirmed(f, index, amount = '1') {
  Object.assign(f.evidence.rows[index], {spendState: 'confirmed', confirmedNanos: amount,
    receiptDigest: String(index + 2).repeat(64), generationId: `gen-fake_${index + 1}`});
}
test('verified lower actual charges never refund the full lifetime reservation', () => {
  const f = fixture(); confirmed(f, 0, '0'); confirmed(f, 1, '1');
  assert.equal(f.verify(f.budget, f.context), true);
  f.budget.snapshot.reservedNanos = '1'; f.budget.snapshot.remainingNanos = '14999999999';
  assert.equal(f.verify(f.budget, f.context), false);
});
for (const [name, change] of [
  ['missing signed receipt digest', f => { f.evidence.rows[0].receiptDigest = null; }],
  ['missing provider generation', f => { f.evidence.rows[0].generationId = null; }],
  ['over-reservation charge', f => { f.evidence.rows[0].confirmedNanos = '6000000001'; }],
  ['replayed generation', f => { f.evidence.rows[1].generationId = f.evidence.rows[0].generationId; }],
  ['replayed signed receipt', f => { f.evidence.rows[1].receiptDigest = f.evidence.rows[0].receiptDigest; }],
]) test('confirmed charge refuses ' + name, () => {
  const f = fixture(); confirmed(f, 0); confirmed(f, 1); change(f);
  assert.equal(f.verify(f.budget, f.context), false);
});
test('full native bound sum cannot exceed independently admitted lifetime allocation', () => {
  const f = fixture(); f.evidence.rows[1].reservedNanos = '10000000000'; f.budget.attempts[1].ceilingNanos = '10000000000';
  assert.equal(f.verify(f.budget, f.context), false);
});

test('asynchronous native readback cannot qualify a synchronous verification callback', async () => {
  const {budget, context, evidence} = fixture();
  assert.equal(createNativeBudgetVerifier({readNativeEvidence: async () => evidence})(budget, context), false);
  assert.equal(createNativeBudgetVerifier({readNativeEvidence: async () => { throw Error('Fake async read failure'); }})(budget, context), false);
  await Promise.resolve(); // Drain the explicitly handled rejection; no SQL or network occurs.
});
test('independent evaluation ID is bound to actual workflow attempt and frozen plan', () => {
  const f = fixture(); f.evidence.evaluationId = 'chosen-by-candidate'; f.budget.evaluationId = f.evidence.evaluationId;
  f.budget.attempts.forEach(row => { row.evaluationId = f.evidence.evaluationId; });
  assert.equal(f.verify(f.budget, f.context), false);
});
test('a stricter independently admitted allocation is allowed but cannot be enlarged by the candidate', () => {
  const f = fixture(); f.evidence.allocationNanos = '12000000000';
  f.budget.snapshot.allocationNanos = '12000000000'; f.budget.snapshot.remainingNanos = '0';
  assert.equal(f.verify(f.budget, f.context), true);
  f.context.request.budgetUsd = 11;
  assert.equal(f.verify(f.budget, f.context), false);
});
