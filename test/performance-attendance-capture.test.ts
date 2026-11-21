import { expect, it } from 'vitest';
import { isNativeAttendanceCorrectionPost } from '../scripts/performance/mixed-workflows.mjs';

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
