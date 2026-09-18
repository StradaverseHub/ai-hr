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
import { otherContributors } from '@/lib/shared-leave-balance';
import { Info } from 'lucide-react';
import { leaveVisual } from '@/lib/leave-visual';
// 4a1abc4a: day figures print through the ONE shared formatter, never a local toFixed — see lib/day-format.ts.
import { DAY_DASH, formatDays } from '@/lib/day-format';
// The pure row-derivation + sort + types live in a SERVER-SAFE module (no 'use client') so the RSC /me
// page can call deriveBalanceRow() without the "called from the server but it's on the client" crash
// (b7d84266). This client table only needs the sort + types.
import { sortBalanceRows, type LeaveBalanceRow, type NumCol, type SortKey } from './leave-balance-row';
// 31e39d74: the label/tooltip mapping lives beside the union it describes, so the table, the admin grid and
// the export cannot label the same status three ways.
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  ENTITLEMENT_STATUS_TIP_KEY,
  entitlementStatusNeedsNotice,
} from '@/lib/entitlement-status';

// Standardize Leave Balance Table (776cd1b5): the trimmed, consistently-named column set —
// Leave Type | YTD Entitled | Accrued | Carried Forward | Taken | Adjustment | Overutilized | Balance.
// "Accrued" surfaces the existing `available` value; Balance is a new computed column (deriveBalanceRow). Each
// numeric column carries a STATIC plain-English hover tooltip (tipKey, no HR config). Order = display order.
const NUM_COLS: { key: NumCol; labelKey: string; tipKey: string }[] = [
  { key: 'ytdEntitled', labelKey: 'colYtdEntitled', tipKey: 'tip.ytdEntitled' },
  { key: 'available', labelKey: 'colAccrued', tipKey: 'tip.accrued' },
  { key: 'broughtForward', labelKey: 'colCarriedForward', tipKey: 'tip.carriedForward' },
  { key: 'taken', labelKey: 'colTaken', tipKey: 'tip.taken' },
  { key: 'adjustment', labelKey: 'colAdjustment', tipKey: 'tip.adjustment' },
  // 39136455 — the pooled transfer. The employee sees it for the SAME reason HR does: without it, a leave
  // type that borrows reads "taken 2, entitlement 0" and contradicts itself. 0.00 on every type that
  // spends its own balance, which is most of them.
  { key: 'share', labelKey: 'colShare', tipKey: 'tip.share' },
  { key: 'pendingShare', labelKey: 'colPendingShare', tipKey: 'tip.pendingShare' },
  { key: 'overutilized', labelKey: 'colOverutilized', tipKey: 'tip.overutilized' },
  { key: 'balance', labelKey: 'colBalance', tipKey: 'tip.balance' },
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

  // A null cell is "not mapped / ESS-hidden", NOT zero — it keeps the em dash rather than gaining a
  // "0.00 Days" label that would read as a real balance (4a1abc4a).
  const fmt = (n: number | null) => (n == null ? DAY_DASH : tt('daysValue', { value: formatDays(n) }));
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
                <span className="inline-flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => toggle(c.key)}
                    aria-label={tt('sortBy', { column: tt(c.labelKey) })}
                    className="inline-flex items-center font-medium hover:text-foreground"
                  >
                    {tt(c.labelKey)}
                    <span aria-hidden>{caret(c.key)}</span>
                  </button>
                  {/* Static plain-English hover tooltip on each calculated column (776cd1b5) — no HR config. */}
                  <span title={tt(c.tipKey)} aria-label={tt(c.tipKey)} className="shrink-0 cursor-help text-muted-foreground/70">
                    <Info className="size-3" aria-hidden />
                  </span>
                </span>
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
                  {/* r209 — ONE SHARED FIGURE, AND WHAT SHARES IT. `balance_source_type_id` makes this type
                      spend another's ledger (Emergency Leave draws on Annual Leave on production), so every
                      number on this row is the POOL's. Without the sentence the employee reads two rows
                      showing the same balance as two separate allowances and books both. Rendered under the
                      NAME rather than under a figure because it qualifies all of them at once. */}
                  {r.sharedBalance && otherContributors(r.sharedBalance, r.leaveType).length > 0 && (
                    <span className="mt-0.5 block whitespace-normal text-[11px] font-normal normal-case text-muted-foreground">
                      {tt('sharedBalanceWith', {
                        pool: r.sharedBalance.sourceLeaveTypeName,
                        types: otherContributors(r.sharedBalance, r.leaveType).join(', '),
                      })}
                    </span>
                  )}
                  {r.detail}
                </th>
                {/* Column order matches NUM_COLS: YTD Entitled | Accrued | Carried Forward | Taken | Adjustment | Overutilized | Balance. */}
                {/* 31e39d74 — the figure KEEPS its place and gains a caption beneath it. Replacing the number
                    with the caption was the obvious move and is wrong: YTD Entitled is
                    currentYearEntitlement + carriedForward, so an ungenerated type with a carry-in has a REAL
                    non-zero figure here, and hiding it to announce the status would trade one wrong reading
                    for another. The reporter's objection is to the SILENCE, not to the number. */}
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">
                  <div>{fmt(r.ytdEntitled)}</div>
                  {entitlementStatusNeedsNotice(r.entitlementStatus) && (
                    <div
                      className="mt-0.5 whitespace-nowrap text-[11px] font-normal normal-case text-amber-700 dark:text-amber-500"
                      title={tt(ENTITLEMENT_STATUS_TIP_KEY[r.entitlementStatus]!)}
                    >
                      {tt(ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus])}
                    </div>
                  )}
                </td>
                <td className="py-2.5 pl-3 text-right tabular-nums">
                  <span className={r.available != null && r.available < 0 ? 'font-medium text-destructive' : ''}>{fmt(r.available)}</span>
                </td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.broughtForward)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.taken)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">{fmt(r.adjustment)}</td>
                <td className="py-2.5 pl-3 text-right tabular-nums">
                  <span className={r.overutilized != null && r.overutilized > 0 ? 'font-medium text-destructive' : 'text-foreground'}>{fmt(r.overutilized)}</span>
                </td>
                <td className="py-2.5 pl-3 text-right tabular-nums">
                  <span className={r.balance != null && r.balance < 0 ? 'font-medium text-destructive' : 'font-medium text-foreground'}>{fmt(r.balance)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
