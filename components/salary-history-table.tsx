'use client';

import { useMemo, useState } from 'react';
import { paginateRows } from '@/lib/pagination';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';

import { useTranslations } from 'next-intl';
import { Badge } from './ui/badge';
import { ConfirmSubmit } from './ui/confirm-submit';
import { FamilyFormDialog } from './family-form-dialog';
import { inputCls } from './ui';
import { DateField } from './ui/date-field';
import { formatDmy } from '@/lib/date-display';
import { PayStructureFields, type PayModeOption } from './pay-structure-fields';
import { CurrencySelect } from './currency-select';
import { editCompensationAction, supersedeCompensationAction } from '@/app/admin/personnel/[employmentId]/actions';

export type SalaryStatus = 'active' | 'future' | 'historical';

/** One salary-history row, fully derived server-side (increment/status computed there) and serialized
 *  for the client island so filtering/sorting/exporting stay interactive without any client data fetch.
 *  Audit detail (created/updated by/on) is deliberately NOT here (7c7c2f80) — it lives in the Audit
 *  Trail, keeping this table to salary information only. */
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
  /** ADR-0078 — the salary structure recorded WITH this revision (each row keeps its own settings). */
  payMode: PayModeOption;
  paymentTerm: string;
  rateAmount: string | null;
  remarks: string | null;
  /** Only the open row (latest active OR future-effective) is editable — historical rows are immutable. */
  editable: boolean;
  /** Deletable = not yet relied on by a CLOSED payroll run (server-derived; the service re-enforces). */
  deletable: boolean;
};

type SortKey = 'effectiveDate' | 'basic' | 'increment';

const STATUS_VARIANT: Record<SalaryStatus, 'success' | 'warning' | 'default'> = {
  active: 'success',
  future: 'warning',
  historical: 'default',
};

/**
 * Basic Salary history table (feedback 87c82b18, redesigned under 7c7c2f80). A client island that
 * renders the salary history with SEARCH, STATUS FILTER, column SORTING, CSV EXPORT, a View and an EDIT
 * dialog (amount, currency, structure, remarks AND effective date) for the open (latest/future) record,
 * and a confirmation-gated DELETE for records not yet used by a closed payroll run. All salary math is
 * derived server-side and passed in `rows`; this component only presents + filters/sorts/exports, so
 * it lives inside the server-rendered Payroll panel (f2904eeb).
 *
 * 18719ded — Edit used to be a row that UNFOLDED underneath the record, the same disclosure idiom the
 * Documents tab was reported for. It is now a FamilyFormDialog, matching Pay Items, CP38 and the
 * Qualification tab the reporter asked all of these to look like. Same action, same fields, same
 * confirm step; only the container changed.
 */
