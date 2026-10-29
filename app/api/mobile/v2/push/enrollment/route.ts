/**
 * POST /api/mobile/v2/push/enrollment?employmentId {requestId, installationId, platform, token, permission, locale,
 * appVersion?, appBuild?} — M10 (D6). Binds this installation's push token to the caller's (tenant, user, installation)
 * inside the mobile command receipt (core/mobile-push.ts). The path ends in MOBILE_PUSH_ENROLLMENT_PATH, so the handler
 * meters it 10/hour per actor beside the per-minute write budget. The token is never answered back.
 */
import { enrollPushV2 } from '@/core/mobile-push';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { PushEnrollmentCommand, PushEnrollmentResult } from '@/lib/mobile-api/v2/push';

export const POST = mobileRoute(PushEnrollmentResult, async (s, req) => {
  const command = PushEnrollmentCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  return enrollPushV2(s, employmentId, command.data);
});
