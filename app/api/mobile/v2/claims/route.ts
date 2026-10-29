/**
 * GET  /api/mobile/v2/claims?employmentId&status&cursor&limit — M11. The caller's own claims on their selected
 *      claim-eligible employment (listClaimsForEmployment), newest first, keyset-paged, with per-status counts.
 * POST /api/mobile/v2/claims?employmentId — multipart {command: ClaimSubmitCommand, receipt?}. Files a claim through
 *      submitClaimWithAttachment (or, with draftId, saves and files the caller's own draft) inside the mobile command
 *      receipt; the receipt is sniffed by its bytes. core/mobile-claims.ts composes.
 */
import { ownClaimsPage, submitOwnClaimV2 } from '@/core/mobile-claims';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { claimEmployment, claimUpload } from '@/lib/mobile-api/claim-routes';
import { pageRequest } from '@/lib/mobile-api/v2/common';
import { CLAIMS_CURSOR, ClaimsCursor, ClaimsPageV2, ClaimStatusV2, ClaimSubmitCommand, ClaimSubmitResult } from '@/lib/mobile-api/v2/claims';

export const GET = mobileRoute(ClaimsPageV2, async (s, req) => {
  const url = new URL(req.url);
  if (url.searchParams.getAll('status').length > 1) throw new MobileBadRequest('Repeated status');
  const raw = url.searchParams.get('status');
  const status = raw === null ? undefined : ClaimStatusV2.safeParse(raw).data;
  if (raw !== null && !status) throw new MobileBadRequest('Unknown status');
  const page = pageRequest(url, CLAIMS_CURSOR, ClaimsCursor);
  return ownClaimsPage(s, await claimEmployment(s, req), { status, ...page });
});

export const POST = mobileRoute(ClaimSubmitResult, async (s, req) => {
  const employmentId = await claimEmployment(s, req);
  const { command, upload } = await claimUpload(req, ClaimSubmitCommand);
  return submitOwnClaimV2(s, employmentId, command, upload);
});
