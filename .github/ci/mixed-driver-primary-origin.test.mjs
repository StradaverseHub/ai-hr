import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { mixedDriverPrimaryOrigin, projectMixedNavigationPreflightFailure, projectMixedPayrollPreflight } from '../../scripts/performance/mixed-driver-primary-origin.mjs';

test('retains only allowlisted source coordinates from the primary mixed driver failure', () => {
  const reason = new Error('Fictional private failure contents');
  reason.stack += '\n    at run (file:///home/runner/fixture/source/scripts/performance/system-load-owner.mjs:613:9)';
  const result = mixedDriverPrimaryOrigin(inspect({
    primary: { failed: true, reason },
    secondary: [],
  }));
  assert.deepEqual(result, { file: 'system-load-owner.mjs', line: 613, column: 9 });
});

test('omits private paths and refuses to report a secondary failure as the primary origin', () => {
  const text = `{
  primary: {
    failed: true,
    reason: Error: fictional
        at read (file:///private/source/app/private-records/actions.ts:12:7)
  },
  secondary: [
    Error: fictional
        at read (file:///private/source/scripts/performance/system-load-owner.mjs:54:3)
  ]
}`;
  assert.equal(mixedDriverPrimaryOrigin(text), null);
  assert.equal(mixedDriverPrimaryOrigin('unrecognized diagnostic'), null);
});

test('reports the browser navigation assertion ahead of its mixed-load caller', () => {
  const reason = new Error('Fictional private failure contents');
  reason.stack = [
    reason.toString(),
    '    at captureScenario (/home/runner/private/source/scripts/performance/navigation-browser-capture.ts:401:5)',
    '    at Object.captureActor (/home/runner/private/source/scripts/performance/navigation-browser-capture.ts:341:23)',
    '    at run (file:///home/runner/private/source/scripts/performance/system-load-owner.mjs:1248:27)',
  ].join('\n');
  assert.deepEqual(mixedDriverPrimaryOrigin(inspect({ primary: { failed: true, reason }, secondary: [] })), {
    file: 'navigation-browser-capture.ts', line: 401, column: 5,
  });
});

test('retains a reviewed scenario and bounded link counts without publishing page text', () => {
  const scenario = 'submenu.claims.types.companyHR.usable';
  const result = projectMixedNavigationPreflightFailure({
    scenario, role: 'companyHR', pageText: 'private fixture text',
    linkMatches: {total: 2, visible: 1, href: '/private-record'},
  });
  assert.deepEqual(result, {scenario, role: 'companyHR', linkMatches: {total: 2, visible: 1}});
  assert.equal(projectMixedNavigationPreflightFailure({scenario, role: 'employee'}), null);
  assert.equal(projectMixedNavigationPreflightFailure({scenario: 'invented', role: 'companyHR'}), null);
  assert.deepEqual(projectMixedNavigationPreflightFailure({scenario, role: 'companyHR', linkMatches: {total: 1001}}),
    {scenario, role: 'companyHR', linkMatches: null});
});

test('publishes the failing Payroll preflight surface without private browser data', () => {
  assert.deepEqual(projectMixedPayrollPreflight([
    {phase:'baseline',role:'companyHR',surface:'resume',status:200,scopeDenied:true,elapsedMs:871.5},
    {phase:'baseline',role:'companyHR',surface:'anomalies',failed:true,elapsedMs:90002,
      errorType:'TimeoutError',url:'/payroll/private-id/anomalies',body:'fictional HR record'},
    {phase:'loaded',role:'groupHR',surface:'resume',usable:true},
    {phase:'baseline',role:'other',surface:'private-id'},
  ]), [
    {role:'companyHR',surface:'resume',outcome:'scope-denied',elapsedMs:872,responseStatus:200,errorType:null},
    {role:'companyHR',surface:'anomalies',outcome:'failed',elapsedMs:90002,responseStatus:null,errorType:'TimeoutError'},
  ]);
});
