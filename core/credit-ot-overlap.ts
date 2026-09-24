/**
 * r336 cbfa8b0b · THE DOUBLE-CLAIM CHECK — ONE PREDICATE, BOTH DIRECTIONS.
 *
 * The same worked day may be paid as overtime OR banked as a Leave Credit, never both. That rule already
 * exists once the credit is BANKED: core/payroll.ts's `EXCLUDE_TOIL_BANKED_DAYS` drops any day carrying a
 * live `toil_accrual` row out of the overtime prefill. What did not exist is the rule while both are still
 * CLAIMS — an employee could file an overtime request and a Leave Credit request for the same date, have
 * both sit pending in the same approver's queue, and have whichever was approved second quietly win.
 *
 * ── WHY IT IS ONE FILE AND NOT TWO CHECKS ───────────────────────────────────────────────────────────────
 * The obvious implementation is a query in `submitReplacementLeaveRequest` and a mirror of it in
 * `requestAttendanceCorrection`. That is two copies of one business rule in two files owned by two engines,
 * and the first time either side's definition of "live" moves — a new correction status, a cancelled
 * request, a withdrawn plan — the two disagree and the disagreement is invisible: each side still refuses
 * what it knows about. So the predicate lives here, exactly once, and both callers ask it the same
 * question. A new status is added in ONE place or in none.
 *
 * ── WHAT "LIVE" MEANS, AND WHAT RELEASES THE BLOCK ──────────────────────────────────────────────────────
 * PENDING and APPROVED block. REJECTED and CANCELLED do not. That is the whole release rule and it is
 * symmetric by construction, because both sides read `BLOCKING_STATUSES` below rather than spelling out
 * their own list. An employee whose overtime claim is refused can immediately claim the credit instead,
 * which is the point of asking in the first place.
 *
 * ── THE GRAIN IS THE WHOLE DAY, DELIBERATELY ────────────────────────────────────────────────────────────
 * Not a minute-level or window-level intersection. `EXCLUDE_TOIL_BANKED_DAYS` matches on
 * `ta.worked_date = attendance.attendance_date` — the whole day — and core/payroll.ts records that exclusion
 * as unconditional. A claim check finer than the exclusion it protects would refuse an overlap that payroll
 * cannot act on, and permit a pair that payroll then resolves by suppressing ALL of the day's overtime pay.
 * Splitting a single evening into paid overtime and banked credit is a separate, approved-out-of-scope item
 * (the ticket's point 4); it needs `EXCLUDE_TOIL_BANKED_DAYS` to learn about minutes first, and this round
 * deliberately does not weaken it.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────────────
 * It is NOT the double-BANK guard. `toil_accrual`'s unique index, re-checked inside `bankToilCreditTx`,
 * still owns "this date already has a credit". This owns "this date already has a live claim on the other
 * side of the cash/time-in-lieu choice", which is a different question with a different answer set.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { attendanceCorrection, replacementLeaveRequest, replacementLeaveRequestDate } from '../db/schema';

/**
 * The two statuses that block, for BOTH record types. `replacement_leave_request_status` and
 * `attendance_correction_status` happen to carry the same four values, which is what lets one list serve
 * both — asserted in test rather than assumed, because the two enums are free to diverge.
 */
export const BLOCKING_STATUSES = ['pending', 'approved'] as const;

export class ClaimOverlapError extends Error {
  /** The dates that clash, so a screen can name them rather than saying "somewhere in this request". */
  readonly dates: string[];
  constructor(msg: string, dates: string[]) {
    super(msg);
    this.name = 'ClaimOverlapError';
    this.dates = dates;
  }
}

/** Direction 1 — an overtime claim already exists for these dates, so a Leave Credit cannot be claimed. */
export const OT_BLOCKS_CREDIT_MESSAGE = (dates: string[]) =>
  `An overtime claim is already open for ${dates.join(', ')}. The same hours cannot be both paid as overtime and banked as a Leave Credit — withdraw the overtime claim, or wait for it to be rejected, before claiming a credit for ${dates.length === 1 ? 'that date' : 'those dates'}.`;

