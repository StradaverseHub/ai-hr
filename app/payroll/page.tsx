import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listBatches } from '@/core/payroll';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { PeriodSwitcher } from '@/components/period-switcher';
import { resumeHref } from './process/selection-logic';

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  processed: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  closed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; period?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.list');
  const sp = await searchParams;
  const { error } = sp;
  const period = sp.period || '';
  const allBatches = await listBatches(s, scopeIds);
  // Build #10: derive the distinct pay-period options inline from the already-fetched scoped
  // batches (already desc-sorted by listBatches' orderBy). A single round-trip; the in-JS filter
  // is cheap at per-tenant batch counts. `activePeriod` reconciles the URL param against the
  // available periods — a valid-but-absent ?period (e.g. after a company switch, or a hand-typed
  // value) quietly falls back to "All periods" so the list is never blank with a ghost selection.
  const periodOptions = [...new Set(allBatches.map((b) => b.payPeriod))];
  const activePeriod = period && periodOptions.includes(period) ? period : '';
  const batches = activePeriod ? allBatches.filter((b) => b.payPeriod === activePeriod) : allBatches;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div data-tour="payroll-intro">
        <PageHeader
          title={t('title')}
          actions={
            <div className="flex items-center gap-2">
              <Link
                href="/payroll/history-import"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
              >
                {t('importHistory')}
              </Link>
              <Button asChild data-tour="payroll-create">
                <Link href="/payroll/process">{t('newRun')}</Link>
              </Button>
            </div>
          }
        />
      </div>
      <PayrollTabs active="batches" />
      <div className="flex justify-end">
        <PeriodSwitcher options={periodOptions} active={activePeriod} />
      </div>
      <ErrorBanner message={error} />

      <Card className="overflow-hidden" data-tour="payroll-batches">
        <SectionHeader title={t('batches')} count={batches.length} />
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
              <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
              <th className="px-4 py-2 font-medium">{t('colEmployees')}</th>
              <th className="px-4 py-2 font-medium">{t('colNetPay')}</th>
              <th className="px-4 py-2 font-medium">{t('colPaymentDate')}</th>
              <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {batches.map((b) => {
              const totals = b.totals as { net?: number } | null;
              return (
                <tr key={b.id} className="hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    {/* A DRAFT batch resumes into the wizard at Employee Selection (the "who's in this run"
                        step, formerly bypassed for drafts). Processed/closed batches open directly as
                        read-only, unchanged. */}
                    <Link
                      href={resumeHref(b.id, b.status)}
                      className="font-medium hover:text-primary"
                    >
                      {b.payPeriod}
                    </Link>
                    {b.runType !== 'regular' && (
                      <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                        {t(`runType.${b.runType}`)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{b.company}</td>
                  <td className="px-4 py-2.5 tabular-nums">{b.employeeCount}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {totals?.net != null ? `RM ${Number(totals.net).toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground" title={b.batchDate?.endsWith('-28') ? t('paymentDateLegacyNote') : undefined}>
                    {b.batchDate ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[b.status]}`}>
                      {t(`status.${b.status}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
            {batches.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {activePeriod ? t('filteredEmpty') : t('empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
