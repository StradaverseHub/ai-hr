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
  const measure = process.env.AIHR_SHELL_OPEN_PROFILE === 'true';
  const started = measure ? performance.now() : 0;
  const timings: Partial<Record<'onboardingNotices' | 'projection' | 'bellRead' | 'lifecycle', number>> = {};
  const profile = async <T,>(phase: keyof typeof timings, work: () => T | Promise<T>): Promise<T> => {
    if (!measure) return work();
    const phaseStart = performance.now();
    try { return await work(); }
    finally { timings[phase] = Math.round(performance.now() - phaseStart); }
  };
  const [notices, bell, lifecycle] = await Promise.all([
    profile('onboardingNotices', () => lifecycleEnabled ? onboardingNoticeSummary(session) : { unread: [], read: [], unreadCount: 0 }),
    (async () => {
      if (catchUp) await profile('projection', () => dispatchNotifications(session, { skipIfBusy: true }).catch(() => {}));
      return profile('bellRead', () => scope ? notificationBellSummary(session, scope)
        : { unread: 0, taskCount: 0, items: [], tasks: [], read: [] });
    })(),
    profile('lifecycle', () => lifecycleWork.catch(() => null)),
  ]);
  if (measure) {
    console.info('PERF_NOTIFICATION_SHELL ' + JSON.stringify({
      catchUp, elapsedMs: Math.round(performance.now() - started), timings,
    }));
  }
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
