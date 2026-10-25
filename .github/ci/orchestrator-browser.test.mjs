import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateFixture, receiptExpectation, localesForActor, bounded, observed, journeyPlan, validateCorrectionEvidence} from './orchestrator-browser.mjs';

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

test('populated and empty queues retain every locale on both routes and viewport sizes', () => {
  for (const actor of ['group-admin', 'Empty-hr']) assert.deepEqual(localesForActor(actor).sort(), ['en', 'ms', 'ta', 'th', 'vi', 'zh']);
});
test('every distinct scoped administrator and employee remains in the security journey', () => {
  const actors = manifest().actors;
  const visits = actors.flatMap(actor => localesForActor(actor.key).flatMap(locale =>
    ['desktop', 'mobile'].flatMap(viewport => ['/control-tower', '/control-tower/agents'].map(route => ({actor: actor.key, locale, viewport, route})))));
  assert.equal(visits.length, 64);
  for (const actor of actors) for (const viewport of ['desktop', 'mobile']) for (const route of ['/control-tower', '/control-tower/agents'])
    assert(visits.some(visit => visit.actor === actor.key && visit.viewport === viewport && visit.route === route));
  assert.throws(() => localesForActor('foreign-admin'));
});
test('a response that never finishes fails within its explicit bound', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 'Fictional response', 5), /Fictional response exceeded 5ms/);
});
test('bounded operations preserve ordinary results and errors', async () => {
  assert.equal(await bounded(Promise.resolve('finished'), 'Fictional response', 50), 'finished');
  const error = new Error('Transport failed');
  await assert.rejects(bounded(Promise.reject(error), 'Fictional response', 50), received => received === error);
});

test('observed completion requires the actual outcome, not merely an action response', async () => {
  let calls = 0;
  await observed(async () => ++calls === 2, 'Saved preference', 1000);
  assert.equal(calls, 2);
  await assert.rejects(observed(async () => false, 'Unsaved preference', 5), /Unsaved preference/);
});
test('outcome observation bounds a stalled read and preserves real read errors', async () => {
  await assert.rejects(observed(() => new Promise(() => {}), 'Stalled read', 5), /Stalled read/);
  const error = new Error('Read refused');
  await assert.rejects(observed(async () => { throw error; }, 'Saved preference', 50), received => received === error);
});

test('focused correction proof is explicitly named and cannot silently replace queue coverage', () => {
  assert.deepEqual(journeyPlan('queue'), {journey: 'queue', plannedVisits: 64});
  assert.deepEqual(journeyPlan('correction'), {journey: 'correction', plannedVisits: 0});
  for (const invalid of [undefined, '', 'all', 'skip', '../correction']) assert.throws(() => journeyPlan(invalid));
});
const correctionWitnesses = () => {
  const before = {id: id(1), employmentId: id(2), companyId: id(3), gap: 'no_bank_account',
    paymentMethod: null, state: 'needs_input', verifiedAt: null, reopenCount: 2};
  return [before, {...before, paymentMethod: 'cash', state: 'verified', verifiedAt: '2026-10-25T12:00:00Z'},
    {...before, reopenCount: 3}];
};
test('correction requires persisted cash closure and the same case reopened exactly once after clearing', () => {
  validateCorrectionEvidence(...correctionWitnesses());
  const hrOwned = correctionWitnesses(); hrOwned[0].state = hrOwned[2].state = 'needs_review';
  validateCorrectionEvidence(...hrOwned);
});
for (const [label, change] of [
  ['another case', rows => { rows[2].id = id(9); }],
  ['another employment', rows => { rows[1].employmentId = id(9); }],
  ['another company', rows => { rows[2].companyId = id(9); }],
  ['another gap', rows => { rows[1].gap = 'no_tax_number'; }],
  ['no saved cash value', rows => { rows[1].paymentMethod = null; }],
  ['no verified closure', rows => { rows[1].state = 'needs_input'; }],
  ['no closure timestamp', rows => { rows[1].verifiedAt = null; }],
  ['invalid closure timestamp', rows => { rows[1].verifiedAt = 'unknown'; }],
  ['no cleared source value', rows => { rows[2].paymentMethod = 'cash'; }],
  ['still closed', rows => { rows[2].state = 'verified'; }],
  ['stale closure timestamp', rows => { rows[2].verifiedAt = rows[1].verifiedAt; }],
  ['no recorded reopening', rows => { rows[2].reopenCount = 2; }],
  ['duplicate reopening', rows => { rows[2].reopenCount = 4; }],
  ['counter changed at closure', rows => { rows[1].reopenCount = 3; }],
]) test(`correction evidence refuses ${label}`, () => {
  const rows = correctionWitnesses(); change(rows); assert.throws(() => validateCorrectionEvidence(...rows));
});
