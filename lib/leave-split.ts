/**
 * fef49b9a — ONE derivation of the paid/unpaid breakdown, for the four surfaces that show a leave request.
 *
 * ## What was actually wrong
 *
 * The engine half has worked for a long time: when someone applies for more leave than their balance
 * covers, `leave_request.unpaid_days` records the shortfall on the SAME row, and payroll already routes
 * that figure through the unpaid-deduction path. Nothing about that changes here.
 *
 * What never happened is SAYING so. Every screen renders the request under its original leave type with
 * the total day count, so a five-day application that was really four days Annual and one day Unpaid
 * reads as five days Annual Leave. Five requests on production are in that state today.
 *
 * ## Why this is a shared function and not four subtractions
 *
 * The arithmetic is one line — and that is exactly the trap. Four copies of `days - unpaidDays` is how
 * two screens come to disagree about the same leave, which is the class of defect this item is. Every
 * surface calls `leaveDisplaySplit`; none of them subtracts anything itself.
 *
 * ## The contract
 *
 * - No split (`unpaidDays` null, zero, or somehow ≥ days) ⇒ ONE row, byte-identical to what the screen
 *   renders today. This is the overwhelmingly common case and it must stay unremarkable.
 * - A split ⇒ TWO rows whose days sum EXACTLY to the original total. The sum is asserted by test; a
 *   breakdown that does not add up is worse than no breakdown.
 * - The unpaid row is named from the tenant's own unpaid leave type when the caller can supply it. The
 *   approved plan asked for the leave-type ROLE marker to be used rather than a code literal — there is
 *   no `unpaid` role in `LeaveTypeRoleValue` (annual · sick · hospitalization · maternity · paternity ·
 *   emergency · replacement), so it cannot be done that way today. The caller resolves the name and
 *   passes it in; when it cannot, a translated fallback label is used. Recorded rather than silently
 *   diverging from the plan.
 *
 * Pure and client-safe: no db, no `next-intl` import, no server-only anything. The caller supplies both
 * labels already translated, so this file can be used from a client island and from a server component
 * without a second implementation.
 */

/** One line of a rendered leave request: a leave-type label and the days charged against it. */
export type LeaveSplitRow = {
  /** Already-translated display label. */
  label: string;
  /** Days charged to this label, rounded to 2dp like every other day figure in the product. */
  days: number;
  /** True for the unpaid portion, so a surface can style it without string-matching the label. */
  unpaid: boolean;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Coerce the numeric/string/null shapes the driver returns for a numeric column. */
const num = (v: number | string | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Split one leave request into the rows a surface should render.
 *
 * `days` and `unpaidDays` accept the raw projection shapes (numeric columns arrive as strings from the
 * driver) so no caller has to remember to Number() them — forgetting that is how "4" - "1" becomes NaN
 * on one screen and not another.
 */
export function leaveDisplaySplit(input: {
  /** The request's own leave type, already translated. */
  leaveTypeName: string;
  days: number | string | null | undefined;
  unpaidDays: number | string | null | undefined;
  /** The tenant's unpaid leave type name; falls back to `unpaidFallbackLabel` when absent. */
  unpaidTypeName?: string | null;
  /** Translated fallback, e.g. "Unpaid Leave". Only used when `unpaidTypeName` is not supplied. */
  unpaidFallbackLabel: string;
}): LeaveSplitRow[] {
  const total = round2(num(input.days));
  const unpaid = round2(num(input.unpaidDays));

  // Not split — or a stored figure that cannot be a partial split. Either way ONE row, exactly as today.
  // The `>= total` guard is deliberate rather than defensive: a request that is entirely unpaid is
  // already recorded under an unpaid leave TYPE, so a row claiming "0 days paid" would be an artefact of
  // this function rather than a fact about the leave.
  if (unpaid <= 0 || unpaid >= total) {
    return [{ label: input.leaveTypeName, days: total, unpaid: false }];
  }

  return [
    { label: input.leaveTypeName, days: round2(total - unpaid), unpaid: false },
    { label: input.unpaidTypeName || input.unpaidFallbackLabel, days: unpaid, unpaid: true },
  ];
}

/** True when a request would render as more than one row — for surfaces that only need the question. */
export const isLeaveSplit = (
  days: number | string | null | undefined,
  unpaidDays: number | string | null | undefined,
): boolean => {
  const t = round2(num(days));
  const u = round2(num(unpaidDays));
  return u > 0 && u < t;
};
