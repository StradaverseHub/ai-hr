/**
 * POST /api/mobile/v2/profile/changes?employmentId {requestId, changes[{fieldId, before, value}]} — M13 (D14).
 * Submit ONLY changed simple fields through submitOwnProfileEdit, inside the mobile command receipt
 * (core/mobile-command-receipt.ts): the same requestId replays the first answer; a different command under it is
 * `request_conflict`. A field outside the simple set is `not_simple`; a value changed since the form loaded is `stale`.
 */
import { submitOwnProfileChangeV2 } from '@/core/mobile-profile';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { profileEmployment } from '@/lib/mobile-api/profile-routes';
import { ProfileChangeCommand, ProfileChangeResult } from '@/lib/mobile-api/v2/profile';

export const POST = mobileRoute(ProfileChangeResult, async (s, req) => {
  const command = ProfileChangeCommand.safeParse(await mobileInput(req, 65536));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await profileEmployment(s, req);
  if (!employmentId) return { outcome: 'refused' as const, code: 'not_found' as const };
  return submitOwnProfileChangeV2(s, employmentId, command.data);
});
