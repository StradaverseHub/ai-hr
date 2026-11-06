import type { SessionContext } from '@/db/client';
import { NotificationCenter, type NotificationTaskItem } from '@/components/notification-center';
import { dispatchNotifications, notificationBellSummary } from '@/core/notifications';
import { onboardingNoticeSummary } from '@/packs/lifecycle/service';

export async function ShellNotificationCenter({ session, scope, catchUp, lifecycleEnabled, tasks, taskCount, claimPreviewRevision, canApprove }: {
  session: SessionContext;
  scope: { letterCompanyIds?: string[] } | null;
  catchUp: boolean;
  lifecycleEnabled: boolean;
  tasks: NotificationTaskItem[];
  taskCount: number;
  claimPreviewRevision?: string;
  canApprove: boolean;
}) {
  const [notices, bell] = await Promise.all([
    lifecycleEnabled ? onboardingNoticeSummary(session) : { unread: [], read: [], unreadCount: 0 },
    (async () => {
      if (catchUp) await dispatchNotifications(session, { skipIfBusy: true }).catch(() => {});
      return scope ? notificationBellSummary(session, scope)
        : { unread: 0, taskCount: 0, items: [], tasks: [], read: [] };
    })(),
  ]);
  return <NotificationCenter
    unread={bell.unread + notices.unreadCount}
    items={[...bell.items, ...notices.unread]}
    tasks={tasks}
    taskNotifications={bell.tasks}
    claimPreviewRevision={claimPreviewRevision}
    taskCount={taskCount + bell.taskCount}
    readItems={[...bell.read, ...notices.read]}
    canApprove={canApprove}
  />;
}
