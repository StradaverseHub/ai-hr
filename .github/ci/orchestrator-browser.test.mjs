import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateFixture, receiptExpectation} from './orchestrator-browser.mjs';

const id = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
function manifest(reused = false) {
  const companies = {A: id(1), B: id(2), Empty: id(3)};
  const keys = ['group-admin', 'A-hr', 'A-employee', 'B-hr', 'B-employee', 'Empty-hr'];
  return {preparationOnly: true, reused, scenario: 'prepare', version: 1,
    tenantId: '11111111-1111-1111-1111-111111111111', privateSentinel: 'ORCH23_PRIVATE_SENTINEL', companies,
    actors: keys.map((key, index) => ({key, userId: id(10 + index), personId: key.endsWith('-employee') ? id(20 + index) : null,
      companyId: key === 'group-admin' ? null : companies[key.split('-')[0]]})),
    views: keys.filter(key => !key.endsWith('-employee')).map(actor => ({actor, open: 0,
      lastRun: {failed: false, harnessVersion: 'readiness-v2'}}))};
}

test('accepts only the expected fictional first preparation and preserved second preparation', () => {
  for (const reused of [false, true]) {
    const value = manifest(reused); assert.equal(validateFixture(value, reused), value);
    assert.throws(() => validateFixture(value, !reused));
  }
});

for (const [label, change] of [
  ['a real or foreign tenant', value => { value.tenantId = id(99); }],
  ['a non-preparation result', value => { value.preparationOnly = false; }],
  ['a scenario mutation posing as preparation', value => { value.scenario = 'failed'; }],
  ['an unknown manifest version', value => { value.version = 2; }],
  ['a missing privacy sentinel', value => { delete value.privateSentinel; }],
  ['an extra company', value => { value.companies.Foreign = id(99); }],
  ['companies sharing an identity', value => { value.companies.B = value.companies.A; }],
  ['a missing principal', value => { value.actors.pop(); }],
  ['an unexpected principal role', value => { value.actors[0].key = 'super-admin'; }],
  ['principals sharing a login', value => { value.actors[1].userId = value.actors[0].userId; }],
  ['a malformed login identity', value => { value.actors[0].userId = '../foreign'; }],
  ['a company principal mapped across companies', value => { value.actors[1].companyId = value.companies.B; }],
  ['a group administrator narrowed to a company', value => { value.actors[0].companyId = value.companies.A; }],
  ['an employee without a person identity', value => { value.actors[2].personId = null; }],
  ['a missing administrative view', value => { value.views.pop(); }],
  ['a duplicate administrative view', value => { value.views[1].actor = value.views[0].actor; }],
  ['a negative queue count', value => { value.views[0].open = -1; }],
  ['an imprecise queue count', value => { value.views[0].open = Number.MAX_SAFE_INTEGER + 1; }],
  ['an initially failed coordinator run', value => { value.views[0].lastRun.failed = true; }],
  ['an unsupported initial harness version', value => { value.views[0].lastRun.harnessVersion = 'readiness-v999'; }],
]) test(`rejects ${label} before browser assertions can supply evidence`, () => {
  const value = manifest(); change(value); assert.throws(() => validateFixture(value, false));
});

test('legacy and malformed receipts remain explicitly unknown and incomplete', () => {
  for (const scenario of ['legacy', 'malformed']) assert.deepEqual(receiptExpectation(scenario), {
    outcome: 'unknown', steps: ['unknown', 'unknown', 'unknown', 'unknown'], incomplete: true});
});
test('a future version cannot be accepted as a successful outcome despite recorded successful steps', () => {
  const result = receiptExpectation('unsupported');
  assert.equal(result.outcome, 'unknown'); assert.equal(result.incomplete, true);
  assert.equal(result.version, 'readiness-v999'); assert(result.steps.every(state => state === 'succeeded'));
});
test('one failed step makes the current receipt failed without hiding the other steps', () => {
  assert.deepEqual(receiptExpectation('failed'), {outcome: 'failed',
    steps: ['succeeded', 'succeeded', 'failed', 'succeeded'], incomplete: false, version: 'readiness-v2'});
});
test('successful current receipts have four complete successful steps', () => {
  const result = receiptExpectation('current'); assert.equal(result.outcome, 'succeeded');
  assert.equal(result.incomplete, false); assert.equal(result.steps.length, 4);
  assert(result.steps.every(state => state === 'succeeded')); assert.equal(result.version, 'readiness-v2');
});
test('unknown scenario input is refused rather than silently treated as success', () => {
  for (const value of ['', undefined, 'CURRENT', '../current', 'erase']) assert.throws(() => receiptExpectation(value));
});

test('outcome fixture rows are fictional, scoped to the manifest companies and match the expected counts', async () => {
  const {outcomeFixtureSql, OUTCOME_EXPECTED} = await import('./orchestrator-browser.mjs');
  const value = manifest(), statement = outcomeFixtureSql(value);
  assert.match(statement, /^insert into app\.assistant_own_leave_review\(/);
  assert.equal((statement.match(/'leave\.apply'/g) ?? []).length, 7);
  assert(statement.includes(value.companies.A) && statement.includes(value.companies.B));
  assert(!statement.includes(value.companies.Empty));
  assert.deepEqual(Object.keys(OUTCOME_EXPECTED).sort(), ['A-hr', 'B-hr', 'group-admin']);
  const broken = manifest(); broken.actors[2].userId = "x'; drop table person; --";
  assert.throws(() => outcomeFixtureSql(broken));
});


test('database consumer requires exact v15 cap/budget identity and refuses legacy or mixed selectors', async () => {
  const {assertBrowserPostgresProfile} = await import('./orchestrator-browser.mjs');
  const env = {AIHR_CI_PG_PROFILE: '2', AIHR_CI_PG_CONFIGURED_CAP_BYTES: '2113929216',
    AIHR_CI_PG_PEAK_BUDGET_BYTES: '2147483648', AIHR_CI_PG_JIT: 'on'};
  assert.deepEqual(assertBrowserPostgresProfile(env), {profileVersion: 2, configuredCapBytes: 2113929216, peakBudgetBytes: 2147483648, jit: 'on'});
  for (const changes of [{AIHR_CI_PG_PROFILE: undefined}, {AIHR_CI_PG_PROFILE: '1'},
    {AIHR_CI_PG_CONFIGURED_CAP_BYTES: '2147483648'}, {AIHR_CI_PG_PEAK_BUDGET_BYTES: '2147483649'},
    {AIHR_CI_PG_MEMORY_GIB: '2'}, {AIHR_CI_PG_JIT: 'off'}, {AIHR_CI_PG_JIT: undefined}])
    assert.throws(() => assertBrowserPostgresProfile({...env, ...changes}));
  assert.throws(() => assertBrowserPostgresProfile({AIHR_CI_PG_PROFILE: 'legacy-2g', AIHR_CI_PG_MEMORY_GIB: '2', AIHR_CI_PG_JIT: 'on'}));
});
