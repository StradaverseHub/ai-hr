/**
 * GET /api/mobile/v2/attendance/overtime-plans/offer?employmentId — whether the web's Apply OT Plan page would offer
 * its form to the caller (the Attendance module, an own employment), with the kernel's business day and zone.
 */
import { overtimePlanOfferV2 } from '@/core/mobile-attendance';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { OvertimePlanOfferV2 } from '@/lib/mobile-api/v2/attendance';

export const GET = mobileRoute(OvertimePlanOfferV2, async (s, req) => overtimePlanOfferV2(s, await mobileEmployment(s, req)));
