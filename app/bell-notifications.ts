import 'server-only';
import type { SessionContext } from '@/db/client';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { notificationBellSummary } from '@/core/notifications';
import { onboardingNoticeSummary } from '@/packs/lifecycle/service';
import type { BellNotifications } from '@/lib/bell-notifications';

/**
 * Which notifications the bell reads (ADR-0034 34-3): every notification while the module is on; otherwise only the
 * letter notifications of the companies in scope that have the module; `null` reads none. The shell and the bell's
 * mark-read actions use this one rule, so a refreshed bell lists exactly what a re-rendered shell would.
 */
export function bellNotificationScope(session: SessionContext, scopeIds: readonly string[]): { letterCompanyIds?: string[] } | null {
  if (isModuleEnabledOrFalse(session, 'notifications')) return {};
  const letterCompanyIds = scopeIds.filter(id => isModuleEnabledOrFalse(session, 'notifications', id));
  return letterCompanyIds.length > 0 ? { letterCompanyIds } : null;
}

/**
 * The bell's notification half: the viewer's notifications and the On/Off Boarding notices. Read by the shell
 * (app/shell-notification-center.tsx) and, after a mark-read, by the action itself, which returns it to the bell
 * instead of redrawing the whole app frame (ADR 0181 decision 4).
 */
export async function readBellNotifications(
  session: SessionContext,
  scope: { letterCompanyIds?: string[] } | null,
  lifecycleEnabled: boolean,
): Promise<BellNotifications> {
  const [notices, bell] = await Promise.all([
    lifecycleEnabled ? onboardingNoticeSummary(session) : { unread: [], read: [], unreadCount: 0 },
    scope ? notificationBellSummary(session, scope) : { unread: 0, taskCount: 0, items: [], tasks: [], read: [] },
  ]);
  return {
    unread: bell.unread + notices.unreadCount,
    items: [...bell.items, ...notices.unread],
    taskNotifications: bell.tasks,
    notificationTaskCount: bell.taskCount,
    readItems: [...bell.read, ...notices.read],
  };
}
