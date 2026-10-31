import { formatMinutesToHM } from '@/lib/overtime-duration';
import type { getTranslations } from 'next-intl/server';

/**
 * c6bb5f5a — the request-status vocabulary the four My Attendance screens share.
 *
 * WHY IT EXISTS. This round split ONE screen into four (Self Overtime, My Travel, My Attendance Request
 * Status and the Attendance Irregularity screen that keeps the exceptions). Three of the four render a
 * status pill, and two of them render a request's type or reason category. Left in
 * app/(app)/attendance/requests/page.tsx these would have been copied three times — and the FIRST thing a copy
 * does is drift.
 *
 * r363 — THAT SENTENCE USED TO CONTINUE: "`cancelled` reading 'Cancelled' on one screen and 'Withdrawn'
 * on another for the same row is exactly the confusion the wording below exists to prevent." Right about
 * the danger, wrong about the cure. The wording below did not prevent that confusion, it WAS that
 * confusion: the split it carried put both words on ONE screen — My Attendance Request Status, whose
 * filter chip read "Cancelled" a few centimetres above an overtime row reading "Withdrawn" — which is
 * exactly what the reporter then saw. One module owns those legacy withdrawal labels; later administrative cancellation is distinguished
 * by persisted provenance below.
 * See `statusLabel`.
 *
 * MOVED, NOT REWRITTEN. Every value here is lifted verbatim from the single screen that carried them
 * (2166ef79 / 1e9145d4). Same colours, same labels, same overtime-vs-correction split.
 *
 * SERVER-RENDER ONLY, deliberately: `t` is passed as an argument, so nothing here may cross a client
 * boundary (test/server-client-boundary.test.ts). The one piece of this module's surface the modal needs
 * is plain strings, which the page resolves before it hands them over.
 */
export type T = Awaited<ReturnType<typeof getTranslations<'me'>>>;

/** Legacy withdrawals keep r363's shared Withdrawn wording. Approved administrative cancellation is
 * distinguished by its persisted cancellationKind, with the same resolved label on screen and in exports.
 * A missing kind remains a legacy withdrawal; no historical row is rewritten to manufacture a distinction.
 * The overtime argument remains for existing callers, whose labels were deliberately unified by r363. */
export function statusLabel(status: string, t: T, isOvertime: boolean, cancellation?: { kind?: string | null; cancelledLabel: string }): string {
  // Deliberately unread — see above. The statement is here so "nothing reads it" is visible in the CODE
  // and not only in a comment, and so the unused-argument lint does not have to be silenced.
  void isOvertime;
  if (status === 'cancelled') return cancellation?.kind === 'cancelled' ? cancellation.cancelledLabel : t('otStatusWithdrawn');
  if (status === 'approved') return t('leaveStatus.approved');
  if (status === 'rejected') return t('leaveStatus.rejected');
  return t('leaveStatus.pending');
}

/** A status filter includes both kinds of cancelled rows; its caption must not assert only one of them. */
export function requestStatusFilterLabel(status: string | null | undefined, t: T, cancelledFilterLabel: string): string {
  return status === 'cancelled' ? cancelledFilterLabel : status ? statusLabel(status, t, false) : t('maFilterAll');
}

/**
 * THE STATUS VOCABULARY, ONE LIST. `attendance_correction_status` is pending | approved | rejected |
 * cancelled and NOTHING ELSE — there is no `completed`, nothing in the schema or the service could ever
 * write one, and a filter offering one would return an empty list forever while looking like a real state.
 * r239 pulled the tuple up here (from a copy in the request-status page's filter row and a second copy in
 * its query parser) so the set exists once: the filter pills, the URL whitelist and the colour map below
 * are all derived from it, and test/attendance-screens-layout.test.ts pins it against
 * db/schema.ts's `attendanceCorrectionStatusEnum`. A fifth status therefore cannot reach this screen
 * without someone deciding, in a migration and in that test, that it should.
 */
export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// The request-status colours. Deliberately NOT components/ui's StatusBadge: that palette is the Employee
// Status vocabulary (probation/active/resigned…), which has no entry for pending/approved/rejected —
// every pill here would render neutral grey.
// Keyed by RequestStatus rather than by `string`, so a status added to the tuple above without a colour is
// a type error rather than a silently grey pill.
const REQUEST_STATUS: Record<RequestStatus, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  cancelled: 'bg-muted text-muted-foreground',
};

/**
 * ⚠️ `shrink-0 whitespace-nowrap` IS NOT COSMETIC, AND ENGLISH IS THE ONLY LOCALE THAT HIDES THE NEED.
 * From r239 this pill sits at the end of a flex row beside the date on a phone. "Approved" is 8
 * characters; the Tamil `leaveStatus.approved` is 20 and `otStatusWithdrawn` is 21. Without these the
 * chip is a flex item that shrinks and wraps its own label inside its rounded background — the one place
 * on this screen a long locale would visibly break, and the one an English-only check cannot see.
 *
 * r363 WIDENED WHICH ROWS CARRY THE LONGEST LABEL: `cancelled` resolves to `otStatusWithdrawn` for a
 * clock CORRECTION too now, not only for an overtime plan, so the 21-character Tamil word can appear on
 * any taken-back row on this list. Nothing here changes — the classes were already sized for it — but a
 * phone-width check of this chip must be run against a cancelled correction row, not only an overtime one.
 */
export function Pill({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${REQUEST_STATUS[status as RequestStatus] ?? 'bg-muted text-muted-foreground'}`}
    >
      {label}
    </span>
  );
}

/** request_kind → the `me` key naming it. `other` is the free-form "correct another day" route and every
 *  request filed before migration 0434 (which carries no kind at all). */
export const KIND_LABEL = {
  self_overtime: 'maSectionOvertime',
  short_hours: 'maSectionShort',
  incomplete_entry: 'maSectionIncomplete',
  absent: 'maSectionAbsent',
  other: 'maKindOther',
} as const;

/** ot_reason_category → the `me` key naming it. Exhaustive over db/schema OT_REASON_CATEGORIES. */
export const CATEGORY_KEY = {
  project_deadline: 'otCategoryProjectDeadline',
  system_maintenance: 'otCategorySystemMaintenance',
  month_end_closing: 'otCategoryMonthEndClosing',
  client_request: 'otCategoryClientRequest',
  other: 'otCategoryOther',
} as const;

/** What the request asked for, in one line. */
export function askedFor(
  r: { proposedCheckIn: string | null; proposedCheckOut: string | null; requestedOtMinutes: number | null; clockChanges?: { entries: {punchAt:string;direction:string}[] } | null },
  t: T,
): string {
  if (r.clockChanges) return t('maAskedClockData', { count: r.clockChanges.entries.length });
  if (r.proposedCheckIn == null && r.requestedOtMinutes != null) {
    return t('maAskedOvertime', { hours: formatMinutesToHM(r.requestedOtMinutes) });
  }
  return t('maAskedTimes', {
    in: r.proposedCheckIn?.slice(0, 5) ?? '—',
    out: r.proposedCheckOut?.slice(0, 5) ?? '—',
  });
}
