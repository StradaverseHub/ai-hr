/**
 * M10 (inbox part) and M14 (Home essentials) — the caller's own notifications, their read state, and Home's
 * "what needs me" counts. v2 only: v1 NotificationsResponse is closed and stays for installed clients.
 * Imported by route handlers AND by the Expo app, so this file stays dependency-free (zod and common.ts only, no
 * server module, no 'server-only').
 *
 *   GET  /api/mobile/v2/notifications?cursor&limit&unread=true   → NotificationsPageV2
 *   POST /api/mobile/v2/notifications/read {ids} | {all:true}     → NotificationReadResult
 *   GET  /api/mobile/v2/home/summary                              → HomeSummaryV2
 *
 * A NOTIFICATION NEVER CARRIES A LINK. The stored `link_path` is a coarse WEB path frozen at dispatch; it is never
 * sent. Each item carries a typed `destination` the SERVER derives from the notification's kind through a closed
 * allowlist (lib/mobile-api/notification-destination.ts) and the caller's current module access; anything else is
 * null. The app maps a destination to one of its own fixed screens, which fetch afresh under the caller's session.
 *
 * Reading is idempotent by nature (marking an already-read or vanished row changes nothing), so the read command
 * carries no requestId and records no receipt.
 */
import { z } from 'zod';
import { pageOf, refusalOf } from './common';

const instant = z.string().max(40);
const count = z.number().int().nonnegative();

/** The app screens a notification may open. Closed: a new screen is a contract change. */
export const NOTIFICATION_SCREENS = ['leave', 'leaveHistory', 'approvals', 'pay'] as const;
export const NotificationScreen = z.enum(NOTIFICATION_SCREENS);
export type NotificationScreen = z.infer<typeof NotificationScreen>;
export const NotificationDestination = z.object({ screen: NotificationScreen }).strict();
export type NotificationDestination = z.infer<typeof NotificationDestination>;

/** Stored text is bounded on the way out (core/mobile-notifications.ts clips it), so one long row cannot fail a page. */
export const NOTIFICATION_TITLE_MAX = 500;
export const NOTIFICATION_BODY_MAX = 4000;
export const NotificationItemV2 = z.object({
  id: z.string().uuid(),
  title: z.string().max(NOTIFICATION_TITLE_MAX),
  body: z.string().max(NOTIFICATION_BODY_MAX),
  severity: z.enum(['info', 'action', 'warning']),
  readAt: instant.nullable(),
  createdAt: instant,
  destination: NotificationDestination.nullable(),
});
export type NotificationItemV2 = z.infer<typeof NotificationItemV2>;

/** Keyset tuple: the kernel's order (created_at desc, id desc), the instant to the microsecond as UTC text. */
export const NOTIFICATIONS_CURSOR = 'notifications';
export const NotificationsCursor = z.tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), z.string().uuid()]);
/** `enabled: false` ⇔ the Notifications module is off: nothing is read, `items` is empty, `unreadCount` 0. */
export const NotificationsPageV2 = pageOf(NotificationItemV2).extend({ enabled: z.boolean(), unreadCount: count });
export type NotificationsPageV2 = z.infer<typeof NotificationsPageV2>;

/** Mark these (at most one page) or all of the caller's own notifications read. Nothing else may travel. */
export const NotificationReadCommand = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type NotificationReadCommand = z.infer<typeof NotificationReadCommand>;
/**
 * `items`: each requested id the caller still owns, re-read AFTER the write with its destination re-derived now;
 * an id that is gone or never was the caller's is simply absent (the app says "no longer available"). Empty for
 * `all`. `unreadCount` is the fresh total.
 */
export const NotificationReadResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('read'), unreadCount: count, items: z.array(z.object({ id: z.string().uuid(), destination: NotificationDestination.nullable() })).max(50) }),
  refusalOf(['notifications_off']),
]);
export type NotificationReadResult = z.infer<typeof NotificationReadResult>;

/**
 * Home's counts. Each part is read independently and fails independently: `unavailable` means "could not check",
 * which the app must never present as "nothing needs you".
 *   tasks — the length of the v2 task list (the web inbox's own owner, listPendingTasks), the approvals screen's count
 *   inbox — the caller's unread notifications; `enabled: false` when the Notifications module is off
 */
const unavailable = z.object({ status: z.literal('unavailable') });
export const HomeSummaryV2 = z.object({
  tasks: z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), count }), unavailable]),
  inbox: z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), enabled: z.boolean(), unreadCount: count }), unavailable]),
});
export type HomeSummaryV2 = z.infer<typeof HomeSummaryV2>;
