/**
 * POST /api/mobile/v2/claims/{id}/cancel?employmentId {requestId} — M11. Cancels the caller's own PENDING claim
 * through cancelClaim inside the mobile command receipt; the reservation it held is released.
 */
import { cancelOwnClaimV2 } from '@/core/mobile-claims';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { claimEmployment, claimIdOf } from '@/lib/mobile-api/claim-routes';
import { ClaimCancelCommand, ClaimCancelResult } from '@/lib/mobile-api/v2/claims';

export const POST = mobileRoute(ClaimCancelResult, async (s, req) => {
  const id = claimIdOf(req);
  const command = ClaimCancelCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  return cancelOwnClaimV2(s, await claimEmployment(s, req), id, command.data.requestId);
});
