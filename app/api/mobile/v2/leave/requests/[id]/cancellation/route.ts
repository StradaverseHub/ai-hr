/**
 * POST /api/mobile/v2/leave/requests/{id}/cancellation?employmentId {requestId, cancelDates[], reason?} — M07.
 * Ask to give back dates of the caller's own APPROVED request through requestLeaveCancellation (tenant-local today),
 * inside the mobile command receipt. `accepted` carries `approved` (the type approves automatically; the days are
 * back) or `pending`; a refusal carries the service's own code (lib/mobile-api/v2/leave.ts).
 */
import { cancelOwnLeaveDatesV2 } from '@/core/mobile-leave-history';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { leaveRequestIdOf } from '@/lib/mobile-api/leave-routes';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { LeaveCancellationCommand, LeaveCancellationResult } from '@/lib/mobile-api/v2/leave';

export const POST = mobileRoute(LeaveCancellationResult, async (s, req) => {
  const id = leaveRequestIdOf(req);
  const command = LeaveCancellationCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  return cancelOwnLeaveDatesV2(s, employmentId, id, command.data);
});
