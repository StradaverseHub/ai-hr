'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui';
import type { IndividualTxnViewRow } from '@/core/payroll-view';

/**
 * Individual Transaction History grid (feedback 7b2d4228) — a client component so the columns are SORTABLE
 * (server-side GET filters remain the "searchable" half; this adds the "sortable" half the ticket asked for).
 * The rows arrive already scope-guarded + filtered from the server page; sorting is a pure client reorder of
 * that set. Adds the Created By / Created Date audit columns.
 */

type SortKey = 'payPeriod' | 'txnDate' | 'employeeName' | 'company' | 'kind' | 'amount' | 'batchStatus' | 'createdBy' | 'createdOn';
type SortDir = 'asc' | 'desc';

export function IndividualTxnTable({ rows }: { rows: IndividualTxnViewRow[] }) {
  const t = useTranslations('payroll.transactions');
  const tList = useTranslations('payroll.list');
  const [sortKey, setSortKey] = useState<SortKey>('payPeriod');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggle = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: IndividualTxnViewRow): string | number => {
      switch (sortKey) {
        case 'amount':
          return Number(r.amount);
        case 'employeeName':
          return r.employeeName.toLowerCase();
        case 'company':
          return r.company.toLowerCase();
        case 'kind':
          return r.kind;
        case 'batchStatus':
          return r.batchStatus;
        case 'createdBy':
          return (r.createdBy ?? '').toLowerCase();
        case 'createdOn':
          return r.createdOn;
        case 'txnDate':
          return r.txnDate;
        case 'payPeriod':
        default:
          return r.payPeriod;
      }
    };
    // Copy before sort (never mutate props); a stable tiebreak on id keeps equal rows in a deterministic order.
    return [...rows].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [rows, sortKey, sortDir]);

  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const th = (key: SortKey, label: string, extra = '') => (
    <th className={`px-4 py-2 font-medium ${extra}`}>
      <button
        type="button"
        onClick={() => toggle(key)}
        className={`inline-flex items-center gap-0.5 uppercase tracking-wide transition-colors hover:text-foreground ${
          key === sortKey ? 'text-foreground' : ''
        }`}
        aria-label={`${label}${arrow(key)}`}
      >
        {label}
        <span className="text-[10px]">{arrow(key)}</span>
      </button>
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {th('payPeriod', tList('colPeriod'))}
            <th className="px-4 py-2 font-medium">{tList('colCycle')}</th>
            {th('txnDate', t('individual.txnDate'))}
            {th('employeeName', t('individual.employee'))}
            {th('company', tList('colCompany'))}
            {th('kind', t('individual.kind'))}
            {th('amount', t('individual.amount'), 'text-right')}
            <th className="px-4 py-2 font-medium">{t('individual.quantity')}</th>
            <th className="px-4 py-2 font-medium">{t('individual.notes')}</th>
            {th('batchStatus', tList('colStatus'))}
            {th('createdBy', t('view.filters.createdBy'))}
            {th('createdOn', t('view.filters.createdDate'))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2.5 tabular-nums">{r.payPeriod}</td>
              <td className="px-4 py-2.5">
                {t(`individual.cycle.${r.runType}`)}
                {r.runSeq > 1 ? ` #${r.runSeq}` : ''}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">{r.txnDate}</td>
              <td className="px-4 py-2.5 font-medium">
                {r.employeeName}
                {r.employeeCode && <span className="ml-1 font-mono text-xs text-muted-foreground">({r.employeeCode})</span>}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.company}</td>
              <td className="px-4 py-2.5">
                <Badge>{t(`individual.kindLabel.${r.kind}`)}</Badge>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{Number(r.amount).toFixed(2)}</td>
              <td className="px-4 py-2.5 text-muted-foreground">
                {r.quantity != null ? `${r.quantity}${r.unit ? ` ${t(`individual.unitLabel.${r.unit}`)}` : ''}` : '—'}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.notes ?? '—'}</td>
              <td className="px-4 py-2.5">
                <Badge variant={r.batchStatus === 'draft' ? 'warning' : 'success'}>{tList(`status.${r.batchStatus}`)}</Badge>
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.createdBy ?? '—'}</td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">{r.createdOn}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={12} className="px-4 py-8 text-center text-muted-foreground">
                {t('view.individual.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
