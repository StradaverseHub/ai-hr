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
  /** Ledger balance minus pending. null ⇒ ESS-hidden for this type. */
  available: number | null;
  taken: number | null;
  /** Prorated accrual-to-date, else full current-year entitlement. */
  entitlementToDate: number | null;
  broughtForward: number | null;
  /** Forfeited carry (expiry sweep / cap excess). */
  expiredBroughtForward: number | null;
  /** No aggregate exists yet (deferred; product must define). Always null in v1 ⇒ "—". */
  unplanned: number | null;
  adjustment: number | null;
  /** Derived max(0, -available): how far the type is over-drawn. */
  overutilized: number | null;
  /** Derived currentYearEntitlement + carriedForward. */
  ytdEntitled: number | null;
  /** RSC-instantiated <EntitlementBreakdown/> side-sheet trigger (R22). */
  detail?: ReactNode;
};

export type NumCol =
  | 'available'
  | 'taken'
  | 'entitlementToDate'
  | 'broughtForward'
  | 'expiredBroughtForward'
  | 'unplanned'
  | 'adjustment'
  | 'overutilized'
  | 'ytdEntitled';

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
  return {
    leaveTypeId: b.leaveTypeId,
    leaveType: b.leaveType,
    visual: { color: b.color, icon: b.icon, code: b.code },
    available: showAvailable ? b.available : null,
    taken: showTaken ? b.taken : null,
    // Entitlement to Date = prorated accrual-to-date for earned types, else the full current-year
    // entitlement (grant-on-open). Null when no breakdown was loaded for this type.
    entitlementToDate: bd ? (bd.monthlyAccruedToDate ?? bd.currentYearEntitlement) : null,
    broughtForward: bd ? bd.carriedForward : null,
    expiredBroughtForward: bd ? bd.forfeited : null,
    // No aggregate for emergency/"unplanned" leave exists yet — deferred (see plan). "—" in v1.
    unplanned: null,
    adjustment: bd ? bd.otherAdjustments : null,
    // Overutilized = how far the type is over-drawn. Gated with Available (its own negation) so a hidden
    // balance can't leak.
    overutilized: showAvailable ? Math.max(0, -b.available) : null,
    ytdEntitled: bd ? bd.currentYearEntitlement + bd.carriedForward : null,
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
