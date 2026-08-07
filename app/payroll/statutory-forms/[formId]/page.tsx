import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listReports, reportPreview, submissionDueFor } from '@/core/reporting';
import { Card, ErrorBanner, Field, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { StatutoryReportPanel } from '@/components/statutory-report-panel';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { recordReportAction } from './actions';

/**
 * ONE statutory form: pick the period, check the figures, produce the output (6babf4f6).
 *
 * WHY THIS PAGE EXISTS. "Open form" used to leave Statutory Forms entirely and land on Payroll → Reports:
 * a dropdown of every report in the system, a Layer-A warning banner, a compliance worklist and a
 * generation history — none of which you asked for, and no way back except starting again. Every form now
 * gets the SAME screen, addressed by its own id, so the workflow is identical whichever form you came
 * from and the address bar names the form you are looking at.
 *
 * IT CALLS THE SHARED GENERATOR AND NOTHING ELSE. `reportPreview` is the same core seam Reports has always
 * used, resolving the pack's own `generate` for the id. No figure on this screen is computed here; a second
 * implementation of the same statutory arithmetic is the duplication 241817ef spent two rounds undoing.
 * `recordReportAction` keeps the audit trail exactly as it was.
 *
 * AN UNKNOWN id 404s. `formId` comes from the URL, so it is attacker-controlled; it is resolved against
 * `listReports` FOR THIS COMPANY, which means a report belonging to another jurisdiction's pack 404s here
 * rather than rendering an empty table under a form name.
 *
 * THE AGENCY FILE LINKS ARE GATED ON READINESS, exactly as Reports gates them. An e-CP39 or ASSIST file
 * generated while somebody is missing their tax or SOCSO number is a submission that silently omits them.
 */
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

const STATUS_CLS: Record<string, string> = {
  overdue: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  due_soon: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  upcoming: 'bg-muted text-muted-foreground',
  unknown: 'bg-muted text-muted-foreground',
};
const outBtn =
  'rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted';
const fileBtn =
  'rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';

/** Default to the month just ENDED — the one whose submission is actually open. */
function previousMonth(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export default async function StatutoryFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ formId: string }>;
  searchParams: Promise<{
    companyId?: string;
    year?: string;
    month?: string;
    periodKey?: string;
    error?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  const locale = await getLocale();
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const { formId } = await params;
  const sp = await searchParams;

  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt);
  const companyId = sp.companyId || companies[0]?.id || '';
  const reports = companyId ? await listReports(s, companyId) : [];
  const def = reports.find((r) => r.id === formId);
  // Unknown id, or a form this company's jurisdiction does not have. One answer for both, so the URL
  // cannot be used to enumerate what other packs register.
  if (!def) notFound();

  const today = todayInKualaLumpur();
  const annual = def.periodKind === 'year';
  const fallback = /^\d{4}-\d{2}$/.test(sp.periodKey ?? '') ? sp.periodKey! : previousMonth(today);
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : fallback.slice(0, 4);
  const month = MONTHS.includes(sp.month as (typeof MONTHS)[number]) ? sp.month! : fallback.slice(5, 7);
  // An annual form is filed for a YEAR: showing it a month filter would invite somebody to believe the
  // figures below are August's when they are the whole year's.
  const periodKey = annual ? year : `${year}-${month}`;
  const thisYear = Number(today.slice(0, 4));
  const years = Array.from({ length: 7 }, (_, i) => String(thisYear - i));

  const result = companyId ? await reportPreview(s, { companyId, reportId: formId, periodKey }) : null;
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const due = annual
    ? { dueBy: null as string | null, status: 'unknown' as const }
    : submissionDueFor(periodKey, def.submission?.dueDayOfNextMonth ?? null, today);
  const periodLabel = annual ? year : `${monthName(month)} ${year}`;
  const ready = result != null && result.readiness.length === 0;
  const backHref = `/payroll/statutory-forms?companyId=${encodeURIComponent(companyId)}&year=${year}&month=${month}${
    def.submission ? `&body=${def.submission.body}` : ''
  }`;
  const exportHref = (format: string) =>
    `/payroll/statutory-forms/${encodeURIComponent(formId)}/export?companyId=${encodeURIComponent(
      companyId,
    )}&periodKey=${encodeURIComponent(periodKey)}&format=${format}`;

  return (
    <div className="mx-auto max-w-[100rem] space-y-6 print:max-w-none">
      <div className="print:hidden">
        <PageHeader back={{ href: backHref, label: t('pageTitle') }} title={def.label} description={companyName} />
      </div>
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden print:hidden">
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-4">
          <Field label={t('company')}>
            <select name="companyId" defaultValue={companyId} className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('year')}>
            <select name="year" defaultValue={year} className={inputCls}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          {!annual && (
            <Field label={t('month')}>
              <select name="month" defaultValue={month} className={inputCls}>
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {monthName(m)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <button className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent">
            {t('show')}
          </button>
        </form>
      </Card>

      {/* The preview strip the request asks for: what is being filed, with whom, for when, and how many
          people are in it. There is deliberately NO single "Total amount" tile — these reports have three
          to five money columns that mean different things (gross, employee share, employer share, SKBBK),
          and one summed figure across them would be a statutory number nobody could reconcile. The exact
          per-column totals are the labelled row immediately below. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('previewPeriod')}</div>
          <div className="text-lg font-semibold">{periodLabel}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('previewEmployees')}</div>
          <div className="text-lg font-semibold tabular-nums">{result?.rows.length ?? 0}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('colAgency')}</div>
          <div className="text-sm font-medium">{def.submission?.agency ?? '—'}</div>
          <div className="text-xs text-muted-foreground">{def.submission?.channel ?? ''}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('colDueBy')}</div>
          <div className="font-mono text-sm">{due.dueBy ?? '—'}</div>
          <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLS[due.status]}`}>
            {due.dueBy == null ? t('deadlineNotConfigured') : t(`status_${due.status}` as 'status_upcoming')}
          </span>
        </div>
      </div>

      {result && !result.meta.hasBatch ? (
        <Card>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t('noBatch', { company: companyName, period: periodLabel })}
          </p>
        </Card>
      ) : (
        result && (
          <StatutoryReportPanel
            result={result}
            /* An employee name opens that person's EA statement for the year — the ONLY route to a
               per-employee EA, since an EA is one statement per person and never a company-wide table.
               The YEAR, never the period: the EA page tests its `year` against /^\d{4}$/ and falls back
               to the server's current year when it does not match. */
            eaYear={year}
            strings={{
              heading: t('reportHeader', { label: def.label, period: periodLabel }),
              readinessTitle: t('readinessTitle', { count: result.readiness.length }),
              noRows: t('noRows'),
            }}
            actions={
              <>
                {/* Layer-B agency upload files, gated on readiness exactly as Reports gates them: a file
                    generated while somebody is missing a number is a submission that omits them. */}
                {formId === 'my.cp39' && ready && (
                  <a
                    href={`/payroll/reports/cp39-file?companyId=${companyId}&periodKey=${periodKey}`}
                    className={fileBtn}
                    title={t('cp39DownloadTitle')}
                  >
                    ⬇ {t('cp39DownloadLabel')}
                  </a>
                )}
                {formId === 'my.socso-eis' && ready && (
                  <a
                    href={`/payroll/reports/socso-eis-file?companyId=${companyId}&periodKey=${periodKey}`}
                    className={fileBtn}
                    title={t('socsoEisDownloadTitle')}
                  >
                    ⬇ {t('socsoEisDownloadLabel')}
                  </a>
                )}
                <a href={exportHref('pdf')} className={outBtn}>
                  {t('downloadPdf')}
                </a>
                <a href={exportHref('xlsx')} className={outBtn}>
                  {t('downloadExcel')}
                </a>
                <a href={exportHref('csv')} className={outBtn}>
                  {t('downloadCsv')}
                </a>
                <PrintButton />
                <form action={recordReportAction}>
                  <input type="hidden" name="companyId" value={companyId} />
                  <input type="hidden" name="formId" value={formId} />
                  <input type="hidden" name="periodKey" value={periodKey} />
                  <input type="hidden" name="year" value={year} />
                  <input type="hidden" name="month" value={month} />
                  <button className={btnPrimary}>{t('recordGeneration')}</button>
                </form>
              </>
            }
          />
        )
      )}
    </div>
  );
}
