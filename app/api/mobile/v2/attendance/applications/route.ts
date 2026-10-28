/**
 * GET /api/mobile/v2/attendance/applications?employmentId&status&cursor&limit — M12 (D13). The caller's own
 * attendance applications (the web's My Request list, myAttendanceCorrections) on one of their own employments, in
 * the kernel's order (attendance date, then filed, newest first), keyset-paged, with per-status counts.
 */
import { ownAttendanceApplicationsPage } from '@/core/mobile-attendance';
import { oneParam } from '@/lib/mobile-api/attendance-routes';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { pageRequest } from '@/lib/mobile-api/v2/common';
import { ATTENDANCE_APPLICATIONS_CURSOR, AttendanceApplicationsCursor, AttendanceApplicationsPageV2, AttendanceApplicationStatus } from '@/lib/mobile-api/v2/attendance';

export const GET = mobileRoute(AttendanceApplicationsPageV2, async (s, req) => {
  const url = new URL(req.url);
  const raw = oneParam(url, 'status');
  const status = raw === undefined ? undefined : AttendanceApplicationStatus.safeParse(raw);
  if (status && !status.success) throw new MobileBadRequest('Invalid status');
  const { limit, cursor } = pageRequest(url, ATTENDANCE_APPLICATIONS_CURSOR, AttendanceApplicationsCursor);
  return ownAttendanceApplicationsPage(s, await mobileEmployment(s, req), { status: status?.data, limit, cursor });
});
