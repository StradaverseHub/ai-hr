/**
 * POST /api/mobile/v2/attendance/corrections?employmentId {requestId, date, checkIn?, checkOut?, reason, remark?} —
 * M12 (D13). A missed-punch / correction request for one of the caller's own days through requestAttendanceCorrection
 * (the web day screen's service), inside the mobile command receipt. The kernel validates the times, the reason, the
 * date and the pending fence, snapshots the workflow and the clock pair on record; a raw punch is never edited.
 */
import { requestOwnAttendanceCorrectionV2 } from '@/core/mobile-attendance';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { AttendanceCorrectionCommand, AttendanceCorrectionResult } from '@/lib/mobile-api/v2/attendance';

export const POST = mobileRoute(AttendanceCorrectionResult, async (s, req) => {
  const command = AttendanceCorrectionCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  return requestOwnAttendanceCorrectionV2(s, employmentId, command.data);
});
