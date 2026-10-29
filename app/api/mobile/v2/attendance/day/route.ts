/**
 * GET /api/mobile/v2/attendance/day?employmentId&date — M12 (D13). One of the caller's own days, their own
 * applications for that date, and whether the web's day screen would offer its correction form. A day of an
 * employment that is not the caller's selected own one never reaches a read (mobileEmployment refuses it, 400).
 */
import { ownAttendanceDay } from '@/core/mobile-attendance';
import { attendanceDateOf } from '@/lib/mobile-api/attendance-routes';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { AttendanceDayResult } from '@/lib/mobile-api/v2/attendance';

export const GET = mobileRoute(AttendanceDayResult, async (s, req) => {
  const date = attendanceDateOf(new URL(req.url));
  return ownAttendanceDay(s, await mobileEmployment(s, req), date);
});
