/**
 * POST /api/mobile/v2/documents/share-events {requestId, shareId, document, stage} — M09 (D7). One audited stage of
 * an explicit share of the caller's own payslip or EA PDF through the OS share sheet: `confirmed` (acknowledged
 * BEFORE the share sheet opens), then `completed` or `cancelled`. Recorded inside the mobile command receipt, owned by
 * the actor, with identifiers only — never a figure. core/mobile-pay.ts composes.
 */
import { recordShareEventV2 } from '@/core/mobile-pay';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { ShareEventCommand, ShareEventResult } from '@/lib/mobile-api/v2/pay';

export const POST = mobileRoute(ShareEventResult, async (s, req) => {
  const command = ShareEventCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  return recordShareEventV2(s, command.data);
});
