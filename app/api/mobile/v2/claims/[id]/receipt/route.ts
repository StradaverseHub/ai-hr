/**
 * GET /api/mobile/v2/claims/{id}/receipt?employmentId&attachment — M11. One receipt of the caller's own claim
 * (getClaimAttachment, after the own-claim check), as a protected binary (mobileBinaryRoute: private, no-store,
 * attachment, 10 MB bound, signature checked). PDF, JPEG or PNG — the claim receipt types — for this route only.
 */
import { ownClaimReceipt } from '@/core/mobile-claims';
import { MOBILE_ATTACHMENT_TYPES, mobileBinaryRoute } from '@/lib/mobile-api/handler';
import { attachmentOf, claimEmployment, claimIdOf } from '@/lib/mobile-api/claim-routes';
import { ClaimReceiptRefusal } from '@/lib/mobile-api/v2/claims';

export const GET = mobileBinaryRoute(ClaimReceiptRefusal, async (s, req) => ownClaimReceipt(s, await claimEmployment(s, req), claimIdOf(req), attachmentOf(req)), { types: MOBILE_ATTACHMENT_TYPES });
