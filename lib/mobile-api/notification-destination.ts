/**
 * M10 — the SERVER allowlist from a notification's kind to the app screen it may open (lib/mobile-api/v2/notifications.ts).
 *
 * Keyed on `kind` only: the kind is written by the notification registry (core/notifications.ts REGISTRY), never by a
 * person. The stored `link_path` is NOT an input — it is a coarse web path frozen at dispatch, so it is neither trusted
 * nor sent. A kind that is not listed here (a new registry entry, a retired one, a hand-written row) opens nothing:
 * null. Adding a kind is a reviewed edit to this table and its test (test/mobile-v2-notifications.test.ts).
 *
 * Destinations are LIST screens, never a record id: a notification row holds no business-record reference of its own
 * (only its source event, whose reader is not the recipient's), and each list screen re-reads under the caller's
 * current session, so a stale notification can never open a record the caller may no longer see.
 *
 * Current access: `pay` needs the Payroll module now (the payslip screens are gated by it); the others are the
 * caller's own leave and approvals lists, which are always present and answer for themselves.
 */
import type { NotificationDestination, NotificationScreen } from './v2/notifications';

export const NOTIFICATION_DESTINATIONS: Readonly<Record<string, NotificationScreen>> = Object.freeze({
  // The employee's own request was decided or cancelled → their leave requests.
  'leave.approved': 'leaveHistory',
  'leave.rejected': 'leaveHistory',
  'leave.admin-cancelled': 'leaveHistory',
  'leave.cancellation-approved': 'leaveHistory',
  'leave.cancellation-rejected': 'leaveHistory',
  // Time in lieu banked, converted or lapsed → the leave balances.
  'toil.accrued': 'leave',
  'toil.converted': 'leave',
  'toil.lapsed': 'leave',
  // Work assigned to the caller as an approver → the approvals list (the v2 task list decides what is there).
  'leave.cancellation-requested': 'approvals',
  'leave.escalation': 'approvals',
  'attendance.ot-requested': 'approvals',
  'review.started': 'approvals',
  'review.manager-evaluated': 'approvals',
  'review.reminder': 'approvals',
  // A payslip was released → the own payslips.
  'payslip.ready': 'pay',
});

export type DestinationAccess = { payroll: boolean };

/** The typed destination for a stored notification kind, or null. Never derived from the row's link. */
export function notificationDestination(kind: string, access: DestinationAccess): NotificationDestination | null {
  const screen = Object.hasOwn(NOTIFICATION_DESTINATIONS, kind) ? NOTIFICATION_DESTINATIONS[kind] : undefined;
  if (!screen) return null;
  if (screen === 'pay' && !access.payroll) return null;
  return { screen };
}
