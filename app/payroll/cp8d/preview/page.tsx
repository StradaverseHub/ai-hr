import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { listReports, reportPreview } from '@/core/reporting';
import { scopedAdmin } from '@/lib/scope';
import { pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { criteriaHref, criteriaReturnHref, cyclesRefusalHref } from '../../statutory-forms/criteria';

/**
 * r409 (item 79f3f64d) — FORM E / CP8D: CHOOSE COMPANY AND YEAR, CONTINUE, LOOK, DOWNLOAD.
 *
 * Where the criteria step's Continue lands for the annual LHDN return (`preview.action` on `my.cp8d`, and
 * the Borang E alias's href, because they are one return). It asks for NOTHING ELSE: a month or a payroll
 * cycle means nothing on a yearly return, so neither is asked for here or on the step.
 *
 * ── WHAT THE PREVIEW IS, SAID PLAINLY, BECAUSE IT IS NOT A NEW DOCUMENT ───────────────────────────
 * The frame shows the PDF this entry has ALWAYS exported — `/payroll/statutory-forms/my.cp8d/export
 * ?format=pdf`, the generic serializer (lib/report-export.ts) over the CP8D per-employee schedule — asked to
 * show rather than save. No CP8D renderer was built for this (the plan's step 1 said not to), so the page is
 * OUR column layout, `fidelity: 'figures'`, and the notice beside it says so. The Form E Part A head counts
 * come out of the same read and are listed beside the frame; they are NOT on that PDF, and the notice says
 * that too rather than letting the viewer imply a complete Form E.
 *
 * THE CONTINUE GATE: no processed payroll in the year for the company → back to the step with
 * `?refusal=year_no_payroll` and the company and year kept. No empty return is shown.
 *
 * READINESS IS ADVISORY HERE, exactly as on the figures screen it replaces in the flow: the export route has
 * never refused on a missing tax / EPF / SOCSO number, and this round adds no gate it was not asked for. The
 * names are listed beside the frame so nobody files without seeing them.
 *
 * GATED LIKE ITS SIBLINGS: `scopedAdmin`, and an out-of-scope company is ABSENT (→ the step). Registered in
 * the function-access matrix under `statutoryForms` (lib/permissions.ts).
 */
export const dynamic = 'force-dynamic';

/** The catalog id this screen previews. One literal, as `CP39_REPORT_ID` and `BORANG_A_REPORT_ID` are. */
const CP8D_REPORT_ID = 'my.cp8d';

type Search = Record<string, string | string[] | undefined>;

export default async function Cp8dPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.cp8dPreview');
  const tf = await getTranslations('payroll.statutoryForms');
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');

  const { s, scopeIds } = await scopedAdmin();
  const companyId = scopeIds.includes(one('companyId')) ? one('companyId') : '';
  // `periodKey` (YYYY) is accepted too — it is what the figures screen and the export route call the year.
  const year = /^\d{4}$/.test(one('year')) ? one('year') : /^\d{4}$/.test(one('periodKey')) ? one('periodKey') : '';
  if (!companyId || !year) redirect(criteriaHref(CP8D_REPORT_ID));

  // A company whose jurisdiction does not register this form: one bare 404, as the export route answers.
  const def = (await listReports(s, companyId)).find((r) => r.id === CP8D_REPORT_ID);
  if (!def) notFound();

  const result = await reportPreview(s, { companyId, reportId: CP8D_REPORT_ID, periodKey: year });
  // ── THE CONTINUE GATE. Nothing below runs for a year with no processed payroll. ──────────────────────
  if (!result.meta.hasBatch) redirect(cyclesRefusalHref(CP8D_REPORT_ID, { companyId, year }, 'year_no_payroll'));

  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const exportBase = `/payroll/statutory-forms/${encodeURIComponent(CP8D_REPORT_ID)}/export?companyId=${encodeURIComponent(
    companyId,
  )}&periodKey=${encodeURIComponent(year)}`;
  const backToCriteria = criteriaReturnHref(CP8D_REPORT_ID, { companyId, year });
  const figuresHref = `/payroll/statutory-forms/${encodeURIComponent(CP8D_REPORT_ID)}?companyId=${encodeURIComponent(
    companyId,
  )}&year=${encodeURIComponent(year)}`;

  const sidePanel = (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border monolith:rounded-none">
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileYear')}</div>
          <div className="text-base font-semibold tabular-nums">{year}</div>
        </div>
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileEmployees')}</div>
          <div className="text-base font-semibold tabular-nums">{result.rows.length}</div>
        </div>
      </div>

      {/* WHAT THE FRAME IS, beside it and never in a tooltip. */}
      <div
        data-cp8d-provenance
        className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs monolith:rounded-none monolith:border-hairline monolith:bg-transparent"
      >
        <span className="font-medium">{t('notArtworkTitle')}</span>{' '}
        <span className="text-muted-foreground">{t('notArtwork')}</span>
      </div>

      {/* FORM E PART A — from the same read, and NOT on the PDF. Labels are the pack's own. */}
      {result.meta.summary && result.meta.summary.length > 0 && (
        <div className="rounded-md border border-border px-3 py-2 text-xs monolith:rounded-none">
          <p className="font-medium">{t('partATitle')}</p>
          <dl className="mt-1 space-y-0.5">
            {result.meta.summary.map((item) => (
              <div key={item.label} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{item.label}</dt>
                <dd className="tabular-nums">{item.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1 text-muted-foreground">{t('partAHint')}</p>
        </div>
      )}

      {result.meta.notes?.map((note) => (
        <div
          key={note}
          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300"
        >
          {note}
        </div>
      ))}

      {/* ADVISORY, NEVER BLOCKING — the figures screen has never refused on these, and this does not start. */}
      {result.readiness.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{tf('readinessTitle', { count: result.readiness.length })}</p>
          <ul className="mt-1 space-y-0.5">
            {result.readiness.map((r) => (
              <li key={r.employmentId}>
                {r.name} — {r.missing.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs">
        <Link
          href={figuresHref}
          className="text-primary underline-offset-4 hover:underline monolith:border-b monolith:border-ink monolith:text-ink monolith:no-underline"
        >
          {t('figuresLink')}
        </Link>
      </p>
    </>
  );

  return (
    <div className={pageWideCls}>
      <StatutoryPdfViewer
        title={t('title')}
        subtitle={`${companyName} · ${year}`}
        pdfUrl={`${exportBase}&format=pdf&disposition=inline`}
        downloads={[
          { href: `${exportBase}&format=pdf`, label: tf('downloadPdf') },
          { href: `${exportBase}&format=xlsx`, label: tf('downloadExcel') },
          { href: `${exportBase}&format=csv`, label: tf('downloadCsv') },
        ]}
        back={{ href: backToCriteria, label: t('viewerBack') }}
        openInNewTabLabel={tf('viewer_openNewTab')}
        frameTitle={tf('viewer_frameTitle', { form: t('title') })}
        sidePanel={sidePanel}
      />
    </div>
  );
}
