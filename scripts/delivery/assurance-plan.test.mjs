import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {planAssurance} from './assurance-plan.mjs';

function contract(effects = ['presentation']) {
  return {schemaVersion: 1, changeId: 'synthetic', sourceSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), effects,
    scope: {status: 'bounded', author: 'builder', reviewer: 'verifier'},
    acceptance: {revision: 2, approvedRevision: 2, criteria: ['The reporter can complete the agreed journey.']},
    recovery: 'reversible', observability: 'defined'};
}
function ids(plan) { return plan.obligations.map(o => o.id); }

test('a fully populated proposal still grants no authority and claims no verified evidence', () => {
  const p = planAssurance(contract());
  assert.equal(p.disposition, 'ready-for-evidence-design');
  assert.equal(p.inputTrust, 'UNAUTHENTICATED_PROPOSAL');
  assert.equal(p.releaseAuthorized, false);
  assert.equal(p.exposureAuthorized, false);
  assert.equal(p.evidenceVerified, false);
  assert.ok(ids(p).includes('scope-provenance'));
});
test('changed approval revision and self-review stop readiness', () => {
  const c = contract(); c.acceptance.revision++; c.scope.reviewer = c.scope.author;
  assert.deepEqual(planAssurance(c).holds, ['current-reporter-approval', 'independent-scope-review']);
});
test('unknown recovery and outcome signals cannot become a rollout-ready plan', () => {
  const c = contract(); c.recovery = 'unknown'; c.observability = 'unknown';
  assert.deepEqual(planAssurance(c).holds, ['outcome-signals', 'recovery-design']);
});
test('money, privacy and schema effects require independent proof before exposure', () => {
  const p = planAssurance(contract(['money-calculation', 'private-read', 'schema-change']));
  for (const id of ['financial-oracle', 'side-effect-free-replay', 'isolation-proof']) {
    assert.equal(p.obligations.find(o => o.id === id)?.stage, 'before-exposure');
  }
  assert.equal(p.obligations.find(o => o.id === 'migration-proof')?.stage, 'before-installation');
  assert.equal(p.exposure, 'requires-pre-effect-controls');
});
test('irreversible actions retain controls even with reversible code', () => {
  const cases = {'money-finalization': 'finalization-control', 'access-change': 'grant-control',
    'external-message': 'delivery-control', 'destructive-write': 'destruction-control', 'schema-change': 'schema-recovery'};
  for (const [effect, id] of Object.entries(cases)) {
    const p = planAssurance(contract([effect]));
    assert.equal(p.obligations.find(o => o.id === id)?.stage, 'before-irreversible-action');
    assert.equal(p.exposure, 'requires-pre-effect-controls');
  }
});
test('adding effects is monotone: existing obligations cannot disappear', () => {
  const effects = ['presentation', 'private-read', 'business-write', 'money-calculation',
    'money-finalization', 'access-change', 'schema-change', 'external-message', 'destructive-write'];
  for (let mask = 1; mask < 2 ** effects.length; mask++) {
    const subset = effects.filter((_, bit) => mask & (1 << bit));
    const existing = ids(planAssurance(contract(subset)));
    for (const effect of effects.filter(e => !subset.includes(e))) {
      const expanded = ids(planAssurance(contract([...subset, effect])));
      assert.ok(existing.every(id => expanded.includes(id)));
    }
  }
});
test('effect order does not change the plan and repeated obligations are deduplicated', () => {
  const effects = ['access-change', 'private-read', 'money-finalization', 'money-calculation'];
  const p = planAssurance(contract(effects));
  assert.deepEqual(p, planAssurance(contract([...effects].reverse())));
  assert.equal(ids(p).filter(id => id === 'isolation-proof').length, 1);
  assert.equal(ids(p).filter(id => id === 'financial-oracle').length, 1);
});
test('unknown effects, forged authority, malformed identities and empty acceptance refuse', () => {
  const bad = [];
  let c = contract(); c.effects.push('harmless'); bad.push(c);
  c = contract(); c.effects.push('presentation'); bad.push(c);
  c = contract(); c.releaseAuthorized = true; bad.push(c);
  c = contract(); c.sourceSha = 'HEAD'; bad.push(c);
  c = contract(); c.acceptance.criteria = []; bad.push(c);
  c = contract(); c.scope.status = 'safe'; bad.push(c);
  c = contract(); c.acceptance.approvedRevision = 0; bad.push(c);
  for (const input of bad) assert.throws(() => planAssurance(input));
});
test('sample deliberately surfaces unanswered design questions', () => {
  const c = JSON.parse(readFileSync(new URL('./example-contract.json', import.meta.url), 'utf8'));
  assert.deepEqual(planAssurance(c).holds,
    ['current-reporter-approval', 'independent-scope-review', 'outcome-signals', 'recovery-design']);
});
test('CLI refuses malformed/oversized input with no success JSON', () => {
  const cli = new URL('./assurance-plan.mjs', import.meta.url);
  for (const input of ['{', JSON.stringify({...contract(), exposureAuthorized: true}), ' '.repeat(128 * 1024 + 1)]) {
    const r = spawnSync(process.execPath, [cli.pathname], {input, encoding: 'utf8'});
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Assurance planning refused:/);
  }
});
