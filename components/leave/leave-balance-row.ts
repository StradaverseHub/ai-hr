/**
 * Pure leave-balance row derivations — SERVER-SAFE (no 'use client', no React runtime).
 *
 * Extracted from leave-balance-table.tsx (a 'use client' island) so the RSC /me page can call
 * deriveBalanceRow() at render time. Importing a function out of a 'use client' module and calling it
 * from the server throws "Attempted to call X from the server but X is on the client" — which took the
 * whole My Profile page down (feedback b7d84266). Keeping the pure column-mapping + sort here, with no
 * client directive, lets both the Server Component (app/me/page.tsx) and the client table import it.
 *
 * Substrate: pure presentation math, no DomainEvent. // substrate: read-only, no event
 */
import type { ReactNode } from 'react';
import type { EntitlementStatus } from '@/lib/entitlement-status';
import type { SharedLeaveBalanceInfo } from '@/lib/shared-leave-balance';

export type LeaveBalanceRow = {
  leaveTypeId: string;
  leaveType: string;
  visual: { color: string | null; icon: string | null; code: string | null };
  /** Ledger balance minus pending — shown as the "Accrued" column (776cd1b5). null ⇒ ESS-hidden for this type. */
  available: number | null;
  taken: number | null;
  /** Carry brought into the current cycle — shown as the "Carried Forward" column. */
  broughtForward: number | null;
  adjustment: number | null;
  /** Derived max(0, -available): how far the type is over-drawn. */
  overutilized: number | null;
  /** r279 — EARNED TO DATE. `currentYearEntitlement` alone: the accrual-class ledger sum between cycle start
   *  and the as-at date, i.e. what this person has actually earned so far. It is NOT the year's allowance —
   *  that is `fullEntitlement` below, and the reporter's request to rename this one "Full Entitlement" was
   *  answered the other way round for exactly that reason (the understatement closes on 31 December, so the
   *  wrong name would look right in January, when someone finally checked it).
   *
   *  THE FIELD KEEPS THE NAME `ytdEntitled` ON PURPOSE. That string is a stored ESS view component key
   *  (`core/ess-view.ts`, persisted per leave type in `leave_type.ess_view_config`), so renaming the field
   *  would be a data migration for a label change. Only the LABEL moved: `me.leaveBalanceTable.colYtdEntitled`
   *  now reads "Earned to Date".
   *
   *  `+ bd.carriedForward` WAS DROPPED HERE. The Explain panel's YTD Entitled line has only ever read
   *  `currentYearEntitlement`, and Brought Forward is already its own column — a column called Earned to Date
   *  that silently folds in last year's leftovers is the same mismatch the rename exists to close. Every
   *  production balance carried 0 when this shipped, so no displayed figure moved; test/r279-earned-and-full-
   *  entitlement.test.ts pins BOTH halves of that (equal at carry 0, apart by exactly the carry otherwise).
   *
   *  r335 (6af80f5d) — AND IT IS NOW ROUNDED BY THE LEAVE TYPE'S RULE. The column showed the raw ledger
   *  running total while the Explain panel, one click away, already NAMED the rounding table that was
   *  supposed to shape it. It now reads `currentYearEntitlementRounded` — the same figure through
   *  `applyRounding`, derived once in core/read.ts. Byte-identical whenever no rounding is configured.
   *  The Balance column did NOT follow it: the balance is the authoritative ledger remaining and is an
   *  identity, so 11.18 earned with 5.00 taken prints Earned to Date 11.00 beside Balance 6.18. */
  ytdEntitled: number | null;
  /** r279 — ENTITLEMENT: this employee's allowance FOR THIS LEAVE YEAR, before carry, adjustment or usage.
   *
   *  845903a3 (r313) — it was the whole year's band figure, "before proration", and the column was headed
   *  "Full Entitlement" to say so. It is now PRORATED for an employee who joined part way through the
   *  leave year, and rounded by the leave type's own Entitlement rounding rule, so the column says what
   *  this person is entitled to this year. The label lost the word "Full" in all six locales for the same
   *  reason. Earned to Date beside it is untouched — a different question, still answered the same way.
   *
   *  It is `bd.eligibleDays` PICKED, never recomputed. That field already resolves the winning entitlement
   *  band in `core/read.ts` and is what the Explain panel renders as `leave.breakdown.field.eligible`;
   *  resolving a band again in the grid would make the grid a SECOND resolver, and the two would drift the
   *  first time a tie-break or an eligibility rule changed.
   *
   *  0 when no entitlement table resolves for the type (15 of 16 types today have none) — an honest 0.00
   *  beside the status caption that already explains it, not a gap. null ⇒ no breakdown loaded at all, or
   *  the `eligible` ESS row is hidden for this type. */
  fullEntitlement: number | null;
  /** 39136455 — SHARE: the finalised transfer between members of one pooled balance. On the row that LENDS
   *  the days out (the pool's own type) it is the sum of what every borrower took; on a borrower it is what
   *  that borrower took. 0 for a leave type that spends its own balance — an honest zero, because "how many
   *  days moved" always has an answer for such a type. Gated on Taken, because it is the same days seen from
   *  the pool's side: a tenant that hides what an employee has taken must not get the figure back through
   *  this column.
   *  2a57a007 — BOTH HALVES ARE POSITIVE. The pool row used to carry a minus; the sign is decided in
   *  core/read.ts and that comment records why the pooled-balance invariant does not depend on it. */
  share: number | null;
  /** 39136455 — PENDING SHARE: the same, for days reserved by an application that is still awaiting a
   *  decision. Gated on Available, which is the figure pending already moves. */
  pendingShare: number | null;
  /** 31e39d74 — the caption the YTD Entitled cell needs when the figure is 0.00 for a reason. Carried on
   *  the ROW (not re-derived per screen) so My Leave, Employee Balances and its export cannot disagree
   *  about whether an entitlement is merely ungenerated. `not_configured` when no breakdown loaded — the
   *  honest read of "we know nothing about a table here". */
  entitlementStatus: EntitlementStatus;
  /** Standardize Leave Balance Table (776cd1b5): the authoritative ledger remaining balance (b.balance = sum
   *  of ledger days, shown GROSS of pending), surfaced directly — NOT re-derived (6574c6b4). null ⇒ Accrued/Taken
   *  ESS-hidden. */
  balance: number | null;
  /** r209 — present when this leave type's figures ARE another type's pool (`balance_source_type_id`).
   *  Carried on the row so the caption naming the pool travels with the number it explains, and every grid
   *  says the same thing. `null` for a type that spends its own balance, which is almost all of them. */
  sharedBalance: SharedLeaveBalanceInfo | null;
  /** RSC-instantiated <EntitlementBreakdown/> side-sheet trigger (R22). */
  detail?: ReactNode;
};

