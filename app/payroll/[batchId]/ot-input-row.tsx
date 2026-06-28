'use client';

import { useTranslations } from 'next-intl';
import { Button, inputCls } from '@/components/ui';
import { setPayrollInputAction } from '../actions';

/**
 * Fix-5 — the per-employee draft-batch input form (OT buckets + bonus + TP1 + zakat).
 *
 * The four OT buckets are MANUAL ringgit amounts the admin computes against the EA s.60/60A/60D
 * structure — NOT rates the system applies (#4/#28). The employee's s.60I(1A) ORP (wages/26) + hourly
 * (ORP/8) basis is surfaced read-only beside the inputs so the admin keys against the correct figures.
 *
 * Provenance (M#17): when this row's overtime was prefilled from attendance (otSource='attendance'),
 * a manual Save would overwrite the statutory engine total — so we confirm before submitting. Above the
 * s.60A RM4,000 ceiling (otEligible=false) we surface an eligibility note (#29). All client-side; the
 * persisted figures and the server action are unchanged.
 */
export type OtRow = {
  employmentId: string;
  otBreakdown: { flat: number; normal: number; rest: number; holiday: number } | null;
  otSource: 'attendance' | 'manual' | null;
  orp: number | null;
  hourly: number | null;
  otEligible: boolean | null;
  otWageCeiling: number | null;
  bonusAmount: number;
  tp1Deduction: number;
  zakat: number;
};

const fmt = (n: number) =>
  `RM ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function OtInputRow({ batchId, row }: { batchId: string; row: OtRow }) {
  const t = useTranslations('payroll.batch');
  const isAttendance = row.otSource === 'attendance';

  return (
    <form
      action={setPayrollInputAction}
      className="flex items-end justify-end gap-2"
      onSubmit={(e) => {
        // M#17: warn before a manual Save clobbers an attendance-derived (statutory) overtime row.
        if (isAttendance && !window.confirm(t('otClobberWarn'))) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="employmentId" value={row.employmentId} />
      <fieldset className="flex flex-col gap-1">
        <span className="text-[10px] uppercase text-muted-foreground" title={t('fieldOtHint')}>
          {t('fieldOt')}
        </span>
        {/* #4: read-only s.60I(1A) basis so the admin keys the manual amounts against the right figures. */}
        {row.orp != null && row.hourly != null && (
          <span className="text-[10px] tabular-nums text-muted-foreground" title={t('otBasisTitle')}>
            {t('otBasis', { orp: fmt(row.orp), hourly: fmt(row.hourly) })}
          </span>
        )}
        {/* #29: above the s.60A RM4,000 ceiling, statutory OT is not mandated. */}
        {row.otEligible === false && row.otWageCeiling != null && (
          <span className="max-w-[18rem] text-[10px] leading-tight text-amber-700 dark:text-amber-400">
            {t('otAboveCeiling', { ceiling: row.otWageCeiling.toLocaleString() })}
          </span>
        )}
        {/* M#17: signal that this row's OT is engine-derived (a manual Save will overwrite it). */}
        {isAttendance && (
          <span className="text-[10px] uppercase tracking-wide text-blue-700 dark:text-blue-400">
            {t('otSourceAttendance')}
          </span>
        )}
        <div className="grid grid-cols-2 gap-1">
          <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('fieldOtFlatTitle')}>
            {t('fieldOtFlat')}
            <input name="otFlat" type="number" min="0" step="0.01" defaultValue={row.otBreakdown?.flat ?? 0} className={`${inputCls} w-20 text-right`} />
          </label>
          <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('fieldOtNormalTitle')}>
            {t('fieldOtNormal')}
            <input name="otNormal" type="number" min="0" step="0.01" defaultValue={row.otBreakdown?.normal ?? 0} className={`${inputCls} w-20 text-right`} />
          </label>
          <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('fieldOtRestTitle')}>
            {t('fieldOtRest')}
            <input name="otRest" type="number" min="0" step="0.01" defaultValue={row.otBreakdown?.rest ?? 0} className={`${inputCls} w-20 text-right`} />
          </label>
          <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('fieldOtHolidayTitle')}>
            {t('fieldOtHoliday')}
            <input name="otHoliday" type="number" min="0" step="0.01" defaultValue={row.otBreakdown?.holiday ?? 0} className={`${inputCls} w-20 text-right`} />
          </label>
        </div>
      </fieldset>
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
        {t('fieldBonus')}
        <input name="bonusAmount" type="number" min="0" step="0.01" defaultValue={row.bonusAmount} className={`${inputCls} w-24 text-right`} />
      </label>
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('fieldTp1Title')}>
        {t('fieldTp1')}
        <input name="tp1Deduction" type="number" min="0" step="0.01" defaultValue={row.tp1Deduction} className={`${inputCls} w-20 text-right`} />
      </label>
      <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('fieldZakatTitle')}>
        {t('fieldZakat')}
        <input name="zakat" type="number" min="0" step="0.01" defaultValue={row.zakat} className={`${inputCls} w-20 text-right`} />
      </label>
      <Button type="submit" variant="secondary">
        {t('save')}
      </Button>
    </form>
  );
}
