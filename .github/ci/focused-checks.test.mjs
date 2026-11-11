/** Controller-only regressions; no app imports, database, compiler or provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSelection, partitionSelection, verifyFocusedResult} from './focused-checks.mjs';

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
