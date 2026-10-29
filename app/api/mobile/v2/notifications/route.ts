/**
 * GET /api/mobile/v2/notifications?cursor&limit&unread=true — M10. The caller's own notifications, newest first, keyset-
 * paged in the kernel's order (created_at desc, id desc — D5), with the unread total. Each item carries a typed
 * destination from the server allowlist, never its stored link (core/mobile-notifications.ts says why).
 */
import { notificationsPageV2 } from '@/core/mobile-notifications';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { pageRequest } from '@/lib/mobile-api/v2/common';
import { NOTIFICATIONS_CURSOR, NotificationsCursor, NotificationsPageV2 } from '@/lib/mobile-api/v2/notifications';

export const GET = mobileRoute(NotificationsPageV2, async (s, req) => {
  const url = new URL(req.url);
  const unread = url.searchParams.getAll('unread');
  if (unread.length > 1 || (unread.length === 1 && unread[0] !== 'true')) throw new MobileBadRequest('Invalid unread filter');
  return notificationsPageV2(s, { ...pageRequest(url, NOTIFICATIONS_CURSOR, NotificationsCursor), unread: unread.length === 1 });
});
