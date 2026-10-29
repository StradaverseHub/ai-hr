/**
 * GET /api/mobile/v2/attendance/records?employmentId&from&to — M12 (D13). The caller's own days on one of their own
 * employments over a window of at most 31 days (default: this calendar month), ascending, each with its schedule,
 * the punches in force as evidence, the engine's outcome and the unresolved exception kept apart
 * (core/mobile-attendance.ts). `enabled: false` when the Attendance module is off.
 */
import { ownAttendanceRecords } from '@/core/mobile-attendance';
import { attendanceWindowOf } from '@/lib/mobile-api/attendance-routes';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { AttendanceRecordsV2 } from '@/lib/mobile-api/v2/attendance';
import { todayInKualaLumpur } from '@/lib/hr-date';

export const GET = mobileRoute(AttendanceRecordsV2, async (s, req) => {
  const window = attendanceWindowOf(new URL(req.url), todayInKualaLumpur());
  return ownAttendanceRecords(s, await mobileEmployment(s, req), window);
});
