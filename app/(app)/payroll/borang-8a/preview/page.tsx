import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { payslipCycleLabel } from '@/core/payslip-cycle-label';
import { listFilableRunsForPeriod } from '@/packs/payroll/service';
import { scopedAdmin } from '@/lib/scope';
import { BORANG_8A_STATUS_PARAM_PREFIX, money, statusOverridesFrom } from '@/lib/borang-8a';
import { PERKESO_FILE_LINE_LENGTH } from '@/lib/perkeso-socso-file';
import { parseRunSelection } from '@/lib/payroll-run-selection';
import { isUnfinishedPersonName } from '@/lib/unfinished-name';
import { Card, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { criteriaHref, criteriaReturnHref, cyclesRefusalHref } from '../../statutory-forms/criteria';
import { BORANG_8A_REPORT_ID, loadBorang8A } from '../shared';
import { borang8ADocumentPairs, borang8ADocumentQuery, borang8AQuery, type Search } from '../query';
import { Borang8AMycoidNotice, Borang8AOneLineNotice, Borang8AUnfinishedNames } from '../notices';

/**
 * 8ca344bf — the Borang 8A review screen: check the form, then download it.
 *
 * "SHOW ME A REVIEW SCREEN FIRST, NAMING ANYONE MISSING AN IDENTITY CARD NUMBER BEFORE ANYTHING CAN BE
 * DOWNLOADED, AND LET ME TYPE A STATUS AGAINST ANY ROW." That is the original item, and it still holds:
 * while anybody is not ready there is no drawn form and no download on this screen, only the names and
 * what each is missing.
 *
 * ── r408 (item e74af58c): CHOOSE, CONTINUE, LOOK, DOWNLOAD — the Borang A path (r407), for PERKESO ─────
 * This is now where the Borang 8A criteria step's Continue lands (`runSelection.action` on the pack's
 * entry):
 *
 *   • THE CONTINUE GATE RUNS HERE, BEFORE ANYTHING IS DRAWN. No processed payroll run for the company and
 *     month, an invalid cycle selection, a selection that matches no run, or a selection holding no SOCSO
 *     contribution sends the operator BACK to the criteria step (`cyclesRefusalHref`) with their criteria
 *     and the refusal — no empty form is produced. A BONUS-ONLY selection is not "no data": the read names
 *     every person on it with the SOCSO-not-in-this-selection reason (r373), and that named refusal — no
 *     form, no download — is the one it keeps.
 *   • THE FORM IS SHOWN IN THE APP: r402's shared viewer frames `../pdf?…&disposition=inline` — the download
 *     route's own bytes, served inline — at A4 proportions, full width. Its downloads are the same routes
 *     with the same parameters.
 *   • THE PAYROLL-CYCLE SELECTION AND THE TYPED STATUSES REACH EVERY SURFACE. The frame, the viewer's
 *     downloads and the schedule form's hidden inputs are all built from `borang8ADocumentPairs`
 *     (../query.ts), which carries `run` and every non-empty `st_` status.
 *   • THE BOXES THAT STAY BLANK ARE NAMED BESIDE THE FORM: the payment method and cheque number, the
 *     signature, name, telephone and stamp, and the collection agent's boxes. The records hold none of them.
 *
 * The old Company / Year / Month filter card is GONE from this screen: the criteria step is where those are
 * chosen (with the cycles), and "Change selection" returns to it with the current choice kept. An arrival
 * that names no company or no month goes to the criteria step rather than defaulting to one (r256).
 *
 * GET-DRIVEN, NO CLIENT STATE, NO SERVER ACTION. The typed statuses travel in the query string, so the
 * reviewed form is a URL. ONE `<form>` here (the schedule form); the viewer's downloads are links.
 *
 * THE READINESS GATE IS ENFORCED TWICE, AND THAT IS NOT BELT-AND-BRACES. This screen hides the download
 * buttons while anyone is not ready; `loadBorang8A` refuses to produce the document at all.
 *
 * GATED LIKE ITS SIBLING ROUTES: `scopedAdmin`, not `isAdmin`. Registered in the function-access matrix
 * under `statutoryForms` (lib/permissions.ts).
 */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/**
 * The header fields an operator can actually go and fill in, named in their language. A PARTIAL MAP,
 * DELIBERATELY: the computed fields fall through to the raw key rather than a reassuring label.
 */
const HEADER_FIELD_LABEL: Record<string, string> = {
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

export default async function Borang8APreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.borang8a');
  const tf = await getTranslations('payroll.statutoryForms');
  const tr = await getTranslations('payroll.runPicker');
  const locale = await getLocale();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');

  const { scopeIds, s } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // An out-of-scope companyId is ABSENT, and absent goes to the criteria step (r256), never to "the first
  // company this admin can administer".
  const companyId = scopeIds.includes(one('companyId')) ? one('companyId') : '';

  // The legacy `periodKey` (YYYY-MM) is still accepted — every link this screen ever drew carries it, and
  // the [formId] figures screen's "Open Borang 8A review" still sends it.
  const legacy = /^\d{4}-(0[1-9]|1[0-2])$/.test(one('periodKey')) ? one('periodKey') : '';
  const year = /^\d{4}$/.test(one('year')) ? one('year') : legacy.slice(0, 4);
  const month = MONTHS.includes(one('month') as (typeof MONTHS)[number]) ? one('month') : legacy.slice(5, 7);
  if (!companyId || !year || !month) redirect(criteriaHref(BORANG_8A_REPORT_ID));
  const periodKey = `${year}-${month}`;

  // EVERY value of a repeated `run` (a string-only conversion drops the array).
  const query = borang8AQuery(sp);
  const selection = parseRunSelection(query);
  const runSeqs = selection.ok ? selection.runSeqs : undefined;
  const criteria = { companyId, year, month, runSeqs };

  // ── THE CONTINUE GATE. Nothing below this block runs for a selection with nothing to file. ──────────
  if (!selection.ok) redirect(cyclesRefusalHref(BORANG_8A_REPORT_ID, criteria, 'cycles_invalid'));
  const filable = await listFilableRunsForPeriod(s, { companyIds: scopeIds, companyId, periodKey });
  if (filable.length === 0) redirect(cyclesRefusalHref(BORANG_8A_REPORT_ID, criteria, 'cycles_no_runs'));
  // `includeIncomplete` — this screen must be able to RENDER the table in order to name who is missing.
  // The download routes call the same function without it and are refused.
  const loaded = await loadBorang8A({ companyId, periodKey, query, includeIncomplete: true });
  if (!loaded.ok) {
    if (loaded.reason === 'no-batch') redirect(cyclesRefusalHref(BORANG_8A_REPORT_ID, criteria, 'cycles_no_runs'));
    if (loaded.reason === 'selection-empty') {
      redirect(cyclesRefusalHref(BORANG_8A_REPORT_ID, criteria, 'cycles_no_data'));
    }
    if (loaded.reason === 'bad-selection') redirect(cyclesRefusalHref(BORANG_8A_REPORT_ID, criteria, 'cycles_invalid'));
    // "No processed SOCSO contributions for this selection" — decided in the loader, so every download
    // route refuses the same selection the same way.
    if (loaded.reason === 'no-contributions') {
      redirect(cyclesRefusalHref(BORANG_8A_REPORT_ID, criteria, 'cycles_no_data'));
    }
    // 'not-found': a company whose jurisdiction does not register this form. Same bare answer as the routes.
    notFound();
  }

  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const periodLabel = `${monthFmt.format(new Date(Date.UTC(2000, Number(month) - 1, 1)))} ${year}`;
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  // The cycles this form covers, by the names the criteria step showed — or "All payroll cycles".
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
  const rows = form.pages.flatMap((p) => p.rows);
  // What was TYPED, by value — the box shows only that; the derived B / H / M is shown beside it.
  const typed = statusOverridesFrom(query);

  // ONE list of parameters for the frame, the downloads and the schedule form's hidden inputs.
  const documentQuery = borang8ADocumentQuery({ companyId, periodKey, runSeqs, query });
  // The schedule form's hidden inputs carry company, month and cycles but NOT the statuses: the form's own
  // status boxes submit those, and a hidden copy beside each box would send every status twice.
  const hiddenPairs = borang8ADocumentPairs({ companyId, periodKey, runSeqs });
  const backToCriteria = criteriaReturnHref(BORANG_8A_REPORT_ID, criteria);

  // THE PROVENANCE NOTICE, never in a tooltip: what comes off this screen looks like a government form and
  // is not one.
  const provenance = (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs monolith:rounded-none monolith:border-hairline monolith:bg-transparent">
      <span className="font-medium">{t('notArtworkTitle')}</span>{' '}
      <span className="text-muted-foreground">{t('notArtworkDrawn')}</span>
    </div>
  );

  const tiles = (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border monolith:rounded-none">
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileMonth')}</div>
        <div className="text-base font-semibold">{form.contributionMonth}</div>
        <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileDue')}</div>
        <div className="font-mono text-base font-semibold">{form.paymentDueDate}</div>
        <div className="text-xs text-muted-foreground">{t('tileDueNextMonth')}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileEmployees')}</div>
        <div className="text-base font-semibold tabular-nums">{form.employees}</div>
        <div className="text-xs text-muted-foreground">{t('tileSheets', { count: form.pages.length })}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileTotal')}</div>
        <div className="text-base font-semibold tabular-nums">RM {money(form.total)}</div>
        <div className="text-xs text-muted-foreground">{t('tileEmployerCode', { code: form.employerCode || '—' })}</div>
      </div>
    </div>
  );

  /*
    THE BOXES THAT STAY BLANK, named before the download. Each is the operator's or the collection agent's,
    and the records hold none of them, so the drawn page leaves every one empty rather than invent it.
  */
  const blankBoxes = (
    <div data-blank-boxes className="space-y-2 border-t border-border pt-3 text-xs monolith:border-ink">
      <p className="font-medium uppercase tracking-wide text-muted-foreground">{t('blankTitle')}</p>
      <dl className="space-y-2">
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
        <div>
          <dt className="font-medium">{t('blankStatus')}</dt>
          <dd className="text-muted-foreground">{t('statusHintDerived')}</dd>
        </div>
      </dl>
    </div>
  );

  /*
    NAMED BEFORE THE DOWNLOAD, NOT DISCOVERED AFTER IT. While either list is non-empty there are no
    downloads and no drawn form, and the routes refuse the request as well. TWO SEPARATE BANNERS, because
    they are fixed in two different places: the employer code once under Organization, an IC (or a
    selection that carries no SOCSO) against one person.
  */
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
              <li key={f}>{HEADER_FIELD_LABEL[f] ? t(HEADER_FIELD_LABEL[f] as 'headerField_employerCode') : f}</li>
            ))}
          </ul>
          <p className="mt-1">{t('headerMissingHint')}</p>
        </div>
      )}
      {missing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('missingTitle', { count: missing.length })}</p>
          {/* r372 — THE REASON, PER PERSON, from the pack (an absent IC; a month whose runs were charged on
              different SOCSO/EIS wages; a selection that carries no SOCSO). */}
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
        <dl className="grid gap-px bg-border sm:grid-cols-4">
          {summary.map((item) => (
            <div key={item.label} className="bg-card p-4">
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className="text-sm font-semibold tabular-nums">RM {item.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    ) : null;

  const schedule = (
    <Card className="overflow-hidden">
      <SectionHeader title={t('scheduleTitle')} count={form.employees} />
      <p className="px-4 pt-3 text-xs text-muted-foreground">{t('statusHintDerived')}</p>

      {/* THE ONLY FORM ON THIS SCREEN. Its hidden inputs are `borang8ADocumentPairs` — company, payroll month
          AND the payroll cycles — so Apply re-reviews the same selection, and every download is built from
          it together with the status boxes below. */}
      <form method="get" action="/payroll/borang-8a/preview">
        {hiddenPairs.map((h, i) => (
          <input key={`${h.name}-${i}`} type="hidden" name={h.name} value={h.value} />
        ))}

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colStart')}</th>
                <th className="px-4 py-2 font-medium">{t('colStop')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 font-medium">{t('colIc')}</th>
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colContribution')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.employmentId}>
                  <td className="px-4 py-2 font-mono text-xs">{r.startDate || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.stopDate || '—'}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      {/* What PRINTS in column (2) — derived, or the typed status that replaced it. */}
                      <span className="w-5 text-center font-mono text-xs font-semibold" data-status-printed>
                        {r.status}
                      </span>
                      {/* ALWAYS SUBMITTED, EVEN WHEN EMPTY — which is exactly why the loader reads these by
                          VALUE and never by presence. An empty box means "no typed status", so the derived
                          one stands. */}
                      <input
                        type="text"
                        name={`${BORANG_8A_STATUS_PARAM_PREFIX}${r.employmentId}`}
                        defaultValue={typed.get(r.employmentId) ?? ''}
                        maxLength={12}
                        placeholder={t('statusPlaceholder')}
                        aria-label={t('statusAria', { name: r.name })}
                        className={`${inputCls} h-8 w-24 text-xs`}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{r.ic || <span className="text-red-600 dark:text-red-400">—</span>}</td>
                  <td className="px-4 py-2 font-medium">{r.name}</td>
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

        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-3">
          <button className={btnGhost}>{t('apply')}</button>
          {/* NO DOWNLOAD BUTTONS AT ALL while somebody is not ready — not disabled ones, which are still
              buttons and still get clicked at. The sentence beside them says why. */}
          {ready ? (
            <>
              <button className={btnPrimary} formAction="/payroll/borang-8a/pdf" title={t('downloadPdfTitle')}>
                {t('downloadPdf')}
              </button>
              <button className={btnGhost} formAction="/payroll/borang-8a/text" title={t('downloadTextTitle')}>
                {t('downloadText')}
              </button>
              {/* 18c1d92b — the PERKESO ASSIST upload file. */}
              <button className={btnGhost} formAction="/payroll/borang-8a/file" title={t('downloadFileTitle')}>
                {t('downloadFile')}
              </button>
              {/* The same route asked for the field-by-field check instead of the file.
                  ⚠️ `report=1` IS THE BUTTON'S OWN name/value, NOT a query string on formAction and NOT a
                  hidden input: this form is method="get", so the browser DISCARDS an action URL's query
                  string, and a hidden input is submitted by every button in the form. A submit button's
                  name/value pair is sent only when THAT button submits. */}
              <button
                className={btnGhost}
                formAction="/payroll/borang-8a/file"
                formTarget="_blank"
                name="report"
                value="1"
                title={t('checkFileTitle')}
              >
                {t('checkFile')}
              </button>
            </>
          ) : (
            <span className="text-xs italic text-muted-foreground">{t('downloadsBlocked')}</span>
          )}
          {/* 5dbce839 — the MyCoID box, when it is going out empty. A notice, never a gate. */}
          <Borang8AMycoidNotice mycoid={form.mycoid} title={t('mycoidNoticeTitle')} body={t('mycoidNoticeBody')} />
          {/* r218 — names that are not yet names. Same standing, same reason. */}
          <Borang8AUnfinishedNames
            people={form.pages
              .flatMap((pg) => pg.rows)
              .filter((r) => isUnfinishedPersonName(r.name))
              .map((r) => ({ ic: r.ic, name: r.name }))}
            title={t('unfinishedNameTitle')}
            hint={t('unfinishedNameHint')}
          />
          {/* 64c09b0e — what the upload file looks like when it is opened, said before it is opened. */}
          <Borang8AOneLineNotice
            ready={ready}
            title={t('oneLineNoticeTitle')}
            body={t('oneLineNoticeBody', { length: PERKESO_FILE_LINE_LENGTH })}
          />
        </div>
      </form>
    </Card>
  );

  const subtitle = `${companyName} · ${periodLabel} · ${cyclesText}`;

  if (!ready) {
    // NOT READY: no drawn form at all — the PDF route would refuse it, and a framed refusal is not a preview.
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('title')} description={subtitle} back={{ href: backToCriteria, label: t('viewerBack') }} />
        {provenance}
        {tiles}
        {checks}
        <p className="text-sm text-muted-foreground" data-preview-blocked>
          {t('previewBlocked')}
        </p>
        {reconciliation}
        {schedule}
      </div>
    );
  }

  return (
    <div className={pageWideCls}>
      <StatutoryPdfViewer
        title={t('title')}
        subtitle={subtitle}
        pdfUrl={`/payroll/borang-8a/pdf?${documentQuery}&disposition=inline`}
        downloads={[
          { href: `/payroll/borang-8a/pdf?${documentQuery}`, label: t('downloadPdf') },
          { href: `/payroll/borang-8a/text?${documentQuery}`, label: t('downloadText') },
          { href: `/payroll/borang-8a/file?${documentQuery}`, label: t('downloadFile') },
        ]}
        back={{ href: backToCriteria, label: t('viewerBack') }}
        openInNewTabLabel={tf('viewer_openNewTab')}
        frameTitle={tf('viewer_frameTitle', { form: t('title') })}
        sidePanel={
          <>
            {tiles}
            {provenance}
            {checks}
            {blankBoxes}
          </>
        }
      />
      {reconciliation}
      {schedule}
    </div>
  );
}
