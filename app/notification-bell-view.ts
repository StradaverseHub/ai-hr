import type { SessionContext } from '@/db/client';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { dispatchNotifications, notificationBellSummary } from '@/core/notifications';
import { onboardingNoticeSummary } from '@/packs/lifecycle/service';

export type NotificationBellScope = { letterCompanyIds?: string[] } | null;

export function notificationBellScope(session: SessionContext, scopeIds: readonly string[]): NotificationBellScope {
  if (isModuleEnabledOrFalse(session, 'notifications')) return {};
  const letterCompanyIds = scopeIds.filter(id => isModuleEnabledOrFalse(session, 'notifications', id));
  return letterCompanyIds.length ? { letterCompanyIds } : null;
}

/** Same recipient and company scope for the shell and for the result of a bell write. */
export async function readNotificationBellView(
  session: SessionContext,
  scope: NotificationBellScope,
  lifecycleEnabled: boolean,
  catchUp = false,
) {
  const [onboarding, notifications] = await Promise.all([
    lifecycleEnabled ? onboardingNoticeSummary(session) : { unread: [], read: [], unreadCount: 0 },
    (async () => {
      if (catchUp) await dispatchNotifications(session, { skipIfBusy: true }).catch(() => {});
      return scope ? notificationBellSummary(session, scope)
        : { unread: 0, taskCount: 0, items: [], tasks: [], read: [] };
    })(),
  ]);
  return {
    unread: notifications.unread + onboarding.unreadCount,
    items: [...notifications.items, ...onboarding.unread],
    taskNotifications: notifications.tasks,
    notificationTaskCount: notifications.taskCount,
    readItems: [...notifications.read, ...onboarding.read],
  };
}

export type NotificationBellView = Awaited<ReturnType<typeof readNotificationBellView>>;
