/**
 * Approvals deep-link targets for the dashboard Leave Calendar (item 8cb7b089).
 *
 * A calendar pill that is waiting for the viewer's decision links straight to the matching
 * /approvals section by URL hash. Pure + DB-free: shared by the server pill mapping
 * (components/planned-absences.tsx), the approvals page's section ids, and the arrival island
 * (app/approvals/attention-on-arrival.tsx) — one constant, so the ids cannot drift apart.
 */

/** The two /approvals sections a calendar pill can deep-link to, keyed by focus kind. */
export const APPROVAL_SECTION_ID = {
  leave: 'approvals-leave',
  leaveCancellation: 'approvals-leave-cancellation',
} as const;

export type ApprovalFocus = keyof typeof APPROVAL_SECTION_ID;

/**
 * Which approvals section (if any) a calendar pill should deep-link to:
 *  - a PENDING row → the Leave Requests section. This wins even when the row ALSO carries a pending
 *    cancellation (the read layer's pending-cancellation subquery does not constrain the parent's
 *    status, so that state is representable) — the Approvals page shows such a row in the Leave
 *    Requests section, and the link must agree with the destination.
 *  - an APPROVED row with a pending cancellation → the Leave Cancellation section.
 *  - anything else → null (no affordance).
 */
export function focusForCalendarPill(l: {
  status: string;
  pendingCancellationId?: string | null;
}): ApprovalFocus | null {
  if (l.status === 'pending') return 'leave';
  if (l.status === 'approved' && l.pendingCancellationId) return 'leaveCancellation';
  return null;
}
