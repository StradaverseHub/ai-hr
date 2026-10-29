/**
 * POST /api/mobile/v2/attendance/applications/{id}/withdraw?employmentId {requestId} — M12 (D13). Withdraw the
 * caller's own PENDING application through cancelOwnAttendanceCorrection, inside the mobile command receipt
 * (core/mobile-command-receipt.ts): the same requestId replays the first accepted answer; a different command under
 * it is `request_conflict`. An overtime plan is withdrawn on the web (`not_withdrawable`).
 */
import { withdrawOwnAttendanceApplicationV2 } from '@/core/mobile-attendance';
import { attendanceApplicationIdOf } from '@/lib/mobile-api/attendance-routes';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { AttendanceWithdrawCommand, AttendanceWithdrawResult } from '@/lib/mobile-api/v2/attendance';

export const POST = mobileRoute(AttendanceWithdrawResult, async (s, req) => {
  const id = attendanceApplicationIdOf(req);
  const command = AttendanceWithdrawCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  return withdrawOwnAttendanceApplicationV2(s, employmentId, id, command.data.requestId);
});
