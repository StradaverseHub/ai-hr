import type { SessionContext } from '@/db/client';
import { NotificationCenter, type NotificationTaskItem,type NotificationTaskQueueLink } from '@/components/notification-center';
import { dispatchNotifications, notificationBellSummary } from '@/core/notifications';
import { onboardingNoticeSummary } from '@/packs/lifecycle/service';

export async function ShellNotificationCenter({ session, scope, catchUp, lifecycleEnabled, lifecycleWork, claimPreviewRevision, canApprove }: {
  session: SessionContext;
  scope: { letterCompanyIds?: string[] } | null;
  catchUp: boolean;
  lifecycleEnabled: boolean;
  lifecycleWork: Promise<{
    tasks: NotificationTaskItem[];
    taskCount: number;
    taskQueueLinks: NotificationTaskQueueLink[];
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
    lifecycleWork.catch(() => null),
  ]);
  return <NotificationCenter
    unread={bell.unread + notices.unreadCount}
    items={[...bell.items, ...notices.unread]}
    tasks={lifecycle?.tasks ?? []}
    taskQueueLinks={lifecycle?.taskQueueLinks}
    taskNotifications={bell.tasks}
    claimPreviewRevision={claimPreviewRevision}
    taskCount={(lifecycle?.taskCount ?? 0) + bell.taskCount}
    readItems={[...bell.read, ...notices.read]}
    canApprove={canApprove}
  />;
}
