'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { toCsv } from '@/lib/csv';
import { Button, Field, inputCls } from './ui';
import { MultiSelectPopover } from './ui/multi-select-popover';
import { previewEarnedAccrualAction, runEarnedAccrualAction } from '@/app/admin/actions';
import type { EarnedAccrualGroup } from '@/core/leave';

export type EarnedScopeOption = { id: string; name: string };
export type EarnedLeaveYearOption = { year: number; status: string };

/**
 * feedback 2c7c6385 — "Run Earned Accrual" review card. Wraps the shipped, idempotent accrual engine with
 * the missing front-of-house: pick a SCOPE (Company / Leave Year / Leave Type / Grade), PREVIEW a grouped
 * summary table (a dry-run that writes nothing yet reports the exact numbers the commit will produce), then
 * Run / Cancel / Export. Mirrors the FestiveGrantCard client pattern (multi-select popovers + useTransition
 * + toast + router.refresh). Empty selection on any axis ⇒ "all" on that axis. Export is a client-side CSV
 * (toCsv guards CSV injection).
 *
 * 4b0e76ae — THE LEAVE-YEAR SELECTOR NO LONGER READS ANY TABLE. It used to be fed from the managed
 * leave_year_config records (9aa894a4); that module was removed, so the page now hands it the ONE shared
 * computed range (core/leave.ts `entitlementYearOptions`, currentYear − 3 .. currentYear + 6). The prop
 * SHAPE is unchanged and `status` is informational only — this card renders the year and nothing else —
 * so every computed year arrives as 'draft', exactly what the old empty-config fallback produced.
 */
