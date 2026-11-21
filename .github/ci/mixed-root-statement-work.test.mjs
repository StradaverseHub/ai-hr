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

test('recognizes the task bundle and quoted relations without publishing identifiers or query text', () => {
  const [row] = projectMixedRootStatementWork([{
    ...defaults,
    normalized_query: 'WITH task_caller AS MATERIALIZED (select 1) SELECT * FROM "public"."tenant_module" '
      + 'JOIN "other_schema"."private_accounts" ON true JOIN "company" ON true WHERE fixture = $1',
  }]);
  assert.deepEqual(row, {
    sourceMarkers: ['account-task-bundle', 'company', 'tenant_module'],
    calls: 100, plans: 98, planningMs: 125, executionMs: 50,
  });
});

test('attributes unclassified root work using only names in the disposable catalog', () => {
  const [row] = projectMixedRootStatementWork([{
    ...defaults,
    normalized_query: 'select "app"."load_session"($1), app.load_session($1), app.unknown_fn($1), '
      + "'select app.literal_fn() from public.secret_table' from public.payroll_policy p "
      + 'join app.scope_projection s on true join external.secret_table e on true',
  }], { routines: ['load_session', 'literal_fn'], relations: ['payroll_policy', 'scope_projection', 'secret_table'] });
  assert.deepEqual(row, {
    sourceMarkers: [], statementKind: 'select', appRoutines: ['load_session'], relations: ['payroll_policy', 'scope_projection'],
    calls: 100, plans: 98, planningMs: 125, executionMs: 50,
  });
});

test('ignores comments, dollar-quoted values and catalog entries requiring redaction', () => {
  const [row] = projectMixedRootStatementWork([{
    ...defaults,
    normalized_query: '/* select app.hidden() */ with x as (select $payload$ FROM role_assignment $payload$) '
      + 'select * from public.approvals_table -- app.hidden()',
  }], { routines: ['hidden', 'private sensitive value'], relations: ['approvals_table', 'role_assignment'] });
  assert.equal(row.statementKind, 'with');
  assert.deepEqual(row.appRoutines, []);
  assert.deepEqual(row.relations, ['approvals_table']);
  assert.equal(JSON.stringify(row).includes('private sensitive value'), false);
});
