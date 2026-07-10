'use client';

/**
 * Leave Balance summary table (feedback 483fa7c3) — Workday-style one-row-per-type balance grid for ESS /me.
 *
 * Replaces the per-type progress-bar cards with a single dense, scannable table so an employee can compare
 * every leave type across all balance components at a glance. Columns follow the reporter's spec:
 *   Leave Type | Available | Taken | Entitlement to Date | Brought Forward | Expired Brought Forward |
 *   Unplanned | Adjustment | Overutilized | YTD Entitled
 * Numeric cells are right-aligned tabular-nums, formatted "X.XX Days"; header clicks sort client-side
 * (nulls always last, direction toggles). The whole thing scrolls horizontally on narrow screens
 * (overflow-x-auto) since ten columns cannot fit a phone.
 *
 * DB-free client island: the RSC pre-joins leaveBalances + leaveEntitlementBreakdown into plain row data and
 * (for R22 preservation) hands each row an already-instantiated <EntitlementBreakdown/> trigger as `detail`,
 * so the per-type side-sheet ledger + its ?asOf= form + ESS-view gating + per-type visual all survive intact.
 * A `null` numeric cell (either not-yet-mapped "Unplanned", or a figure ESS-hidden for this type) renders "—".
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { leaveVisual } from '@/lib/leave-visual';

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

type NumCol =
  | 'available'
  | 'taken'
  | 'entitlementToDate'
  | 'broughtForward'
  | 'expiredBroughtForward'
  | 'unplanned'
  | 'adjustment'
  | 'overutilized'
  | 'ytdEntitled';

type SortKey = 'leaveType' | NumCol;

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

const NUM_COLS: { key: NumCol; labelKey: string }[] = [
  { key: 'available', labelKey: 'colAvailable' },
  { key: 'taken', labelKey: 'colTaken' },
  { key: 'entitlementToDate', labelKey: 'colEntitlementToDate' },
  { key: 'broughtForward', labelKey: 'colBroughtForward' },
  { key: 'expiredBroughtForward', labelKey: 'colExpiredBroughtForward' },
  { key: 'unplanned', labelKey: 'colUnplanned' },
  { key: 'adjustment', labelKey: 'colAdjustment' },
  { key: 'overutilized', labelKey: 'colOverutilized' },
  { key: 'ytdEntitled', labelKey: 'colYtdEntitled' },
];

export function LeaveBalanceTable({ rows }: { rows: LeaveBalanceRow[] }) {
  const t = useTranslations('me');
  const tt = useTranslations('me.leaveBalanceTable');
  // Default = leave-type ascending (mirrors the server's localeCompare sort).
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'leaveType', dir: 'asc' });

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noBalances')}</p>;
  }

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const sorted = sortBalanceRows(rows, sort.key, sort.dir);

  const fmt = (n: number | null) => (n == null ? '—' : tt('daysValue', { value: n.toFixed(2) }));
  const ariaSort = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  const caret = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" aria-sort={ariaSort('leaveType')} className="whitespace-nowrap py-2 pr-3 font-medium">
              <button
                type="button"
                onClick={() => toggle('leaveType')}
                aria-label={tt('sortBy', { column: tt('colLeaveType') })}
                className="inline-flex items-center font-medium hover:text-foreground"
              >
                {tt('colLeaveType')}
                <span aria-hidden>{caret('leaveType')}</span>
              </button>
            </th>
            {NUM_COLS.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={ariaSort(c.key)}
                className="whitespace-nowrap py-2 pl-3 text-right font-medium"
              >
                <button
                  type="button"
                  onClick={() => toggle(c.key)}
                  aria-label={tt('sortBy', { column: tt(c.labelKey) })}
                  className="inline-flex items-center font-medium hover:text-foreground"
                >
                  {tt(c.labelKey)}
                  <span aria-hidden>{caret(c.key)}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => {
            const visual = leaveVisual({ color: r.visual.color, icon: r.visual.icon, code: r.visual.code });
            const Icon = visual.Icon;
            return (
              <tr key={r.leaveTypeId} className="align-top">
                <th scope="row" className="whitespace-nowrap py-2.5 pr-3 text-left font-normal">
                  <span className="flex items-center gap-1.5">
                    <span className={visual.hasColor ? `rounded p-0.5 ${visual.chipClass}` : undefined}>
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                    </span>
                    <span className="font-medium text-foreground">{r.leaveType}</span>
                  </span>
                  {r.detail}
                </th>
                <td className="py-2.5 pl-3 text-right tabular-nums">
                  <span className={r.available != null && r.available < 0 ? 'font-medium text-destructive' : ''}>{fmt(r.available)}</span>
                </td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.taken)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.entitlementToDate)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.broughtForward)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.expiredBroughtForward)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-muted-foreground">{fmt(r.unplanned)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.adjustment)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums">
                  <span className={r.overutilized != null && r.overutilized > 0 ? 'font-medium text-destructive' : 'text-foreground'}>{fmt(r.overutilized)}</span>
                </td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.ytdEntitled)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