export function SalaryHistoryTable({ rows }: { rows: SalaryRowView[] }) {
  const t = useTranslations('people.detail');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SalaryStatus>('all');
  const [sortKey, setSortKey] = useState<SortKey>('effectiveDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const pq = useClientPageQuery();

  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const statusLabel = (s: SalaryStatus) =>
    s === 'active' ? t('salaryStatusActive') : s === 'future' ? t('salaryStatusFuture') : t('salaryStatusHistorical');

  // ADR-0078 — localized labels for the per-revision salary structure (keys shipped with R46 79eb7151).
  const payModeLabel = (m: PayModeOption) => t(`payMode_${m}` as 'payMode_monthly');
  const paymentTermLabel = (f: string) =>
    f === 'weekly' || f === 'biweekly' || f === 'monthly' ? t(`paymentTerm_${f}` as 'paymentTerm_monthly') : f;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [
        r.effectiveDate,
        formatDmy(r.effectiveDate),
        `${r.currency} ${fmt(r.basic)}`,
        r.previous != null ? fmt(r.previous) : '',
        r.incrementAmount != null ? fmt(r.incrementAmount) : '',
        r.incrementPct != null ? `${r.incrementPct.toFixed(2)}%` : '',
        payModeLabel(r.payMode),
        paymentTermLabel(r.paymentTerm),
        statusLabel(r.status),
        r.remarks ?? '',
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

  // Filter and sort first, page second — so sorting orders the whole matching set rather than one page.
  const { rows: pageRows, state } = paginateRows(filtered, pq);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'effectiveDate' ? 'desc' : 'desc');
    }
  };
  const sortMark = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const exportCsv = () => {
    // ADR-0078 — Pay Mode / Payment Term appear in BOTH this export header array and the visible table
    // header below (editing only one would silently omit them from the other surface).
    const headers = [
      t('effectiveDate'),
      t('basicSalaryMyr'),
      t('salaryColPrevious'),
      t('salaryColIncrement'),
      t('salaryColIncrementPct'),
      t('payMode'),
      t('paymentTerm'),
      t('rateAmount'),
      t('status'),
      t('salaryColRemarks'),
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
          payModeLabel(r.payMode),
          paymentTermLabel(r.paymentTerm),
          r.rateAmount != null ? `${r.currency} ${fmt(Number(r.rateAmount))}` : '',
          statusLabel(r.status),
          r.remarks ?? '',
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

  // 18719ded — ONE field block, rendered by both the Edit dialog and the read-only View dialog, so the
  // two can never describe the same revision differently. Control names are load-bearing for
  // editCompensationAction; the service re-validates everything (period boundary, processed period,
  // rate required for daily/hourly) on save.
  const salaryFields = (r: SalaryRowView) => (
    <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('effectiveDate')}</span>
        <DateField name="effectiveFrom" required defaultValue={r.effectiveDate} className={inputCls} label={t('effectiveDate')} />
      </label>
      {/* r374 (item 7dbaf677) — `required` DROPPED here too, and the two forms HAD to move together.
          This is the EDIT half of the same screen whose Add half dropped it; leaving one of them is how
          the two drift. Clearing this box is a DELIBERATE clear, never an absent field — it always posts
          (its `defaultValue` is the stored amount) — so `editCompensationAction` reads a posted blank as
          an explicit ZERO rather than "untouched", which is what a blank meant before this round.
          `min="0"` stays: the service refuses a negative amount. */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('basicSalaryMyr')}</span>
        <input name="basicSalary" type="number" min="0" step="0.01" defaultValue={r.basic} className={inputCls} />
      </label>
      {/* 297ae65a — edit the open row's salary currency in place (searchable ISO 4217 select; the service
          validates and records only a real change). */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('salaryCurrency')}</span>
        <CurrencySelect name="currency" value={r.currency} />
      </div>
      {/* ADR-0078 — the open row's salary structure, edited in place. The service enforces the
          period-boundary rule and refuses a mode change on a processed period. */}
      <PayStructureFields
        defaultPayMode={r.payMode}
        defaultPaymentTerm={r.paymentTerm}
        defaultRateAmount={r.rateAmount}
      />
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-xs font-medium text-muted-foreground">{t('salaryColRemarks')}</span>
        <input
          name="remarks"
          type="text"
          defaultValue={r.remarks ?? ''}
          placeholder={t('salaryRemarksPlaceholder')}
          className={inputCls}
        />
      </label>
    </div>
  );

  // The edit form, now the body of a FamilyFormDialog rather than a row that unfolded under the record.
  // TWO things are load-bearing here and both are invisible:
  //   · the STATIC hidden `tab` input — Dialog.Portal reparents this form to document.body, outside the
  //     PersonnelTabs shell, so the shell's capture-phase submit listener cannot inject the tab and a save
  //     would otherwise redirect back to the Profile tab. `data-tab-tracker` keeps the shell authoritative
  //     if this form is ever rendered inside it again.
  //   · ConfirmSubmit's trigger stays INSIDE this <form>, so its closest('form').requestSubmit() still
  //     finds the form from within the portal. This is an AlertDialog nested in a Dialog; the composition
  //     is pinned by test/personnel-payroll-tab-dialogs.dom.test.tsx.
  const salaryEditForm = (r: SalaryRowView) => (
    <form action={editCompensationAction} className="space-y-3">
      <input type="hidden" name="employmentId" value={r.employmentId} />
      <input type="hidden" name="compensationId" value={r.id} />
      <input type="hidden" name="tab" value="payroll" data-tab-tracker="" />
      {salaryFields(r)}
      <div className="flex justify-end">
        <ConfirmSubmit
          variant="default"
          title={t('salaryEditConfirmTitle')}
          description={t('salaryEditConfirmDescription')}
          confirmLabel={t('updatePay')}
        >
          {t('updatePay')}
        </ConfirmSubmit>
      </div>
    </form>
  );

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
              {/* ADR-0078 — per-revision salary structure; mirrored in the CSV export header above. */}
              <th className="px-4 py-2 font-medium">{t('payMode')}</th>
              <th className="px-4 py-2 font-medium">{t('paymentTerm')}</th>
              <th className="px-4 py-2 font-medium">{t('status')}</th>
              <th className="px-4 py-2 font-medium">{t('salaryColRemarks')}</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('salaryNoResults')}
                </td>
              </tr>
            ) : (
              pageRows.map((r) => (
                <tr key={r.id} className={`border-b border-border/60 ${r.status === 'active' ? 'bg-primary/5' : ''}`}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDmy(r.effectiveDate)}</td>
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
                  {/* ADR-0078 — the structure recorded with THIS revision; a daily/hourly row also shows
                      its rate under the mode so the paying figure is visible in history. */}
                  <td className="whitespace-nowrap px-4 py-2">
                    {payModeLabel(r.payMode)}
                    {r.rateAmount != null && (
                      <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                        ({r.currency} {fmt(Number(r.rateAmount))})
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{paymentTermLabel(r.paymentTerm)}</td>
                  <td className="px-4 py-2">
                    <Badge variant={STATUS_VARIANT[r.status]}>{statusLabel(r.status)}</Badge>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{r.remarks || '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* 18719ded — View exists so a HISTORICAL revision is readable at all: only the
                          open row is editable, so before this the closed rows had no way to show their
                          remarks or pay structure beyond what fits in the table. Same fields, disabled,
                          no <form> — it can never drift from Edit and can never post. */}
                      <FamilyFormDialog
                        triggerLabel={t('salaryView')}
                        triggerVariant="outline"
                        title={t('salaryViewTitle')}
                      >
                        <fieldset disabled>{salaryFields(r)}</fieldset>
                      </FamilyFormDialog>
                      {r.editable && (
                        <FamilyFormDialog
                          triggerLabel={t('salaryEdit')}
                          triggerVariant="outline"
                          title={t('salaryEditTitle')}
                        >
                          {salaryEditForm(r)}
                        </FamilyFormDialog>
                      )}
                      {r.deletable && (
                        /* Soft delete (7c7c2f80): confirmation-gated; the service refuses records a
                           CLOSED payroll run relied on (this flag pre-hides those). */
                        <form action={supersedeCompensationAction} className="inline-flex">
                          <input type="hidden" name="employmentId" value={r.employmentId} />
                          <input type="hidden" name="compensationId" value={r.id} />
                          <ConfirmSubmit
                            variant="ghost"
                            size="sm"
                            className="h-auto px-0 py-0 text-sm font-medium text-red-700 hover:bg-transparent hover:underline dark:text-red-400"
                            title={t('salaryDeleteConfirmTitle')}
                            description={t('salaryDeleteConfirmDescription')}
                            confirmLabel={t('salaryDelete')}
                          >
                            {t('salaryDelete')}
                          </ConfirmSubmit>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <ClientPager state={state} />
    </div>
  );
}
