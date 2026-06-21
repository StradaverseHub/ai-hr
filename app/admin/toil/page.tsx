import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listToilPolicies } from '@/core/toil';
import { Card, ErrorBanner, Field, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { setToilPolicyAction, runToilExpiryAction } from '../actions';

export default async function ToilPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; processed?: string; converted?: string; lapsed?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.toilPolicy');
  const { error, processed, converted, lapsed } = await searchParams;
  const envOn = process.env.TOIL_ENABLED === 'true';

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const policies = await listToilPolicies(s, visible.map((c) => c.id));
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      {processed !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {Number(processed) === 0
            ? t('processedNone')
            : t('processedBanner', { processed: Number(processed), converted: Number(converted ?? 0), lapsed: Number(lapsed ?? 0) })}
        </div>
      )}

      {!envOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('envGateOff')}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        visible.map((c) => {
          const p = byCompany.get(c.id);
          if (!p) return null;
          return (
            <Card key={c.id}>
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">{c.name}</h2>
                <span
                  className={
                    p.enabled
                      ? 'rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                      : 'rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
                  }
                >
                  {p.enabled ? t('on') : t('off')}
                </span>
              </div>
              <form action={setToilPolicyAction} className="space-y-4 p-4">
                <input type="hidden" name="companyId" value={c.id} />

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="enabled" defaultChecked={p.enabled} className="mt-0.5 h-4 w-4 accent-primary" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{t('enabledLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{t('enabledHint')}</span>
                  </span>
                </label>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('accrualBasis')}>
                    <select name="accrualBasis" defaultValue={p.accrualBasis} className={inputCls}>
                      <option value="hours_worked">{t('basisHoursWorked')}</option>
                      <option value="premium_equivalent">{t('basisPremiumEquivalent')}</option>
                    </select>
                  </Field>
                  <Field label={t('expiryDays')}>
                    <input type="number" name="expiryDays" min={1} max={730} required defaultValue={p.expiryDays} className={inputCls} />
                  </Field>
                  <Field label={t('onExpiry')}>
                    <select name="onExpiry" defaultValue={p.onExpiry} className={inputCls}>
                      <option value="convert_to_pay">{t('expiryConvertToPay')}</option>
                      <option value="lapse">{t('expiryLapse')}</option>
                    </select>
                  </Field>
                </div>

                <label className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-500/25 dark:bg-amber-500/5">
                  <input
                    type="checkbox"
                    name="allowFirstScheduleEligible"
                    defaultChecked={p.allowFirstScheduleEligible}
                    className="mt-0.5 h-4 w-4 accent-amber-600"
                  />
                  <span>
                    <span className="text-sm font-medium text-foreground">{t('allowEligibleLabel')}</span>
                    <span className="block text-xs text-amber-700/90 dark:text-amber-300/80">{t('allowEligibleHint')}</span>
                  </span>
                </label>

                <button className={btnPrimary}>{t('save')}</button>
              </form>
            </Card>
          );
        })
      )}

      {envOn && visible.length > 0 && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">{t('processTitle')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('processHint')}</p>
            </div>
            <form action={runToilExpiryAction}>
              <button className={btnPrimary}>{t('processButton')}</button>
            </form>
          </div>
        </Card>
      )}

      <p className="px-1 text-xs text-muted-foreground">{t('footnote')}</p>
    </div>
  );
}
