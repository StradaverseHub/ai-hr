/**
 * POST /api/mobile/v2/leave/requests/{id}/withdraw?employmentId {requestId} — M07. Withdraw the caller's own
 * PENDING request through cancelOwnLeave, inside the mobile command receipt (core/mobile-command-receipt.ts): the
 * same requestId replays the first accepted answer; a different command under it is `request_conflict`.
 */
import { withdrawOwnLeaveV2 } from '@/core/mobile-leave-history';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { leaveRequestIdOf } from '@/lib/mobile-api/leave-routes';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { LeaveWithdrawCommand, LeaveWithdrawResult } from '@/lib/mobile-api/v2/leave';

export const POST = mobileRoute(LeaveWithdrawResult, async (s, req) => {
  const id = leaveRequestIdOf(req);
  const command = LeaveWithdrawCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  return withdrawOwnLeaveV2(s, employmentId, id, command.data.requestId);
});
