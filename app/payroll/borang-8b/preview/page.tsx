import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { scopedAdmin } from '@/lib/scope';
import { PageHeader, pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { criteriaHref, criteriaReturnHref } from '../../statutory-forms/criteria';
import { BORANG_8B_REPORT_ID, borang8BDocumentQuery, loadBorang8B } from '../shared';

/**
 * r412 (item e74af58c, step 2) — BORANG 8B: choose Company and the UNDER-PAID month, Continue, look, download.
 *
 * NO PAYROLL CYCLE BOX AND NO "NOTHING TO FILE" GATE: the 8B is drawn from no payroll run. The criteria step
 * asks Company, Year and Month (the catalog's `preview`, not `runSelection`) and Continue lands here.
 *
 * THE FORM IS SHOWN IN THE APP, in the shared viewer, framing `../pdf?…&disposition=inline` — the download's
 * own bytes. Beside it the screen says, before the download, what was FILLED from the records and what was
 * LEFT BLANK and why — above all that the employee lines and amounts are blank because the system holds no
 * underpayment record (core/back-pay.ts charges arrears in the month paid).
 *
 * A COMPANY THAT CANNOT FILE ONE YET (no SOCSO employer code, no legal name) gets the screen with the gap
 * named and no form and no download; the PDF route refuses the same request.
 *
 * GATED LIKE ITS SIBLINGS: `scopedAdmin`, registered under `statutoryForms` (lib/permissions.ts).
 */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

const HEADER_FIELD_LABEL: Record<string, 'headerField_employerCode' | 'headerField_employerName'> = {
  employerCode: 'headerField_employerCode',
  employerName: 'headerField_employerName',
};

type Search = Record<string, string | string[] | undefined>;

export default async function Borang8BPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.borang8b');
  const tf = await getTranslations('payroll.statutoryForms');
  const locale = await getLocale();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');

  const { scopeIds, s } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  const companyId = scopeIds.includes(one('companyId')) ? one('companyId') : '';
  const legacy = /^\d{4}-(0[1-9]|1[0-2])$/.test(one('periodKey')) ? one('periodKey') : '';
  const year = /^\d{4}$/.test(one('year')) ? one('year') : legacy.slice(0, 4);
  const month = MONTHS.includes(one('month') as (typeof MONTHS)[number]) ? one('month') : legacy.slice(5, 7);
  if (!companyId || !year || !month) redirect(criteriaHref(BORANG_8B_REPORT_ID));
  const periodKey = `${year}-${month}`;

  const loaded = await loadBorang8B({ companyId, periodKey, includeIncomplete: true });
  if (!loaded.ok) notFound();
  const { form, headerMissing } = loaded;
  const ready = headerMissing.length === 0;

  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const periodLabel = `${monthFmt.format(new Date(Date.UTC(2000, Number(month) - 1, 1)))} ${year}`;
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const subtitle = `${companyName} · ${t('subtitleMonth', { month: periodLabel })}`;
  const backToCriteria = criteriaReturnHref(BORANG_8B_REPORT_ID, { companyId, year, month });
  const documentQuery = borang8BDocumentQuery({ companyId, periodKey });
  const hasSignatory = Boolean(form.signatoryName.trim() || form.signatoryPhone.trim());

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
        <div className="font-mono text-base font-semibold">{form.contributionMonth || '—'}</div>
        <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileEmployerCode')}</div>
        <div className="font-mono text-base font-semibold">{form.employerCode || '—'}</div>
        <div className="text-xs text-muted-foreground">{t('tileNoDeadline')}</div>
      </div>
    </div>
  );

  /* WHAT CAME FROM THE RECORDS, AND WHAT IS LEFT FOR THE EMPLOYER — said before the download, never after. */
  const boxes = (
    <div data-blank-boxes className="space-y-2 border-t border-border pt-3 text-xs monolith:border-ink">
      <p className="font-medium uppercase tracking-wide text-muted-foreground">{t('filledTitle')}</p>
      <p className="text-muted-foreground">{t('filledHint')}</p>
      {!hasSignatory && <p className="text-amber-700 dark:text-amber-300">{t('signatoryMissing')}</p>}
      <p className="pt-1 font-medium uppercase tracking-wide text-muted-foreground">{t('blankTitle')}</p>
      <dl className="space-y-2">
        <div>
          <dt className="font-medium">{t('blankLines')}</dt>
          <dd className="text-muted-foreground">{t('blankLinesHint')}</dd>
        </div>
        <div>
          <dt className="font-medium">{t('blankTotals')}</dt>
          <dd className="text-muted-foreground">{t('blankTotalsHint')}</dd>
        </div>
        <div>
          <dt className="font-medium">{t('blankPayment')}</dt>
          <dd className="text-muted-foreground">{t('blankPaymentHint')}</dd>
        </div>
        <div>
          <dt className="font-medium">{t('blankSignature')}</dt>
          <dd className="text-muted-foreground">{t('blankSignatureHint')}</dd>
        </div>
        <div>
          <dt className="font-medium">{t('blankAgent')}</dt>
          <dd className="text-muted-foreground">{t('blankAgentHint')}</dd>
        </div>
      </dl>
    </div>
  );

  if (!ready) {
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('title')} description={subtitle} back={{ href: backToCriteria, label: t('viewerBack') }} />
        {provenance}
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('headerMissingTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {headerMissing.map((f) => (
              <li key={f}>{HEADER_FIELD_LABEL[f] ? t(HEADER_FIELD_LABEL[f]) : f}</li>
            ))}
          </ul>
          <p className="mt-1">{t('headerMissingHint')}</p>
        </div>
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
        pdfUrl={`/payroll/borang-8b/pdf?${documentQuery}&disposition=inline`}
        downloads={[{ href: `/payroll/borang-8b/pdf?${documentQuery}`, label: t('downloadPdf') }]}
        back={{ href: backToCriteria, label: t('viewerBack') }}
        openInNewTabLabel={tf('viewer_openNewTab')}
        frameTitle={tf('viewer_frameTitle', { form: t('title') })}
        sidePanel={
          <>
            {tiles}
            {provenance}
            {boxes}
          </>
        }
      />
    </div>
  );
}
