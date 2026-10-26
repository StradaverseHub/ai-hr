import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRepairCoverage} from './resume-repair.mjs';
import {fixture, put} from './resume-test-fixtures.mjs';
import {hash, buildUnits} from './manifest.mjs';
function repair() {
  const sourceEvidence = fixture(), candidate = 'd'.repeat(40);
  const {fingerprint: unused, ...body} = {...structuredClone(sourceEvidence.expectedPlan), sha: candidate};
  const candidatePlan = {...body, fingerprint: hash(body)};
  const impact = {policyVersion: 3, tier: 'impact', risk: 'moderate', changed: ['core/example.ts'], reasons: [],
    classifications: [{path: 'core/example.ts', risk: 'moderate', uncertainties: []}],
    run: ['test/plain.test.ts'], selection: {'test/plain.test.ts': ['transitive import consumer of core/example.ts']}, browser: false};
  const binding = {baseTree: 'e'.repeat(40), headTree: 'f'.repeat(40), controller: candidatePlan.controller, impactPolicy: 3};
  return {sourceEvidence, candidate, candidatePlan,
    impactContext: {...binding, base: sourceEvidence.expected.candidate, head: candidate,
      snapshotSource: 'IMMUTABLE_GIT_OBJECTS', sourceInputsFingerprint: hash(binding), plan: {...impact, fingerprint: hash(impact)}}};
}
function alterImpact(f, mutate) {
  const {fingerprint: unused, ...body} = f.impactContext.plan; mutate(body);
  f.impactContext.plan = {...body, fingerprint: hash(body)};
}
function alterPlan(f, mutate) {
  const {fingerprint: unused, ...body} = f.candidatePlan; mutate(body);
  f.candidatePlan = {...body, fingerprint: hash(body)};
}
test('Unaffected units retain their original SHA/report hash and new candidate binding without rewriting reports', () => {
  const f = repair(), before = structuredClone(f.sourceEvidence.reports), result = assessRepairCoverage(f);
  assert.equal(result.carry.length, 4); assert.equal(result.fresh.length, 1);
  assert(result.fresh[0].id.startsWith('nodb-'));
  for (const unit of result.carry) {
    assert.equal(unit.candidateSha, f.candidate); assert.equal(unit.original.sha, f.sourceEvidence.expected.candidate);
    assert.match(unit.original.reportHash, /^[a-f0-9]{64}$/); assert(unit.original.source.jobId > 0);
  }
  assert.deepEqual(f.sourceEvidence.reports, before);
  assert.equal(result.releaseAuthorized, false); assert.equal(result.result, undefined);
  assert.equal(result.requiresIndependentlyRecomputedImpact, true);
  assert.equal(result.requiresGitAncestryAndInputRevalidation, true);
  assert.equal(result.requiresFreshGitHubApiAndLatestFailureHistoryValidation, true);
  assert(result.freshPrerequisites.includes('typecheck')); assert(result.freshPrerequisites.includes('build'));
});
test('High-risk deployment/database/verification work keeps all coverage fresh', () => {
  const f = repair(); alterImpact(f, plan => {
    plan.tier = 'full'; plan.risk = 'high'; plan.changed = ['deploy/deploy-state.sh'];
    plan.classifications = [{path: plan.changed[0], risk: 'high', uncertainties: []}];
    plan.reasons = ['deployment infrastructure requires full verification'];
  });
  const result = assessRepairCoverage(f); assert.equal(result.carry.length, 0);
  assert.equal(result.fresh.length, f.candidatePlan.units.length);
});
test('Failed producing job is rerun after a repair even when unrelated to the changed file', () => {
  const f = repair(), db = f.sourceEvidence.expectedPlan.units.find(unit => unit.kind === 'db');
  f.sourceEvidence.jobs.find(job => job.name === `test (${db.id})`).conclusion = 'failure';
  const result = assessRepairCoverage(f); assert.equal(result.fresh.length, 2);
  assert(result.fresh.some(unit => unit.id === db.id));
  assert.equal(result.originalFailureObservations.find(unit => unit.id === db.id).conclusion, 'failure');
});
test('Changed browser inputs invalidate all engines despite a contradictory false browser flag', () => {
  const f = repair(); alterImpact(f, plan => {
    plan.changed = ['components/example.tsx']; plan.classifications[0].path = plan.changed[0];
  });
  const result = assessRepairCoverage(f); assert.equal(result.carry.length, 1);
  assert.equal(result.fresh.filter(unit => unit.id.startsWith('browser-')).length, 3);
});
test('A changed test cannot be carried when it is omitted from impact.run', () => {
  const f = repair(); alterImpact(f, plan => {
    plan.changed = ['test/db.test.ts']; plan.classifications[0].path = plan.changed[0];
  });
  assert.equal(assessRepairCoverage(f).fresh.length, 2);
});
test('New unit membership stays fresh; candidate coverage is never shrunk to match an older source', () => {
  const f = repair(); alterPlan(f, plan => {
    plan.suite.push('test/new.test.ts'); plan.suite.sort();
    plan.units = buildUnits(plan.suite, {db: ['test/db.test.ts', 'test/new.test.ts'], nodb: ['test/plain.test.ts']}, ['test/ui.browser.test.tsx']);
  });
  const result = assessRepairCoverage(f); assert.equal(result.fresh.length, 2);
  assert.equal(result.completeRequiredUnits.length, f.candidatePlan.units.length);
});
test('Skipped or unhealthy original payloads stay fresh even with a passing producing job', () => {
  const f = repair(), report = f.sourceEvidence.reports.find(unit => unit.id.startsWith('db-'));
  report.databaseTerminalEvidence.memoryEvents.oom_kill = 1;
  put(f.sourceEvidence, 'unit-' + report.id, `unit-${report.id}.json`, report);
  assert(assessRepairCoverage(f).fresh.some(unit => unit.id === report.id));
});
for (const [name, change] of [
  ['impact base', f => f.impactContext.base = f.candidate],
  ['impact head', f => f.impactContext.head = f.sourceEvidence.expected.candidate],
  ['impact controller', f => f.impactContext.controller = 'e'.repeat(40)],
  ['source tree binding', f => f.impactContext.headTree = '0'.repeat(40)],
  ['candidate identity', f => f.candidate = 'e'.repeat(40)],
  ['controller identity', f => alterPlan(f, p => p.controller = 'e'.repeat(40))],
  ['migration baseline', f => alterPlan(f, p => p.migrationBase = 'e'.repeat(40))],
  ['runtime', f => alterPlan(f, p => p.runtime = {...p.runtime, node: '22.99.0'})],
  ['resource budget', f => alterPlan(f, p => p.execution = {...p.execution, workers: 20})],
  ['impact fingerprint', f => f.impactContext.plan.fingerprint = 'forged'],
  ['unknown impact policy', f => alterImpact(f, p => p.policyVersion = 999)],
  ['omitted classifications', f => alterImpact(f, p => p.classifications = [])],
  ['unknown selected file', f => alterImpact(f, p => p.run.push('test/foreign.test.ts'))],
  ['omitted selection evidence', f => alterImpact(f, p => p.selection = {})],
  ['hidden high-risk classification', f => alterImpact(f, p => p.classifications[0].risk = 'high')],
  ['unknown dependency reach', f => alterImpact(f, p => p.classifications[0].uncertainties.push('computed load'))],
]) test('Refuse repair with ' + name, () => {const f = repair(); change(f); assert.throws(() => assessRepairCoverage(f));});
