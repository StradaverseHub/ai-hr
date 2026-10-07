import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { payslipCycleLabel } from '@/core/payslip-cycle-label';
import { listFilableRunsForPeriod } from '@/packs/payroll/service';
import { scopedAdmin } from '@/lib/scope';
import { money } from '@/lib/borang-a';
import { parseRunSelection } from '@/lib/payroll-run-selection';
import { PageHeader, pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { criteriaHref, criteriaReturnHref, cyclesRefusalHref } from '../../statutory-forms/criteria';
import { borangADocumentQuery, borangAQuery, type Search } from '../../borang-a/query';
import { BORANG_BBCD_REPORT_ID, loadBorangBbcd } from '../shared';

/**
 * r411 (item 4f45f9b0) — the BBCD preview: Open Form → Company, Year, Month, Payroll Cycle → Continue →
 * the one-page form inside the app (the shared viewer) → Download.
 *
 * THE SAME PATH AS BORANG A, AND THE SAME GATE. The Continue gate below is Borang A's own, outcome for
 * outcome: an invalid selection (`cycles_invalid`), no processed run for the month (`cycles_no_runs`), and a
 * selection that names no run or carries no EPF contribution (`cycles_no_data`) send the operator back to
 * the criteria step with their choice kept. NO DOCUMENT IS DRAWN on that path.
 *
 * ONE READ. `loadBorangBbcd` is `loadBorangA` plus a projection (app/payroll/borang-bbcd/shared.ts), so the
 * Amaun Caruman shown here, framed here and downloaded here is the Borang A total for the same company,
 * month and cycles — and the frame and the download carry the same `run` values, built by the Borang A
 * screen's own `borangADocumentQuery`.
 *
 * A MISSING SIGNATORY IS A NOTE, NOT A REFUSAL: it is named beside the form, before the download, and the
 * form prints those lines empty. A Borang A that is not ready (no EPF employer reference, a member number
 * missing) DOES stop the BBCD: it is the cover for that form's payment.
 *
 * GATED LIKE ITS SIBLINGS: `scopedAdmin`, registered under `statutoryForms` in lib/permissions.ts.
 */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

const SIG_FIELD_LABEL = {
  name: 'sigField_name',
  ic: 'sigField_ic',
  position: 'sigField_position',
  phone: 'sigField_phone',
} as const;

const HEADER_FIELD_LABEL: Record<string, 'headerField_employerRef' | 'headerField_employerName'> = {
  employerRef: 'headerField_employerRef',
  employerName: 'headerField_employerName',
};

const RUN_TYPE_KEY: Record<string, 'runTypeRegular' | 'runTypeOffCycle' | 'runTypeBonus' | 'runTypeAdjustment'> = {
  regular: 'runTypeRegular',
  off_cycle: 'runTypeOffCycle',
  bonus: 'runTypeBonus',
  adjustment: 'runTypeAdjustment',
};

export default async function BorangBbcdPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.borangBbcd');
  const tf = await getTranslations('payroll.statutoryForms');
  const tr = await getTranslations('payroll.runPicker');
  const locale = await getLocale();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');

  const { scopeIds, s } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // Out of scope ⇒ absent ⇒ the criteria step (r256), never "the first company this admin can see".
  const companyId = scopeIds.includes(one('companyId')) ? one('companyId') : '';
  const legacy = /^\d{4}-(0[1-9]|1[0-2])$/.test(one('periodKey')) ? one('periodKey') : '';
  const year = /^\d{4}$/.test(one('year')) ? one('year') : legacy.slice(0, 4);
  const month = MONTHS.includes(one('month') as (typeof MONTHS)[number]) ? one('month') : legacy.slice(5, 7);
  if (!companyId || !year || !month) redirect(criteriaHref(BORANG_BBCD_REPORT_ID));
  const periodKey = `${year}-${month}`;

  // EVERY value of a repeated `run`, through Borang A's own conversion.
  const query = borangAQuery(sp);
  const selection = parseRunSelection(query);
  const runSeqs = selection.ok ? selection.runSeqs : undefined;
  const criteria = { companyId, year, month, runSeqs };

  // ── THE CONTINUE GATE — Borang A's, outcome for outcome. Nothing below runs for a refused selection. ──
  if (!selection.ok) redirect(cyclesRefusalHref(BORANG_BBCD_REPORT_ID, criteria, 'cycles_invalid'));
  const filable = await listFilableRunsForPeriod(s, { companyIds: scopeIds, companyId, periodKey });
  if (filable.length === 0) redirect(cyclesRefusalHref(BORANG_BBCD_REPORT_ID, criteria, 'cycles_no_runs'));
  const loaded = await loadBorangBbcd({ companyId, periodKey, query, includeIncomplete: true });
  if (!loaded.ok) {
    if (loaded.reason === 'no-batch') redirect(cyclesRefusalHref(BORANG_BBCD_REPORT_ID, criteria, 'cycles_no_runs'));
    if (loaded.reason === 'selection-empty') {
      redirect(cyclesRefusalHref(BORANG_BBCD_REPORT_ID, criteria, 'cycles_no_data'));
    }
    if (loaded.reason === 'bad-selection') redirect(cyclesRefusalHref(BORANG_BBCD_REPORT_ID, criteria, 'cycles_invalid'));
    if (loaded.reason === 'no-contributions') {
      redirect(cyclesRefusalHref(BORANG_BBCD_REPORT_ID, criteria, 'cycles_no_data'));
    }
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

  const { bbcd, missing, headerMissing, signatoryMissing } = loaded;
  const ready = missing.length === 0 && headerMissing.length === 0;
  // The SAME parameter list the Borang A screen builds its frame and downloads from — company, month, run.
  const documentQuery = borangADocumentQuery({ companyId, periodKey, runSeqs, query });
  const backToCriteria = criteriaReturnHref(BORANG_BBCD_REPORT_ID, criteria);
  const borangAHref = `/payroll/borang-a/preview?${borangADocumentQuery({ companyId, periodKey, runSeqs })}`;
  const subtitle = `${companyName} · ${periodLabel} · ${cyclesText}`;

  const provenance = (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs monolith:rounded-none monolith:border-hairline monolith:bg-transparent">
      <span className="font-medium">{t('notArtworkTitle')}</span>{' '}
      <span className="text-muted-foreground">{t('notArtwork')}</span>
    </div>
  );

  const tiles = (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 monolith:rounded-none">
      <div className="bg-card p-3 sm:col-span-2">
        <div className="text-xs text-muted-foreground">{t('tileTotal')}</div>
        <div className="text-base font-semibold tabular-nums">RM {money(bbcd.amount)}</div>
        <div className="text-xs text-muted-foreground">{t('tileTotalHint')}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileMonth')}</div>
        <div className="text-base font-semibold">{bbcd.contributionMonthName}</div>
        <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tilePayroll')}</div>
        <div className="text-base font-semibold">{bbcd.payrollMonthName}</div>
        <div className="text-xs text-muted-foreground">{t('tileRef', { ref: bbcd.employerRef || '—' })}</div>
      </div>
    </div>
  );

  // BEFORE THE DOWNLOAD: whose lines will be empty. Advisory — it never hides the download.
  const signatoryNote =
    signatoryMissing.length > 0 ? (
      <div
        data-signatory-missing
        className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
      >
        <p className="font-medium">{t('signatoryMissingTitle')}</p>
        <p className="mt-1">{signatoryMissing.map((f) => t(SIG_FIELD_LABEL[f])).join(', ')}</p>
        <p className="mt-1">{t('signatoryMissingHint')}</p>
      </div>
    ) : null;

  const blanks = (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <p className="font-medium">{t('blankTitle')}</p>
      <p className="mt-1">{t('blankHint')}</p>
    </div>
  );

  if (!ready) {
    // The Borang A for this choice cannot be filed yet, so neither can its cover. No frame: the PDF route
    // would refuse it, and a framed refusal is not a preview.
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('title')} description={subtitle} back={{ href: backToCriteria, label: t('viewerBack') }} />
        {provenance}
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('notReadyTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {headerMissing.map((f) => (
              <li key={f}>{HEADER_FIELD_LABEL[f] ? t(HEADER_FIELD_LABEL[f]) : f}</li>
            ))}
            {missing.length > 0 && <li>{t('notReadyEmployees', { count: missing.length })}</li>}
          </ul>
          <p className="mt-1">{t('notReadyHint')}</p>
          <Link href={borangAHref} className="mt-2 inline-block font-medium underline underline-offset-2">
            {t('openBorangA')}
          </Link>
        </div>
        {signatoryNote}
        <p className="text-sm text-muted-foreground" data-preview-blocked>
          {t('previewBlocked')}
        </p>
      </div>
    );
  }

  return (
    <div className={pageWideCls}>
      <StatutoryPdfViewer
        title={t('title')}
        subtitle={subtitle}
        pdfUrl={`/payroll/borang-bbcd/pdf?${documentQuery}&disposition=inline`}
        downloads={[{ href: `/payroll/borang-bbcd/pdf?${documentQuery}`, label: t('downloadPdf') }]}
        back={{ href: backToCriteria, label: t('viewerBack') }}
        openInNewTabLabel={tf('viewer_openNewTab')}
        frameTitle={tf('viewer_frameTitle', { form: t('title') })}
        sidePanel={
          <>
            {signatoryNote}
            {tiles}
            {provenance}
            {blanks}
          </>
        }
      />
    </div>
  );
}
