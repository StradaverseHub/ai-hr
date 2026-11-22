import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoadedAccessBlockerDiagnostics, projectLoadedAccessBlockers } from '../../scripts/performance/loaded-access-blockers.mjs';

const labels = new Map([['1:3:1', 'access-configuration:fixture-tenant-0']]);
const lock = (pid, mode, granted, properties = {}) => ({
  pid, mode, granted, classid: '1', objid: '3', objsubid: 1, app_session: true, ...properties,
});

test('links Access waiters to granted holders and queued blockers from the same sample', () => {
  const diagnostics = createLoadedAccessBlockerDiagnostics();
  diagnostics.observe([
    lock(10, 'ShareLock', false, { blockers: [12, 13, 12] }),
    lock(11, 'ShareLock', false, { blockers: [12] }),
    lock(12, 'ExclusiveLock', false, { blockers: [14], access_backend: 'worker', access_statement: 'clocking import' }),
    lock(13, 'ExclusiveLock', true, { objid: '5', access_backend: 'web' }),
    lock(14, 'ShareLock', true, { access_backend: 'web', access_statement: 'transaction end' }),
  ], labels);
  diagnostics.observe([
    lock(20, 'ShareLock', false, { blockers: [21] }),
    lock(21, 'ExclusiveLock', true, { access_backend: 'worker', access_statement: 'payroll' }),
  ], labels);
  diagnostics.observe([lock(23, 'ShareLock', false, { blockers: [24] })], labels);
  const report = projectLoadedAccessBlockers(diagnostics.facts(), 3);
  assert.equal(report.linkedSamples, 2);
  assert.equal(report.unlinkedSamples, 1);
  assert.deepEqual(report.groups, [
    { waiterMode: 'ShareLock', blockerMode: 'ExclusiveLock', blockerState: 'queued', backend: 'worker', statement: 'clocking import', samples: 1 },
    { waiterMode: 'ExclusiveLock', blockerMode: 'ShareLock', blockerState: 'granted', backend: 'web', statement: 'transaction end', samples: 1 },
    { waiterMode: 'ShareLock', blockerMode: 'ExclusiveLock', blockerState: 'granted', backend: 'worker', statement: 'payroll', samples: 1 },
  ]);
});

test('the report keeps labels closed and validates them against the total Access census', () => {
  const diagnostics = createLoadedAccessBlockerDiagnostics();
  diagnostics.observe([
    lock(20, 'ShareLock', false, { blockers: [21] }),
    lock(21, 'ExclusiveLock', true, { access_backend: 'unrecognised backend', access_statement: 'arbitrary query' }),
  ], labels);
  const raw = diagnostics.facts();
  assert.equal(projectLoadedAccessBlockers(raw, 0), null);
  assert.equal(projectLoadedAccessBlockers({ ...raw, groups: [...raw.groups, ...raw.groups] }, 1), null);
  const [group] = projectLoadedAccessBlockers(raw, 1).groups;
  assert.equal(group.statement, 'unclassified');
  assert.equal(group.backend, 'unclassified');
  assert.equal(projectLoadedAccessBlockers({ ...raw, groups: [{ ...group, blockerMode: 'ShareLock' }] }, 1), null);
});
