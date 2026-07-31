'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui';
import type { UnattachedGroupRow } from '@/core/payroll-view';

/**
 * Outstanding transactions grid (feedback d0d2c9d1) — money that was entered against an employee and a
 * month and has never reached a payslip, grouped by (employee, month) with a GRAND TOTAL.
 *
 * The grand total is the actual missing artefact. The individual rows behind this were always listable
 * on the Individual tab (?txnStatus=unattached), but nothing anywhere added them up, so RM23,170
 * accumulated across several months without ever being a number anyone could see.
 *
 * THE RUN-STATE COLUMN CARRIES THE MEANING. A month with no regular run yet legitimately holds
 * unattached rows — that is the designed pre-run entry flow (f1564110 Phase 2), not a fault. A month
 * whose regular run is already processed or closed has gone past these rows, and that IS the fault.
 * Both are shown, visually distinguished, with no default filter: showing only the fault class would
 * hide the pipeline, and showing everything undifferentiated is what made the money invisible.
 *
 * Client component purely so the columns sort (mirroring individual-table.tsx). The rows arrive already
 * RBAC- and RLS-fenced from the server page; sorting is a pure client reorder of that set.
 */

type SortKey = 'payPeriod' | 'employeeName' | 'company' | 'count' | 'totalAmount' | 'oldestTxnDate' | 'runState';
type SortDir = 'asc' | 'desc';

/** A run that has already been processed or closed has gone PAST these rows — that is the fault case. */
const isStranded = (r: UnattachedGroupRow) => r.runState === 'processed' || r.runState === 'closed';

export function OutstandingTable({ rows }: { rows: UnattachedGroupRow[] }) {
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
    const val = (r: UnattachedGroupRow): string | number => {
      switch (sortKey) {
        case 'totalAmount':
          return Number(r.totalAmount);
        case 'count':
          return r.count;
        case 'employeeName':
          return r.employeeName.toLowerCase();
        case 'company':
          return r.company.toLowerCase();
        case 'oldestTxnDate':
          return r.oldestTxnDate;
        case 'runState':
          return r.runState;
        case 'payPeriod':
        default:
          return r.payPeriod;
      }
    };
    // Copy before sort (never mutate props); a stable tiebreak keeps equal rows deterministic.
    return [...rows].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      const ak = `${a.employmentId}${a.payPeriod}`;
      const bk = `${b.employmentId}${b.payPeriod}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  }, [rows, sortKey, sortDir]);

  // Totalled in CENTS. Summing the decimal strings as floats would drift on exactly the four-figure
  // bonuses this screen exists to surface.
  const grandTotal = useMemo(
    () => rows.reduce((cents, r) => cents + Math.round(Number(r.totalAmount) * 100), 0) / 100,
    [rows],
  );
  const strandedTotal = useMemo(
    () =>
      rows.filter(isStranded).reduce((cents, r) => cents + Math.round(Number(r.totalAmount) * 100), 0) / 100,
    [rows],
  );

  // LITERAL keys, deliberately not `t(\`…runState${r.runState}\`)`. A computed key is invisible to
  // check C of test/i18n-coverage.test.ts, so a typo'd or missing one ships as a raw key on screen with
  // a green suite. (This file is multi-namespace, so check C skips it entirely either way — all the
  // more reason not to hide the keys from a future reader too.)
  const RUN_STATE_LABEL: Record<UnattachedGroupRow['runState'], string> = {
    none: t('view.outstanding.runStateNone'),
    draft: t('view.outstanding.runStateDraft'),
    processed: t('view.outstanding.runStateProcessed'),
    closed: t('view.outstanding.runStateClosed'),
  };

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
            {th('employeeName', t('individual.employee'))}
            {th('company', tList('colCompany'))}
            {th('count', t('view.outstanding.colEntries'), 'text-right')}
            {th('totalAmount', t('view.outstanding.colAmount'), 'text-right')}
            {th('oldestTxnDate', t('view.outstanding.colOldest'))}
            {th('runState', t('view.outstanding.colRunState'))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={`${r.employmentId}-${r.payPeriod}`}>
              <td className="px-4 py-2.5 tabular-nums">{r.payPeriod}</td>
              <td className="px-4 py-2.5 font-medium">
                {r.employeeName}
                {r.employeeCode && (
                  <span className="ml-1 font-mono text-xs text-muted-foreground">({r.employeeCode})</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.company}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{r.count}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{Number(r.totalAmount).toFixed(2)}</td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">{r.oldestTxnDate}</td>
              <td className="px-4 py-2.5">
                {/* 'none' is the normal pre-run state, not an alarm — only a run that has already gone
                    past these rows is flagged. */}
                <Badge variant={isStranded(r) ? 'warning' : undefined}>{RUN_STATE_LABEL[r.runState]}</Badge>
                {r.arrivedAfterProcessing && (
                  <div className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                    {t('view.outstanding.arrivedAfterProcessing')}
                  </div>
                )}
                {isStranded(r) && !r.arrivedAfterProcessing && (
                  <div className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                    {t('view.outstanding.leftOutByScope')}
                  </div>
                )}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                {t('view.outstanding.empty')}
              </td>
            </tr>
          )}
        </tbody>
        {sorted.length > 0 && (
          <tfoot className="border-t-2 border-border bg-muted/30 font-medium">
            <tr>
              <td colSpan={4} className="px-4 py-2.5 text-right">
                {t('view.outstanding.grandTotal')}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{grandTotal.toFixed(2)}</td>
              <td colSpan={2} className="px-4 py-2.5 text-xs font-normal text-muted-foreground">
                {strandedTotal > 0 && t('view.outstanding.strandedTotal', { amount: strandedTotal.toFixed(2) })}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
