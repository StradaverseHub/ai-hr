'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { LoanRow } from '@/core/loans';
import type { LoanSortKey as SortKey, ServerTablePage } from '@/lib/server-table-page';
import { useServerTableQuery } from '@/components/use-server-table-query';
import { EmployeeCode, inputCls } from '@/components/ui';
import { paginateRows } from '@/lib/pagination';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';

/**
 * The loans "Transaction history" table (feedback 6d72816e).
 *
 * WHAT MOVED OFF IT, AND WHY. Every row used to unfold in place: five lifecycle actions (amend, suspend,
 * resume, settle, cancel) plus the whole repayment schedule, all wedged into a `<td colSpan={8}>`. So the
 * two things an operator most needs room for — the confirmation copy that says what "Settle" actually does,
 * and the instalment schedule — had the least. Both now live on the loan's own page, `/admin/loans/[id]`,
 * and this table has ONE destination per row, exactly as fixed-list.tsx does.
 *
 * That also removed an N+1: the page used to fetch every visible loan's full schedule just to render a fold
 * nobody had opened.
 *
 * SORT BEFORE PAGE, NEVER WITHIN THE PAGE (the rule recorded on components/client-pager.tsx): the whole
 * matching set is ordered and then sliced, so a column header cannot reorder twenty-five rows and leave the
 * rest where they were. The Loans screen supplies serverPage: SQL filters and sorts the whole set
 * before returning this page. Other callers can retain the bounded client-list contract.
 */

const STATUS_CLS: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  suspended: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  settled: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  cancelled: 'bg-muted text-muted-foreground',
};

/** Sort order for the Status column — the lifecycle's own order, not the alphabet. */
const STATUS_RANK: Record<string, number> = { active: 0, suspended: 1, settled: 2, cancelled: 3 };

function money(n: number): string {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function LoanList({ loans, serverPage }: { loans: LoanRow[]; serverPage?: ServerTablePage<SortKey> }) {
  const t = useTranslations('loans');
  const tType = useTranslations('loans.loanType');
  const tStatus = useTranslations('loans.status');
  const q = useClientPageQuery();
  const { query, setQuery, sort: navigateSort } = useServerTableQuery(serverPage?.query, { query: 'q', sort: 'sort', dir: 'dir', page: 'page' });
  const [localSortKey, setSortKey] = useState<SortKey>('employee');
  const [localSortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const sortKey = serverPage?.sort ?? localSortKey;
  const sortDir = serverPage?.dir ?? localSortDir;
  const sorted = useMemo(() => {
    if (serverPage) return loans;
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? loans.filter(
          (l) =>
            (l.employeeName ?? '').toLowerCase().includes(needle) ||
            (l.employeeCode ?? '').toLowerCase().includes(needle) ||
            l.loanType.toLowerCase().includes(needle) ||
            l.status.toLowerCase().includes(needle) ||
            (l.notes ?? '').toLowerCase().includes(needle) ||
            String(l.principal).includes(needle),
        )
      : loans;
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (l: LoanRow): string | number => {
      switch (sortKey) {
        case 'type':
          return l.loanType;
        case 'principal':
          return l.principal;
        case 'instalment':
          return l.monthlyInstalment;
        case 'outstanding':
          return l.outstandingBalance;
        case 'progress':
          // Proportion paid, not the raw count — 3/6 is further along than 4/24.
          return l.durationMonths > 0 ? l.instalmentsPaid / l.durationMonths : 0;
        case 'status':
          return STATUS_RANK[l.status] ?? 99;
        case 'employee':
        default:
          return (l.employeeName ?? '').toLowerCase();
      }
    };
    return [...matched].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Newest first within a tie — the order this list has always opened in.
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [loans, query, sortKey, sortDir, serverPage]);

  const { rows: pageLoans, state } = serverPage ? { rows: loans, state: serverPage.state } : paginateRows(sorted, q);

  const toggleSort = (key: SortKey) => {
    if (serverPage) {
      navigateSort(key, key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : (['principal', 'instalment', 'outstanding'].includes(key) ? 'desc' : 'asc'));
      return;
    }
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'principal' || key === 'instalment' || key === 'outstanding' ? 'desc' : 'asc');
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
          maxLength={serverPage ? 200 : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className={`${inputCls} max-w-xs`}
          aria-label={t('searchPlaceholder')}
        />
        <span className="text-xs text-muted-foreground">{t('nShown', { count: state.total })}</span>
      </div>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {sortTh('employee', t('colEmployee'))}
              {sortTh('type', t('colType'))}
              {sortTh('principal', t('colPrincipal'))}
              {sortTh('instalment', t('colInstalment'))}
              {sortTh('outstanding', t('colOutstanding'))}
              {sortTh('progress', t('colProgress'))}
              {sortTh('status', t('colStatus'))}
              <th className="px-4 py-2 text-right font-medium">{t('colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageLoans.map((l) => (
              <tr key={l.id} className="hover:bg-muted/40">
                <td className="px-4 py-2.5 font-medium">
                  {/* Employee ID left-of-name (feedback 38668d9b) */}
                  {l.employeeCode && <EmployeeCode code={l.employeeCode} className="mr-1.5" />}
                  {l.employeeName}
                </td>
                <td className="px-4 py-2.5">{tType(l.loanType)}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(l.principal)}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(l.monthlyInstalment)}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(l.outstandingBalance)}</td>
                <td className="px-4 py-2.5 tabular-nums">
                  {l.instalmentsPaid}/{l.durationMonths}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLS[l.status] ?? ''}`}
                  >
                    {tStatus(l.status)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {/* One destination, not five action forms and a schedule folded into the cell. */}
                  <Link
                    href={`/admin/loans/${l.id}?employmentId=${encodeURIComponent(l.employmentId)}`}
                    className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {t('viewEdit')}
                  </Link>
                </td>
              </tr>
            ))}
            {pageLoans.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  {serverPage ? (serverPage.query ? t('noMatches') : t('empty')) : (loans.length === 0 ? t('empty') : t('noMatches'))}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ClientPager state={state} />
    </div>
  );
}
