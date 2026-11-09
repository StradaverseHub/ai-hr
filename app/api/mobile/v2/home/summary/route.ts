/**
 * GET /api/mobile/v2/home/summary — M14. Home's "what needs me": the v2 task list's count and the unread notification
 * count, and open employee loop findings. Each part is read independently.
 */
import { homeSummaryV2 } from '@/core/mobile-notifications';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { HomeSummaryV2 } from '@/lib/mobile-api/v2/notifications';

export const GET = mobileRoute(HomeSummaryV2, async (s) => homeSummaryV2(s));
