import type { SessionContext } from '@/db/client';
import { NotificationCenter, type NotificationTaskItem,type NotificationTaskQueueLink } from '@/components/notification-center';
import { dispatchNotifications, notificationBellSummary } from '@/core/notifications';
import { onboardingNoticeSummary } from '@/packs/lifecycle/service';

export async function ShellNotificationCenter({ session, scope, catchUp, lifecycleEnabled, lifecyclePreview, claimPreviewRevision, canApprove }: {
  session: SessionContext;
  scope: { letterCompanyIds?: string[] } | null;
  catchUp: boolean;
  lifecycleEnabled: boolean;
  lifecyclePreview: Promise<{
    items: NotificationTaskItem[];
    count: number;
    queueLinks: NotificationTaskQueueLink[];
  }>;
  claimPreviewRevision?: string;
  canApprove: boolean;
}) {
  const [notices, bell, lifecycle] = await Promise.all([
    lifecycleEnabled ? onboardingNoticeSummary(session) : { unread: [], read: [], unreadCount: 0 },
    (async () => {
      if (catchUp) await dispatchNotifications(session, { skipIfBusy: true }).catch(() => {});
      return scope ? notificationBellSummary(session, scope)
        : { unread: 0, taskCount: 0, items: [], tasks: [], read: [] };
    })(),
    lifecyclePreview,
  ]);
  return <NotificationCenter
    unread={bell.unread + notices.unreadCount}
    items={[...bell.items, ...notices.unread]}
    tasks={lifecycle.items}
    taskQueueLinks={lifecycle.queueLinks}
    taskNotifications={bell.tasks}
    claimPreviewRevision={claimPreviewRevision}
    taskCount={lifecycle.count + bell.taskCount}
    readItems={[...bell.read, ...notices.read]}
    canApprove={canApprove}
  />;
}
