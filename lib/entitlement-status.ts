/**
 * 31e39d74 — WHY A LEAVE TYPE READS 0.00, AS A VALUE INSTEAD OF AS A SILENCE.
 *
 * The reporter configured entitlement tables for Medical and Hospitalization Leave, saw 0.00 on My Leave,
 * and had no way to tell WHICH of four different situations they were in. Their own words, verbatim:
 * "the system should clearly indicate that the entitlement is configured but not yet generated, rather
 * than silently showing 0.00".
 *
 * r193 fixed the ENGINE (a9d0a94a: tables read from the date they apply, mid-year joiners included, a sole
 * table applied without a rule). This is the other half — the screen saying which state it is in, so the
 * next 0.00 is answerable without reading the ledger.
 *
 * ── WHY IT CANNOT BE INFERRED FROM THE LEDGER ALONE ─────────────────────────────────────────────────
 * `openLeaveYear` skips a pair with `days <= 0` (outcome `no_entitlement`) and writes NO ledger row at all,
 * so "no rows" cannot distinguish "never generated" from "generated and worth nothing". And the
 * `accrual_unconfigured` path DOES write a row — a 0.00 accrual, deliberately, because that row is the
 * idempotency open-marker and the expiry sweep's "year was opened" marker (core/leave.ts). So the answer
 * needs THREE facts, not one:
 *
 *   1. does an entitlement table resolve for this (employment, leave type) at this date?
 *   2. does the leave type carry the `accrual_unconfigured` marker (no earning method chosen)?
 *   3. is there an accrual row inside this leave year / cycle?
 *
 * ── ORDER MATTERS, AND THE ORDER IS DELIBERATE ──────────────────────────────────────────────────────
 * `earning_method_missing` OUTRANKS `not_generated` when both are true. Telling HR "not generated yet"
 * while the type has no earning method sends them to press Generate Entitlement, which writes a 0.00 row
 * and lands them straight back on a silent zero — the exact loop this item exists to break. The earning
 * method is the thing they can go and fix, so it is the thing they are told.
 *
 * Per the plan, this SURFACES the reporter's data state; it never corrects it. Nothing here writes.
 *
 * DB-free and framework-free on purpose: `core/read.ts` computes the status server-side and the
 * server-safe presentation modules (`components/leave/leave-balance-row.ts`) and client islands both
 * consume the same union, so no screen can invent a fourth meaning for 0.00.
 * Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */

/** Why a leave type's entitlement figure is what it is, for one (employment, leave type, as-at date). */
export type EntitlementStatus =
  /** An accrual row exists inside this leave year — the figure on screen is the generated entitlement. */
  | 'granted'
  /** A table applies, and generation has not run for this leave year yet. The 0.00 is a NOT-YET, not a nil. */
  | 'not_generated'
  /** A table applies, but the leave type has no earning method, so generation grants 0.00 until HR sets one
   *  (`leave_type.accrual_unconfigured`, bc36c768). HR's own setting — named, never changed here. */
  | 'earning_method_missing'
  /** No entitlement table resolves for this employee and type at this date. 0.00 is the true answer. */
  | 'not_configured';

export function resolveEntitlementStatus(p: {
  /** An entitlement template resolved for this (employment, leave type) as at the breakdown's date. */
  hasTemplateInForce: boolean;
  /** `leave_type.accrual_unconfigured` is set — no earning method has been chosen for the type. */
  accrualUnconfigured: boolean;
  /** At least one `accrual` / `in_lieu_accrual` ledger row inside [cycleStart, asOf]. */
  hasAccrualRowInCycle: boolean;
}): EntitlementStatus {
  // Nothing configured ⇒ nothing to explain. Said FIRST so a tenant who has not written a table for a type
  // is never told their entitlement is "not generated yet" — there is nothing to generate.
  if (!p.hasTemplateInForce) return 'not_configured';
  // Ranked above `not_generated`; see the header for why the order is the whole point.
  if (p.accrualUnconfigured) return 'earning_method_missing';
  if (!p.hasAccrualRowInCycle) return 'not_generated';
  return 'granted';
}

/** True for the two states a screen must SAY OUT LOUD beside the figure. `granted` needs no caption, and
 *  `not_configured` is the long-standing meaning of a blank row — announcing it on every unconfigured type
 *  would bury the two that matter under noise on a tenant with a dozen types. */
export function entitlementStatusNeedsNotice(s: EntitlementStatus): boolean {
  return s === 'not_generated' || s === 'earning_method_missing';
}

/** The i18n leaf under `me.leaveBalanceTable` (label) — one map so the table, the admin grid, the export and
 *  the breakdown panel can never label the same status two ways. */
export const ENTITLEMENT_STATUS_LABEL_KEY: Record<EntitlementStatus, string> = {
  granted: 'statusGenerated',
  not_generated: 'statusNotGenerated',
  earning_method_missing: 'statusEarningMethodMissing',
  not_configured: 'statusNotConfigured',
};

/** The i18n leaf under `me.leaveBalanceTable` carrying the plain-English explanation shown on hover. Only
 *  the two notice states have one — the other two are self-explanatory and show no icon. */
export const ENTITLEMENT_STATUS_TIP_KEY: Partial<Record<EntitlementStatus, string>> = {
  not_generated: 'statusNotGeneratedTip',
  earning_method_missing: 'statusEarningMethodMissingTip',
};
