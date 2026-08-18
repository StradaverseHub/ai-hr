import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { getPayrollConfig } from '@/core/payroll-config';
import { listAssignablePolicies } from '@/core/payroll-policy';
import type { PayslipRelease } from '@/db/schema';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { savePayrollConfigAction } from '../../actions';
import { configCompanyHref } from '../../nav';

/**
 * Pay Schedule — EDIT ONE COMPANY (feedback 6df24751, step 3 of the company-first route).
 *
 * ONE company's form, on its own screen, with Save and Cancel at the bottom. Previously this exact form
 * was rendered once per company, all of them open at once, down a single narrow column.
 *
 * SAME FIELDS, SAME ACTION, SAME VALIDATION — `savePayrollConfigAction` and `setPayrollConfig` are
 * untouched; only where the action redirects afterwards changed. Nothing about how payroll is calculated,
 * what a field means, or what is refused on save is different.
 *
 * NO STATUTORY FIELDS, deliberately (r79a 4fb8b75a step 4). The company statutory record is owned by
 * Organization → Statutory and is shown read-only on ../page.tsx. Rendering it here — even read-only —
 * would put it back on a screen with a Save button, which is how the two-writer race started.
 */

const RELEASE_MODES = ['immediate', 'fixed_day', 'relative'] as const;

export default async function EditPayrollConfigPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ error?: string; q?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('payrollConfig');
  const { companyId } = await params;
  const { error, q } = await searchParams;

  const all = await listCompanies(s);
  const company = all.find((c) => c.id === companyId && scopeIds.includes(c.id));
  if (!company) notFound();

  const cfg = await getPayrollConfig(s, company.id);
  const policies = await listAssignablePolicies(s, company.id);
  const release = (cfg?.payslipRelease ?? null) as PayslipRelease | null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t('editTitle')}
        description={company.name}
        back={{ href: configCompanyHref(company.id, q), label: company.name }}
      />
      {error && <ErrorBanner message={error} />}

      <Card>
        <SectionHeader title={company.name} />
        <form action={savePayrollConfigAction} className="space-y-5 p-4">
          <input type="hidden" name="companyId" value={company.id} />
          <input type="hidden" name="q" value={q ?? ''} />

          <div>
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('scheduleTitle')}</h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('cutOffDay')}>
                <input type="number" name="cutOffDay" min={1} max={31} defaultValue={cfg?.cutOffDay ?? ''} placeholder={t('monthEnd')} className={inputCls} />
              </Field>
              <Field label={t('payDay')}>
                <input type="number" name="payDay" min={1} max={31} defaultValue={cfg?.payDay ?? ''} placeholder={t('monthEnd')} className={inputCls} />
              </Field>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('dayHint')}</p>
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

          <div className="flex items-center gap-3">
            <button className={btnPrimary}>{t('save')}</button>
            <a
              href={configCompanyHref(company.id, q)}
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {t('cancel')}
            </a>
          </div>
        </form>
      </Card>
    </div>
  );
}
