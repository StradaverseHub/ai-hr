/**
 * M10 (inbox part) and M14 (Home essentials) — COMPOSITION ONLY over the canonical notification service
 * (core/notifications.ts) and the v2 task list's owner (core/mobile-approvals.ts → listPendingTasks).
 *
 *   page     listNotificationsPage (D5 keyset, created_at desc + id desc) + unreadNotificationCount
 *   read     markNotificationRead per id / markAllNotificationsRead, then a fresh re-read of the ids
 *   home     pendingTaskCountV2 and unreadNotificationCount, each settled on its own
 *
 * RECIPIENT-ONLY. Every read and write runs under the caller's own session: `notification_recipient_rls` (0078)
 * admits only rows addressed to one of the caller's own employments, administrators included, so an id that is
 * someone else's is neither marked nor returned. No employment filter is applied (the web bell applies none).
 *
 * NO LINK LEAVES THE SERVER. `link_path` is never mapped; `destination` comes from the kind allowlist
 * (lib/mobile-api/notification-destination.ts) and the caller's module access at the moment of the read.
 *
 * Gated like the web bell and v1: the Notifications module off ⇒ nothing is read or written.
 * Kept free of 'server-only' (mobile-command-receipt.ts says why).
 */
import type { SessionContext } from '../db/client';
import { AuthRequiredError } from '../lib/auth-errors';
import { isModuleEnabled } from './entitlements';
import { listNotificationsPage, markAllNotificationsRead, markNotificationRead, unreadNotificationCount } from './notifications';
import { pendingTaskCountV2 } from './mobile-approvals';
import { notificationDestination, type DestinationAccess } from '../lib/mobile-api/notification-destination';
import { encodeCursor } from '../lib/mobile-api/v2/common';
import {
  NOTIFICATION_BODY_MAX, NOTIFICATION_TITLE_MAX, NOTIFICATIONS_CURSOR,
  type HomeSummaryV2, type NotificationItemV2, type NotificationReadCommand, type NotificationReadResult, type NotificationsPageV2,
} from '../lib/mobile-api/v2/notifications';

type PageRow = Awaited<ReturnType<typeof listNotificationsPage>>[number];
const enabled = (ctx: SessionContext) => isModuleEnabled(ctx, 'notifications');
const accessOf = (ctx: SessionContext): DestinationAccess => ({ payroll: isModuleEnabled(ctx, 'payroll') });
const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1) + '…');
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

function itemOf(r: PageRow, access: DestinationAccess): NotificationItemV2 {
  return {
    id: r.id, title: clip(r.title, NOTIFICATION_TITLE_MAX), body: clip(r.body, NOTIFICATION_BODY_MAX), severity: r.severity,
    readAt: r.readAt ? iso(r.readAt) : null, createdAt: iso(r.createdAt), destination: notificationDestination(r.kind, access),
  };
}

/** One page of the caller's own notifications, newest first; `unread` narrows to unread rows. */
export async function notificationsPageV2(
  ctx: SessionContext,
  q: { limit: number; cursor: readonly [string, string] | null; unread: boolean },
): Promise<NotificationsPageV2> {
  if (!enabled(ctx)) return { enabled: false, unreadCount: 0, items: [], nextCursor: null };
  const [rows, unreadCount] = await Promise.all([
    listNotificationsPage(ctx, { limit: q.limit + 1, after: q.cursor ? { at: q.cursor[0], id: q.cursor[1] } : null, read: q.unread ? false : undefined }),
    unreadNotificationCount(ctx),
  ]);
  const shown = rows.slice(0, q.limit), last = shown[shown.length - 1], access = accessOf(ctx);
  return {
    enabled: true, unreadCount,
    items: shown.map((r) => itemOf(r, access)),
    nextCursor: rows.length > q.limit && last ? encodeCursor(NOTIFICATIONS_CURSOR, [last.cursorAt, last.id]) : null,
  };
}

/** Mark the caller's own rows read; answer each still-owned id with its destination as of now, and the fresh count. */
export async function markNotificationsReadV2(ctx: SessionContext, command: NotificationReadCommand): Promise<NotificationReadResult> {
  if (!enabled(ctx)) return { outcome: 'refused', code: 'notifications_off' };
  if ('all' in command) {
    await markAllNotificationsRead(ctx);
    return { outcome: 'read', unreadCount: await unreadNotificationCount(ctx), items: [] };
  }
  const ids = [...new Set(command.ids.map((id) => id.toLowerCase()))];
  for (const id of ids) await markNotificationRead(ctx, id);
  const [rows, unreadCount] = await Promise.all([listNotificationsPage(ctx, { limit: ids.length, ids }), unreadNotificationCount(ctx)]);
  const access = accessOf(ctx);
  return { outcome: 'read', unreadCount, items: rows.map((r) => ({ id: r.id, destination: notificationDestination(r.kind, access) })) };
}

/** Home's two counts, each settled on its own: one failing never hides the other, and neither reads as zero. */
export async function homeSummaryV2(ctx: SessionContext): Promise<HomeSummaryV2> {
  const [tasks, inbox] = await Promise.allSettled([
    pendingTaskCountV2(ctx),
    enabled(ctx) ? unreadNotificationCount(ctx).then((n) => ({ enabled: true, unreadCount: n })) : Promise.resolve({ enabled: false, unreadCount: 0 }),
  ]);
  // A signed-out caller is 401 for the whole summary, never a per-part "could not check".
  for (const part of [tasks, inbox]) if (part.status === 'rejected' && part.reason instanceof AuthRequiredError) throw part.reason;
  // The cause may carry private HR or SQL text (lib/mobile-api/handler.ts privateFailure): log the part, never the error.
  for (const [name, part] of [['tasks', tasks], ['inbox', inbox]] as const) if (part.status === 'rejected') console.error('[mobile-api]', { event: 'home_summary_part_unavailable', part: name });
  return {
    tasks: tasks.status === 'fulfilled' ? { status: 'ok', count: tasks.value } : { status: 'unavailable' },
    inbox: inbox.status === 'fulfilled' ? { status: 'ok', ...inbox.value } : { status: 'unavailable' },
  };
}