/** Direction 2 — a Leave Credit claim already exists for these dates, so overtime cannot be claimed. */
export const CREDIT_BLOCKS_OT_MESSAGE = (dates: string[]) =>
  `A Leave Credit request is already open for ${dates.join(', ')}. The same hours cannot be both banked as a Leave Credit and paid as overtime — withdraw the Leave Credit request, or wait for it to be rejected, before claiming overtime for ${dates.length === 1 ? 'that date' : 'those dates'}.`;

/**
 * Which of `dates` already carry a LIVE overtime claim for this employment.
 *
 * `requested_ot_minutes IS NOT NULL` is the filter that makes this an OVERTIME question rather than an
 * attendance one: `attendance_correction` also carries plain clock-time corrections (a forgotten punch),
 * and a corrected clock-in has nothing to do with whether the evening was banked. ADR-0069's own comment on
 * the column says the same — an OT-only request is the one that supplies this figure.
 *
 * Returns a SORTED, de-duplicated list so the message it feeds reads the same every time and a test can
 * assert it without an ORDER BY of its own (CLAUDE.md §8: pin invariants, not positions).
 */
export async function liveOvertimeClaimDatesTx(tx: Tx, employmentId: string, dates: string[]): Promise<string[]> {
  if (dates.length === 0) return [];
  const rows = await tx
    .select({ date: attendanceCorrection.attendanceDate })
    .from(attendanceCorrection)
    .where(
      and(
        eq(attendanceCorrection.employmentId, employmentId),
        inArray(attendanceCorrection.attendanceDate, dates),
        inArray(attendanceCorrection.status, [...BLOCKING_STATUSES]),
        isNotNull(attendanceCorrection.requestedOtMinutes),
        // A zero-minute OT figure is a request for no overtime and blocks nothing. Written as a SQL
        // comparison rather than filtered in JS so the index can still be used.
        sql`${attendanceCorrection.requestedOtMinutes} > 0`,
      ),
    );
  return [...new Set(rows.map((r) => r.date))].sort();
}

/**
 * Which of `dates` already carry a LIVE Leave Credit claim for this employment.
 *
 * `excludeRequestId` exists for the ONE caller that needs it: a re-check inside an approval must not count
 * the request being approved as its own blocker. No caller passes it today (submission is the only entry
 * point), and it is here so that the day one does, the answer is a parameter rather than a second query.
 */
export async function liveCreditClaimDatesTx(
  tx: Tx,
  employmentId: string,
  dates: string[],
  opts: { excludeRequestId?: string } = {},
): Promise<string[]> {
  if (dates.length === 0) return [];
  const rows = await tx
    .select({ date: replacementLeaveRequestDate.workedDate, requestId: replacementLeaveRequestDate.requestId })
    .from(replacementLeaveRequestDate)
    .innerJoin(replacementLeaveRequest, eq(replacementLeaveRequest.id, replacementLeaveRequestDate.requestId))
    .where(
      and(
        eq(replacementLeaveRequest.employmentId, employmentId),
        inArray(replacementLeaveRequestDate.workedDate, dates),
        inArray(replacementLeaveRequest.status, [...BLOCKING_STATUSES]),
      ),
    );
  const hits = rows.filter((r) => r.requestId !== opts.excludeRequestId).map((r) => r.date);
  return [...new Set(hits)].sort();
}

/**
 * Direction 1, as the credit path calls it: refuse a Leave Credit claim whose dates already carry live
 * overtime.
 */
export async function assertNoOvertimeClaimForDatesTx(tx: Tx, employmentId: string, dates: string[]): Promise<void> {
  const clash = await liveOvertimeClaimDatesTx(tx, employmentId, dates);
  if (clash.length > 0) throw new ClaimOverlapError(OT_BLOCKS_CREDIT_MESSAGE(clash), clash);
}

/**
 * Direction 2, as the overtime path calls it: refuse an overtime claim whose date already carries a live
 * Leave Credit claim.
 */
export async function assertNoCreditClaimForDatesTx(tx: Tx, employmentId: string, dates: string[]): Promise<void> {
  const clash = await liveCreditClaimDatesTx(tx, employmentId, dates);
  if (clash.length > 0) throw new ClaimOverlapError(CREDIT_BLOCKS_OT_MESSAGE(clash), clash);
}
