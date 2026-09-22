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
 * WHAT A ROW IS, SAID ONCE AND SAID HERE — AND CHANGED BY 7ad37961. This list used to be one line per
 * ASSESSMENT YEAR, because a year held exactly one declaration. The official LHDN TP1 (1/2026) has a
 * DEDUCTION MONTH box, so a year legitimately holds up to twelve, and collapsing them would hide eleven
 * real records. It is now ONE LINE PER DEDUCTION MONTH within the year the page selected — January,
 * February, March — which is what the reporter sketched.
 *
 * THE HALF OF THE OLD RULE THAT WAS NEVER ABOUT YEARS IS KEPT, UNCHANGED. `tp1_relief` is append-only, so
 * a CORRECTION is another row and the latest wins; core/tax-relief.ts listTp1DeclarationsForPersonYear
 * collapses those to the winning row PER MONTH and counts the rest as `versions`. Two competing lines for
 * the same month would read as two declarations, which is the confusion the collapse exists to prevent.
 *
 * A DECLARATION WRITTEN BEFORE THIS ROUND HAS NO MONTH, and is not given one: it shows as a single
 * month-less line, sorted last, labelled for what it is. The relief figures themselves are lines INSIDE a
 * declaration (components/tp1-declaration-form.tsx) and stay there. The record of what payroll actually
 * deducted is the "Applied in payroll" list below, which has a row per processed run.
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
  /** 1–12, or null for a pre-7ad37961 whole-year declaration. */
  deductionMonth: number | null;
  /**
   * The month's name, ALREADY TRANSLATED by the server page. Resolved there rather than here because
   * this screen deliberately resolves every caption from ONE namespace (payroll.transactions) so check C
   * of test/i18n-coverage.test.ts validates it key by key — and a month name comes from Intl, not from a
   * message catalogue, so twelve hand-written names in six locales would be six copies of the calendar.
   */
  monthLabel: string;
  /** numeric(12,2) as it left the row — formatted here, never rounded here. */
  amount: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  /** Append-only rows behind this month, the winning one included (1 ⇒ no corrections). */
  versions: number;
  /** 'YYYY-MM-DD HH:MM' in the tenant timezone, resolved on the SERVER (see the page). */
  lastSaved: string;
  /** Where View / Edit opens — built by the server from its OWN resolved selection. */
  href: string;
  /** A closed assessment year is a read-only historical view, so the action reads View, not View / Edit. */
  readOnly: boolean;
  /**
   * 27605faa rev 2 — where Delete goes: a LINK to a server-rendered confirmation, never an action.
   *
   * A STRING, and that is the point. This is a client island, and a server action handed across that
   * boundary as a prop returns a 500 on every request while tsc, the suite and next build all stay green
   * (r123's defect, recorded on the TP1 declaration form too). An href also gives the reporter the
   * confirmation step they asked for, and works with no JavaScript at all.
   *
   * NULL for a row that cannot be deleted — a rejected declaration, which both services refuse: the
   * screen must not offer an action that can only end in a refusal.
   */
  deleteHref: string | null;
};

type SortKey = 'year' | 'month' | 'amount' | 'status' | 'lastSaved';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function Tp1DeclarationsList({ rows }: { rows: Tp1DeclarationListRow[] }) {
  const t = useTranslations('payroll.transactions.tp1');
  const q = useClientPageQuery({ page: 'dPage', size: 'dSize' });
  const [query, setQuery] = useState('');
  // Months open in calendar order (January first), which is the order the reporter's own sketch shows.
  const [sortKey, setSortKey] = useState<SortKey>('month');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const statusLabel = (s: Tp1DeclarationListRow['status']) => t(`history.status_${s}`);
  /** Approved is the only status that feeds payroll, so it is the only one that reads as success. */
  const statusVariant = (s: Tp1DeclarationListRow['status']) =>
    s === 'approved' ? 'success' : s === 'rejected' || s === 'cancelled' ? 'danger' : 'default';

  const sorted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? rows.filter(
          (r) =>
            r.monthLabel.toLowerCase().includes(needle) ||
            r.amount.includes(needle) ||
            r.status.includes(needle) ||
            r.lastSaved.toLowerCase().includes(needle),
        )
      : rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: Tp1DeclarationListRow): string | number => {
      switch (sortKey) {
        case 'year':
          return r.assessmentYear;
        case 'amount':
          return Number(r.amount);
        case 'status':
          return r.status;
        case 'lastSaved':
          return r.lastSaved;
        case 'month':
        default:
          // A month-less legacy line sorts LAST rather than ahead of January (99, not 0).
          return r.deductionMonth ?? 99;
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
      // Dates open newest-first; months open in calendar order; anything else reads as an accident.
      // Dates and YEARS open newest-first; months open in calendar order.
      setSortDir(key === 'lastSaved' || key === 'year' ? 'desc' : 'asc');
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
              {/* 27605faa rev 2 — the YEAR is a COLUMN now, not a filter you must set before anything
                  appears. Sortable like the rest, and it opens newest-first. */}
              {sortTh('year', t('history.colYear'))}
              {sortTh('month', t('history.colMonth'))}
              {sortTh('amount', t('history.colAmount'), 'text-right')}
              {sortTh('status', t('history.colStatus'))}
              {sortTh('lastSaved', t('history.colLastSaved'))}
              <th className="px-4 py-2 text-right font-medium">{t('history.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageRows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 tabular-nums font-medium">{r.assessmentYear}</td>
                <td className="px-4 py-2.5 font-medium">{r.monthLabel}</td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(r.amount)}</td>
                <td className="px-4 py-2.5">
                  <Badge variant={statusVariant(r.status)}>{statusLabel(r.status)}</Badge>
                  {/* The superseded rows behind this MONTH, counted rather than listed — a correction is
                      an append, and two "January" lines would read as two declarations. */}
                  {r.versions > 1 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('history.versions', { count: r.versions })}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.lastSaved}</td>
                <td className="px-4 py-2.5 text-right">
                  <span className="inline-flex items-center gap-1.5">
                    <Link
                      href={r.href}
                      className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {r.readOnly ? t('history.view') : t('history.viewEdit')}
                    </Link>
                    {/* 27605faa rev 2 — DELETE, beside View, in the Actions column that already existed.
                        A LINK to a confirmation, not a submit: the reporter asked to be asked first, and a
                        server action cannot cross into this client island as a prop without 500ing. */}
                    {r.deleteHref && (
                      <Link
                        href={r.deleteHref}
                        className="rounded-md border border-destructive/30 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                      >
                        {t('history.delete')}
                      </Link>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
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
