/**
 * POST /api/mobile/v2/claims/drafts?employmentId — M11 (D11). Multipart {command: ClaimDraftCommand, receipt?}: save a
 * new draft, or the caller's own draft named by draftId, through saveClaimDraft inside the mobile command receipt. A
 * draft is the server's own `draft` row, the one the web lists; it reserves nothing and is checked against no limit.
 */
import { saveOwnClaimDraftV2 } from '@/core/mobile-claims';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { claimEmployment, claimUpload } from '@/lib/mobile-api/claim-routes';
import { ClaimDraftCommand, ClaimDraftResult } from '@/lib/mobile-api/v2/claims';

export const POST = mobileRoute(ClaimDraftResult, async (s, req) => {
  const employmentId = await claimEmployment(s, req);
  const { command, upload } = await claimUpload(req, ClaimDraftCommand);
  return saveOwnClaimDraftV2(s, employmentId, command, upload);
});
