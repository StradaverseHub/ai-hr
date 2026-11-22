import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLoadedAdvisoryDiagnostics,
  createWorkerLoadedDiagnostics,
  projectLoadedAdvisoryDiagnostics,
} from '../../scripts/performance/worker-comparison-failure.mjs';

test('mixed load and worker reports count observed lock families once per sample', () => {
  const advisory = createLoadedAdvisoryDiagnostics();
  const worker = createWorkerLoadedDiagnostics(advisory);
  advisory.observe(2, ['audit-chain', 'audit-chain', 'leave-dependency-employment']);
  advisory.observe(1, []);
  advisory.observe(0, ['a raw identifier']);
  advisory.observe(0, []);

  const counts = projectLoadedAdvisoryDiagnostics(advisory.facts(), 4);
  assert.deepEqual(counts, worker.facts().loadedAdvisory);
  assert.equal(counts.activityWaitSamples, 2);
  assert.equal(counts.appAdvisorySamples, 2);
  assert.equal(counts.activityWithoutAdvisorySamples, 1);
  assert.equal(counts.families['audit-chain'], 1);
  assert.equal(counts.families['leave-dependency-employment'], 1);
  assert.equal(counts.families['advisory-unclassified'], 1);
  assert.equal(Object.hasOwn(counts.families, 'a raw identifier'), false);
});

test('projection stays empty without sample evidence and rejects inconsistent or extra data', () => {
  const advisory = createLoadedAdvisoryDiagnostics();
  assert.equal(projectLoadedAdvisoryDiagnostics(advisory.facts(), 0), null);
  assert.equal(projectLoadedAdvisoryDiagnostics(undefined, 2), null);
  advisory.observe(1, ['audit-chain']);
  advisory.observe(1, []);

  const counts = advisory.facts();
  assert.equal(projectLoadedAdvisoryDiagnostics(counts, 1), null);
  assert.equal(projectLoadedAdvisoryDiagnostics({ ...counts, activityWaitSamples: 3 }, 3), null);
  assert.equal(projectLoadedAdvisoryDiagnostics({
    ...counts, families: { ...counts.families, raw: 1 },
  }, 2), null);
});
