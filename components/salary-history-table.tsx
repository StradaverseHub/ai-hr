'use client';

import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from './ui/badge';
import { ConfirmSubmit } from './ui/confirm-submit';
import { inputCls } from './ui';
import { editCompensationAction } from '@/app/admin/personnel/[employmentId]/actions';

export type SalaryStatus = 'active' | 'future' | 'historical';

/** One salary-history row, fully derived server-side (increment/status computed there) and serialized
 *  for the client island so filtering/sorting/exporting stay interactive without any client data fetch. */
export type SalaryRowView = {
  id: string;
  employmentId: string;
  effectiveDate: string;
  currency: string;
  basic: number;
  previous: number | null;
  incrementAmount: number | null;
  incrementPct: number | null;
  status: SalaryStatus;
  remarks: string | null;
  createdByName: string | null;
  createdOn: string;
  updatedByName: string | null;
  updatedOn: string | null;
  /** Only the open row (latest active OR future-effective) is editable — historical rows are immutable. */
  editable: boolean;
};

type SortKey = 'effectiveDate' | 'basic' | 'increment';

const STATUS_VARIANT: Record<SalaryStatus, 'success' | 'warning' | 'default'> = {
  active: 'success',
  future: 'warning',
  historical: 'default',
};

/**
 * Basic Salary history table (feedback 87c82b18, section 7). A client island that renders the salary
 * history with SEARCH, STATUS FILTER, column SORTING, CSV EXPORT, and an inline EDIT flow for the open
 * (latest/future) record. All salary math is derived server-side and passed in `rows`; this component
 * only presents + filters/sorts/exports, so it lives inside the server-rendered Payroll panel (f2904eeb).
 */
