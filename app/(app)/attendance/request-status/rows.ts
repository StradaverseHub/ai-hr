/**
 * 7709ffd1 (r369) — HOW MANY OF THEIR OWN REQUESTS "My Request" WILL SHOW, AND WHAT IT DOES PAST THAT.
 *
 * ── THE DEFECT THIS CLOSES, WHICH THE TICKET DID NOT REPORT ─────────────────────────────────────────
 * The screen asked `myAttendanceCorrections` for `{ limit: 200 }`, filtered by status IN MEMORY over
 * whatever came back, paged that array with `paginateRows`, and handed the pager a total of `rows.length`.
 * So an employee with more than 200 requests was shown "200" and told nothing — a short list that is
 * indistinguishable from a complete one. The ticket asked for an Export on this screen, and a download
 * built on that arrangement is a FILE that looks complete and is not, which is why this is fixed BEFORE
 * the export rather than after it.
 *
 * ── WHY THIS IS A MODULE AND NOT FOUR LINES IN THE PAGE (the r367 convention, 67268d83) ─────────────
 * It closes a live hazard, so it has to be testable without a session, and the SCREEN and the EXPORT have
 * to reach the same answer from the same code — a second copy of either the ceiling test or the `?status=`
 * whitelist is exactly how a file comes to hold a different set of rows from the screen it was asked for.
 *
 * PURE: no DB, no React, no `t`, no clock. The ceiling is passed IN rather than imported, so this module
 * never pulls the pack facade (and db/client with it) into a unit test; the two callers pass the kernel's
 * own `MY_ATTENDANCE_REQUEST_ROW_CEILING`, so the two numbers cannot drift apart.
 *
 * ── REFUSAL, NEVER A CLAMP ──────────────────────────────────────────────────────────────────────────
 * Past the ceiling the screen says so and shows no list, and the export answers a sentence instead of a
 * workbook. Handing over the first N rows under a total of N is the defect, not the remedy: the reader has
 * no way to know the answer was cut, and neither has the spreadsheet they send on. Narrowing by the status
 * tab is a real way out, because the status now narrows the READ rather than the array.
 */
import { REQUEST_STATUSES, type RequestStatus } from '../request-ui';

/**
 * The `?status=` whitelist, in ONE place.
 *
 * r239 pulled `REQUEST_STATUSES` up into request-ui.tsx so the filter pills and the URL whitelist could be
 * derived from one tuple instead of restating it; this lifts the DERIVATION up too, out of the page, so the
 * export route narrows by exactly what the pill the reader pressed narrows by. A second copy in the route
 * is how a file comes to hold "every request" while the tab said "Rejected".
 */
export const parseRequestStatus = (raw: string | undefined | null): RequestStatus | null =>
  REQUEST_STATUSES.includes(raw as never) ? (raw as RequestStatus) : null;

/**
 * How many rows to ASK the kernel for: one past the ceiling.
 *
 * A complete list of exactly `ceiling` rows and a list truncated AT `ceiling` are the same array, so the
 * only way to know which one is in hand is to ask for one more and see whether it arrives. The kernel's
 * clamp is deliberately one higher than the ceiling for this (see `MY_ATTENDANCE_REQUEST_ROW_CEILING`).
 */
export const requestRowsProbeLimit = (ceiling: number) => ceiling + 1;

/** Why the list cannot be shown, or `null` when it can. `too_many` is the only reason there is. */
export type RequestRowsRefusal = 'too_many' | null;

export type ResolvedRequestRows<T> = {
  /** The rows to render or serialise — EMPTY when refused, so a caller that ignores `refusal` shows nothing
   *  rather than a short list under a wrong total. */
  rows: T[];
  refusal: RequestRowsRefusal;
};

/**
 * Decide whether the probe read is a complete answer.
 *
 * `fetched` is the array `requestRowsProbeLimit(ceiling)` asked for. More than `ceiling` rows means the
 * kernel had at least one more than may be shown, so the answer is refused rather than sliced — and the
 * rows are dropped on the floor deliberately, so nothing downstream can render half of them by accident.
 */
export function resolveRequestRows<T>(fetched: readonly T[], ceiling: number): ResolvedRequestRows<T> {
  if (fetched.length > ceiling) return { rows: [], refusal: 'too_many' };
  return { rows: [...fetched], refusal: null };
}
