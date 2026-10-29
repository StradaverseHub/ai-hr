/**
 * M12 (D13) — replacement leave (Leave Credit), the web's My Leave request through the same owners.
 *
 * GET  /api/mobile/v2/attendance/replacement-leave?employmentId — may the caller ask (replacementRequestAvailability,
 *      with its reason when not), the tenant's Replacement Leave type, the company's tier ladder and whether an
 *      ordinary working day may earn a credit.
 * POST /api/mobile/v2/attendance/replacement-leave?employmentId {requestId, rows[], reason, firstScheduleConsent} —
 *      submitLeaveCreditRequest inside the mobile command receipt. Grants nothing: a manager's approval mints the credit.
 */
import { replacementLeaveOfferV2, submitReplacementLeaveV2 } from '@/core/mobile-attendance';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment, mobileLocale } from '@/lib/mobile-api/request';
import { ReplacementLeaveCommand, ReplacementLeaveOfferV2, ReplacementLeaveResult } from '@/lib/mobile-api/v2/attendance';

export const GET = mobileRoute(ReplacementLeaveOfferV2, async (s, req) => replacementLeaveOfferV2(s, await mobileEmployment(s, req), mobileLocale(req)));

export const POST = mobileRoute(ReplacementLeaveResult, async (s, req) => {
  const command = ReplacementLeaveCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  return submitReplacementLeaveV2(s, employmentId, command.data, mobileLocale(req));
});
