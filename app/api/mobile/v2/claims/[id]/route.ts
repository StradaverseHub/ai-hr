/**
 * GET /api/mobile/v2/claims/{id}?employmentId — M11. One of the caller's own claims on their selected employment:
 * lines, custom answers, receipts, filing and decision, the rejection reason, the payout route and status, and the
 * actions the kernel's status rules allow. Not the caller's own (or guessed): `not_found`.
 */
import { ownClaimDetail } from '@/core/mobile-claims';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { claimEmployment, claimIdOf } from '@/lib/mobile-api/claim-routes';
import { ClaimDetailResult } from '@/lib/mobile-api/v2/claims';

export const GET = mobileRoute(ClaimDetailResult, async (s, req) => ownClaimDetail(s, await claimEmployment(s, req), claimIdOf(req)));
