/**
 * GET /api/mobile/v2/profile/requests?employmentId — M13 (D14). The caller's own profile change requests, newest
 * first, with status, the reviewer's decision, what was asked and today's value — as the web's "My change requests"
 * shows them, through the same owner (myProfileChangeRequests). The employment must be the caller's own.
 */
import { ownProfileRequestsV2 } from '@/core/mobile-profile';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { profileEmployment, profileLabels } from '@/lib/mobile-api/profile-routes';
import { ProfileRequestsResult } from '@/lib/mobile-api/v2/profile';

export const GET = mobileRoute(ProfileRequestsResult, async (s, req) => {
  const employmentId = await profileEmployment(s, req);
  if (!employmentId) return { outcome: 'refused' as const, code: 'not_found' as const };
  return ownProfileRequestsV2(s, employmentId, await profileLabels(req));
});
