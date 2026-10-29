/**
 * GET /api/mobile/v2/push/status?installationId — M10 (D6). Whether the caller has an active push binding for this
 * installation (another login's binding reads as not registered), and whether this server can deliver to each platform.
 */
import { pushStatusV2 } from '@/core/mobile-push';
import { oneParam } from '@/lib/mobile-api/attendance-routes';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { PushStatusV2 } from '@/lib/mobile-api/v2/push';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = mobileRoute(PushStatusV2, async (s, req) => {
  const installationId = oneParam(new URL(req.url), 'installationId');
  if (!installationId || !UUID.test(installationId)) throw new MobileBadRequest('Invalid installation');
  return pushStatusV2(s, installationId);
});
