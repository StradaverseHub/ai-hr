'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Field, inputCls } from '@/components/ui';
import { resumeHref } from '../selection-logic';

export type ExistingRun = {
  id: string;
  companyId: string;
  payPeriod: string;
  runType: string;
  status: string;
  company: string;
};

export type Company = { id: string; name: string };

/** The four fixed behavioural run types a configured cycle maps to (mirrors payrollRunTypeEnum). */
export type CycleRunType = 'regular' | 'off_cycle' | 'bonus' | 'adjustment';

/** ADR-0069: a configurable cycle option, sourced from the payroll_cycle catalog. `id` is the selected
 *  value submitted to the wizard; `runType` drives the same gating the hardcoded list used to. */
export type CycleOption = { id: string; name: string; runType: CycleRunType; remarks: string | null };

/** Step 1 (3c) — company, month/year, cycle (DB-driven), payment date; existing-runs panel for resume. */
export function StepPeriod({
  companies,
  companyId,
  onCompanyId,
  payPeriod,
  onPayPeriod,
  cycleId,
  onCycleId,
  cycleOptions,
  paymentDate,
  onPaymentDate,
  defaultPaymentDate,
  multiCycle,
  existingRuns,
}: {
  companies: Company[];
  companyId: string;
  onCompanyId: (v: string) => void;
  payPeriod: string;
  onPayPeriod: (v: string) => void;
  cycleId: string;
  onCycleId: (v: string) => void;
  cycleOptions: CycleOption[];
  paymentDate: string;
  onPaymentDate: (v: string) => void;
  defaultPaymentDate: string;
  multiCycle: boolean;
  existingRuns: ExistingRun[];
}) {
  const t = useTranslations('payroll.process');
  const runsForPeriod = existingRuns.filter((r) => r.companyId === companyId && r.payPeriod === payPeriod);
  const regularExists = runsForPeriod.some((r) => r.runType === 'regular');
  const regularRun = runsForPeriod.find((r) => r.runType === 'regular');

  // The selected cycle's mapped run type drives the "only one regular per period" gating exactly as the
  // old literal 'regular' compare did — but keyed off the resolved runType, not the label.
  const selectedRunType = cycleOptions.find((c) => c.id === cycleId)?.runType;

  // Each configured cycle becomes an option. A regular-mapped cycle is disabled once a regular run exists;
  // a non-regular cycle is disabled until one does (unchanged behaviour). The multiCycle flag continues to
  // gate visibility upstream (page.tsx / wizard filter this list to regular-only when the flag is off).
  const options = cycleOptions.map((c) => ({
    id: c.id,
    label: c.name,
    runType: c.runType,
    disabled: c.runType === 'regular' ? regularExists : !regularExists,
  }));

  return (
    <div className="space-y-4">
      <Field label={t('company')}>
        <select value={companyId} onChange={(e) => onCompanyId(e.target.value)} className={inputCls}>
          <option value="">{t('selectCompany')}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('payPeriod')}>
          <input
            type="month"
            value={payPeriod}
            onChange={(e) => onPayPeriod(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={t('cycleLabel')}>
          <select value={cycleId} onChange={(e) => onCycleId(e.target.value)} className={inputCls}>
            {options.length === 0 && <option value="">{t('noCyclesConfigured')}</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id} disabled={o.disabled}>
                {o.label}
                {o.disabled ? ` (${t('cycleDisabled')})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('paymentDate')}>
          <input
            type="date"
            value={paymentDate || defaultPaymentDate}
            onChange={(e) => onPaymentDate(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>

      {!multiCycle && (
        <p className="text-xs text-muted-foreground">{t('multiCycleOffNote')}</p>
      )}

      {runsForPeriod.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
          <div className="mb-1.5 font-medium text-foreground">{t('existingRunsTitle')}</div>
          <ul className="space-y-1">
            {runsForPeriod.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {t(`runType.${r.runType}`)} · <span className="capitalize">{r.status}</span>
                </span>
                {/* A DRAFT run resumes into the wizard at Employee Selection (the "who's in this run" step,
                    formerly bypassed for drafts). Processed/closed runs keep their direct read-only link. */}
                <Link
                  href={resumeHref(r.id, r.status)}
                  className="font-medium text-primary hover:underline"
                >
                  {t('resumeDraft')}
                </Link>
              </li>
            ))}
          </ul>
          {regularExists && selectedRunType === 'regular' && (
            <p className="mt-1.5 text-amber-700 dark:text-amber-400">
              {t('regularExistsNote', { period: regularRun?.payPeriod ?? payPeriod })}
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t('consolidationNote')}</p>
    </div>
  );
}
