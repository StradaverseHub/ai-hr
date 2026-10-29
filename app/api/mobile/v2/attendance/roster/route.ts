/**
 * GET /api/mobile/v2/attendance/roster?employmentId&from&to — M12 (D13). The caller's own roster (My Roster's read,
 * core/roster.ts myRosterWindow) over a window of at most 31 days (default: this calendar month): rostered or usual
 * shift with its times (an overnight shift marked as crossing midnight), rest day, off, plus the window's totals.
 */
import { ownAttendanceRoster } from '@/core/mobile-attendance';
import { attendanceWindowOf } from '@/lib/mobile-api/attendance-routes';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { AttendanceRosterV2 } from '@/lib/mobile-api/v2/attendance';
import { todayInKualaLumpur } from '@/lib/hr-date';

export const GET = mobileRoute(AttendanceRosterV2, async (s, req) => {
  const window = attendanceWindowOf(new URL(req.url), todayInKualaLumpur());
  return ownAttendanceRoster(s, await mobileEmployment(s, req), window);
});
