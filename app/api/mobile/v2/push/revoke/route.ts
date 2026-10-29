/**
 * POST /api/mobile/v2/push/revoke?employmentId {requestId, installationId, reason} — M10 (D6). Closes the caller's own
 * active push binding for this installation (logout, turned off, company switch, permission denied) inside the mobile
 * command receipt. Nothing active answers `revoked: false`. Works with the Notifications module off.
 */
import { revokePushV2 } from '@/core/mobile-push';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { PushRevokeCommand, PushRevokeResult } from '@/lib/mobile-api/v2/push';

export const POST = mobileRoute(PushRevokeResult, async (s, req) => {
  const command = PushRevokeCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  return revokePushV2(s, employmentId, command.data);
});
