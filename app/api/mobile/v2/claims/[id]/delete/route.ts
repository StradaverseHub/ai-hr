/**
 * POST /api/mobile/v2/claims/{id}/delete?employmentId {requestId} — M11. Deletes the caller's own DRAFT through
 * deleteClaimDraft inside the mobile command receipt (a lost answer replays `deleted`).
 */
import { deleteOwnClaimDraftV2 } from '@/core/mobile-claims';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { claimEmployment, claimIdOf } from '@/lib/mobile-api/claim-routes';
import { ClaimDeleteCommand, ClaimDeleteResult } from '@/lib/mobile-api/v2/claims';

export const POST = mobileRoute(ClaimDeleteResult, async (s, req) => {
  const id = claimIdOf(req);
  const command = ClaimDeleteCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  return deleteOwnClaimDraftV2(s, await claimEmployment(s, req), id, command.data.requestId);
});
