/**
 * GET /api/mobile/v2/profile?employmentId — M13 (D14). The simple personal and contact fields of the caller's OWN
 * employment that the employer's policy shows: current value, editability and read-only reason, whether a change
 * applies at once or waits for approval, the choices, the stale-value baseline, and web paths for what the app does
 * not edit. Not own, guessed or another person's: `not_found`.
 */
import { ownProfileWorkspaceV2 } from '@/core/mobile-profile';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { profileEmployment, profileLabels } from '@/lib/mobile-api/profile-routes';
import { ProfileWorkspaceResult } from '@/lib/mobile-api/v2/profile';

export const GET = mobileRoute(ProfileWorkspaceResult, async (s, req) => {
  const employmentId = await profileEmployment(s, req);
  if (!employmentId) return { outcome: 'refused' as const, code: 'not_found' as const };
  return ownProfileWorkspaceV2(s, employmentId, await profileLabels(req));
});
