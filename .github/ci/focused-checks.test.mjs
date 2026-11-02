/** Controller-only regressions; no app imports, database, compiler or provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSelection, partitionSelection, verifyFocusedResult, classifierEnvironment, admitFocusedEvaluation, captureNativeBudgetScope} from './focused-checks.mjs';

const files = ['test/example.test.ts', 'test/screen.dom.test.tsx'];
test('Manifest retains exact file identities and sorts a copied selection', () => {
  assert.deepEqual(parseSelection(JSON.stringify(files.toReversed())), files);
});
for (const value of ['{}', 'null', '[]', 'invalid', JSON.stringify(Array(65).fill(files[0])),
  JSON.stringify([files[0], files[0]]), JSON.stringify([null]), JSON.stringify([2]),
  ...['../test/example.test.ts', '/test/example.test.ts', 'test/../example.test.ts',
    'test//example.test.ts', 'test/./example.test.ts', 'test/example.browser.test.tsx',
    'test/*.test.ts', 'test/example.test.ts\nother', 'test/$(whoami).test.ts'].map(file => JSON.stringify([file]))]) {
  test('Reject invalid or ambiguous manifest: ' + value.slice(0, 100), () => assert.throws(() => parseSelection(value)));
}
test('Manifest rejects oversized input before parsing', () => {
  assert.throws(() => parseSelection(' '.repeat(16_385)));
});
test('Actual classifier owns the complete, disjoint selected partition', () => {
  assert.deepEqual(partitionSelection(files, `DB\t${files[0]}\treason\nNODB\t${files[1]}\tno DB\n`),
    {DB: [files[0]], NODB: [files[1]]});
});
for (const output of ['', `DB\t${files[0]}`, `DB\t${files[0]}\nNODB\t${files[0]}`,
  `UNKNOWN\t${files[0]}\nNODB\t${files[1]}`, `DB\t${files[0]}\nDB\ttest/foreign.test.ts`]) {
  test('Reject classifier omission, duplicate, foreign file or category: ' + output, () => {
    assert.throws(() => partitionSelection(files, output));
  });
}

function result() {
  return {success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 2, numPassedTests: 2,
    testResults: files.map(name => ({name: '/candidate/' + name, status: 'passed', assertionResults: [{status: 'passed'}]}))};
}
test('A focused result proves execution of every selected file and assertion', () => {
  assert.equal(verifyFocusedResult(result(), files, '/candidate'), 2);
});
for (const [name, mutate] of [
  ['false success', r => { r.success = false; }],
  ['failed count', r => { r.numFailedTests = 1; }],
  ['failed suite count', r => { r.numFailedTestSuites = 1; }],
  ['omitted file', r => { r.testResults.pop(); }],
  ['duplicate file', r => { r.testResults[1] = r.testResults[0]; }],
  ['foreign file', r => { r.testResults[0].name = '/candidate/test/foreign.test.ts'; }],
  ['outside checkout', r => { r.testResults[0].name = '/other/test/example.test.ts'; }],
  ['failed suite', r => { r.testResults[0].status = 'failed'; }],
  ['empty assertions', r => { r.testResults[0].assertionResults = []; }],
  ['skipped assertion', r => { r.testResults[0].assertionResults[0].status = 'pending'; }],
  ['todo assertion', r => { r.testResults[0].assertionResults[0].status = 'todo'; }],
  ['invented total', r => { r.numTotalTests = 3; }],
  ['invented passed total', r => { r.numPassedTests = 3; }],
  ['no tests', r => { r.testResults = []; r.numTotalTests = 0; r.numPassedTests = 0; }],
]) test('Reject incomplete/false focused execution: ' + name, () => {
  const value = result(); mutate(value);
  assert.throws(() => verifyFocusedResult(value, files, '/candidate'));
});


test('database consumer requires exact v15 cap/budget identity and refuses legacy or mixed selectors', async () => {
  const {assertFocusedPostgresProfile} = await import('./focused-checks.mjs');
  const env = {AIHR_CI_PG_PROFILE: '2', AIHR_CI_PG_CONFIGURED_CAP_BYTES: '2113929216',
    AIHR_CI_PG_PEAK_BUDGET_BYTES: '2147483648', AIHR_CI_PG_JIT: 'on'};
  assert.deepEqual(assertFocusedPostgresProfile(env), {profileVersion: 2, configuredCapBytes: 2113929216, peakBudgetBytes: 2147483648, jit: 'on'});
  for (const changes of [{AIHR_CI_PG_PROFILE: undefined}, {AIHR_CI_PG_PROFILE: '1'},
    {AIHR_CI_PG_CONFIGURED_CAP_BYTES: '2147483648'}, {AIHR_CI_PG_PEAK_BUDGET_BYTES: '2147483649'},
    {AIHR_CI_PG_MEMORY_GIB: '2'}, {AIHR_CI_PG_JIT: 'off'}, {AIHR_CI_PG_JIT: undefined}])
    assert.throws(() => assertFocusedPostgresProfile({...env, ...changes}));
  assert.throws(() => assertFocusedPostgresProfile({AIHR_CI_PG_PROFILE: 'legacy-2g', AIHR_CI_PG_MEMORY_GIB: '2', AIHR_CI_PG_JIT: 'on'}));
});


test('focused plan identity binds cap and peak budget independently of selected file identity', async () => {
  const {focusedPlanIdentity} = await import('./focused-checks.mjs');
  const input = {sha: 'a'.repeat(40), controller: 'c'.repeat(40), files, groups: {DB: files, NODB: []},
    classifierHash: 'b'.repeat(64), execution: {workers: 2, postgres: {profileVersion: 2,
      configuredCapBytes: 2113929216, peakBudgetBytes: 2147483648, jit: 'on'}}};
  const original = focusedPlanIdentity(input);
  for (const change of [{configuredCapBytes: 2147483648}, {peakBudgetBytes: 2147483649}, {profileVersion: 1}]) {
    const altered = focusedPlanIdentity({...input, execution: {...input.execution, postgres: {...input.execution.postgres, ...change}}});
    assert.notEqual(altered.fingerprint, original.fingerprint);
    assert.deepEqual(altered.files, original.files);
  }
});

/** A green Vitest assertion is not evidence that a requested model evaluation ran.
 * These fixtures intentionally exercise the existing verifier, not a missing helper import. */
