/**
 * The leave-request status pill's colour classes — ONE definition.
 *
 * fe3eb141 gave Employee Leave Records a Status column so an admin can see why a record is (or is
 * not) cancellable. That made a second copy of this map necessary, which is exactly how two screens
 * describing the same records start disagreeing about what "approved" looks like. Both the Requests
 * table on /leave and the Employee Leave Records table import this instead.
 *
 * `partial` is a DISPLAY-only status (an approved request with ≥1 rejected date); it is never stored.
 */
export const LEAVE_STATUS_PILL: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
};

/** Fallback for a status with no colour of its own (today: `cancelled`). */
export const LEAVE_STATUS_PILL_DEFAULT = 'bg-muted text-muted-foreground';

/**
 * Can an HR admin cancel this record on the employee's behalf?
 *
 * Mirrors the gates `adminCancelLeave` (core/leave.ts) enforces authoritatively, so the button is
 * only offered where the service will accept it:
 *  - the viewer is not the subject (the service self-bans everyone below super_admin, and a UI that
 *    offered the button to someone it will refuse is worse than no button);
 *  - the record is still pending or approved;
 *  - it is not an APPROVED replacement (TOIL) leave — `consumeReplacementLeaveTx` has no inverse.
 *
 * The service ALSO refuses a month whose payroll is closed. That is a DB read, so it cannot be
 * mirrored here; the dialog surfaces the refusal as an error banner instead of hiding the button.
 */
export function canAdminCancelLeave(r: {
  status: string;
  typeCode: string | null;
  personId: string | null;
}, viewerPersonId: string | null | undefined): boolean {
  const isOwn = viewerPersonId != null && r.personId === viewerPersonId;
  if (isOwn) return false;
  if (r.status !== 'pending' && r.status !== 'approved') return false;
  if (r.status === 'approved' && r.typeCode === 'REPLACEMENT') return false;
  return true;
}
