import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listReports, reportPreview, submissionDueFor } from '@/core/reporting';
import { Card, ErrorBanner, Field, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { StatutoryReportPanel } from '@/components/statutory-report-panel';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
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
 *
 * 587ee719 — THE FIDELITY BANNER SAYS WHAT THIS SCREEN CAN GIVE YOU, AND NOTHING MORE. It repeats the
 * status the card on the shelf already carried, so nobody arrives here having forgotten. It describes the
 * STATUS ONLY: it does not say the form is validated, complete for filing, or accepted anywhere. The
 * request asked for generation to be BLOCKED when statutory numbers are missing; that is deliberately not
 * built here, because a hard block needs each form's own required-field list and that arrives with each
 * form's own build. What exists is unchanged — readiness named per person (components/statutory-report-
 * panel.tsx) and the readiness gate on the two agency upload files below.
 *
 * 587ee719 — `lang` IS ACCEPTED AND CARRIED, NOT RENDERED. The two EA shelf entries (my.ea.en / my.ea.ms)
 * land on this screen's CP8D employee list, and the language they were chosen for has to survive the trip
 * to the per-employee statement. It changes nothing about this page's own words: those follow the viewer's
 * UI locale exactly as before.
 */
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const EA_LANGS = ['en', 'ms'] as const;
type EaLang = (typeof EA_LANGS)[number];
const FIDELITY_KEY: Record<string, string> = {
  official: 'fidelity_official',
  // 8ca344bf — the agency's own layout, drawn by us because the agency publishes no blank page.
  'agency-layout': 'fidelity_agency_layout',
  figures: 'fidelity_figures',
  'draft-file': 'fidelity_draft_file',
};
const FIDELITY_HINT_KEY: Record<string, string> = {
  official: 'fidelity_official_hint',
  'agency-layout': 'fidelity_agency_layout_hint',
  figures: 'fidelity_figures_hint',
  'draft-file': 'fidelity_draft_file_hint',
};
const FIDELITY_CLS: Record<string, string> = {
  official: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  'agency-layout': 'border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300',
  figures: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300',
  'draft-file': 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
};

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
    /** 587ee719 — which language the per-employee EA statements should come out in (en / ms). */
    lang?: string;
    error?: string;
  }>;
}) {
  // 6babf4f6 — scopedAdmin, NOT requireAdmin, and the company list is narrowed to what this admin actually
  // administers. Found in verification.
  //
  // WHAT WAS AND WAS NOT WRONG, measured rather than assumed (test/statutory-forms-scope.test.ts): the READ
  // already fails closed — payroll_batch's RLS needs can_admin_payroll_for(company_id), so reportPreview
  // returns NO rows for a company this admin does not administer. Nothing leaked.
  //
  // What did happen is worse than harmless: listCompanies() is tenant-wide, so the picker OFFERED those
  // companies. Choosing one rendered an EMPTY statutory return under that company's name — which an
  // operator can read as "nothing to file" — while the export route on the same screen answers 404 for the
  // identical selection, because it already fenced with scopeIds. A screen that disagrees with its own
  // export button is the defect; the empty return is how it shows up.
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  const locale = await getLocale();
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const { formId } = await params;
  const sp = await searchParams;

  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // An out-of-scope companyId in the URL falls back to the first company this admin CAN administer, rather
  // than being honoured. Same rule the export route applies, so the two cannot disagree again.
  const requested = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const companyId = requested || companies[0]?.id || '';
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
  // Always includes the selected year, so an older link cannot resolve correctly while the select
  // silently shows a different year beside the figures.
  const years = yearOptions(today, year);

  // Unconditional, and safe to be: past the `notFound` above, `companyId` named a company whose
  // jurisdiction registers this report — an empty or foreign id yields no `def` and never reaches here.
  const result = await reportPreview(s, { companyId, reportId: formId, periodKey });
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  // `submissionDueFor` only models a monthly deadline, so an annual period comes back "unknown" — the
  // honest answer for Form E, whose statutory date was never stated to us.
  const due = submissionDueFor(periodKey, def.submission?.dueDayOfNextMonth ?? null, today);
  const periodLabel = annual ? year : `${monthName(month)} ${year}`;
  const ready = result.readiness.length === 0;
  // ALLOWLISTED, never echoed. An unrecognised value is dropped rather than passed on: `lang` ends up in
  // a URL the employee-name links point at, and the EA route allowlists it a second time.
  const eaLang: EaLang | null = EA_LANGS.includes(sp.lang as EaLang) ? (sp.lang as EaLang) : null;
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
      {/* The on-screen header carries a back link, so it is hidden on paper — but a printed statutory
          return with no form name, company or period on it is not a document anybody can file. */}
      <div className="hidden print:block">
        <h1 className="text-lg font-semibold">{def.label}</h1>
        <p className="text-sm">
          {companyName} · {periodLabel}
        </p>
      </div>
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden print:hidden">
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-4">
          {/* The chosen EA language survives a re-Show. A GET form submits only its own controls, so
              without this hidden field picking a different month would silently drop back to the UI
              locale — the exact "it follows your app language" behaviour this round removed. */}
          {eaLang && <input type="hidden" name="lang" value={eaLang} />}
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
          <div className="text-lg font-semibold tabular-nums">{result.rows.length}</div>
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
            {t(`status_${due.status}` as 'status_upcoming')}
          </span>
        </div>
      </div>

      {/* 587ee719 — the same status the card on the shelf carried, restated where the download buttons
          are. STATUS ONLY: it names what this screen produces, never that it is validated or ready to
          file. Absent entirely for a form whose catalog entry declares no fidelity, rather than guessed. */}
      {def.fidelity && (
        <div className={`rounded-lg border px-4 py-3 text-xs ${FIDELITY_CLS[def.fidelity]}`}>
          <span className="font-medium uppercase tracking-wide">
            {t(FIDELITY_KEY[def.fidelity] as 'fidelity_official')}
          </span>{' '}
          <span>{t(FIDELITY_HINT_KEY[def.fidelity] as 'fidelity_official_hint')}</span>
        </div>
      )}

      {!result.meta.hasBatch ? (
        <Card>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t('noBatch', { company: companyName, period: periodLabel })}
          </p>
        </Card>
      ) : (
        <StatutoryReportPanel
          result={result}
          /* An employee name opens that person's EA statement for the year — the ONLY route to a
             per-employee EA, since an EA is one statement per person and never a company-wide table.
             The YEAR, never the period: the EA page tests its `year` against /^\d{4}$/ and falls back
             to the server's current year when it does not match. */
          eaYear={year}
          /* 587ee719 — when this list was opened FROM an EA shelf entry, the employee names hand you that
             person's EA statement in the chosen language, as a PDF: that PDF is the form the entry names.
             Null (the ordinary CP8D arrival) leaves the link exactly as it was — the on-screen statement,
             in the viewer's own language. */
          eaLang={eaLang}
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
              {/* e0cd4583 — the PRINTED CP39, one press further on. This screen is the figures; the
                  review screen is where the preparer block is typed and where the drawn statement and
                  its plain-text twin are downloaded from. Deliberately NOT gated on `ready`, exactly like
                  the Borang 8A and Borang A rows below: the review screen's whole job is to NAME whoever
                  is missing an income tax reference number, which it cannot do if you cannot reach it.
                  The downloads themselves are gated, on that screen AND in the routes.

                  It sits BESIDE the e-Data PCB file above, not instead of it: that file is the actual
                  LHDN submission, and this page is for internal records and as a payment cover document
                  (LHDN has not accepted a paper CP39 since September 2019). */}
              {formId === 'my.cp39' && (
                <a
                  href={`/payroll/cp39/preview?companyId=${encodeURIComponent(companyId)}&periodKey=${encodeURIComponent(periodKey)}`}
                  className={outBtn}
                  title={t('cp39ReviewTitle')}
                >
                  {t('cp39Review')}
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
              {/* 8ca344bf — the DOCUMENT, one press further on. This screen is the figures; the review
                  screen is where a status is typed against a row and where the drawn form and its plain-text
                  twin are downloaded from. Deliberately NOT gated on `ready`: the review screen's whole job
                  is to NAME whoever is missing an identity card number, which it cannot do if you cannot
                  reach it. The downloads themselves are gated, on that screen AND in the routes. */}
              {formId === 'my.borang-8a' && (
                <a
                  href={`/payroll/borang-8a/preview?companyId=${encodeURIComponent(companyId)}&periodKey=${encodeURIComponent(periodKey)}`}
                  className={outBtn}
                  title={t('borang8aReviewTitle')}
                >
                  {t('borang8aReview')}
                </a>
              )}
              {/* 9c8dad7a — same shape, same reasoning as the Borang 8A row above: this screen is the
                  figures, the review screen is where the contribution month is set and where the drawn
                  form, its text twin and the i-Akaun upload file are downloaded from. Deliberately NOT
                  gated on `ready` — the review screen's whole job is to NAME whoever is missing an EPF
                  member number, which it cannot do if you cannot reach it. */}
              {formId === 'my.borang-a' && (
                <a
                  href={`/payroll/borang-a/preview?companyId=${encodeURIComponent(companyId)}&periodKey=${encodeURIComponent(periodKey)}`}
                  className={outBtn}
                  title={t('borangAReviewTitle')}
                >
                  {t('borangAReview')}
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
      )}
    </div>
  );
}
