import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLoadedPayrollJobs } from '../../scripts/performance/loaded-payroll-jobs.mjs';

const atSteady = { active: 500, launched: 500, inSteadyWindow: true };
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
