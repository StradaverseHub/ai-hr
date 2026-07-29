import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { getPayrollConfig } from '@/core/payroll-config';
import { listAssignablePolicies } from '@/core/payroll-policy';
import { packFor } from '@/localization/registry';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { savePayrollConfigAction } from './actions';

/**
 * Payroll Schedule — the per-company payroll timing screen.
 *
 * r79a (4fb8b75a) reduced this screen to ONE job:
 *  • step 1 — it is reached by ONE card on Payroll Settings, not three. It was never three screens; the
 *    "Payroll Period Template" and "Payment Submission Control" cards opened this same form, each named
 *    after one of its sections.
 *  • step 2 — the Payment Basis field is gone. Nothing read it (migration 0324).
 *  • step 3 — probation months, review reminder days and default salary currency have left. They were
 *    never payroll settings; they now live with hiring (/admin/personnel/settings) and with the company
 *    (Organization → General) respectively.
 *  • step 4 — the company statutory block is READ-ONLY here. Organization owns it. It was editable from
 *    both screens against the same record with no coordination, so the later save silently won.
 */

const HRDF = ['not_registered', 'mandatory', 'optional'] as const;
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

              {/* Step 4 (4fb8b75a) — READ-ONLY. The company statutory block is ONE record that was editable
                  from here AND from Organization → Statutory, with no coordination between them: whoever
                  saved last won, silently. Organization owns it now (see the page docblock), so this is a
                  view with a link. No input names are rendered, so the action cannot receive statutory
                  fields even from a hand-crafted POST. */}
              <div>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('statutoryTitle')}</h4>
                  <Link href="/admin/organization" className="text-xs font-medium text-primary hover:underline">
                    {t('statutoryEditInOrganization')} →
                  </Link>
                </div>
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    { label: t('hrdfStatus'), value: t(`hrdf_${HRDF.includes(stat?.hrdfStatus as never) ? (stat?.hrdfStatus as string) : 'not_registered'}`) },
                    { label: t('epfEmployerNo'), value: stat?.epfEmployerNo },
                    { label: t('socsoEmployerCode'), value: stat?.socsoEmployerCode },
                    { label: t('lhdnEmployerNo'), value: stat?.lhdnEmployerNo },
                    { label: t('myinvoisTin'), value: stat?.myinvoisTin },
                    { label: t('ssmRegistrationNo'), value: stat?.ssmRegistrationNo },
                  ].map((row) => (
                    <div key={row.label}>
                      <dt className="text-xs font-medium text-muted-foreground">{row.label}</dt>
                      <dd className="mt-0.5 text-sm text-foreground">{row.value || t('statutoryNotSet')}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('statutoryReadOnlyHint')}</p>
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

              {/* Step 3 (4fb8b75a) — signposts for the three settings that LEFT this screen, so an admin
                  who came here looking for them is told where they went rather than finding a gap. */}
              <p className="text-xs text-muted-foreground">
                {t('movedSettingsHint')}{' '}
                <Link href="/admin/personnel/settings" className="font-medium text-primary hover:underline">
                  {t('movedHiringLink')}
                </Link>
                {' · '}
                <Link href="/admin/organization" className="font-medium text-primary hover:underline">
                  {t('movedCurrencyLink')}
                </Link>
              </p>

              <button className={btnPrimary}>{t('save')}</button>
            </form>
          </Card>
          );
        })
      )}
    </div>
  );
}