const evalFile = 'test/assistant-model-ceiling.eval.test.ts';
function disabledEvalResult() {
  return {success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 1, numPassedTests: 1,
    testResults: [{name: '/candidate/' + evalFile, status: 'passed', assertionResults: [{status: 'passed',
      title: 'stays disabled and calls no provider without the protected evaluation secret'}]}]};
}
function requestedEvalContext() {
  const identity = {sourceSha: 'a'.repeat(40), controllerSha: 'c'.repeat(40), runId: '123', attempt: '1',
    runtime: {node: '22.23.3', platform: 'linux', arch: 'x64'}};
  const request = {provider: 'openrouter', model: 'openai/gpt-6-luna', path: 'production', budgetUsd: 15,
    allowedProviders: ['azure'], carrier: evalFile, profileId: 'fixture', repeats: 1, identity};
  // This verifier fixture receives an already controller-validated test-owned plan.
  // Full plan cardinality/source validation has independent contract tests.
  const cases = ['baseline:leave-annual:0', 'sensitive:crisis-en:0'].map((id, index) => ({id,
    requiresModel: index === 0, dependsOn: null, quality: {kind: 'deterministic', criteria: ['fixture-outcome']}}));
  const plan = {files: [evalFile], cases, planHash: 'b'.repeat(64), corpusReviewDigest: 'd'.repeat(64)};
  const receipt = {schemaVersion: 1, request: structuredClone(request), files: [evalFile],
    planHash: plan.planHash, corpusReviewDigest: plan.corpusReviewDigest, productionReviewed: true, path: 'production',
    plannedCaseIds: cases.map(row => row.id), outcomes: cases.map((row, index) => ({id: row.id,
      status: 'completed', providerCalls: index === 0 ? 1 : 0,
      security: {passed: true, findings: []}, criteria: [{id: 'fixture-outcome', status: 'met'}]})),
    budget: {fixtureReservation: 'actual-held-allocation'}};
  return {requested: true, request, plan, receipt, identity,
    budgetVerifier: budget => budget?.fixtureReservation === 'actual-held-allocation'};
}
test('Ordinary no-model invocation retains the disabled/no-provider proof without claiming evaluation', () => {
  assert.equal(verifyFocusedResult(disabledEvalResult(), [evalFile], '/candidate'), 1);
});
test('Requested model evaluation cannot qualify from a passing disabled assertion without its measurement receipt', () => {
  const context = requestedEvalContext(); delete context.receipt;
  assert.throws(() => verifyFocusedResult(disabledEvalResult(), [evalFile], '/candidate', context));
});
test('Requested model evaluation refuses a measurement receipt for a different selected carrier', () => {
  const context = requestedEvalContext();
  context.request.carrier = 'test/review/teras-review-model.eval.test.ts';
  context.receipt.request.carrier = context.request.carrier;
  context.receipt.files = [context.request.carrier];
  assert.throws(() => verifyFocusedResult(disabledEvalResult(), [evalFile], '/candidate', context));
});
test('Requested model evaluation refuses a declared complete receipt missing a planned case outcome', () => {
  const context = requestedEvalContext(); context.receipt.outcomes.pop();
  assert.throws(() => verifyFocusedResult(disabledEvalResult(), [evalFile], '/candidate', context));
});
test('Requested model evaluation refuses budget-truncated outcomes even when every Vitest assertion passed', () => {
  const context = requestedEvalContext();
  context.receipt.outcomes[1].status = 'budget_refused';
  context.receipt.executionComplete = false;
  assert.throws(() => verifyFocusedResult(disabledEvalResult(), [evalFile], '/candidate', context));
});

