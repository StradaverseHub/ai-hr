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
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { leaveVisual } from '@/lib/leave-visual';
// The pure row-derivation + sort + types live in a SERVER-SAFE module (no 'use client') so the RSC /me
// page can call deriveBalanceRow() without the "called from the server but it's on the client" crash
// (b7d84266). This client table only needs the sort + types.
import { sortBalanceRows, type LeaveBalanceRow, type NumCol, type SortKey } from './leave-balance-row';

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
