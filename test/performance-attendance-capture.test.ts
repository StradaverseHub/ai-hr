import { expect, it } from 'vitest';
import { clockingImportOutcome, isNativeAttendanceCorrectionPost } from '../scripts/performance/mixed-workflows.mjs';

it('captures the same-page native Attendance form and excludes unrelated browser POSTs', () => {
  const path = 'https://localhost:3443/attendance/my-records/2026-11-21?employmentId=fixture-subject';
  const headers = { 'content-type': 'multipart/form-data; boundary=fixture' };
  const payload = Buffer.from('--fixture\r\nContent-Disposition: form-data; name="reason"\r\n\r\nPERF_ATTENDANCE_BROWSER\r\n--fixture--\r\n');
  const request = {
    method: () => 'POST',
    url: () => path,
    isNavigationRequest: () => true,
    resourceType: () => 'document',
    headers: () => headers,
    postDataBuffer: () => payload,
  };
  expect(isNativeAttendanceCorrectionPost(request, path)).toBe(true);
  for (const other of [
    { url: () => path + '&tab=other' },
    { isNavigationRequest: () => false },
    { resourceType: () => 'fetch' },
    { headers: () => ({ ...headers, 'next-action': 'hydrated' }) },
    { postDataBuffer: () => Buffer.from(payload.toString().replace('PERF_ATTENDANCE_BROWSER', 'PERF_ATTENDANCE_BROWSER_APPROVAL')) },
  ]) {
    expect(isNativeAttendanceCorrectionPost({ ...request, ...other }, path)).toBe(false);
  }
});

it('separates typed clocking admission and refusal from the HTTP status', () => {
  const response = (result: object) => '0:{"a":"$1"}\n1:' + JSON.stringify(result);
  expect(clockingImportOutcome(response({ ok: true, preview: { total: 100 } }), 'validate')).toBe('accepted');
  expect(clockingImportOutcome(response({ ok: true, job: { state: 'queued' } }), 'commit')).toBe('accepted');
  expect(clockingImportOutcome(response({ ok: false, error: 'alreadyRunning' }), 'commit')).toBe('alreadyRunning');
  expect(clockingImportOutcome(response({ ok: false, error: 'mappingInactive' }), 'validate')).toBe('refused');
  expect(() => clockingImportOutcome(response({ ok: true, preview: {} }), 'commit')).toThrow(/typed outcome/);
  expect(() => clockingImportOutcome(response({ ok: true, job: {} }) + '\n2:{"ok":false,"error":"unavailable"}', 'commit')).toThrow(/typed outcome/);
});
