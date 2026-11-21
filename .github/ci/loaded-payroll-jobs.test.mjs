import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLoadedPayrollJobs, projectPayrollAdmissionPhases, projectPayrollAfterTraffic, projectPayrollUiPreflight, projectTimedOutPayrollResponses } from '../../scripts/performance/loaded-payroll-jobs.mjs';

const atSteady = { active: 500, launched: 500, inSteadyWindow: true };

test('projects ordered Payroll phase durations without carrying raw log fields or accepting partial success', () => {
  const sample = { sample: 'steady-0', outcome: 'queued', phases: { session: 5, translations: 6, prechecks: 19, enqueue: 22 }, handlerMs: 23 };
  const log = [sample, { ...sample, phases: { session: 4, enqueue: 20 } }, { ...sample, sample: 'private' },
    { ...sample, outcome: 'refused', phases: { session: 5, translations: 6 } },
    { ...sample, handlerMs: 1 }].map(row => 'PERF_PAYROLL_RECEIPT '+JSON.stringify({ ...row, privateLog: 'private' })).join('\n');
  assert.deepEqual(projectPayrollAdmissionPhases(log), [
    sample, { ...sample, outcome: 'refused', phases: { session: 5, translations: 6 } },
  ]);
});

const job = tenant => ({
  tenant, startedWith: atSteady, responseMs: 241, acknowledgmentMs: 267,
  verifiedCompletionMs: 7300, verifiedWith: atSteady,
  exportStartedWith: atSteady, verifiedExportMs: 354, exportVerifiedWith: atSteady,
});

test('retains both verified jobs with separate response, acknowledgement, verification and export times', () => {
  const privateJob = { ...job(1), jobId: 'private-job', batchId: 'private-batch',
    verifiedWith: { ...atSteady, privateTrace: 'private-trace' } };
  assert.deepEqual(projectLoadedPayrollJobs([privateJob, job(0)]), {
    state: 'verified-at-steady-load', jobs: [job(0), job(1)],
  });
});

test('keeps partial timings and records a completion or export outside steady load as incomplete', () => {
  const early = { tenant: 0, startedWith: atSteady, responseMs: 321 };
  assert.deepEqual(projectLoadedPayrollJobs([early]), { state: 'incomplete', jobs: [early] });
  for (const field of ['startedWith', 'verifiedWith', 'exportStartedWith', 'exportVerifiedWith']) {
    const late = { ...job(1), [field]: { ...atSteady, active: 480 } };
    assert.equal(projectLoadedPayrollJobs([job(0), late]).state, 'incomplete');
  }
  assert.equal(projectLoadedPayrollJobs([job(0)]).state, 'incomplete');
});

test('checks typed receipt timing and publishes the browser result separately from the register', () => {
  const received = { ...job(0), receiptHeadersMs: 180, receiptConfirmed: true };
  assert.deepEqual(projectLoadedPayrollJobs([received]).jobs, [received]);
  for (const row of [{ ...received, receiptHeadersMs: 250 }, { ...received, receiptConfirmed: false }, { ...received, receiptHeadersMs: undefined }]) {
    assert.equal(projectLoadedPayrollJobs([row]).state, 'invalid');
  }
  assert.deepEqual(projectPayrollUiPreflight({ browserReceiptMs: 400, registerReadyMs: 850, page: 'private' }),
    { browserReceiptMs: 400, registerReadyMs: 850 });
  assert.deepEqual(projectPayrollUiPreflight({ browserReceiptMs: 410 }), { browserReceiptMs: 410 });
  assert.equal(projectPayrollUiPreflight({ browserReceiptMs: 400, registerReadyMs: 399 }), null);
});

test('rejects duplicate tenants, inconsistent phases, and invalid load or timing values', () => {
  const invalid = { state: 'invalid', jobs: [] };
  for (const rows of [
    [job(0), job(0)], [job(0), job(1), job(2)], [job(2)],
    [{ ...job(0), verifiedCompletionMs: 120 }], [{ ...job(0), responseMs: -1 }],
    [{ ...job(0), verifiedExportMs: undefined }],
    [{ ...job(0), startedWith: { active: 500, launched: 499, inSteadyWindow: true } }],
  ]) assert.deepEqual(projectLoadedPayrollJobs(rows), invalid);
  assert.equal(projectLoadedPayrollJobs(undefined), null);
});

test('distinguishes durable results from an unconfirmed response and strips database identifiers', () => {
  const completed = { tenant: 0, batchState: 'processed', jobCount: 1, jobState: 'completed', payslipCount: 50 };
  const missing = { tenant: 1, batchState: 'draft', jobCount: 0, jobState: null, payslipCount: 0 };
  assert.deepEqual(projectPayrollAfterTraffic({ status: 'checked', rows: [
    { ...completed, jobId: 'private-job', tenantId: 'private-tenant' }, missing,
  ] }), { status: 'checked', rows: [completed, missing] });
  assert.deepEqual(projectPayrollAfterTraffic({ status: 'unavailable', sql: 'private' }), { status: 'unavailable', rows: [] });
  assert.deepEqual(projectPayrollAfterTraffic({ status: 'unavailable', kind: 'unclassified', sqlState: '42P01', sql: 'private' }),
    { status: 'unavailable', rows: [], kind: 'unclassified', sqlState: '42P01' });
  assert.deepEqual(projectPayrollAfterTraffic({ status: 'unavailable', kind: 'private', sqlState: 'raw diagnostic' }),
    { status: 'unavailable', rows: [] });
  const invalid = { status: 'invalid', rows: [] };
  for (const rows of [[completed, completed], [{ ...missing, jobState: 'queued' }], [{ ...completed, payslipCount: -1 }]]) {
    assert.deepEqual(projectPayrollAfterTraffic({ status: 'checked', rows }), invalid);
  }
});

test('publishes only the approved Payroll timeout boundaries and no redirect values', () => {
  const tenantForActor = new Map([[7, 0], [10, 1]]);
  const timeout = { user: 7, action: 'payrollProcess', route: '/payroll/[batchId]', method: 'POST',
    role: 'groupHR', error: 'ABORT_ERR', startedMs: 50, elapsedMs: 90000.4,
    responseHeaders: { status: 200, ttfbMs: 350.4, payrollRedirect: 'queued', rawRedirect: 'private' } };
  const otherTenant = { ...timeout, user: 10, responseHeaders: null };
  assert.deepEqual(projectTimedOutPayrollResponses([otherTenant, { ...timeout, startedMs: 10 }, timeout],
    30, tenantForActor), [
    { tenant: 0, elapsedMs: 90000, headers: { status: 200, elapsedMs: 350, redirect: 'queued' } },
    { tenant: 1, elapsedMs: 90000, headers: null },
  ]);
  assert.deepEqual(projectTimedOutPayrollResponses([timeout, timeout], 30, tenantForActor), []);
  assert.deepEqual(projectTimedOutPayrollResponses([{ ...timeout,
    responseHeaders: { ...timeout.responseHeaders, payrollRedirect: '/payroll/private' } }], 30, tenantForActor), []);
});
