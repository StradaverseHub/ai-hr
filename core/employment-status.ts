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
 * Buckets (v1) and priority — first match wins:
 *   1. blacklisted            — an authorised-HR manual override (the one stored, event-driven flag).
 *   2. resigned               — lifecycle ended: today >= resignationDate | lastWorkingDate | terminatedOn.
 *   3. active_serving_notice  — a resignation is recorded and today is still before its effective date.
 *   4. probation              — today is before the effective (final) confirmation date.
 *   5. active                 — past confirmation, no resignation recorded, not blacklisted (the default).
 *
 * Deferred (documented): a "Withhold" status (payroll-driven, depends on the salary-withhold feature that is
 * not wired yet) — see the R43 plan. Not represented here.
 */

export type EmploymentStatus =
  | 'probation'
  | 'active'
  | 'active_serving_notice'
  | 'resigned'
  | 'blacklisted';

/** The complete list of derived buckets — the canonical order (probation → … → blacklisted) for pickers/legends. */
export const EMPLOYMENT_STATUSES: readonly EmploymentStatus[] = [
  'probation',
  'active',
  'active_serving_notice',
  'resigned',
  'blacklisted',
] as const;

/** The lifecycle inputs the deriver reads. All optional/nullable — a field that is not captured is ignored. */
export type EmploymentStatusInput = {
  /** Effective confirmation date (extended ?? normal). Preferred; falls back to `confirmationDate`. */
  finalConfirmationDate?: string | null;
  confirmationDate?: string | null;
  /** Manual/administrative resignation date (HR override) — the effective resignation date. */
  resignationDate?: string | null;
  /** Physical final working day. */
  lastWorkingDate?: string | null;
  /** Termination date (voluntary or involuntary lifecycle end). */
  terminatedOn?: string | null;
  /** Non-null ⇒ the employment is blacklisted (highest-priority override). */
  blacklistedAt?: string | null;
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
  today: string = new Date().toISOString().slice(0, 10),
): EmploymentStatus {
  // 1. Blacklist — a deliberate HR override wins over every date-derived bucket.
  if (emp.blacklistedAt) return 'blacklisted';

  // 2. Resigned — the lifecycle has ended once today reaches the earliest of the recorded end dates. A
  //    future-dated end date does not resign the employee yet (it feeds "serving notice" below instead).
  const ended = earliest(emp.resignationDate, emp.lastWorkingDate, emp.terminatedOn);
  if (ended && today >= ended) return 'resigned';

  // 3. Active — Serving Notice: a resignation/last-working/termination is on the books but still in the future.
  if (ended && today < ended) return 'active_serving_notice';

  // 4. Probation — before the effective (extended ?? normal) confirmation date.
  const confirmation = emp.finalConfirmationDate ?? emp.confirmationDate ?? null;
  if (confirmation && today < confirmation) return 'probation';

  // 5. Active — past confirmation (or no confirmation date recorded), no resignation, not blacklisted.
  return 'active';
}
