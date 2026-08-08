'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, inputCls } from '@/components/ui';
import { paginateRows } from '@/lib/pagination';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';

/**
 * 3e3d3fb2 — the TP1 Relief "Transaction history" list, with the search, sorting and paging the screen
 * never had (it had no listing at all: picking somebody dropped you straight into their declaration form).
 *
 * WHAT A ROW IS, SAID ONCE AND SAID HERE. An employee has ONE TP1 declaration per ASSESSMENT YEAR, not a
 * list of separate relief entries: the medical / education / insurance figures are lines INSIDE that one
 * declaration (components/tp1-declaration-form.tsx, laid out like the paper LHDN form) and stay there.
 * `tp1_relief` is append-only, so a correction is another row and the latest wins — core/tax-relief.ts
 * listTp1DeclarationsForPerson collapses those to the winning row per year and counts the rest. So this
 * list is one line per YEAR, never a version chain, and nothing in it may imply otherwise. The
 * month-by-month record is the "Applied in payroll" list below, which does have a row per payroll run.
 *
 * SORT BEFORE PAGE (components/client-pager.tsx): the whole matching set is ordered and then sliced, so a
 * column header cannot reorder twenty-five rows and leave the rest where they were. The pager keeps this
 * screen's own `dPage`/`dSize` names so paging one list never resets the other.
 *
 * ROWS ARE PLAIN DATA — no function prop crosses from the server page into this client island (r123's 500
 * was exactly that), and the destination of View / Edit arrives as a STRING the server built: the server
 * owns which employment the link may name, because its scope guard is the one that can be trusted. Every
 * caption resolves from the single `payroll.transactions.tp1` namespace so check C of
 * test/i18n-coverage.test.ts validates them key by key.
 */

export type Tp1DeclarationListRow = {
  id: string;
  assessmentYear: number;
  /** numeric(12,2) as it left the row — formatted here, never rounded here. */
  amount: string;
  status: 'draft' | 'submitted';
  /** Append-only rows behind this year, the winning one included (1 ⇒ no corrections). */
  versions: number;
  /** 'YYYY-MM-DD HH:MM' in the tenant timezone, resolved on the SERVER (see the page). */
  lastSaved: string;
  /** Where View / Edit opens — built by the server from its OWN resolved selection. */
  href: string;
  /** A closed assessment year is a read-only historical view, so the action reads View, not View / Edit. */
  readOnly: boolean;
};

type SortKey = 'year' | 'amount' | 'status' | 'lastSaved';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function Tp1DeclarationsList({ rows }: { rows: Tp1DeclarationListRow[] }) {
  const t = useTranslations('payroll.transactions.tp1');
  const q = useClientPageQuery({ page: 'dPage', size: 'dSize' });
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('year');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const statusLabel = (s: Tp1DeclarationListRow['status']) =>
    s === 'submitted' ? t('history.statusSubmitted') : t('history.statusDraft');

  const sorted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? rows.filter(
          (r) =>
            String(r.assessmentYear).includes(needle) ||
            r.amount.includes(needle) ||
            r.status.includes(needle) ||
            r.lastSaved.toLowerCase().includes(needle),
        )
      : rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: Tp1DeclarationListRow): string | number => {
      switch (sortKey) {
        case 'amount':
          return Number(r.amount);
        case 'status':
          return r.status;
        case 'lastSaved':
          return r.lastSaved;
        case 'year':
        default:
          return r.assessmentYear;
      }
    };
    return [...matched].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Deterministic tiebreak so two runs of the same sort never disagree about row order.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [rows, query, sortKey, sortDir]);

  const { rows: pageRows, state } = paginateRows(sorted, q);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      // Years and dates open newest-first; anything else reads as an accident.
      setSortDir(key === 'year' || key === 'lastSaved' ? 'desc' : 'asc');
    }
  };
  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortTh = (key: SortKey, label: string, extra = '') => (
    <th className={`px-4 py-2 font-medium ${extra}`}>
      <button type="button" onClick={() => toggleSort(key)} className="uppercase tracking-wide hover:text-foreground">
        {label}
        {arrow(key)}
      </button>
    </th>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('history.searchPlaceholder')}
          className={`${inputCls} max-w-xs`}
          aria-label={t('history.searchPlaceholder')}
        />
        <span className="text-xs text-muted-foreground">{t('history.nShown', { count: sorted.length })}</span>
      </div>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {sortTh('year', t('history.colYear'))}
              {sortTh('amount', t('history.colAmount'), 'text-right')}
              {sortTh('status', t('history.colStatus'))}
              {sortTh('lastSaved', t('history.colLastSaved'))}
              <th className="px-4 py-2 text-right font-medium">{t('history.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageRows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 font-medium tabular-nums">{r.assessmentYear}</td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(r.amount)}</td>
                <td className="px-4 py-2.5">
                  <Badge variant={r.status === 'submitted' ? 'success' : 'default'}>{statusLabel(r.status)}</Badge>
                  {/* The superseded rows behind this year, counted rather than listed — a correction is an
                      append, and three "2026" lines would read as three declarations. */}
                  {r.versions > 1 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('history.versions', { count: r.versions })}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.lastSaved}</td>
                <td className="px-4 py-2.5 text-right">
                  <Link
                    href={r.href}
                    className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {r.readOnly ? t('history.view') : t('history.viewEdit')}
                  </Link>
                </td>
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  {/* Empty is the state a reader sees FIRST here: production carries 2 declarations in
                      total. It must read as empty, not as an error. */}
                  {rows.length === 0 ? t('history.empty') : t('history.noMatches')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ClientPager state={state} paramNames={{ page: 'dPage', size: 'dSize' }} />
    </div>
  );
}
