'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, inputCls } from '@/components/ui';
import { paginateRows } from '@/lib/pagination';
import type { AppliedLoanSortKey as SortKey, ServerTablePage } from '@/lib/server-table-page';
import { useServerTableQuery } from '@/components/use-server-table-query';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';

/**
 * "Applied in payroll" — what a payroll run ACTUALLY deducted, for one employee or for everybody.
 *
 * BUILT ONCE, FOR THE SAME REASON THE EMPLOYEE PANEL WAS (components/collapsible-employee-panel.tsx).
 * Zakat (6a1f2bd6), Loans (6d72816e) and TP1 Relief (3e3d3fb2) are the same request written three times,
 * and the reporter asked for consistency in those words. Three separately-built "applied" tables would
 * have drifted into three lookalikes with different column orders and different empty states — which is
 * precisely the outcome the shared panel exists to prevent. So there is ONE table and the screens feed it.
 *
 * ROWS ARE PLAIN DATA, ALREADY TRANSLATED WHERE THEY HAVE TO BE. `cycleLabel` and `statusLabel` arrive
 * resolved because they are DYNAMIC lookups in namespaces this file does not own (`payroll.transactions.
 * individual.cycle.*`, `payroll.list.status.*`); resolving them here would make this a multi-namespace
 * file, the exact shape check C of test/i18n-coverage.test.ts skips entirely, static keys included. Its own
 * twenty-odd captions come from the single `appliedInPayroll` namespace so they ARE checked key by key.
 *
 * SORT BEFORE PAGE, NOT WITHIN THE PAGE. The whole matching set is ordered and then sliced (the rule
 * recorded on components/client-pager.tsx): slice first and a column header reorders twenty-five rows
 * while leaving the rest where they are, which looks like sorting and is not. `ClientPager` rather than
 * the server `<Pager>` for the mechanical reason that file records — `<Pager>` is an async server
 * component and a 'use client' grid cannot render it — and it keeps the same ?page=&size= address
 * contract, so a copied link still opens the view its sender was looking at.
 *
 * EVERY PROP IS PLAIN DATA. No callback, no closure: a function prop crossing from a server component to
 * a client one returns a 500 on every request while tsc, the suite and `next build` all stay green.
 */

export type AppliedInPayrollRow = {
  id: string;
  /** Effective payroll month, 'YYYY-MM'. */
  payPeriod: string;
  /** Pre-translated payroll cycle, run number appended when the month had more than one run. */
  cycleLabel: string;
  employeeName: string;
  employeeCode: string | null;
  company: string;
  /** numeric(12,2) as a string, straight from the row — formatted here, never rounded here. */
  amount: string;
  /** Pre-translated batch status (processed / closed). */
  statusLabel: string;
  /** 'YYYY-MM-DD HH:MM:SS' — when the deduction was recorded. */
  createdOn: string;
};


const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function AppliedInPayrollList({
  rows,
  emptyLabel,
  paramNames,
  serverPage,
}: {
  rows: AppliedInPayrollRow[];
  serverPage?: ServerTablePage<SortKey>;
  /** Pre-translated "nothing here" line — each screen says what an empty list MEANS on that screen
   *  (no zakat deducted yet vs. no instalment taken yet), and the caller does the literal `t('…')`
   *  lookup so the i18n coverage check can still see it. */
  emptyLabel: string;
  /** A screen carrying two independently paged listings gives this one its own prefixed pair. */
  paramNames?: { page: string; size: string };
}) {
  const t = useTranslations('appliedInPayroll');
  const q = useClientPageQuery(paramNames);
  const { query, setQuery, sort: navigateSort } = useServerTableQuery(serverPage?.query, { query: 'aQ', sort: 'aSort', dir: 'aDir', page: paramNames?.page ?? 'page' });
  const [localSortKey, setSortKey] = useState<SortKey>('payPeriod');
  const [localSortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sortKey = serverPage?.sort ?? localSortKey;
  const sortDir = serverPage?.dir ?? localSortDir;
  const sorted = useMemo(() => {
    if (serverPage) return rows;
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? rows.filter(
          (r) =>
            r.payPeriod.includes(needle) ||
            r.cycleLabel.toLowerCase().includes(needle) ||
            r.employeeName.toLowerCase().includes(needle) ||
            (r.employeeCode ?? '').toLowerCase().includes(needle) ||
            r.company.toLowerCase().includes(needle) ||
            r.amount.includes(needle) ||
            r.createdOn.includes(needle),
        )
      : rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: AppliedInPayrollRow): string | number => {
      switch (sortKey) {
        case 'employee':
          return r.employeeName.toLowerCase();
        case 'company':
          return r.company.toLowerCase();
        case 'amount':
          return Number(r.amount);
        case 'createdOn':
          return r.createdOn;
        case 'payPeriod':
        default:
          return r.payPeriod;
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
  }, [rows, query, sortKey, sortDir, serverPage]);

  const { rows: pageRows, state } = serverPage ? { rows, state: serverPage.state } : paginateRows(sorted, q);

  const toggleSort = (key: SortKey) => {
    if (serverPage) {
      navigateSort(key, key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : (key === 'payPeriod' || key === 'createdOn' ? 'desc' : 'asc'));
      return;
    }
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      // Dates open newest-first; names open A–Z. Anything else reads as an accident.
      setSortDir(key === 'payPeriod' || key === 'createdOn' ? 'desc' : 'asc');
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
              {sortTh('payPeriod', t('colPeriod'))}
              <th className="px-4 py-2 font-medium">{t('colCycle')}</th>
              {sortTh('employee', t('colEmployee'))}
              {sortTh('company', t('colCompany'))}
              {sortTh('amount', t('colAmount'), 'text-right')}
              <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
              {sortTh('createdOn', t('colCreated'))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageRows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 tabular-nums">{r.payPeriod}</td>
                <td className="px-4 py-2.5">{r.cycleLabel}</td>
                <td className="px-4 py-2.5 font-medium">
                  {r.employeeName}
                  {r.employeeCode && (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">({r.employeeCode})</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.company}</td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(r.amount)}</td>
                <td className="px-4 py-2.5">
                  <Badge variant="success">{r.statusLabel}</Badge>
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.createdOn}</td>
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  {/* An empty list is the state the reporter sees FIRST on Loans (1 loan, 0 instalments
                      deducted on production). It must read as empty, not as an error. */}
                  {serverPage ? (serverPage.query ? t('noMatches') : emptyLabel) : (rows.length === 0 ? emptyLabel : t('noMatches'))}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ClientPager state={state} paramNames={paramNames} />
    </div>
  );
}
