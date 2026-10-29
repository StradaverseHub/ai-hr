/**
 * POST /api/mobile/v2/attendance/overtime-plans?employmentId {requestId, date, plannedStart, plannedEnd, reason, remark?} —
 * the self overtime plan (the web's Apply OT Plan, myRequestOvertime) for one of the caller's own dates, through
 * requestAttendanceCorrection inside the mobile command receipt. The minutes come from the planned window on the
 * server; the kernel validates, files it as `self_overtime` and routes it. No attachment on mobile.
 */
import { requestOwnOvertimePlanV2 } from '@/core/mobile-attendance';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { OvertimePlanCommand, OvertimePlanResult } from '@/lib/mobile-api/v2/attendance';

export const POST = mobileRoute(OvertimePlanResult, async (s, req) => {
  const command = OvertimePlanCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  return requestOwnOvertimePlanV2(s, employmentId, command.data);
});
