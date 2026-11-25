import type { SessionContext } from '@/db/client';
import { NotificationCenter, type NotificationTaskItem } from '@/components/notification-center';
import { readBellNotifications } from './bell-notifications';
import type { LifecycleModuleInbox } from './lifecycle/module-inbox';

/** The shell's bell. It streams behind the layout's Suspense boundary and only reads: a page load never dispatches
 * notifications (ADR 0181 decision 3, package 1.3; the minute sweep, scripts/notification-email-sweep.ts, owns
 * projection). The lifecycle module inbox is started in the frame's read pass and awaited here, so nothing above the
 * boundary waits for it. */
export async function ShellNotificationCenter({ session, scope, lifecycleEnabled, onboardingTasks, lifecycleInbox, claimPreviewRevision, canApprove }: {
  session: SessionContext;
  scope: { letterCompanyIds?: string[] } | null;
  lifecycleEnabled: boolean;
  onboardingTasks: NotificationTaskItem[];
  lifecycleInbox: Promise<LifecycleModuleInbox>;
  claimPreviewRevision?: string;
  canApprove: boolean;
}) {
  const [bell, lifecycle] = await Promise.all([
    readBellNotifications(session, scope, lifecycleEnabled),
    lifecycleInbox,
  ]);
  return <NotificationCenter
    unread={bell.unread}
    items={bell.items}
    tasks={[...onboardingTasks, ...lifecycle.items]}
    taskQueueLinks={lifecycle.queueLinks}
    taskNotifications={bell.taskNotifications}
    notificationTaskCount={bell.notificationTaskCount}
    claimPreviewRevision={claimPreviewRevision}
    taskCount={onboardingTasks.length + lifecycle.count + bell.notificationTaskCount}
    readItems={bell.readItems}
    canApprove={canApprove}
  />;
}
