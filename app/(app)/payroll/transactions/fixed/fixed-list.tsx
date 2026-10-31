'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, inputCls } from '@/components/ui';
import { formatMoney } from '@/lib/money';

/**
 * f3ae3245 — the selected employee's recurring items, with the search, sorting and paging the screen has
 * never had.
 *
 * WHY THIS MATTERS MORE HERE THAN ANYWHERE ELSE, and it is not a general tidiness argument. Changing a
 * recurring item does not overwrite it: `updateEmploymentPayComponent` closes the current value at the new
 * effective date and INSERTS a new row (core/pay-components.ts). So every edit adds a line. A list with no
 * sort and no paging therefore gets steadily harder to read in exactly the situation the redesign is meant
 * to improve, and the widened workspace would have made that MORE visible, not less.
 *
 * ROW SHAPE: EXACTLY THE COLUMNS THAT EXIST. Pay item, amount, payroll cycle, effective date, end date,
 * status. The request's sketch also asked for Input, Input Type, Input Value and Calculated Amount — none
 * of those exist for a recurring item (they are the one-off ledger's quantity/unit) and empty columns are
 * worse than absent ones, so they are not here. Status is DERIVED (`validTo` in the past ⇒ ended) and has
 * exactly the two honest values; superseded rows never reach this list at all, so "removed" can never
 * render as a status.
 *
 * MONEY GOES THROUGH `formatMoney`. The old table printed `Number(amount).toFixed(2)` — a bare number with
 * no currency at all, on a screen whose rows carry a stored currency.
 *
 * Sorting/searching/paging are CLIENT-side over the rows already on the page, matching the Individual
 * Transaction listing beside it. That is deliberate parity, and it is honest at this size: the list is one
 * employee's recurring items, not a tenant-wide table.
 */

export type FixedTxnRow = {
  id: string;
  code: string;
  name: string;
  /** numeric(12,2) as a string, straight from the row. */
  amount: string;
  currency: string | null;
  validFrom: string;
  validTo: string | null;
  /** null on legacy rows and on anything written by the people-detail editor. */
  runType: string | null;
  /** 4fffe638 — the linked configured Payroll Cycle's name; null when the row is not linked. */
  cycleName: string | null;
  remarks: string | null;
  /** Derived on the SERVER against the tenant timezone — a browser an hour either side of MYT midnight
   *  would otherwise call an item ended a day early or late. */
  ended: boolean;
};

const PAGE_SIZE = 20;
type SortKey = 'code' | 'amount' | 'validFrom' | 'validTo' | 'status';

export function FixedTxnList({
  rows,
  employmentId,
  cycleLabels,
  cycleUnspecifiedLabel,
}: {
  rows: FixedTxnRow[];
  employmentId: string;
  /** Pre-translated `runType` → label map, resolved on the server. A client component cannot look these
   *  up from the `payroll.transactions.individual` namespace without becoming a second-namespace file,
   *  which is precisely the shape the i18n coverage check skips entirely. */
  cycleLabels: Record<string, string>;
  cycleUnspecifiedLabel: string;
}) {
  const t = useTranslations('payroll.transactions.fixed');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('code');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? rows.filter(
          (r) =>
            r.code.toLowerCase().includes(q) ||
            r.name.toLowerCase().includes(q) ||
            (r.remarks ?? '').toLowerCase().includes(q) ||
            r.amount.includes(q) ||
            r.validFrom.includes(q) ||
            (r.validTo ?? '').includes(q),
        )
      : rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: FixedTxnRow): string | number => {
      switch (sortKey) {
        case 'amount':
          return Number(r.amount);
        case 'validFrom':
          return r.validFrom;
        case 'validTo':
          // An open-ended item sorts LAST ascending: "no end date" is later than any date, not earlier,
          // and '' would put it first.
          return r.validTo ?? '9999-12-31';
        case 'status':
          return r.ended ? 1 : 0;
        case 'code':
        default:
          return r.code;
      }
    };
    return [...matched].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Within one pay item the effective date is the reading order — which is also the order the
      // versioning chain was written in — then id for a deterministic tiebreak.
      if (a.validFrom !== b.validFrom) return a.validFrom < b.validFrom ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [rows, query, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'validFrom' || key === 'validTo' ? 'desc' : 'asc');
    }
  };
  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortTh = (key: SortKey, label: string, extra = '') => (
    <th className={`px-3 py-2 font-medium ${extra}`}>
      <button type="button" onClick={() => toggleSort(key)} className="uppercase tracking-wide hover:text-foreground">
        {label}
        {arrow(key)}
      </button>
    </th>
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder={t('searchTxnPlaceholder')}
          className={`${inputCls} max-w-xs`}
        />
        <span className="text-xs text-muted-foreground">{t('nShown', { count: sorted.length })}</span>
      </div>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {sortTh('code', t('payrollItem'))}
              {sortTh('amount', t('amount'), 'text-right')}
              <th className="px-3 py-2 font-medium">{t('payrollCycle')}</th>
              {sortTh('validFrom', t('startDate'))}
              {sortTh('validTo', t('endDate'))}
              {sortTh('status', t('status'))}
              <th className="px-3 py-2 text-right font-medium">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {rows.length === 0 ? t('noTransactions') : t('noMatches')}
                </td>
              </tr>
            )}
            {pageRows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2.5">
                  <span className="font-mono text-xs">{r.code}</span>{' '}
                  <span className="text-muted-foreground">{r.name}</span>
                </td>
                <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                <td className="px-3 py-2.5">
                  {/* 4fffe638 — the linked cycle's name; else the old run-type label (a row the one-match
                      backfill could not resolve); else "unspecified" (legacy + people-editor rows). */}
                  {r.cycleName ?? (r.runType ? (cycleLabels[r.runType] ?? r.runType) : cycleUnspecifiedLabel)}
                </td>
                <td className="px-3 py-2.5 tabular-nums">{r.validFrom}</td>
                <td className="px-3 py-2.5 tabular-nums">{r.validTo ?? '—'}</td>
                <td className="px-3 py-2.5">
                  <Badge variant={r.ended ? 'default' : 'success'}>
                    {r.ended ? t('statusEnded') : t('statusActive')}
                  </Badge>
                </td>
                <td className="px-3 py-2.5 text-right">
                  {/* One destination, not three disclosure widgets wedged into the cell. Edit, Stop and
                      Remove all live on the item's own page now. */}
                  <Link
                    href={`/payroll/transactions/fixed/${r.id}?employmentId=${encodeURIComponent(employmentId)}`}
                    className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {t('viewEdit')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('prevPage')}
          </button>
          <span className="text-muted-foreground">{t('pageOf', { page: safePage + 1, total: pageCount })}</span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
            className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('nextPage')}
          </button>
        </div>
      )}
    </>
  );
}
