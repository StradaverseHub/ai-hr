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
  /** Standardize Leave Balance Table (776cd1b5): computed final remaining balance —
   *  (Accrued + Carried Forward + Adjustment) − Taken − Overutilized. null ⇒ Accrued/Taken ESS-hidden. */
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
  // Standardize Leave Balance Table (776cd1b5): Balance = (Accrued + Carried Forward + Adjustment) − Taken −
  // Overutilized, where Accrued = available. Missing breakdown parts count as 0. Gated on Available AND Taken
  // being visible (Balance contains both) so a hidden figure can never leak through the computed column.
  const carried = bd ? bd.carriedForward : 0;
  const adj = bd ? bd.otherAdjustments : 0;
  const balance =
    showAvailable && showTaken
      ? Math.round((b.available + carried + adj - b.taken - Math.max(0, -b.available)) * 100) / 100
      : null;
  return {
    leaveTypeId: b.leaveTypeId,
    leaveType: b.leaveType,
    visual: { color: b.color, icon: b.icon, code: b.code },
    available: showAvailable ? b.available : null,
    taken: showTaken ? b.taken : null,
    broughtForward: bd ? bd.carriedForward : null,
    adjustment: bd ? bd.otherAdjustments : null,
    // Overutilized = how far the type is over-drawn. Gated with Available (its own negation) so a hidden
    // balance can't leak.
    overutilized,
    ytdEntitled: bd ? bd.currentYearEntitlement + bd.carriedForward : null,
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
