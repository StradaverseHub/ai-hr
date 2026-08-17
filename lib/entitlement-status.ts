/**
 * 31e39d74 — WHY A LEAVE TYPE READS 0.00, AS A VALUE INSTEAD OF AS A SILENCE.
 *
 * The reporter configured entitlement tables for Medical and Hospitalization Leave, saw 0.00 on My Leave,
 * and had no way to tell WHICH situation they were in. Their own words, verbatim:
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
 * idempotency open-marker and the expiry sweep's "year was opened" marker (core/leave.ts).
 *
 * ── THE CORRECTION THAT MADE THIS FILE'S SHAPE WHAT IT IS ───────────────────────────────────────────
 * ⚠️ THE FIRST CUT OF THIS DERIVATION TOOK THREE FACTS AND WAS WRONG ON THE COMMONEST LEAVE TYPE IN THE
 * PRODUCT. "A table is in force AND there is no accrual row" is NOT the same statement as "generation has
 * not run" — `openLeaveYear` has FIVE branches that write no row, and only one of them is answered by
 * pressing Generate Entitlement:
 *
 *   core/leave.ts branch          writes a row?   is "Run Generate Entitlement" the remedy?
 *   ── earned_method  (6302)      no              NO — earned types are accrueEarnedLeave's business; a
 *                                                 year-open logs `earned_method` and moves on, FOREVER.
 *   ── no_entitlement (6306)      no              NO — the band resolves 0 days; a run repeats the skip.
 *   ── frozen         (6271)      no              NO — ADR-0069 encashment freeze; a run skips it again.
 *   ── pack_blocked   (6252)      no              NO — the country pack is inactive.
 *   ── (fell through) (6377)      YES             — this is the only one, and it is `not_generated`.
 *
 * The earned branch is not an edge case: ANNUAL with an entitlement table — the ordinary shape of the
 * commonest leave type there is — takes it on EVERY year-open. Captioning that "Not yet generated" told
 * every employee with an earned Annual Leave, from cycle rollover until the first monthly accrual landed,
 * to press a button that would skip their type and change nothing. A remedy that cannot fire is worse than
 * the silent 0.00 it replaced: the silence at least did not send anyone anywhere.
 *
 * So the derivation now asks the SAME QUESTIONS THE ENGINE ASKS, IN THE ENGINE'S OWN ORDER, off the same
 * resolved policy the breakdown already computed (`isEarnedMethod(policy.method)`, `policy.days`) — not
 * off the absence of a row. `resolveEntitlementStatus` below is a mirror of core/leave.ts's loop, and the
 * order of its branches is the order of that loop's, deliberately.
 *
 * ── AND WHY NOT JUST READ THE OUTCOME THE ENGINE ALREADY LOGS ───────────────────────────────────────
 * It is written down: `leave_generation_run_item` stores the very `LeaveYearGrantOutcome` this file is
 * reconstructing. It is still the wrong source for THIS screen, for three separate reasons, and each one
 * alone would be enough:
 *   1. It exists only for runs launched from the Generate Entitlement screen (core/leave-generation.ts is
 *      the only writer, verified). A year opened any other way logs nothing, so the caption would be blank
 *      on exactly the tenants who have not used that screen — i.e. the ones with the problem.
 *   2. It is a record of an OPERATOR ACTION at a run date. This breakdown answers for an arbitrary `asOf`
 *      (a past leave year's panel is a first-class use), and a run log cannot say what the configuration
 *      resolved to in June 2025.
 *   3. It would cost a query on a read that already runs once PER LEAVE TYPE per screen.
 * The engine's INPUTS are already in hand here and its ORDER is copied exactly, which gives the same
 * answer with no new query, no new writer dependency, and no staleness.
 *
 * ── THE TWO THIS FILE CANNOT SEE, AND WHAT IT DOES ABOUT THEM ───────────────────────────────────────
 * `frozen` and `pack_blocked` are the remaining no-row branches, and neither is derivable from anything
 * `leaveEntitlementBreakdown` reads (an encashment snapshot and the company's country pack — two more
 * queries on a read that already runs once PER LEAVE TYPE per screen). They are therefore NOT invented as
 * statuses. They are DISCLOSED in `not_generated`'s own copy instead: the caption offers the run and then
 * names, in one clause, the two reasons it might not move the figure. Naming what we cannot distinguish is
 * honest; a fifth status that guessed between them would not be.
 *
 * ── ORDER MATTERS, AND THE ORDER IS DELIBERATE ──────────────────────────────────────────────────────
 * `earning_method_missing` OUTRANKS EVERYTHING BELOW IT, including `granted`. Telling HR "not generated
 * yet" while the type has no earning method sends them to press Generate Entitlement, which writes a 0.00
 * row and lands them straight back on a silent zero — the exact loop this item exists to break. The
 * earning method is the thing they can go and fix, so it is the thing they are told. It sits above
 * `earned_accrual` for the same reason the engine's `accrueEarnedLeave` gates on it first (core/leave.ts
 * 6910): an unconfigured type earns nothing however its method column reads.
 *
 * Per the plan, this SURFACES the reporter's data state; it never corrects it. Nothing here writes.
 *
 * DB-free and framework-free on purpose: `core/read.ts` computes the status server-side and the
 * server-safe presentation modules (`components/leave/leave-balance-row.ts`) and client islands both
 * consume the same union, so no screen can invent another meaning for 0.00.
 * Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */

