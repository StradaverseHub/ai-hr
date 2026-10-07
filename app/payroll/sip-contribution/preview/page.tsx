import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { payslipCycleLabel } from '@/core/payslip-cycle-label';
import { listFilableRunsForPeriod } from '@/packs/payroll/service';
import { scopedAdmin } from '@/lib/scope';
import { money } from '@/lib/borang-8a';
import { parseRunSelection } from '@/lib/payroll-run-selection';
import { Card, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { criteriaHref, criteriaReturnHref, cyclesRefusalHref } from '../../statutory-forms/criteria';
import { SIP_REPORT_ID, loadSip } from '../shared';
import { sipDocumentQuery, sipQuery, type Search } from '../query';

/**
 * r412 (item e74af58c, step 2) — THE EIS (SIP) MONTHLY CONTRIBUTION SCHEDULE: choose, Continue, look, download.
 *
 * The Borang 8A screen (r408) is the pattern, decision for decision:
 *   • THE CONTINUE GATE RUNS HERE, BEFORE ANYTHING IS DRAWN: an invalid selection, no processed run for the
 *     month, a selection matching no run, or a selection with no EIS on it goes BACK to the criteria step
 *     (`cyclesRefusalHref`) with the criteria kept. A BONUS-ONLY selection is not "no data": the read names
 *     every person on it with the SOCSO/EIS-not-in-this-selection reason, and that named refusal — no form,
 *     no download — is what it gets, as on the 8A.
 *   • THE FORM IS SHOWN IN THE APP: the shared viewer frames `../pdf?…&disposition=inline`, the download's own
 *     bytes, at A4 proportions, full width. Its download is the same route with the same parameters, built
 *     from ONE list (`sipDocumentQuery`) that carries the selection.
 *   • NOTHING IS ADDED THAT THE SAMPLE DOES NOT HAVE: no declaration, no signature — so there is no "boxes
 *     left blank" panel either; there are none.
 * GATED LIKE ITS SIBLINGS: `scopedAdmin`, registered under `statutoryForms` (lib/permissions.ts).
 */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/** Header fields an operator can go and fill in. Partial on purpose: computed fields fall through raw. */
const HEADER_FIELD_LABEL: Record<string, 'headerField_employerCode' | 'headerField_employerName'> = {
  employerCode: 'headerField_employerCode',
  employerName: 'headerField_employerName',
};

/** The run-type word for a cycle label, through an EXPLICIT map (the shared picker's own words). */
const RUN_TYPE_KEY: Record<string, 'runTypeRegular' | 'runTypeOffCycle' | 'runTypeBonus' | 'runTypeAdjustment'> = {
  regular: 'runTypeRegular',
  off_cycle: 'runTypeOffCycle',
  bonus: 'runTypeBonus',
  adjustment: 'runTypeAdjustment',
};

export default async function SipContributionPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.sipContribution');
  const tf = await getTranslations('payroll.statutoryForms');
  const tr = await getTranslations('payroll.runPicker');
  const locale = await getLocale();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');

  const { scopeIds, s } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  const companyId = scopeIds.includes(one('companyId')) ? one('companyId') : '';
  const legacy = /^\d{4}-(0[1-9]|1[0-2])$/.test(one('periodKey')) ? one('periodKey') : '';
  const year = /^\d{4}$/.test(one('year')) ? one('year') : legacy.slice(0, 4);
  const month = MONTHS.includes(one('month') as (typeof MONTHS)[number]) ? one('month') : legacy.slice(5, 7);
  if (!companyId || !year || !month) redirect(criteriaHref(SIP_REPORT_ID));
  const periodKey = `${year}-${month}`;

  const query = sipQuery(sp);
  const selection = parseRunSelection(query);
  const runSeqs = selection.ok ? selection.runSeqs : undefined;
  const criteria = { companyId, year, month, runSeqs };

  // ── THE CONTINUE GATE. Nothing below this block runs for a selection with nothing to file. ──────────
  if (!selection.ok) redirect(cyclesRefusalHref(SIP_REPORT_ID, criteria, 'cycles_invalid'));
  const filable = await listFilableRunsForPeriod(s, { companyIds: scopeIds, companyId, periodKey });
  if (filable.length === 0) redirect(cyclesRefusalHref(SIP_REPORT_ID, criteria, 'cycles_no_runs'));
  const loaded = await loadSip({ companyId, periodKey, query, includeIncomplete: true });
  if (!loaded.ok) {
    if (loaded.reason === 'no-batch') redirect(cyclesRefusalHref(SIP_REPORT_ID, criteria, 'cycles_no_runs'));
    if (loaded.reason === 'selection-empty') redirect(cyclesRefusalHref(SIP_REPORT_ID, criteria, 'cycles_no_data'));
    if (loaded.reason === 'bad-selection') redirect(cyclesRefusalHref(SIP_REPORT_ID, criteria, 'cycles_invalid'));
    if (loaded.reason === 'no-contributions') redirect(cyclesRefusalHref(SIP_REPORT_ID, criteria, 'cycles_no_data'));
    notFound();
  }

  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const periodLabel = `${monthFmt.format(new Date(Date.UTC(2000, Number(month) - 1, 1)))} ${year}`;
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const cyclesText =
    runSeqs === undefined
      ? t('cyclesAll')
      : filable
          .filter((r) => runSeqs.includes(r.runSeq))
          .map(
            (r) =>
              payslipCycleLabel({
                cycleName: r.cycleName,
                runTypeLabel: RUN_TYPE_KEY[r.runType] ? tr(RUN_TYPE_KEY[r.runType]) : null,
              }) ?? tr('run', { seq: r.runSeq }),
          )
          .join(', ');

  const { form, missing, headerMissing, summary, notes } = loaded;
  const ready = missing.length === 0 && headerMissing.length === 0;
  const documentQuery = sipDocumentQuery({ companyId, periodKey, runSeqs });
  const backToCriteria = criteriaReturnHref(SIP_REPORT_ID, criteria);
  const subtitle = `${companyName} · ${periodLabel} · ${cyclesText}`;

  const provenance = (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs monolith:rounded-none monolith:border-hairline monolith:bg-transparent">
      <span className="font-medium">{t('notArtworkTitle')}</span>{' '}
      <span className="text-muted-foreground">{t('notArtwork')}</span>
    </div>
  );

  const tiles = (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border monolith:rounded-none">
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileMonth')}</div>
        <div className="font-mono text-base font-semibold">{form.contributionMonth}</div>
        <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileEmployees')}</div>
        <div className="text-base font-semibold tabular-nums">{form.employees}</div>
        <div className="text-xs text-muted-foreground">{t('tileSheets', { count: form.pages.length })}</div>
      </div>
      <div className="col-span-2 bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileTotal')}</div>
        <div className="text-base font-semibold tabular-nums">RM {money(form.total)}</div>
        <div className="text-xs text-muted-foreground">{t('tileEmployerCode', { code: form.employerCode || '—' })}</div>
      </div>
    </div>
  );

  const checks = (
    <>
      {notes.map((note) => (
        <div
          key={note}
          className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300"
        >
          ℹ️ {note}
        </div>
      ))}
      {headerMissing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('headerMissingTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {headerMissing.map((f) => (
              <li key={f}>{HEADER_FIELD_LABEL[f] ? t(HEADER_FIELD_LABEL[f]) : f}</li>
            ))}
          </ul>
          <p className="mt-1">{t('headerMissingHint')}</p>
        </div>
      )}
      {missing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('missingTitle', { count: missing.length })}</p>
          <ul className="mt-1 space-y-0.5">
            {missing.map((m) => (
              <li key={m.employmentId}>
                {m.name} — {m.missing.join(', ')}
              </li>
            ))}
          </ul>
          <p className="mt-1">{t('missingHint')}</p>
        </div>
      )}
    </>
  );

  const reconciliation =
    summary.length > 0 ? (
      <Card className="overflow-hidden">
        <SectionHeader title={t('reconTitle')} />
        <dl className="grid gap-px bg-border sm:grid-cols-2">
          {summary.map((item) => (
            <div key={item.label} className="bg-card p-4">
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className="text-sm font-semibold tabular-nums">RM {item.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    ) : null;

  const rows = form.pages.flatMap((p) => p.rows.map((r, i) => ({ ...r, bil: p.firstBil + i })));
  const schedule = (
    <Card className="overflow-hidden">
      <SectionHeader title={t('scheduleTitle')} count={form.employees} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-right font-medium">{t('colBil')}</th>
              <th className="px-4 py-2 font-medium">{t('colKod')}</th>
              <th className="px-4 py-2 font-medium">{t('colIc')}</th>
              <th className="px-4 py-2 font-medium">{t('colName')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('colMonth')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('colContribution')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.employmentId}>
                <td className="px-4 py-2 text-right tabular-nums">{r.bil}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.employerCode || '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.ic || <span className="text-red-600 dark:text-red-400">—</span>}</td>
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">{r.contributionMonth}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.contribution)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border bg-muted/30 text-sm font-semibold">
            {form.pages.map((p) => (
              <tr key={p.sheet}>
                <td colSpan={5} className="px-4 py-2">
                  {t('pageTotal', { sheet: p.sheet, of: p.of })}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{money(p.pageTotal)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} className="px-4 py-2">
                {t('grandTotal')}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{money(form.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );

  if (!ready) {
    // NOT READY: no drawn form and no download — the PDF route refuses it too.
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('title')} description={subtitle} back={{ href: backToCriteria, label: t('viewerBack') }} />
        {provenance}
        {tiles}
        {checks}
        <p className="text-sm text-muted-foreground" data-preview-blocked>
          {t('previewBlocked')}
        </p>
        {/* An empty table totalling 0.00 would assert there is no EIS to file — a bonus-only selection holds
            NONE because the selection is wrong, not because nothing is owed. Shown only when it has lines. */}
        {form.employees > 0 && reconciliation}
        {form.employees > 0 && schedule}
      </div>
    );
  }

  return (
    <div className={pageWideCls}>
      <StatutoryPdfViewer
        title={t('title')}
        subtitle={subtitle}
        pdfUrl={`/payroll/sip-contribution/pdf?${documentQuery}&disposition=inline`}
        downloads={[{ href: `/payroll/sip-contribution/pdf?${documentQuery}`, label: t('downloadPdf') }]}
        back={{ href: backToCriteria, label: t('viewerBack') }}
        openInNewTabLabel={tf('viewer_openNewTab')}
        frameTitle={tf('viewer_frameTitle', { form: t('title') })}
        sidePanel={
          <>
            {tiles}
            {provenance}
            {checks}
          </>
        }
      />
      {reconciliation}
      {schedule}
    </div>
  );
}
