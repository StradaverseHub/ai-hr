import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectMixedRootStatementWork } from '../../scripts/performance/mixed-root-statement-work.mjs';

const defaults = { calls: 100, plans: 98, total_plan_time: 125.2, total_exec_time: 50.2 };

test('publishes only fixed markers and counters, ranked by total cost', () => {
  const rows = projectMixedRootStatementWork([
    { ...defaults, normalized_query: 'select * from public.domain_event where id=$1', queryid: '91827' },
    { ...defaults, total_plan_time: 950.6, normalized_query: 'select app.principal_snapshot_current() from public.app_user where user_id=$1' },
  ]);
  assert.deepEqual(rows, [
    { sourceMarkers: ['principal_snapshot_current', 'app_user'], calls: 100, plans: 98, planningMs: 951, executionMs: 50 },
    { sourceMarkers: ['domain_event'], calls: 100, plans: 98, planningMs: 125, executionMs: 50 },
  ]);
});

test('rejects invalid counters and bounds the number of published shapes', () => {
  const row = { ...defaults, normalized_query: 'select $1' };
  assert.deepEqual(projectMixedRootStatementWork([{ ...row, plans: '-1' }, { ...row, calls: 'unknown' }]), []);
  assert.equal(projectMixedRootStatementWork(Array(35).fill(row)).length, 12);
  assert.deepEqual(projectMixedRootStatementWork(Array(36).fill(row)), []);
});