/** Why a leave type's entitlement figure is what it is, for one (employment, leave type, as-at date). */
export type EntitlementStatus =
  /** An accrual row exists inside this leave year — the figure on screen is the generated entitlement. */
  | 'granted'
  /** A table applies, days resolve, the method is a lump grant, and no row exists yet. THE ONLY STATE FOR
   *  WHICH "Run Generate Entitlement" IS THE REMEDY — see the header's branch table. */
  | 'not_generated'
  /** A table applies and the method is `earned_monthly` / `earned_quarterly` / `earned_daily`: a year-open
   *  logs `earned_method` and grants nothing, now and always. The days arrive through the accrual sweep,
   *  so the figure is "none accrued yet", NOT "waiting for someone to press Generate Entitlement". */
  | 'earned_accrual'
  /** A table applies but resolves 0 days for this employee's length of service (no band covers them, or the
   *  band that does is configured at zero). `openLeaveYear` skips it as `no_entitlement` and will do so on
   *  every future run — the fix is in the table's service bands, not in a sweep. */
  | 'zero_entitlement'
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
  /** `isEarnedMethod(policy.method)` — the resolved earning method is one of the `earned_*` family, so the
   *  days come from `accrueEarnedLeave` and NEVER from a year-open. Read from the SAME resolved policy the
   *  breakdown's own `monthlyAccruedToDate` uses, so the caption and the figure cannot disagree. */
  earnedMethod: boolean;
  /** The whole-year days the winning band resolves to for this employee (`policy.days`) — the same number
   *  the breakdown prints as Eligible, and the same one `openLeaveYear`'s `days <= 0` guard tests. */
  entitlementDays: number;
  /** At least one `accrual` / `in_lieu_accrual` ledger row inside [cycleStart, asOf]. */
  hasAccrualRowInCycle: boolean;
}): EntitlementStatus {
  // Nothing configured ⇒ nothing to explain. Said FIRST so a tenant who has not written a table for a type
  // is never told their entitlement is "not generated yet" — there is nothing to generate.
  if (!p.hasTemplateInForce) return 'not_configured';
  // Ranked above everything below, including `granted`; see the header for why the order is the point.
  if (p.accrualUnconfigured) return 'earning_method_missing';
  // Days have landed for this cycle: the figure on screen IS the answer, whatever produced it.
  if (p.hasAccrualRowInCycle) return 'granted';
  // ── from here on: a table applies, a method is chosen, and the ledger is empty for this cycle. WHICH of
  // the engine's no-row branches is it? Asked in core/leave.ts's own order (earned before days<=0).
  if (p.earnedMethod) return 'earned_accrual';
  if (!(p.entitlementDays > 0)) return 'zero_entitlement';
  return 'not_generated';
}

/** True for the states a screen must SAY OUT LOUD beside the figure. `granted` needs no caption, and
 *  `not_configured` is the long-standing meaning of a blank row — announcing it on every unconfigured type
 *  would bury the ones that matter under noise on a tenant with a dozen types. */
export function entitlementStatusNeedsNotice(s: EntitlementStatus): boolean {
  return s !== 'granted' && s !== 'not_configured';
}

/** The i18n leaf under `me.leaveBalanceTable` (label) — one map so the table, the admin grid, the export and
 *  the breakdown panel can never label the same status two ways. */
export const ENTITLEMENT_STATUS_LABEL_KEY: Record<EntitlementStatus, string> = {
  granted: 'statusGenerated',
  not_generated: 'statusNotGenerated',
  earned_accrual: 'statusEarnedAccrual',
  zero_entitlement: 'statusZeroEntitlement',
  earning_method_missing: 'statusEarningMethodMissing',
  not_configured: 'statusNotConfigured',
};

/** The i18n leaf under `me.leaveBalanceTable` carrying the plain-English explanation shown on hover. Only
 *  the announced states have one — `granted` and `not_configured` are self-explanatory and show no icon. */
export const ENTITLEMENT_STATUS_TIP_KEY: Partial<Record<EntitlementStatus, string>> = {
  not_generated: 'statusNotGeneratedTip',
  earned_accrual: 'statusEarnedAccrualTip',
  zero_entitlement: 'statusZeroEntitlementTip',
  earning_method_missing: 'statusEarningMethodMissingTip',
};