test('Requested model evaluation accepts a complete current receipt only with trusted reservation verification', () => {
  const value = disabledEvalResult(); value.testResults[0].assertionResults[0].title = 'measures its exact planned cases';
  const context = requestedEvalContext(); let verified;
  context.onVerified = summary => { verified = summary; };
  assert.equal(verifyFocusedResult(value, [evalFile], '/candidate', context), 1);
  assert.equal(verified.measurementPassed, true); assert.equal(verified.releaseEligible, false);
  delete context.budgetVerifier;
  assert.throws(() => verifyFocusedResult(value, [evalFile], '/candidate', context));
});
test('Requested model evaluation keeps human review and unmet quality separate from execution success', () => {
  for (const status of ['missed', 'review_required']) {
    const context = requestedEvalContext(); context.receipt.outcomes[0].criteria[0].status = status;
    assert.throws(() => verifyFocusedResult(disabledEvalResult(), [evalFile], '/candidate', context));
  }
});

test('candidate classifier receives no eval or spend-receipt capability, preserving ordinary DB/resource configuration', () => {
  const env = {AIHR_EVAL_OPENROUTER_KEY: 'fictional-secret', AIHR_EVAL_MODEL: 'openai/gpt-6-luna',
    AIHR_EVAL_BUDGET_USD: '15', AIHR_EVAL_FUTURE_CREDENTIAL: 'future-secret',
    AI_SPEND_RECEIPT_SIGNING_KEY: 'fictional-signer', AI_SPEND_RECEIPT_FUTURE: 'future-capability',
    DATABASE_URL: 'postgres://fixture', TEST_DB_NAMESPACE: 'aifocus', AIHR_CI_PG_PROFILE: '2',
    AIHR_CI_PG_JIT: 'on', RUNNER_TEMP: '/runner/private', PATH: '/usr/bin', CI: 'true'};
  const filtered = classifierEnvironment(env);
  assert.deepEqual(filtered, {DATABASE_URL: 'postgres://fixture', TEST_DB_NAMESPACE: 'aifocus', AIHR_CI_PG_PROFILE: '2',
    AIHR_CI_PG_JIT: 'on', RUNNER_TEMP: '/runner/private', PATH: '/usr/bin', CI: 'true'});
  assert.notEqual(filtered, env); assert.equal(env.AIHR_EVAL_OPENROUTER_KEY, 'fictional-secret');
});
test('missing trusted budget adapter refuses before a candidate-classification callback can execute', () => {
  const {request, identity} = requestedEvalContext(); let classifications = 0;
  const env = {AIHR_EVAL_MODEL: request.model, AIHR_EVAL_OPENROUTER_KEY: 'fictional-secret', AIHR_EVAL_PATH: 'production',
    AIHR_EVAL_BUDGET_USD: '15', AIHR_EVAL_ALLOWED_PROVIDERS: 'azure', AIHR_EVAL_REPEATS: '1', AIHR_EVAL_PROFILE: 'fixture'};
  const attempt = () => {
    admitFocusedEvaluation({env, files: [evalFile], identity, loadPlan: () => ({fixture: 'read-only plan'})});
    classifications++;
  };
  assert.throws(attempt, /verified budget admission is unavailable/);
  assert.equal(classifications, 0);
});
test('ordinary classifier preflight does not load an eval plan or require a paid adapter', () => {
  assert.deepEqual(admitFocusedEvaluation({env: {}, files, identity: undefined,
    loadPlan() { throw Error('ordinary CI must not load an evaluation plan'); }}), {request: null, plan: null});
});

