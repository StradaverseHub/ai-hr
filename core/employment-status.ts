/**
 * Employee Status — System-Controlled Lifecycle Management (R43 c26c3ce5).
 *
 * Employee Status is DERIVED read-time from the employment lifecycle dates rather than stored as a manual
 * field, so it can never drift out of sync with the dates (e.g. still showing "Active" after a resignation
 * date has passed). This is a PURE function of (dates, today): no stored status column, no clock-dependent
 * staleness — the same inputs always yield the same bucket, and a time-based transition (e.g. flipping to
 * Resigned the day the resignation date arrives) happens with no manual step.
 *
 * The safety of switching status to derived was established during planning: nothing in payroll, attendance
 * or leave gates on the old manual `assignment.status` — those all gate on the employment's real lifecycle
 * dates (terminatedOn etc.). So making status derived changes only the DISPLAYED label, never any pay/leave
 * behaviour. This mirrors the read-time layering the UI already did (terminatedOn over status).
 *
 * R81 (9cbf5e0d, superseding R43/r75) — the reporter supplied the FULL rule set: six statuses, three retired
 * (On Leave / Offboarding / Terminated), and NO MANUAL EDITING. This module is the single derivation; the
 * stored `assignment.status` column and its `assignment_status` enum are GONE (migration 0331), so there is
 * no longer any field an administrator can type a status into. Status changes only by recording the event
 * that causes it — a confirmation, a resignation, a blacklist, a payroll hold.
 *
 * Buckets and priority — first match wins:
 *   1. blacklisted            — an authorised-HR event (the one stored, event-driven flag on `employment`).
 *   2. withhold               — a Payroll hold. The two EXCEPTION statuses sit above the date ladder because
 *                              they describe a deliberate administrative state that outranks where the
 *                              employee happens to be in their lifecycle: a blacklisted or payment-held
 *                              leaver must not read as a plain "Resigned". Blacklist outranks Withhold
 *                              (it is the stronger, person-level sanction; a hold is only about payment).
 *   3. resigned               — lifecycle ended: today >= resignationDate | lastWorkingDate | terminatedOn.
 *   4. active_serving_notice  — a resignation is recorded and today is still before its effective date.
 *   5. probation              — today is before the effective (final) confirmation date.
 *   6. active                 — past confirmation, no resignation recorded, no exception (the default).
 *
 * WITHHOLD IS INERT TODAY, BY DESIGN. Payroll has no salary-hold field yet, so `payrollHoldAt` is modelled
 * as a derivation INPUT that no caller can currently populate — never a column, and never a box anyone can
 * tick. The bucket exists so the vocabulary is complete (labels, badge colour, filter options) and so the
 * payroll-hold feature, when it lands, has one line to fill in rather than a status to invent. Until then
 * `withhold` is unreachable from real data; test/employment-status-derive.test.ts pins BOTH facts — that a
 * hold derives to `withhold`, and that nothing in the schema can produce one.
 */

import { todayInKualaLumpur } from '../lib/hr-date';

export type EmploymentStatus =
  | 'probation'
  | 'active'
  | 'active_serving_notice'
  | 'resigned'
  | 'blacklisted'
  | 'withhold';

/** The complete list of derived buckets — the canonical order (probation → … → withhold) for pickers/legends. */
export const EMPLOYMENT_STATUSES: readonly EmploymentStatus[] = [
  'probation',
  'active',
  'active_serving_notice',
  'resigned',
  'blacklisted',
  'withhold',
] as const;

/** The lifecycle inputs the deriver reads. All optional/nullable — a field that is not captured is ignored. */
export type EmploymentStatusInput = {
  /** Effective confirmation date (extended ?? normal). Preferred; falls back to `confirmationDate`. */
  finalConfirmationDate?: string | null;
  confirmationDate?: string | null;
  /**
   * R81 — THE PROBATION FALLBACKS, AND THE BUG THEY FIX. Rule 1 is "Probation until confirmed", but the
   * only inputs this deriver read were the two confirmation dates above, and NOTHING WRITES THOSE AT HIRE:
   * hireEmployee records `provisional_end_on` (probation end for a full-timer, contract/internship end for
   * the other types) and the employment-review workflow is advisory — it never writes a confirmation date
   * back. So every new hire serving a probation period derived to "Active" from their first day unless an
   * administrator separately typed a Confirmation Date on the Employment tab. That is precisely the
   * "status does not automatically update according to the employee's employment lifecycle" the request
   * describes, and fixing it by asking HR to type a date would reintroduce the manual step the same
   * request removes.
   *
   * Order matters: a RECORDED confirmation is the confirmation event and always wins. Only when none has
   * been recorded does the probation END date stand in for it — `probationEndDate` (the employment-review
   * trigger column) before `provisionalEndOn` (the date captured at hire), since the former is the more
   * specific and more recently maintained of the two.
   */
  probationEndDate?: string | null;
  provisionalEndOn?: string | null;
  /** Manual/administrative resignation date (HR override) — the effective resignation date. */
  resignationDate?: string | null;
  /** Physical final working day. */
  lastWorkingDate?: string | null;
  /** Termination date (voluntary or involuntary lifecycle end). */
  terminatedOn?: string | null;
  /** Non-null ⇒ the employment is blacklisted (highest-priority override). */
  blacklistedAt?: string | null;
  /**
   * Non-null ⇒ Payroll is holding this employee's payment ⇒ status `withhold`. THE SEAM, NOT A FEATURE:
   * no column and no writer exists for this yet, so every caller leaves it undefined and the bucket never
   * appears on any screen. When the payroll-hold setting is built it populates this field (and only this
   * field) — the derivation, the labels and the badge are already here and do not change.
   */
  payrollHoldAt?: string | null;
};

