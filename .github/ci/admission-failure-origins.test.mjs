import assert from 'node:assert/strict';
import test from 'node:test';
import {admissionFailureOrigins} from '../../scripts/performance/admission-failure-log.mjs';

test('counts only complete, allowlisted admission markers', () => {
  const log = [
    'PERF_ADMISSION_FAILURE shell company-scope queue-full',
    'PERF_ADMISSION_FAILURE shell company-scope queue-full',
    'PERF_ADMISSION_FAILURE next render capacity-digest',
    'PERF_ADMISSION_FAILURE next action queue-timeout',
    'PERF_ADMISSION_FAILURE shell customer-private queue-full',
    'PERF_ADMISSION_FAILURE next route capacity-digest /personal/123',
    ' Other context: PERF_ADMISSION_FAILURE shell session queue-full',
  ].join('\n');
  assert.deepEqual(admissionFailureOrigins(log), [
    {source: 'shell', stage: 'company-scope', kind: 'queue-full', count: 2},
    {source: 'next', stage: 'render', kind: 'capacity-digest', count: 1},
    {source: 'next', stage: 'action', kind: 'queue-timeout', count: 1},
  ]);
});
