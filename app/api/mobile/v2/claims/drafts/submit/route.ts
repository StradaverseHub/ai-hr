/**
 * POST /api/mobile/v2/claims/drafts/submit?employmentId {requestId, ids} — M11. Files the caller's own drafts through
 * submitDraftClaims (all or none, against one limit) inside the mobile command receipt.
 */
import { submitOwnClaimDraftsV2 } from '@/core/mobile-claims';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { claimEmployment } from '@/lib/mobile-api/claim-routes';
import { ClaimDraftsSubmitCommand, ClaimDraftsSubmitResult } from '@/lib/mobile-api/v2/claims';

export const POST = mobileRoute(ClaimDraftsSubmitResult, async (s, req) => {
  const command = ClaimDraftsSubmitCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  return submitOwnClaimDraftsV2(s, await claimEmployment(s, req), command.data);
});
