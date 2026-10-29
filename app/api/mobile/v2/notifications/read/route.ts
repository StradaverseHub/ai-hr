/**
 * POST /api/mobile/v2/notifications/read {ids: uuid[≤50]} | {all: true} — M10. Marks the caller's OWN notifications read
 * through markNotificationRead / markAllNotificationsRead (recipient-only RLS: another person's id changes nothing and
 * is not answered). Idempotent by nature, so no requestId and no receipt. Answers the fresh unread total and, for
 * `ids`, each still-owned id with its destination re-derived now.
 */
import { markNotificationsReadV2 } from '@/core/mobile-notifications';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { NotificationReadCommand, NotificationReadResult } from '@/lib/mobile-api/v2/notifications';

export const POST = mobileRoute(NotificationReadResult, async (s, req) => {
  const command = NotificationReadCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  return markNotificationsReadV2(s, command.data);
});