// Scope parsing is not authority: only a trusted admission callback may supply this context.
test('native scope is a copied fixed allocation, including fractional-dollar caps', () => {
  const scope={tenantId:'11111111-1111-4111-8111-111111111111',allocationNanos:'100000000',maxAttempts:1500};
  const captured=captureNativeBudgetScope(scope,{budgetUsd:0.1});
  assert.notEqual(captured,scope);assert.ok(Object.isFrozen(captured));
  scope.tenantId='22222222-2222-4222-8222-222222222222';
  assert.equal(captured.tenantId,'11111111-1111-4111-8111-111111111111');
});
for(const change of [undefined,{}, {tenantId:'invalid',allocationNanos:'15000000000',maxAttempts:1500},
  {tenantId:'00000000-0000-0000-0000-000000000000',allocationNanos:'15000000000',maxAttempts:1500},
  {tenantId:'11111111-1111-4111-8111-111111111111',allocationNanos:'16000000000',maxAttempts:1500},
  {tenantId:'11111111-1111-4111-8111-111111111111',allocationNanos:'15000000000',maxAttempts:1}]) {
 test('native controller refuses missing or mismatched independently admitted scope: '+JSON.stringify(change),()=>{
  const {request,identity}=requestedEvalContext();let classifications=0;
  const env={AIHR_EVAL_MODEL:request.model,AIHR_EVAL_OPENROUTER_KEY:'fictional',AIHR_EVAL_BUDGET_USD:'15',
    AIHR_EVAL_ALLOWED_PROVIDERS:'azure',AIHR_EVAL_REPEATS:'1',AIHR_EVAL_PROFILE:'fixture'};
  assert.throws(()=>{
   admitFocusedEvaluation({env,files:[evalFile],identity,loadPlan:()=>({}),budgetAdmission:()=>({admitted:true,nativeScope:change}),
    budgetVerifier:()=>false,nativeVerification:true});
   classifications++;
  },/independent native scope/);
  assert.equal(classifications,0);
 });
}
