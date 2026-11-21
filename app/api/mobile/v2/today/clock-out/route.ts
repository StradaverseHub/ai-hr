/**
 * POST /api/mobile/v2/today/clock-out {caseId, reason, other?, confirm: true} — Confirm on a missed clock-out reminder.
 * The clock-out owner (core/loops/clock-out-confirm.ts) re-reads the case as the caller and sends the attendance
 * correction for the usual approval; the date and proposed clock-out are never posted. Anything but an explicit
 * `confirm: true` is refused by the contract (400) before the owner runs. A repeated Confirm sends nothing more: the
 * attendance service holds one waiting correction per day.
 */
import { confirmOwnClockOutV2 } from '@/core/mobile-today';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileLocale } from '@/lib/mobile-api/request';
import { ClockOutConfirmCommandV2, ClockOutConfirmResultV2 } from '@/lib/mobile-api/v2/today';

export const POST = mobileRoute(ClockOutConfirmResultV2, async (s, req) => {
  const command = ClockOutConfirmCommandV2.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  return confirmOwnClockOutV2(s, command.data, mobileLocale(req));
});