// Standardize Leave Balance Table (776cd1b5): trimmed to the columns that help an employee read their balance —
// entitlementToDate, expiredBroughtForward and the always-empty unplanned column are dropped; a computed
// balance column is added. Order here is the display order (matched by the table body).
export type NumCol =
  | 'ytdEntitled'
  | 'available'
  | 'broughtForward'
  | 'taken'
  | 'adjustment'
  // 39136455 — the two pooled-transfer columns, sortable like every other figure beside them.
  | 'share'
  | 'pendingShare'
  | 'overutilized'
  | 'balance';

export type SortKey = 'leaveType' | NumCol;

/** Balance-row inputs the RSC already loaded (leaveBalances). */
export type BalanceInput = {
  leaveTypeId: string;
  leaveType: string;
  color: string | null;
  icon: string | null;
  code: string | null;
  /** Authoritative ledger remaining (sum of ledger days), GROSS of pending — surfaced as Balance (6574c6b4). */
  balance: number;
  available: number;
  taken: number;
  /** Employee Leave View Configuration (65dec703): resolved per-component visibility (missing ⇒ visible). */
  essView: Record<string, boolean>;
  /** r209 — the shared-pool descriptor `leaveBalances` attaches when this type draws on another's balance.
   *  Optional so existing fixtures and callers that predate the pool compile unchanged. */
  sharedBalance?: SharedLeaveBalanceInfo | null;
  /** 39136455 — the pooled transfer `leaveBalances` computes in the same pass as `sharedBalance`. Optional
   *  so every non-pooled caller and every fixture stays byte-identical; absent ⇒ 0, i.e. shares nothing. */
  share?: number | null;
  pendingShare?: number | null;
};

/** The subset of leaveEntitlementBreakdown this table consumes (null ⇒ no breakdown loaded for the type). */
export type BreakdownInput = {
  monthlyAccruedToDate: number | null;
  /** r279 — the winning policy's FULL-YEAR days (`LeaveEntitlementBreakdown.eligibleDays`). No longer the
   *  Entitlement column's source (see `entitlement` below), but still required: it is the figure the
   *  proration is taken FROM, and several captions name it. */
  eligibleDays: number;
  /** 845903a3 (r313) — the ENTITLEMENT column's source: the prorated, rounded figure plus its working.
   *  Required rather than optional so a call site handing this helper a hand-built breakdown cannot
   *  silently render an em dash where a band exists — the same reason `eligibleDays` is required. */
  entitlement: { displayEntitlementDays: number };
  currentYearEntitlement: number;
  /** r335 (6af80f5d) — the Earned to Date COLUMN's source: `currentYearEntitlement` through the leave
   *  type's Rounding Method, derived in core/read.ts. Required, not optional, for the same reason
   *  `entitlement` above is: a call site handing this helper a hand-built breakdown must not silently fall
   *  back to the unrounded figure, which is precisely the defect this field exists to fix. */
  currentYearEntitlementRounded: number;
  carriedForward: number;
  forfeited: number;
  otherAdjustments: number;
  /** 0315dac7: the CONFIG-only adjustment total (festive / one-off / manual grants, both signs) — what the
   *  Adjustment column shows, so this table and the breakdown panel name the same number. */
  configAdjustments: number;
  /** 31e39d74: computed server-side (core/read.ts) and PICKED here — never re-derived from the figures,
   *  because two of the four states are indistinguishable from the numbers alone. */
  entitlementStatus: EntitlementStatus;
} | null;

