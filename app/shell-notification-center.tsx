import type { SessionContext } from '@/db/client';
import { NotificationCenter, type NotificationTaskItem,type NotificationTaskQueueLink } from '@/components/notification-center';
import { readNotificationBellView, type NotificationBellScope } from './notification-bell-view';

export async function ShellNotificationCenter({ session, scope, catchUp, lifecycleEnabled, lifecycleWork, claimPreviewRevision, canApprove }: {
  session: SessionContext;
  scope: NotificationBellScope;
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
  const [bell, lifecycle] = await Promise.all([
    readNotificationBellView(session, scope, lifecycleEnabled, catchUp),
    lifecycleWork.catch(() => null),
  ]);
  return <NotificationCenter
    {...bell}
    tasks={lifecycle?.tasks ?? []}
    taskQueueLinks={lifecycle?.taskQueueLinks}
    claimPreviewRevision={claimPreviewRevision}
    taskCount={(lifecycle?.taskCount ?? 0) + bell.notificationTaskCount}
    canApprove={canApprove}
  />;
}