export function SalaryHistoryTable({ rows }: { rows: SalaryRowView[] }) {
  const t = useTranslations('people.detail');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SalaryStatus>('all');
  const [sortKey, setSortKey] = useState<SortKey>('effectiveDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [editingId, setEditingId] = useState<string | null>(null);

  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const statusLabel = (s: SalaryStatus) =>
    s === 'active' ? t('salaryStatusActive') : s === 'future' ? t('salaryStatusFuture') : t('salaryStatusHistorical');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [
        r.effectiveDate,
        `${r.currency} ${fmt(r.basic)}`,
        r.previous != null ? fmt(r.previous) : '',
        r.incrementAmount != null ? fmt(r.incrementAmount) : '',
        r.incrementPct != null ? `${r.incrementPct.toFixed(2)}%` : '',
        statusLabel(r.status),
        r.remarks ?? '',
        r.createdByName ?? '',
        r.updatedByName ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
    out = [...out].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'effectiveDate') cmp = a.effectiveDate.localeCompare(b.effectiveDate);
      else if (sortKey === 'basic') cmp = a.basic - b.basic;
      else cmp = (a.incrementAmount ?? 0) - (b.incrementAmount ?? 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, statusFilter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'effectiveDate' ? 'desc' : 'desc');
    }
  };
  const sortMark = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const exportCsv = () => {
    const headers = [
      t('effectiveDate'),
      t('basicSalaryMyr'),
      t('salaryColPrevious'),
      t('salaryColIncrement'),
      t('salaryColIncrementPct'),
      t('status'),
      t('salaryColRemarks'),
      t('salaryColCreatedBy'),
      t('salaryColCreatedOn'),
      t('salaryColLastUpdatedBy'),
      t('salaryColLastUpdatedOn'),
    ];
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [headers.map(esc).join(',')];
    for (const r of filtered) {
      lines.push(
        [
          r.effectiveDate,
          `${r.currency} ${fmt(r.basic)}`,
          r.previous != null ? `${r.currency} ${fmt(r.previous)}` : '',
          r.incrementAmount != null ? fmt(r.incrementAmount) : '',
          r.incrementPct != null ? `${r.incrementPct.toFixed(2)}%` : '',
          statusLabel(r.status),
          r.remarks ?? '',
          r.createdByName ?? '',
          r.createdOn,
          r.updatedByName ?? '',
          r.updatedOn ?? '',
        ]
          .map((v) => esc(String(v)))
          .join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'salary-history.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const incrementCls = (amt: number | null) =>
    amt == null || amt === 0
      ? 'text-muted-foreground'
      : amt > 0
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-red-700 dark:text-red-400';

  return (
    <div>
      {/* Search + filter + export toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('salarySearchPlaceholder')}
          className={`${inputCls} max-w-xs`}
          aria-label={t('salarySearchPlaceholder')}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | SalaryStatus)}
          className={`${inputCls} w-auto`}
          aria-label={t('status')}
        >
          <option value="all">{t('salaryFilterAll')}</option>
          <option value="active">{t('salaryStatusActive')}</option>
          <option value="historical">{t('salaryStatusHistorical')}</option>
          <option value="future">{t('salaryStatusFuture')}</option>
        </select>
        <button type="button" onClick={exportCsv} className="ml-auto text-sm font-medium text-primary hover:underline">
          {t('salaryExport')}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">
                <button type="button" onClick={() => toggleSort('effectiveDate')} className="hover:text-foreground">
                  {t('effectiveDate')}
                  {sortMark('effectiveDate')}
                </button>
              </th>
              <th className="px-4 py-2 text-right font-medium">
                <button type="button" onClick={() => toggleSort('basic')} className="hover:text-foreground">
                  {t('basicSalaryMyr')}
                  {sortMark('basic')}
                </button>
              </th>
              <th className="px-4 py-2 text-right font-medium">{t('salaryColPrevious')}</th>
              <th className="px-4 py-2 text-right font-medium">
                <button type="button" onClick={() => toggleSort('increment')} className="hover:text-foreground">
                  {t('salaryColIncrement')}
                  {sortMark('increment')}
                </button>
              </th>
              <th className="px-4 py-2 text-right font-medium">{t('salaryColIncrementPct')}</th>
              <th className="px-4 py-2 font-medium">{t('status')}</th>
              <th className="px-4 py-2 font-medium">{t('salaryColRemarks')}</th>
              <th className="px-4 py-2 font-medium">{t('salaryColCreatedBy')}</th>
              <th className="px-4 py-2 font-medium">{t('salaryColCreatedOn')}</th>
              <th className="px-4 py-2 font-medium">{t('salaryColLastUpdatedBy')}</th>
              <th className="px-4 py-2 font-medium">{t('salaryColLastUpdatedOn')}</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('salaryNoResults')}
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <Fragment key={r.id}>
                  <tr className={`border-b border-border/60 ${r.status === 'active' ? 'bg-primary/5' : ''}`}>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums">{r.effectiveDate}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                      {r.currency} {fmt(r.basic)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {r.previous != null ? `${r.currency} ${fmt(r.previous)}` : '—'}
                    </td>
                    <td className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${incrementCls(r.incrementAmount)}`}>
                      {r.incrementAmount != null ? fmt(r.incrementAmount) : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {r.incrementPct != null ? `${r.incrementPct.toFixed(2)}%` : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_VARIANT[r.status]}>{statusLabel(r.status)}</Badge>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{r.remarks || '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{r.createdByName || '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">{r.createdOn}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{r.updatedByName || '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">{r.updatedOn || '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      {r.editable && (
                        <button
                          type="button"
                          onClick={() => setEditingId((id) => (id === r.id ? null : r.id))}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          {t('salaryEdit')}
                        </button>
                      )}
                    </td>
                  </tr>
                  {r.editable && editingId === r.id && (
                    <tr className="border-b border-border/60 bg-muted/40">
                      <td colSpan={12} className="px-4 py-4">
                        <form action={editCompensationAction} className="flex flex-wrap items-end gap-3">
                          <input type="hidden" name="employmentId" value={r.employmentId} />
                          <input type="hidden" name="compensationId" value={r.id} />
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">{t('basicSalaryMyr')}</span>
                            <input
                              name="basicSalary"
                              type="number"
                              min="0"
                              step="0.01"
                              required
                              defaultValue={r.basic}
                              className={`${inputCls} w-40`}
                            />
                          </label>
                          <label className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">{t('salaryColRemarks')}</span>
                            <input
                              name="remarks"
                              type="text"
                              defaultValue={r.remarks ?? ''}
                              placeholder={t('salaryRemarksPlaceholder')}
                              className={inputCls}
                            />
                          </label>
                          <ConfirmSubmit
                            variant="default"
                            title={t('salaryEditConfirmTitle')}
                            description={t('salaryEditConfirmDescription')}
                            confirmLabel={t('updatePay')}
                          >
                            {t('updatePay')}
                          </ConfirmSubmit>
                        </form>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
