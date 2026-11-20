import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { mixedDriverPrimaryOrigin } from '../../scripts/performance/mixed-driver-primary-origin.mjs';

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