/**
 * Pure column mapping — the single source of truth for every figure in a table row (sans the `detail`
 * side-sheet, which the RSC instantiates). Keeps the derivation (Overutilized) + the ESS
 * gating unit-testable without a DOM. A figure gated off by essView, or missing its breakdown, is `null` ⇒
 * the cell renders "—" and never leaks a hidden number.
 */
export function deriveBalanceRow(b: BalanceInput, bd: BreakdownInput): Omit<LeaveBalanceRow, 'detail'> {
  const showAvailable = b.essView.available !== false;
  const showTaken = b.essView.taken !== false;
  // r279 — Full Entitlement rides the ESS key the SAME figure already has in the panel (`eligible`). HR's own
  // grid passes an empty essView, so it is always visible there; on an employee-facing surface a tenant that
  // has hidden the panel's Eligible row must not get the identical number back as a grid column.
  const showEligible = b.essView.eligible !== false;
  const overutilized = showAvailable ? Math.max(0, -b.available) : null;
  // Balance = the authoritative ledger remaining (b.balance = sum of ledger days, already nets entitlement +
  // carried + adjustments − taken − forfeited), surfaced DIRECTLY rather than re-derived (6574c6b4). The old
  // formula re-added carried/adjustments and re-subtracted taken over the ledger sum — a double-count that turned
  // a true +14 into −14. Shown GROSS of pending (the adjacent Accrued column shows balance − pending). Still gated
  // on Available AND Taken being visible so a hidden figure can never leak through this column.
  const balance = showAvailable && showTaken ? Math.round(b.balance * 100) / 100 : null;
  return {
    leaveTypeId: b.leaveTypeId,
    leaveType: b.leaveType,
    visual: { color: b.color, icon: b.icon, code: b.code },
    available: showAvailable ? b.available : null,
    taken: showTaken ? b.taken : null,
    // 39136455 — the two halves of a pooled transfer, gated by the figure each one IS.
    share: showTaken ? (b.share ?? 0) : null,
    pendingShare: showAvailable ? (b.pendingShare ?? 0) : null,
    broughtForward: bd ? bd.carriedForward : null,
    // Adjustment = the CONFIG adjustments only (0315dac7). It used to be `otherAdjustments`, which commingles
    // HR's festive / one-off grants with the automatic `sys:policy_recalc` corrections (and drops
    // `sys:profile_recalc` and every negative row). The breakdown panel's Adjustment line reads the same
    // configAdjustments bucket, so the table and the panel can never disagree about "Adjustment" — the
    // feedback's single-source-of-truth requirement. System corrections are labelled separately in the panel.
    adjustment: bd ? bd.configAdjustments : null,
    // Overutilized = how far the type is over-drawn. Gated with Available (its own negation) so a hidden
    // balance can't leak.
    overutilized,
    // r279 — Earned to Date. `currentYearEntitlement` ONLY; see the field's doc above for why the
    // `+ bd.carriedForward` that used to be here is gone and why the field name did not change with the label.
    // r335 (6af80f5d) — and now that figure THROUGH THE LEAVE TYPE'S ROUNDING METHOD. Still a PICK: the
    // rounding happens once, in core/read.ts's `displayEarnedToDateDays`, so this file cannot become a
    // second place a rounding table is read. The Balance column beside it is UNCHANGED and still exact —
    // it is the authoritative ledger remaining, an identity rather than an agreement, so a row can honestly
    // read Earned to Date 11.00 beside Balance 6.18.
    ytdEntitled: bd ? bd.currentYearEntitlementRounded : null,
    // r279 — ENTITLEMENT. A PICK off the breakdown, never a re-resolved band.
    // 845903a3 (r313): the pick moved from `eligibleDays` (the table's whole-year allowance) to the
    // prorated, rounded figure the kernel derives from it. Still a pick, still one resolver — the
    // proration and its rounding happen in `displayEntitlementFor`, not here, so this file cannot
    // become a second place the number is decided.
    fullEntitlement: bd && showEligible ? bd.entitlement.displayEntitlementDays : null,
    // 31e39d74 — deliberately NOT gated by essView. It is not a figure: it is the reason a figure reads
    // 0.00, and hiding the reason while showing the zero is precisely the silence the reporter raised.
    // No breakdown loaded ⇒ 'not_configured' (we cannot claim a table exists), which shows no caption.
    entitlementStatus: bd ? bd.entitlementStatus : 'not_configured',
    balance,
    // r209 — NOT ESS-gated, for the same reason the status is not: it is not a figure, it is the sentence
    // that says whose figure this is. Hiding "shared with Annual Leave" while showing the shared number is
    // how an employee concludes they have two allowances when they have one.
    sharedBalance: b.sharedBalance ?? null,
  };
}

/** Pure sort used by the table header buttons: nulls always last, then numeric/locale compare by direction. */
export function sortBalanceRows<T extends LeaveBalanceRow>(rows: T[], key: SortKey, dir: 'asc' | 'desc'): T[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'leaveType') return mul * a.leaveType.localeCompare(b.leaveType);
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return mul * (av - bv);
  });
}
