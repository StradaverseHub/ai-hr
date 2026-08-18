import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listPayrollConfigs } from '@/core/payroll-config';
import type { PayslipRelease } from '@/db/schema';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { settingsBack } from '@/app/payroll/setup/back';
import { CONFIG_ROOT, configCompanyHref, configEditHref } from './nav';

/**
 * Pay Schedule — THE COMPANY LISTING (feedback 6df24751).
 *
 * This page used to render a FULL, OPEN editing form for every company the admin manages, stacked one
 * under another down a narrow column, each with its own Save button. Three companies meant three open
 * forms and no list, no search, and no way to see at a glance which companies were configured.
 *
 * It is now step 1 of a company-first route: pick a company, read its settings on their own screen, edit
 * them on a screen of their own. Pay Schedule is the ONE screen of the three where a company holds a
 * single set of settings, so it is the only one whose listing offers both View and Edit — there is a
 * single record for Edit to open.
 *
 * NOTHING ON THIS PAGE WRITES: no form, no Save button, no `savePayrollConfigAction`. That is the
 * regression this item is about, and test/payroll-settings-company-first.test.ts pins it.
 *
 * Guard unchanged (`scopedSession`, screen key `payrollConfig` in lib/permissions.ts) — the redesign moves
 * screens around, it does not re-open who may reach them. Writes are still gated by RLS
 * (can_admin_payroll_for) in core/payroll-config.ts.
 *
 * One query for every company's config (`listPayrollConfigs`), not one per company: the listing exists to
 * be fast enough to be the front door.
 */
export default async function PayrollConfigCompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; q?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('payrollConfig');
  const { error, q: qParam } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const q = (qParam ?? '').trim();
  const needle = q.toLowerCase();
  const rows = needle ? companies.filter((c) => c.name.toLowerCase().includes(needle)) : companies;

  const configs = await listPayrollConfigs(
    s,
    rows.map((c) => c.id),
  );
  const byCompany = new Map(configs.map((cfg) => [cfg.companyId, cfg]));

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('listDescription')} back={await settingsBack()} />
      {error && <ErrorBanner message={error} />}

      <Card className="overflow-hidden">
        <SectionHeader title={t('companiesTitle')} count={rows.length} />

        {/* Search — a plain GET form, so the term lives in the URL and every back link can carry it. */}
        <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
          <form action={CONFIG_ROOT} method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder={t('searchCompanyPlaceholder')}
              aria-label={t('searchCompanyPlaceholder')}
              className={`${inputCls} w-56`}
            />
            <button className={btnPrimary} type="submit">
              {t('search')}
            </button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('cutOffDay')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('payDay')}</th>
                <th className="px-4 py-2 font-medium">{t('releaseMode')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 font-medium">{t('colLastUpdated')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((c) => {
                const cfg = byCompany.get(c.id) ?? null;
                const release = (cfg?.payslipRelease ?? null) as PayslipRelease | null;
                return (
                  <tr key={c.id}>
                    <td className="px-4 py-2.5 font-medium">{c.name}</td>
                    {/* Blank means month-end, exactly as the form's placeholder has always said — so the
                        cell says Month-end rather than an em dash that would read as "not answered". */}
                    <td className="px-4 py-2.5 text-center tabular-nums text-muted-foreground">
                      {cfg ? (cfg.cutOffDay ?? t('monthEnd')) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center tabular-nums text-muted-foreground">
                      {cfg ? (cfg.payDay ?? t('monthEnd')) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {cfg ? t(`release_${release?.mode ?? 'immediate'}`) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {/* "Set" is deliberately a fact and not a judgement: it says this company has a
                          saved pay-schedule record. Whether that schedule lets payroll RUN is the
                          readiness question, answered on /payroll/setup. */}
                      <Badge variant={cfg ? 'success' : 'warning'}>{cfg ? t('statusSet') : t('statusNotSet')}</Badge>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {cfg ? cfg.updatedAt.toISOString().slice(0, 10) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-3">
                        <Link href={configCompanyHref(c.id, q)} className="text-xs font-medium text-primary hover:underline">
                          {t('view')}
                        </Link>
                        <Link href={configEditHref(c.id, q)} className="text-xs font-medium text-primary hover:underline">
                          {t('edit')}
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('emptyScope')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
