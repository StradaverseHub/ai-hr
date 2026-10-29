/**
 * GET /api/mobile/v2/attendance/replacement-leave/day?employmentId&date&start&end — M12 (D13). One worked date's facts
 * for a Leave Credit request (extendedHoursDayForEmployment: the roster's day type, the shift, the clock-in/out on
 * record, approved overtime) and, with a claimed window, the kernel's own review of it (leaveCreditClaimReview).
 */
import { replacementLeaveDayV2 } from '@/core/mobile-attendance';
import { attendanceDateOf, claimWindowOf } from '@/lib/mobile-api/attendance-routes';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { ReplacementLeaveDayResult } from '@/lib/mobile-api/v2/attendance';

export const GET = mobileRoute(ReplacementLeaveDayResult, async (s, req) => {
  const url = new URL(req.url);
  const date = attendanceDateOf(url), window = claimWindowOf(url);
  return replacementLeaveDayV2(s, await mobileEmployment(s, req), { date, ...window });
});
