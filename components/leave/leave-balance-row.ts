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
  /** Derived currentYearEntitlement + carriedForward. */
  ytdEntitled: number | null;
  /** 31e39d74 — the caption the YTD Entitled cell needs when the figure is 0.00 for a reason. Carried on
   *  the ROW (not re-derived per screen) so My Leave, Employee Balances and its export cannot disagree
   *  about whether an entitlement is merely ungenerated. `not_configured` when no breakdown loaded — the
   *  honest read of "we know nothing about a table here". */
  entitlementStatus: EntitlementStatus;
  /** Standardize Leave Balance Table (776cd1b5): the authoritative ledger remaining balance (b.balance = sum
   *  of ledger days, shown GROSS of pending), surfaced directly — NOT re-derived (6574c6b4). null ⇒ Accrued/Taken
   *  ESS-hidden. */
  balance: number | null;
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
};

/** The subset of leaveEntitlementBreakdown this table consumes (null ⇒ no breakdown loaded for the type). */
export type BreakdownInput = {
  monthlyAccruedToDate: number | null;
  currentYearEntitlement: number;
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
 * side-sheet, which the RSC instantiates). Keeps the derivations (Overutilized, YTD Entitled) + the ESS
 * gating unit-testable without a DOM. A figure gated off by essView, or missing its breakdown, is `null` ⇒
 * the cell renders "—" and never leaks a hidden number.
 */
export function deriveBalanceRow(b: BalanceInput, bd: BreakdownInput): Omit<LeaveBalanceRow, 'detail'> {
  const showAvailable = b.essView.available !== false;
  const showTaken = b.essView.taken !== false;
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
    ytdEntitled: bd ? bd.currentYearEntitlement + bd.carriedForward : null,
    // 31e39d74 — deliberately NOT gated by essView. It is not a figure: it is the reason a figure reads
    // 0.00, and hiding the reason while showing the zero is precisely the silence the reporter raised.
    // No breakdown loaded ⇒ 'not_configured' (we cannot claim a table exists), which shows no caption.
    entitlementStatus: bd ? bd.entitlementStatus : 'not_configured',
    balance,
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