export function EarnedAccrualCard({
  companies,
  grades,
  leaveTypes,
  leaveYears,
  defaultYear,
}: {
  /** Already narrowed by the page to the companies this admin administers (RLS re-enforces server-side). */
  companies: EarnedScopeOption[];
  grades: EarnedScopeOption[];
  leaveTypes: EarnedScopeOption[];
  /** The entitlement-year list, oldest first — the shared computed range (see the header). */
  leaveYears: EarnedLeaveYearOption[];
  defaultYear: number;
}) {
  const t = useTranslations('admin.leave');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number>(defaultYear);
  const [companyIds, setCompanyIds] = useState<Set<string>>(new Set());
  const [gradeIds, setGradeIds] = useState<Set<string>>(new Set());
  const [leaveTypeIds, setLeaveTypeIds] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<EarnedAccrualGroup[] | null>(null);
  const [previewAsOf, setPreviewAsOf] = useState<string | null>(null);
  // Once a real run commits, flip the table's Status column from Pending → Done (until the next preview).
  const [committed, setCommitted] = useState(false);

  const scope = useMemo(
    () => ({ year, companyIds: [...companyIds], gradeIds: [...gradeIds], leaveTypeIds: [...leaveTypeIds] }),
    [year, companyIds, gradeIds, leaveTypeIds],
  );

  // bc36c768 — three branches, because the else-was-monthly fallback this replaces would have labelled
  // every earned_daily row "Monthly accrual" on the Accrual Process preview: a table that tells HR the
  // wrong cadence for the run they are about to commit.
  const methodLabel = (m: string) =>
    m === 'earned_quarterly'
      ? t('earnedMethodQuarterly')
      : m === 'earned_daily'
        ? t('earnedMethodDaily')
        : t('earnedMethodMonthly');

  const onPreview = () =>
    start(async () => {
      setError(null);
      setCommitted(false);
      const res = await previewEarnedAccrualAction(scope);
      if (res.error) {
        setError(res.error);
        setRows(null);
        return;
      }
      setRows(res.rows ?? []);
      setPreviewAsOf(res.asOf ?? null);
    });

  const onRun = () =>
    start(async () => {
      setError(null);
      const res = await runEarnedAccrualAction(scope);
      if (res.error) {
        setError(res.error);
        return;
      }
      toast.success(t('earnedRunToast', { granted: res.granted ?? 0, forfeits: res.forfeits ?? 0 }));
      setCommitted(true);
      router.refresh();
    });

  const onCancel = () => {
    setRows(null);
    setError(null);
    setCommitted(false);
    setPreviewAsOf(null);
  };

  const onExport = () => {
    if (!rows) return;
    const statusLabel = committed ? t('earnedStatusDone') : t('earnedStatusPending');
    const header = [
      t('earnedColCompany'),
      t('earnedColGrade'),
      t('earnedColCount'),
      t('earnedColType'),
      t('earnedColPeriod'),
      t('earnedColMethod'),
      t('earnedColEntitlement'),
      t('earnedColStatus'),
    ];
    // toCsv runs every cell through csvSafeCell → a leading =/+/-/@ value can never execute on open.
    const body = rows.map((r) => [
      r.companyName,
      r.gradeName ?? t('earnedGradeUngraded'),
      r.employeeCount,
      r.leaveTypeName,
      r.accrualPeriod,
      methodLabel(r.method),
      r.entitlementGenerated,
      statusLabel,
    ]);
    const csv = toCsv([header, ...body]);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `earned-accrual-preview-${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalEntitlement = useMemo(
    () => (rows ? Math.round(rows.reduce((s, r) => s + r.entitlementGenerated, 0) * 100) / 100 : 0),
    [rows],
  );

  return (
    <div className="space-y-4 px-4 py-3">
      <p className="max-w-2xl text-xs text-muted-foreground">{t('earnedAccrualHelp')}</p>
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}

      {/* Step 1 — Select Scope. */}
      <div className="flex flex-wrap items-end gap-3">
        <MultiSelectPopover
          label={t('earnedScopeCompany')}
          allLabel={t('earnedAllCompanies')}
          options={companies}
          selected={companyIds}
          onChange={setCompanyIds}
          searchPlaceholder={t('earnedSearchPlaceholder')}
          selectAllLabel={t('festiveSelectAll')}
          clearAllLabel={t('festiveClearAll')}
          selectedCount={(n) => t('festiveSelectedCount', { count: n })}
        />
        <Field label={t('earnedScopeLeaveYear')}>
          <select
            value={String(year)}
            onChange={(e) => setYear(Number(e.target.value))}
            className={`${inputCls} w-28`}
          >
            {leaveYears.map((y) => (
              <option key={y.year} value={y.year}>
                {y.year}
              </option>
            ))}
          </select>
        </Field>
        <MultiSelectPopover
          label={t('earnedScopeLeaveType')}
          allLabel={t('earnedAllTypes')}
          options={leaveTypes}
          selected={leaveTypeIds}
          onChange={setLeaveTypeIds}
          searchPlaceholder={t('earnedSearchPlaceholder')}
          selectAllLabel={t('festiveSelectAll')}
          clearAllLabel={t('festiveClearAll')}
          selectedCount={(n) => t('festiveSelectedCount', { count: n })}
        />
        <MultiSelectPopover
          label={t('earnedScopeGrade')}
          allLabel={t('earnedAllGrades')}
          options={grades}
          selected={gradeIds}
          onChange={setGradeIds}
          searchPlaceholder={t('earnedSearchPlaceholder')}
          selectAllLabel={t('festiveSelectAll')}
          clearAllLabel={t('festiveClearAll')}
          selectedCount={(n) => t('festiveSelectedCount', { count: n })}
        />
        <Button type="button" size="sm" onClick={onPreview} disabled={pending}>
          {pending && rows === null ? t('earnedPreviewingButton') : t('earnedPreviewButton')}
        </Button>
      </div>

      {/* Step 2 — Preview table. */}
      {rows !== null && (
        <div className="space-y-3">
          {rows.length === 0 ? (
            <p className="rounded-lg bg-background px-3 py-4 text-center text-xs text-muted-foreground">
              {t('earnedPreviewEmpty')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('earnedColCompany')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColGrade')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('earnedColCount')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColType')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColPeriod')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColMethod')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('earnedColEntitlement')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColStatus')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r, i) => (
                    <tr key={`${r.companyId}|${r.gradeId ?? ''}|${r.leaveTypeId}|${i}`}>
                      <td className="px-3 py-2 text-foreground">{r.companyName}</td>
                      <td className="px-3 py-2 text-foreground">{r.gradeName ?? t('earnedGradeUngraded')}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">{r.employeeCount}</td>
                      <td className="px-3 py-2 text-foreground">{r.leaveTypeName}</td>
                      <td className="px-3 py-2 tabular-nums text-foreground">{r.accrualPeriod}</td>
                      <td className="px-3 py-2 text-foreground">{methodLabel(r.method)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">
                        {t('earnedDaysValue', { days: r.entitlementGenerated })}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium',
                            committed
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                          )}
                        >
                          {committed ? t('earnedStatusDone') : t('earnedStatusPending')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-border bg-muted/30 text-foreground">
                  <tr>
                    <td className="px-3 py-2 font-medium" colSpan={6}>
                      {t('earnedTotalRow')}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {t('earnedDaysValue', { days: totalEntitlement })}
                    </td>
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {previewAsOf && (
            <p className="text-[11px] text-muted-foreground">{t('earnedAsOfNote', { date: previewAsOf })}</p>
          )}

          {/* Step 3 — Confirm / Cancel / Export. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={onRun} disabled={pending || committed || rows.length === 0}>
              {pending && rows !== null ? t('earnedRunningButton') : t('earnedRunButton')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
              {t('earnedCancelButton')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onExport}
              disabled={rows.length === 0}
            >
              {t('earnedExportButton')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
