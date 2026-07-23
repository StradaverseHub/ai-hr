import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { getPayrollConfig } from '@/core/payroll-config';
import { listAssignablePolicies } from '@/core/payroll-policy';
import { packFor } from '@/localization/registry';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
// 297ae65a — searchable ISO 4217 picker for the company default salary currency.
import { CurrencySelect } from '@/components/currency-select';
import { savePayrollConfigAction } from './actions';

const HRDF = ['not_registered', 'mandatory', 'optional'] as const;
const BASES = ['monthly', 'daily', 'hourly', 'other'] as const;
const RELEASE_MODES = ['immediate', 'fixed_day', 'relative'] as const;

export default async function PayrollConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('payrollConfig');
  const { error } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const configs = await Promise.all(
    companies.map(async (c) => ({
      company: c,
      cfg: await getPayrollConfig(s, c.id),
      // Rung 5c — company statutory read via the pack registry (ADR-0080 D1), not a direct import.
      stat: (await packFor('MY')?.companyStatutory.get(s, c.id)) ?? null,
      // Step 1 (f3148da1) — active policies assignable as this company's default payroll policy.
      policies: await listAssignablePolicies(s, c.id),
    })),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} back={await settingsBack()} />
      {error && <ErrorBanner message={error} />}

      {companies.length === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('emptyScope')}</p>
        </Card>
      ) : (
        configs.map(({ company, cfg, stat, policies }) => {
          const release = (cfg?.payslipRelease ?? null) as { mode?: string; day?: number; offsetDays?: number } | null;
          return (
          <Card key={company.id}>
            <SectionHeader title={company.name} />
            <form action={savePayrollConfigAction} className="space-y-5 p-4">
              <input type="hidden" name="companyId" value={company.id} />

              <div>
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('scheduleTitle')}</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('cutOffDay')}>
                    <input type="number" name="cutOffDay" min={1} max={31} defaultValue={cfg?.cutOffDay ?? ''} placeholder={t('monthEnd')} className={inputCls} />
                  </Field>
                  <Field label={t('payDay')}>
                    <input type="number" name="payDay" min={1} max={31} defaultValue={cfg?.payDay ?? ''} placeholder={t('monthEnd')} className={inputCls} />
                  </Field>
                  <Field label={t('paymentBasis')}>
                    <select name="paymentBasis" defaultValue={cfg?.paymentBasis ?? 'monthly'} className={inputCls}>
                      {BASES.map((bs) => (
                        <option key={bs} value={bs}>{t(`basis_${bs}`)}</option>
                      ))}
                    </select>
                  </Field>
                  {/* 297ae65a — the company default salary currency: new Basic Salary records preselect
                      it (per-record currency stays editable on the employee's salary form). */}
                  <Field label={t('defaultCurrency')}>
                    <CurrencySelect name="defaultCurrency" value={cfg?.defaultCurrency ?? 'MYR'} />
                  </Field>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('dayHint')}</p>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('defaultCurrencyHint')}</p>
              </div>

              {/* Step 1 (f3148da1) — company-default payroll policy + Step 6 payslip release */}
              <div>
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('policyReleaseTitle')}</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('defaultPolicy')}>
                    <select name="defaultPayrollPolicyId" defaultValue={cfg?.defaultPayrollPolicyId ?? ''} className={inputCls}>
                      <option value="">{t('defaultPolicyNone')}</option>
                      {policies.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('releaseMode')}>
                    <select name="payslipReleaseMode" defaultValue={release?.mode ?? 'immediate'} className={inputCls}>
                      {RELEASE_MODES.map((m) => (
                        <option key={m} value={m}>{t(`release_${m}`)}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('releaseValue')}>
                    <input
                      type="number"
                      name="payslipReleaseValue"
                      defaultValue={release?.mode === 'fixed_day' ? (release.day ?? '') : release?.mode === 'relative' ? (release.offsetDays ?? '') : ''}
                      placeholder={t('releaseValuePlaceholder')}
                      className={inputCls}
                    />
                  </Field>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('defaultPolicyHint')}</p>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('releaseHint')}</p>
              </div>

              <div>
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('statutoryTitle')}</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('hrdfStatus')}>
                    <select name="hrdfStatus" defaultValue={stat?.hrdfStatus ?? 'not_registered'} className={inputCls}>
                      {HRDF.map((h) => (
                        <option key={h} value={h}>{t(`hrdf_${h}`)}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('epfEmployerNo')}>
                    <input name="epfEmployerNo" defaultValue={stat?.epfEmployerNo ?? ''} className={inputCls} />
                  </Field>
                  <Field label={t('socsoEmployerCode')}>
                    <input name="socsoEmployerCode" defaultValue={stat?.socsoEmployerCode ?? ''} className={inputCls} />
                  </Field>
                  <Field label={t('lhdnEmployerNo')}>
                    <input name="lhdnEmployerNo" defaultValue={stat?.lhdnEmployerNo ?? ''} className={inputCls} />
                  </Field>
                  <Field label={t('myinvoisTin')}>
                    <input name="myinvoisTin" defaultValue={stat?.myinvoisTin ?? ''} className={inputCls} />
                  </Field>
                  <Field label={t('ssmRegistrationNo')}>
                    <input name="ssmRegistrationNo" defaultValue={stat?.ssmRegistrationNo ?? ''} className={inputCls} />
                  </Field>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('hrdfHint')}</p>
              </div>

              <div>
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('cutOffsTitle')}</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('overtimeCutOff')}>
                    <input type="number" name="overtimeCutOffDay" min={1} max={31} defaultValue={cfg?.overtimeCutOffDay ?? ''} placeholder={t('monthEnd')} className={inputCls} />
                  </Field>
                  <Field label={t('claimCutOff')}>
                    <input type="number" name="claimCutOffDay" min={1} max={31} defaultValue={cfg?.claimCutOffDay ?? ''} placeholder={t('monthEnd')} className={inputCls} />
                  </Field>
                  <Field label={t('unpaidLeaveCutOff')}>
                    <input type="number" name="unpaidLeaveCutOffDay" min={1} max={31} defaultValue={cfg?.unpaidLeaveCutOffDay ?? ''} placeholder={t('monthEnd')} className={inputCls} />
                  </Field>
                  <Field label={t('attendanceCutOff')}>
                    <input type="number" name="attendanceCutOffDay" min={1} max={31} defaultValue={cfg?.attendanceCutOffDay ?? ''} placeholder={t('monthEnd')} className={inputCls} />
                  </Field>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('cutOffsHint')}</p>
              </div>

              <div>
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('hiringTitle')}</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('probationMonths')}>
                    <input type="number" name="probationMonths" min={1} defaultValue={cfg?.probationMonths ?? ''} placeholder="3" className={inputCls} />
                  </Field>
                  <Field label={t('reviewReminderDays')}>
                    <input name="reviewReminderDays" defaultValue={cfg?.reviewReminderDays?.join(', ') ?? ''} placeholder="30, 14, 7" className={inputCls} />
                  </Field>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('probationMonthsHint')}</p>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('reviewReminderDaysHint')}</p>
              </div>

              <button className={btnPrimary}>{t('save')}</button>
            </form>
          </Card>
          );
        })
      )}
    </div>
  );
}
