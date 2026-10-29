/**
 * GET /api/mobile/v2/attendance/applications/{id}?employmentId — M12 (D13). One of the caller's own applications ON
 * THE SELECTED OWN EMPLOYMENT: what was asked, the clock pair on record when it was filed, the routing recorded with
 * it level by level, the decision and its reason, and whether it may still be withdrawn. Any other row — including a
 * subordinate's, which RLS would show a manager — is `refused: not_found`.
 */
import { ownAttendanceApplication } from '@/core/mobile-attendance';
import { attendanceApplicationIdOf } from '@/lib/mobile-api/attendance-routes';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { AttendanceApplicationResult } from '@/lib/mobile-api/v2/attendance';

export const GET = mobileRoute(AttendanceApplicationResult, async (s, req) => {
  const id = attendanceApplicationIdOf(req);
  return ownAttendanceApplication(s, await mobileEmployment(s, req), id);
});
