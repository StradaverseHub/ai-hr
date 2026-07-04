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

export type Cycle = 'regular' | 'bonus' | 'off_cycle' | 'advance' | 'midmonth' | 'adjustment';

/** Step 1 (3c) — company, month/year, cycle, payment date; existing-runs panel for resume/disable. */
export function StepPeriod({
  companies,
  companyId,
  onCompanyId,
  payPeriod,
  onPayPeriod,
  cycle,
  onCycle,
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
  cycle: Cycle;
  onCycle: (v: Cycle) => void;
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

  const cycleOptions: { value: Cycle; label: string; disabled?: boolean }[] = [
    { value: 'regular', label: t('cycle.regular'), disabled: regularExists },
    ...(multiCycle
      ? ([
          { value: 'bonus', label: t('cycle.bonus'), disabled: !regularExists },
          { value: 'off_cycle', label: t('cycle.off_cycle'), disabled: !regularExists },
          { value: 'advance', label: t('cycle.advance'), disabled: !regularExists },
          { value: 'midmonth', label: t('cycle.midmonth'), disabled: !regularExists },
          { value: 'adjustment', label: t('cycle.adjustment'), disabled: !regularExists },
        ] as const)
      : []),
  ];

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
          <select value={cycle} onChange={(e) => onCycle(e.target.value as Cycle)} className={inputCls}>
            {cycleOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
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
          {regularExists && cycle === 'regular' && (
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
