/**
 * GET /api/mobile/v2/leave/requests/{id}?employmentId — M07. One of the caller's own requests ON THE SELECTED OWN
 * EMPLOYMENT, with its per-date outcome, approval levels, rejection, cancellation, pending give-back and the actions
 * offered (core/mobile-leave-history.ts). Any other row — including a subordinate's, which RLS would show a
 * manager — is `refused: not_found`.
 */
import { ownLeaveRequestDetail } from '@/core/mobile-leave-history';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { approverKindLabels, leaveRequestIdOf } from '@/lib/mobile-api/leave-routes';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { LeaveRequestDetailResult } from '@/lib/mobile-api/v2/leave';

export const GET = mobileRoute(LeaveRequestDetailResult, async (s, req) => {
  const id = leaveRequestIdOf(req);
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) return { outcome: 'refused' as const, code: 'not_found' as const };
  return ownLeaveRequestDetail(s, employmentId, id, await approverKindLabels(req));
});
