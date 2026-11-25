import type { SessionContext } from '@/db/client';
import { NotificationCenter, type NotificationTaskItem } from '@/components/notification-center';
import { notificationBellSummary } from '@/core/notifications';
import { onboardingNoticeSummary } from '@/packs/lifecycle/service';
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
  const [notices, bell, lifecycle] = await Promise.all([
    lifecycleEnabled ? onboardingNoticeSummary(session) : { unread: [], read: [], unreadCount: 0 },
    scope ? notificationBellSummary(session, scope)
      : { unread: 0, taskCount: 0, items: [], tasks: [], read: [] },
    lifecycleInbox,
  ]);
  return <NotificationCenter
    unread={bell.unread + notices.unreadCount}
    items={[...bell.items, ...notices.unread]}
    tasks={[...onboardingTasks, ...lifecycle.items]}
    taskQueueLinks={lifecycle.queueLinks}
    taskNotifications={bell.tasks}
    claimPreviewRevision={claimPreviewRevision}
    taskCount={onboardingTasks.length + lifecycle.count + bell.taskCount}
    readItems={[...bell.read, ...notices.read]}
    canApprove={canApprove}
  />;
}