/** The smallest non-null ISO date among the inputs, or null if all are null/undefined. */
function earliest(...dates: (string | null | undefined)[]): string | null {
  let min: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (min === null || d < min) min = d;
  }
  return min;
}

/**
 * Derive the Employee Status from the lifecycle dates as of `today` (ISO 'YYYY-MM-DD'). Pure: no I/O, no
 * stored column. `today` defaults to the current UTC date but callers should pass their page's `today` so the
 * derivation matches the rest of the screen. ISO date strings compare lexicographically, so plain string
 * comparison is correct for same-length 'YYYY-MM-DD' values.
 */
export function deriveEmploymentStatus(
  emp: EmploymentStatusInput,
  // MYT, not UTC: mirrors SQL current_date in the Asia/Kuala_Lumpur database — see lib/hr-date.ts.
  today: string = todayInKualaLumpur(),
): EmploymentStatus {
  // 1. Blacklist — a deliberate HR event wins over every date-derived bucket.
  if (emp.blacklistedAt) return 'blacklisted';

  // 2. Withhold — a Payroll hold. Unreachable today (no column populates payrollHoldAt); see the header.
  if (emp.payrollHoldAt) return 'withhold';

  // 3. Resigned — the lifecycle has ended once today reaches the earliest of the recorded end dates. A
  //    future-dated end date does not resign the employee yet (it feeds "serving notice" below instead).
  const ended = earliest(emp.resignationDate, emp.lastWorkingDate, emp.terminatedOn);
  if (ended && today >= ended) return 'resigned';

  // 4. Active — Serving Notice: a resignation/last-working/termination is on the books but still in the future.
  if (ended && today < ended) return 'active_serving_notice';

  // 5. Probation — before the effective (extended ?? normal) confirmation date.
  const confirmation =
    emp.finalConfirmationDate ?? emp.confirmationDate ?? emp.probationEndDate ?? emp.provisionalEndOn ?? null;
  if (confirmation && today < confirmation) return 'probation';

  // 6. Active — past confirmation (or no confirmation date recorded), no resignation, not blacklisted.
  return 'active';
}

// ───────────────────────── Login lifecycle (0279) ─────────────────────────

/**
 * Has this employment ENDED as of `today`? Blacklisted wins outright; otherwise the lifecycle is over
 * once today is STRICTLY PAST the earliest recorded end date.
 *
 * `payrollHoldAt` is DELIBERATELY NOT READ HERE (R81). A payroll hold withholds PAYMENT; it does not end
 * the employment and must never switch off the person's login — a held employee is still employed, still
 * clocks in, still books leave. Only blacklist and the end dates end a lifecycle. This is why `withhold`
 * lives in the display derivation and nowhere near app.login_blocked().
 *
 * DELIBERATE DIVERGENCE from deriveEmploymentStatus, which flips the label to 'resigned' at
 * `today >= ended`. This uses `today > ended`, so on the final working day the person already reads
 * "Resigned" on every screen while their LOGIN still works for that whole day — which is what handover
 * requires. The same note is in db/migrations/0279_user_archive_and_login_block.sql; the two must stay
 * in step, and test/user-lifecycle.test.ts asserts the SQL and this helper agree across a matrix.
 */
export function isEmploymentEnded(
  emp: EmploymentStatusInput,
  // MYT, not UTC: mirrors SQL current_date in the Asia/Kuala_Lumpur database — see lib/hr-date.ts.
  today: string = todayInKualaLumpur(),
): boolean {
  if (emp.blacklistedAt) return true;
  const ended = earliest(emp.resignationDate, emp.lastWorkingDate, emp.terminatedOn);
  return ended !== null && today > ended;
}

/** The inputs app.login_blocked() reads, in TypeScript form. */
export type LoginBlockInput = {
  /** Non-null ⇒ manually archived by an administrator. */
  archivedAt?: string | Date | null;
  /** Every employment of the login's person. EMPTY for a person_id-null (unlinked/external) login. */
  employments: readonly EmploymentStatusInput[];
};

/**
 * Is this login switched off? The TypeScript mirror of app.login_blocked() — the screen and the auth
 * function must never disagree, so the rule is written once per language and pinned by a test.
 *
 * Blocked when the login is manually archived, OR when the person has AT LEAST ONE employment and
 * EVERY one of them has ended. A login with no employment row at all (an external IT admin) is never
 * auto-blocked; only a manual archive touches it. Someone holding two jobs in the group keeps access
 * until the last of them ends.
 */
export function isLoginBlocked(
  input: LoginBlockInput,
  // MYT, not UTC: mirrors SQL current_date in the Asia/Kuala_Lumpur database — see lib/hr-date.ts.
  today: string = todayInKualaLumpur(),
): boolean {
  if (input.archivedAt) return true;
  if (input.employments.length === 0) return false;
  return input.employments.every((e) => isEmploymentEnded(e, today));
}
