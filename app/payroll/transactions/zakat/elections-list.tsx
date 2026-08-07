'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, inputCls } from '@/components/ui';
import { paginateRows } from '@/lib/pagination';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';

/**
 * 6a1f2bd6 — the Zakat "Transaction history" list, with the search and sorting the screen never had.
 *
 * WHAT A ROW IS, SAID ONCE AND SAID HERE. An employee has ONE zakat setup, not a list of dated zakat
 * entries: `employee_statutory_my` holds a single row per person, saving overwrites it, and switching
 * zakat off nulls every zakat field (core/payroll-view.ts listZakatElections, resolveZakatElection).
 * So this list is one line per EMPLOYEE, never a version chain — and nothing in it may imply otherwise.
 * With somebody selected in the panel it is therefore exactly one row: theirs. The month-by-month record
 * is the "Applied in payroll" list below, which does have a row per payroll run.
 *
 * SORT BEFORE PAGE (components/client-pager.tsx): the whole matching set is ordered and then sliced, so
 * a column header cannot reorder twenty-five rows and leave the rest where they were. The pager keeps
 * this screen's own `ePage`/`eSize` names so paging one list never resets the other.
 *
 * Rows are PLAIN DATA — no function prop crosses from the server page into this client island (r123's
 * 500 was exactly that), and every caption resolves from the single `payroll.transactions.zakat`
 * namespace so check C of test/i18n-coverage.test.ts validates them key by key.
 */

export type ZakatElectionListRow = {
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  company: string;
  zakatActive: boolean;
  zakatMethod: string | null;
  /** Stored as a decimal (0.025 = 2.5%); rendered as a percentage. */
  zakatPercent: string | null;
  zakatFixed: string | null;
  zakatState: string | null;
  zakatEffectiveFrom: string | null;
  zakatEffectiveTo: string | null;
};

type SortKey = 'employee' | 'company' | 'method' | 'state' | 'effective' | 'status';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ZakatElectionsList({ rows }: { rows: ZakatElectionListRow[] }) {
  const t = useTranslations('payroll.transactions.zakat');
  const q = useClientPageQuery({ page: 'ePage', size: 'eSize' });
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('employee');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const methodLabel = (m: string | null) =>
    m === 'percent_of_pcb' ? t('election.methodPercentOfPcb') : m === 'fixed' ? t('election.methodFixed') : '—';
  const amountLabel = (r: ZakatElectionListRow) =>
    r.zakatMethod === 'fixed'
      ? rm(r.zakatFixed)
      : r.zakatMethod === 'percent_of_pcb'
        ? `${(Number(r.zakatPercent ?? 0) * 100).toFixed(2)}%`
        : '—';
  const effectiveLabel = (r: ZakatElectionListRow) =>
    r.zakatEffectiveFrom || r.zakatEffectiveTo
      ? `${r.zakatEffectiveFrom ?? '—'} – ${r.zakatEffectiveTo ?? '—'}`
      : '—';

  const sorted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? rows.filter(
          (r) =>
            r.employeeName.toLowerCase().includes(needle) ||
            (r.employeeCode ?? '').toLowerCase().includes(needle) ||
            r.company.toLowerCase().includes(needle) ||
            (r.zakatState ?? '').toLowerCase().includes(needle) ||
            (r.zakatEffectiveFrom ?? '').includes(needle) ||
            (r.zakatEffectiveTo ?? '').includes(needle),
        )
      : rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: ZakatElectionListRow): string | number => {
      switch (sortKey) {
        case 'company':
          return r.company.toLowerCase();
        case 'method':
          return r.zakatMethod ?? '';
        case 'state':
          return r.zakatState ?? '';
        case 'effective':
          // A setup with no start date sorts LAST ascending — "not dated" is not "earliest".
          return r.zakatEffectiveFrom ?? '9999-12-31';
        case 'status':
          return r.zakatActive ? 0 : 1;
        case 'employee':
        default:
          return r.employeeName.toLowerCase();
      }
    };
    return [...matched].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.employmentId < b.employmentId ? -1 : a.employmentId > b.employmentId ? 1 : 0;
    });
  }, [rows, query, sortKey, sortDir]);

  const { rows: pageRows, state } = paginateRows(sorted, q);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'effective' ? 'desc' : 'asc');
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
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {sortTh('employee', t('history.colEmployee'))}
              {sortTh('company', t('history.colCompany'))}
              {sortTh('method', t('history.colMethod'))}
              <th className="px-4 py-2 text-right font-medium">{t('history.colAmount')}</th>
              {sortTh('state', t('history.colState'))}
              {sortTh('effective', t('history.colEffective'))}
              {sortTh('status', t('history.status'))}
              <th className="px-4 py-2 text-right font-medium">{t('history.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageRows.map((r) => (
              <tr key={r.employmentId}>
                <td className="px-4 py-2.5 font-medium">
                  {r.employeeName}
                  {r.employeeCode && (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">({r.employeeCode})</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.company}</td>
                <td className="px-4 py-2.5">{methodLabel(r.zakatMethod)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{amountLabel(r)}</td>
                <td className="px-4 py-2.5">{r.zakatState ?? '—'}</td>
                <td className="px-4 py-2.5 tabular-nums">{effectiveLabel(r)}</td>
                <td className="px-4 py-2.5">
                  <Badge variant={r.zakatActive ? 'success' : 'default'}>
                    {r.zakatActive ? t('history.active') : t('history.inactive')}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {/* One destination, the same one the Add / Edit button at the top opens. */}
                  <Link
                    href={`/payroll/transactions/zakat/election?employmentId=${encodeURIComponent(r.employmentId)}`}
                    className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {t('history.viewEdit')}
                  </Link>
                </td>
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  {rows.length === 0 ? t('history.electionsEmpty') : t('history.noMatches')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ClientPager state={state} paramNames={{ page: 'ePage', size: 'eSize' }} />
    </div>
  );
}
