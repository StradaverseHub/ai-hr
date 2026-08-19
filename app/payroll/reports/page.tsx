import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listReports, recentReports, reportPreview } from '@/core/reporting';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { DownloadCsv } from '@/components/download-csv';
import { StatutoryReportPanel } from '@/components/statutory-report-panel';
import { recordReportAction } from './actions';

/**
 * 6babf4f6 — THE CP22 / CP22A WORKLIST MOVED OFF THIS PAGE, to Payroll → Statutory Forms.
 *
 * It is not gone: it renders there, unchanged, driven by the same `complianceWorklist`. It sat here
 * only because Statutory Forms did not exist yet, and CP22 (new joiner) and CP22A (cessation) are LHDN
 * statutory notices — exactly what somebody opening Statutory Forms is looking for, and not what
 * somebody opening the general Reports page is. One home each, so nobody has to check both.
 *
 * The report body below is now `components/statutory-report-panel.tsx`, shared with the per-form
 * statutory screen. Same markup, one copy — see that file for why.
 */

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; reportId?: string; periodKey?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.reports');
  const sp = await searchParams;
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt);
  const companyId = sp.companyId || companies[0]?.id || '';
  const reports = companyId ? await listReports(s, companyId) : [];
  const reportId = sp.reportId || reports[0]?.id || '';
  const periodKey = sp.periodKey || '';
  const canPreview = Boolean(companyId && reportId && periodKey);
  const result = canPreview ? await reportPreview(s, { companyId, reportId, periodKey }) : null;
  const recent = companyId ? await recentReports(s, companyId) : [];
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const periodKind = reports.find((r) => r.id === reportId)?.periodKind ?? 'month';
  const annual = periodKind === 'year';

  return (
    <div className={pageWideCls}>
      <div data-tour="payroll-reports">
        <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      </div>
      <ErrorBanner message={sp.error} />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
        ⚠️ {t('layerABanner')}
      </div>

      {/* Where CP22 / CP22A went, said in the place they used to be — a card that simply disappears
          teaches people it was removed. */}
      <p className="text-sm text-muted-foreground">
        {t('worklistMoved')}{' '}
        <Link href="/payroll/statutory-forms#worklist" className="text-primary hover:underline">
          {t('worklistMovedLink')}
        </Link>
      </p>

      {/* bdf7d248 (r209) — the ADR-0024 §7 worksheet's one entry point. It is reached from here rather
          than from a nav row because it answers a question somebody is asking while looking at these
          figures ("what would my statutory totals be if a second run in a month were treated as one
          month?"), and because PAYROLL_ADMIN_NAV is an exact set the sidebar test pins. */}
      <p className="text-sm text-muted-foreground">
        {t('worksheetIntro')}{' '}
        <Link href="/payroll/multi-cycle-worksheet" className="text-primary hover:underline">
          {t('worksheetLink')}
        </Link>
      </p>

      <Card data-tour="payroll-generate">
        <SectionHeader title={t('generateTitle')} />
        <form method="get" className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <Field label={t('fieldCompany')}>
            <select name="companyId" defaultValue={companyId} className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('fieldReport')}>
            <select name="reportId" defaultValue={reportId} className={inputCls}>
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={annual ? t('fieldYear') : t('fieldPeriod')}>
            <input
              name="periodKey"
              defaultValue={periodKey}
              placeholder={annual ? '2026' : '2026-07'}
              className={inputCls}
            />
          </Field>
          <button className={btnPrimary}>{t('preview')}</button>
        </form>
      </Card>

      {result && !result.meta.hasBatch && (
        <Card>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t('noBatch', { company: companyName.get(companyId) ?? '—', period: periodKey })}
          </p>
        </Card>
      )}

      {result && result.meta.hasBatch && (
        <StatutoryReportPanel
          result={result}
          /* `.slice(0, 4)`, NOT the raw periodKey. This link used to send `?year=2026-07` from a monthly
             report; the EA page tests the value against /^\d{4}$/ and silently fell back to the SERVER's
             current year — so in January you opened last month's EPF report and got this year's empty EA
             statement. The year of a month is its first four characters, and for an annual report the
             value is unchanged. */
          eaYear={periodKey.slice(0, 4)}
          strings={{
            heading: t('reportHeader', {
              label: reports.find((r) => r.id === reportId)?.label ?? t('reportFallback'),
              period: periodKey,
            }),
            readinessTitle: t('readinessTitle', { count: result.readiness.length }),
            noRows: t('noPayslips'),
          }}
          actions={
            <>
              {reportId === 'my.cp39' && result.readiness.length === 0 && (
                /* Layer-B (Exhibit 4 byte layout): each download records an artefact + event. */
                <a
                  href={`/payroll/reports/cp39-file?companyId=${companyId}&periodKey=${periodKey}`}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                  title={t('cp39DownloadTitle')}
                >
                  ⬇ {t('cp39DownloadLabel')}
                </a>
              )}
              {reportId === 'my.socso-eis' && result.readiness.length === 0 && (
                /* PERKESO ASSIST combined SOCSO+EIS textfile (v2.0 with SKBBK). */
                <a
                  href={`/payroll/reports/socso-eis-file?companyId=${companyId}&periodKey=${periodKey}`}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                  title={t('socsoEisDownloadTitle')}
                >
                  ⬇ {t('socsoEisDownloadLabel')}
                </a>
              )}
              <DownloadCsv
                columns={result.columns}
                rows={result.rows}
                filename={`${reportId}_${periodKey}.csv`}
              />
              <form action={recordReportAction}>
                <input type="hidden" name="companyId" value={companyId} />
                <input type="hidden" name="reportId" value={reportId} />
                <input type="hidden" name="periodKey" value={periodKey} />
                <button className={btnPrimary}>{t('recordGeneration')}</button>
              </form>
            </>
          }
        />
      )}

      <Card className="overflow-hidden">
        <SectionHeader title={t('recentTitle')} count={recent.length} />
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('colReport')}</th>
              <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
              <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('colRows')}</th>
              <th className="px-4 py-2 font-medium">{t('colTablesVer')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {recent.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5">{r.reportType}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{r.periodKey}</td>
                <td className="px-4 py-2.5 capitalize text-muted-foreground">{r.status}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{r.rowCount}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{r.statutoryVersion ?? '—'}</td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  {t('recentEmpty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
