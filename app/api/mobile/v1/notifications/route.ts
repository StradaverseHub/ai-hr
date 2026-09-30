/**
 * GET /api/mobile/v1/notifications — the caller's in-app notifications, newest first (ADR-0088 §2–§3).
 * Read-only. The same read the web bell makes (app/layout.tsx), with no employment filter: the
 * `notification_recipient_rls` policy (0078) admits only rows whose recipient employment is the caller's
 * own person, for administrators as much as anyone, so this cannot list someone else's.
 *
 * This is where a push notification's content is fetched from: the push payload itself carries only a
 * notification id (ADR-0088 §3).
 */
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { listNotifications, unreadNotificationCount } from '@/core/notifications';
import { NotificationsResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';

export const GET = mobileRoute(NotificationsResponse, async (s) => {
  const enabled = isModuleEnabledOrFalse(s, 'notifications');
  if (!enabled) return { enabled, unread: 0, items: [] };
  const [items, unread] = await Promise.all([listNotifications(s, undefined, { limit: 50 }), unreadNotificationCount(s)]);
  return {
    enabled,
    unread,
    items: items.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      linkPath: n.linkPath,
      severity: n.severity,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      createdAt: n.createdAt.toISOString(),
    })),
  };
});
