/**
 * GET /api/mobile/v2/today?employmentId — the native Today (owner decisions, 12 Nov 2026): the person's AI reminders
 * (the employee loop cards), next steps, this week's hours, payday as a date and what is coming up, for their OWN
 * employment, each section read on its own (core/mobile-today.ts). An employment that is not the caller's own and
 * current never reaches a section read: 400, as mobileEmployment refuses a foreign one.
 */
import { mobileRoute } from '@/lib/mobile-api/handler';
import { ownToday } from '@/lib/mobile-api/today-routes';
import { TodayV2 } from '@/lib/mobile-api/v2/today';

export const GET = mobileRoute(TodayV2, async (s, req) => ownToday(s, req));
