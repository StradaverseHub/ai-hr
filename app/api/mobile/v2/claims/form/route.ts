/**
 * GET /api/mobile/v2/claims/form?employmentId — M11. What the claim form offers the caller's own employment, as the
 * web's form is given it (getEmployeeClaimTypes): types, items, custom fields, the receipt rule and window, what the
 * amount is asked as, and the balances for the caller's grade today. core/mobile-claims.ts composes.
 */
import { ownClaimFormOptions } from '@/core/mobile-claims';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { claimEmployment } from '@/lib/mobile-api/claim-routes';
import { ClaimFormOptionsV2 } from '@/lib/mobile-api/v2/claims';

export const GET = mobileRoute(ClaimFormOptionsV2, async (s, req) => ownClaimFormOptions(s, await claimEmployment(s, req)));
