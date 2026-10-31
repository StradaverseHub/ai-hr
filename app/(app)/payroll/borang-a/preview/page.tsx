import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { payslipCycleLabel } from '@/core/payslip-cycle-label';
import { listFilableRunsForPeriod } from '@/packs/payroll/service';
import { scopedAdmin } from '@/lib/scope';
import { money } from '@/lib/borang-a';
import { parseRunSelection } from '@/lib/payroll-run-selection';
import { Card, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { criteriaHref, criteriaReturnHref, cyclesRefusalHref } from '../../statutory-forms/criteria';
import { BORANG_A_REPORT_ID, loadBorangA } from '../shared';
import { borangADocumentPairs, borangADocumentQuery, borangAQuery, type Search } from '../query';

/**
 * 9c8dad7a / 3aae0789 / cc74dcb2 — the Borang A review screen: check the form, then download it three ways
 * — the drawn form, a readable text copy, and the i-Akaun upload file — with a fourth button that returns
 * the upload file's own field-by-field check instead of the file.
 *
 * "SHOW ME A REVIEW SCREEN FIRST, NAMING ANYONE MISSING AN EPF MEMBER NUMBER OR IDENTITY CARD NUMBER,
 * BEFORE ANYTHING CAN BE DOWNLOADED." That is the original item, and it still holds: while anybody is not
 * ready there is no drawn form and no download on this screen, only the names and what each is missing.
 *
 * ── r407 (item 4f45f9b0): CHOOSE, CONTINUE, LOOK, DOWNLOAD ───────────────────────────────────────
 * This is now where the Borang A criteria step's Continue lands (`runSelection.action` on the pack's
 * entry). Three things changed, and one did not:
 *
 *   • THE CONTINUE GATE RUNS HERE, BEFORE ANYTHING IS DRAWN. No processed payroll run for the company and
 *     month, an invalid cycle selection, or a selection holding no EPF contributions sends the operator
 *     BACK to the criteria step (`cyclesRefusalHref`) with their criteria and the refusal — no empty form
 *     is produced. The gate is the loader's own outcomes (no-batch / selection-empty / bad-selection) plus
 *     `listFilableRunsForPeriod`, read through `packs/payroll/service`.
 *   • THE FORM IS SHOWN IN THE APP: r402's shared viewer frames `../pdf?…&disposition=inline` — the
 *     download route's own bytes, served inline — at A4 proportions, full width. Its Download buttons are
 *     the same routes with the same parameters.
 *   • THE PAYROLL-CYCLE SELECTION REACHES EVERY SURFACE. The frame, the three viewer downloads and the
 *     schedule form's hidden inputs are all built from `borangADocumentPairs` (../query.ts), which carries
 *     the `run` values. On r405 the schedule form's hidden inputs were companyId / periodKey / year / month
 *     only, so a filtered review downloaded the whole month; and the screen's own query conversion dropped
 *     a repeated `run` entirely. Both are pinned in test/r407-borang-a-cycles.test.ts.
 *   • UNCHANGED: the readiness lists, the review table, the contribution-month override and the upload
 *     file's inputs. The readiness lists sit beside the form.
 *
 * The old Company / Year / Month filter card is GONE from this screen: the criteria step is where those are
 * chosen (with the cycles), and "Change selection" returns to it with the current choice kept. An arrival
 * that names no company or no month goes to the criteria step rather than defaulting to one — the r256 rule
 * every other statutory screen already follows.
 *
 * GET-DRIVEN, NO CLIENT STATE, NO SERVER ACTION. The typed inputs travel in the query string, so the
 * reviewed form is a URL. ONE `<form>` here (the schedule form); the viewer's downloads are links.
 *
 * THE READINESS GATE IS ENFORCED TWICE, AND THAT IS NOT BELT-AND-BRACES. This screen hides the download
 * buttons while anyone is not ready; `loadBorangA` refuses to produce the document at all.
 *
 * GATED LIKE ITS SIBLING ROUTES: `scopedAdmin`, not `isAdmin`. Registered in the function-access matrix
 * under `statutoryForms` (lib/permissions.ts).
 */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/**
 * The header fields an operator can actually go and fill in, named in their language.
 *
 * A PARTIAL MAP, DELIBERATELY. `missingBorangAHeader` also reports the computed fields (the contribution
 * month, the two period keys, the print date), which cannot be blank in practice and which nobody can "go
 * and set" if they somehow are. Those fall through to the raw key rather than being given a reassuring
 * label that would send somebody looking for a field that does not exist on any screen.
 */
const HEADER_FIELD_LABEL: Record<string, string> = {
  employerRef: 'headerField_employerRef',
  employerName: 'headerField_employerName',
};

const REP_FIELD_LABEL: Record<string, string> = {
  repName: 'repField_name',
  repIc: 'repField_ic',
  repPosition: 'repField_position',
  repPhone: 'repField_phone',
  repEmail: 'repField_email',
};


/** The run-type word for a cycle label, through an EXPLICIT map (the shared picker's own words). */
const RUN_TYPE_KEY: Record<string, 'runTypeRegular' | 'runTypeOffCycle' | 'runTypeBonus' | 'runTypeAdjustment'> = {
  regular: 'runTypeRegular',
  off_cycle: 'runTypeOffCycle',
  bonus: 'runTypeBonus',
  adjustment: 'runTypeAdjustment',
};

export default async function BorangAPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.borangA');
  const tf = await getTranslations('payroll.statutoryForms');
  const tr = await getTranslations('payroll.runPicker');
  const locale = await getLocale();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');

  const { scopeIds, s } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // An out-of-scope companyId is treated as ABSENT, the rule the download routes apply; and absent goes to
  // the criteria step (r256), never to "the first company this admin can administer".
  const companyId = scopeIds.includes(one('companyId')) ? one('companyId') : '';

  // The legacy `periodKey` (YYYY-MM) is still accepted — every link this screen ever drew carries it.
  const legacy = /^\d{4}-(0[1-9]|1[0-2])$/.test(one('periodKey')) ? one('periodKey') : '';
  const year = /^\d{4}$/.test(one('year')) ? one('year') : legacy.slice(0, 4);
  const month = MONTHS.includes(one('month') as (typeof MONTHS)[number]) ? one('month') : legacy.slice(5, 7);
  if (!companyId || !year || !month) redirect(criteriaHref(BORANG_A_REPORT_ID));
  const periodKey = `${year}-${month}`;

  // EVERY value of a repeated `run` (the r405 conversion kept strings only and dropped the array).
  const query = borangAQuery(sp);
  const selection = parseRunSelection(query);
  const runSeqs = selection.ok ? selection.runSeqs : undefined;
  const criteria = { companyId, year, month, runSeqs };

  // ── THE CONTINUE GATE. Nothing below this block runs for a selection with nothing to file. ──────────
  if (!selection.ok) redirect(cyclesRefusalHref(BORANG_A_REPORT_ID, criteria, 'cycles_invalid'));
  const filable = await listFilableRunsForPeriod(s, { companyIds: scopeIds, companyId, periodKey });
  if (filable.length === 0) redirect(cyclesRefusalHref(BORANG_A_REPORT_ID, criteria, 'cycles_no_runs'));
  // `includeIncomplete` — this screen must be able to RENDER the table in order to name who is missing.
  // The download routes call the same function without it and are refused.
  const loaded = await loadBorangA({ companyId, periodKey, query, includeIncomplete: true });
  if (!loaded.ok) {
    if (loaded.reason === 'no-batch') redirect(cyclesRefusalHref(BORANG_A_REPORT_ID, criteria, 'cycles_no_runs'));
    if (loaded.reason === 'selection-empty') {
      redirect(cyclesRefusalHref(BORANG_A_REPORT_ID, criteria, 'cycles_no_data'));
    }
    if (loaded.reason === 'bad-selection') redirect(cyclesRefusalHref(BORANG_A_REPORT_ID, criteria, 'cycles_invalid'));
    // "No processed EPF contributions for this selection" — nobody on it, or nobody charged a sen of EPF.
    // Decided in the loader, so every download route refuses the same selection the same way.
    if (loaded.reason === 'no-contributions') {
      redirect(cyclesRefusalHref(BORANG_A_REPORT_ID, criteria, 'cycles_no_data'));
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
              }) ??
              tr('run', { seq: r.runSeq }),
          )
          .join(', ');

  const { form, missing, headerMissing, repMissing, fileReadiness, periodOverridden, summary, notes } = loaded;
  const ready = missing.length === 0 && headerMissing.length === 0;
  const rows = form.pages.flatMap((p) => p.rows);

  // ONE list of parameters for the frame, the three downloads and the schedule form's hidden inputs.
  const documentQuery = borangADocumentQuery({ companyId, periodKey, runSeqs, query });
  const hiddenPairs = borangADocumentPairs({ companyId, periodKey, runSeqs });
  const backToCriteria = criteriaReturnHref(BORANG_A_REPORT_ID, criteria);

  // THE PROVENANCE NOTICE, never in a tooltip: what comes off this screen looks like a government form and
  // is not one.
  const provenance = (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs monolith:rounded-none monolith:border-hairline monolith:bg-transparent">
      <span className="font-medium">{t('notArtworkTitle')}</span>{' '}
      <span className="text-muted-foreground">{t('notArtworkDrawn')}</span>
    </div>
  );

  // The +1 rule, stated where the form is produced. It is the fact most likely to be "corrected" into the
  // SOCSO rule by somebody comparing the two forms.
  const tiles = (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border monolith:rounded-none">
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileMonth')}</div>
        <div className="text-base font-semibold">{form.contributionMonth}</div>
        <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileEmployees')}</div>
        <div className="text-base font-semibold tabular-nums">{form.employees}</div>
        <div className="text-xs text-muted-foreground">{t('tileSheets', { count: form.pages.length })}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileWage')}</div>
        <div className="text-base font-semibold tabular-nums">RM {money(form.totalWage)}</div>
        <div className="text-xs text-muted-foreground">{t('tileWageHint')}</div>
      </div>
      <div className="bg-card p-3">
        <div className="text-xs text-muted-foreground">{t('tileTotal')}</div>
        <div className="text-base font-semibold tabular-nums">RM {money(form.totalContribution)}</div>
        <div className="text-xs text-muted-foreground">{t('tileRef', { ref: form.employerRef || '—' })}</div>
      </div>
    </div>
  );

  /*
    NAMED BEFORE THE DOWNLOAD, NOT DISCOVERED AFTER IT. While either list is non-empty there are no
    downloads and no drawn form, and the routes refuse the request as well.

    THREE SEPARATE BANNERS, because they are three different problems fixed in three different places: the
    employer reference is set ONCE under Organization; a member number is fixed on one person's own record;
    and the representative block is a company-level detail that does NOT block anything.
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
      {/* A WARNING, NEVER A BLOCK — some employers file late or early on purpose. */}
      {periodOverridden && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('periodOverridden', { month: form.contributionMonth, payroll: form.payrollPeriodKey })}
        </div>
      )}
      {headerMissing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('headerMissingTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {headerMissing.map((f) => (
              <li key={f}>{HEADER_FIELD_LABEL[f] ? t(HEADER_FIELD_LABEL[f] as 'headerField_employerRef') : f}</li>
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
      {/* THE UPLOAD FILE'S OWN, STRICTER LIST, shown only when the paper form is otherwise ready. */}
      {ready && !fileReadiness.ok && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('fileBlockedTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {fileReadiness.employer.map((e) => (
              <li key={e}>{e}</li>
            ))}
            {fileReadiness.employees.map((e) => (
              <li key={`${e.employmentId}-${e.problem}`}>
                {e.name} — {e.problem}
              </li>
            ))}
          </ul>
          <p className="mt-1">{t('fileBlockedHint')}</p>
        </div>
      )}
      {/* ADVISORY, NEVER BLOCKING — the specimen leaves the representative's own Tarikh blank and the form is
          signed by hand at the counter. */}
      {repMissing.length > 0 && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium">{t('repMissingTitle')}</p>
          <p className="mt-1">
            {repMissing.map((f) => (REP_FIELD_LABEL[f] ? t(REP_FIELD_LABEL[f] as 'repField_name') : f)).join(', ')}
          </p>
          <p className="mt-1">{t('repMissingHint')}</p>
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

      {/* THE ONLY FORM ON THIS SCREEN. Its hidden inputs are `borangADocumentPairs` — company, payroll month
          AND the payroll cycles — so Apply re-reviews the same selection and every download below is built
          from it. r405 carried no `run` here, and a filtered review downloaded the whole month. */}
      <form method="get" action="/payroll/borang-a/preview">
        {hiddenPairs.map((h, i) => (
          <input key={`${h.name}-${i}`} type="hidden" name={h.name} value={h.value} />
        ))}
        <input type="hidden" name="year" value={year} />
        <input type="hidden" name="month" value={month} />

        <div className="flex flex-wrap items-end gap-3 px-4 pt-4">
          <Field label={t('epfPeriod')}>
            {/* READ BY VALUE, never by presence: this box is submitted on every request whether or not it
                was touched, so `has()` would report an override for everybody. */}
            <input type="month" name="epfPeriod" defaultValue={form.contributionPeriodKey} className={inputCls} />
          </Field>
          <Field label={t('shortCode')}>
            <input
              type="text"
              name="code"
              defaultValue={one('code')}
              maxLength={3}
              placeholder="ABC"
              className={`${inputCls} w-24`}
            />
          </Field>
          <Field label={t('batchNo')}>
            <input
              type="text"
              name="batch"
              defaultValue={one('batch') || '1'}
              maxLength={5}
              inputMode="numeric"
              className={`${inputCls} w-24`}
            />
          </Field>
          <Field label={t('controlNo')}>
            {/* AN OVERRIDE, NOT AN INPUT THE FILE NEEDS. Blank — the normal case — derives the trailer's
                control total as the sum of the EPF member numbers on the file. 21 wide because the field is. */}
            <input
              type="text"
              name="control"
              defaultValue={one('control')}
              maxLength={21}
              inputMode="numeric"
              className={`${inputCls} w-44`}
            />
          </Field>
          <button className={btnGhost}>{t('apply')}</button>
        </div>
        <p className="px-4 pt-2 text-xs text-muted-foreground">{t('inputsHint')}</p>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colBil')}</th>
                <th className="px-4 py-2 font-medium">{t('colMember')}</th>
                {/*
                  NO "N K" COLUMN HERE, AND THAT IS DELIBERATE — do not "fix" it. The reserved N K column is on
                  the PRINTED form (catatan 5: "Ruang ketiga (N K) hanya diisi oleh KWSP sahaja"), permanently
                  blank. This is the REVIEW table: a column that is empty by law has nothing to review.
                */}
                <th className="px-4 py-2 font-medium">{t('colIc')}</th>
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colWage')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEmployer')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEmployee')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => (
                <tr key={r.employmentId}>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.memberNo || <span className="text-red-600">—</span>}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.ic || <span className="text-red-600">—</span>}</td>
                  <td className="px-4 py-2 font-medium">{r.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {/* NEVER A FALLBACK TO GROSS. A run that predates the wage-basis stamp says so. */}
                    {r.wageRecorded ? money(r.wage) : <span className="text-red-600">{t('wageNotRecorded')}</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(r.employer)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(r.employee)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-border bg-muted/30 text-sm font-semibold">
              {/* r411 (4f45f9b0) — THE SAME TOTALS AS THE PRINTED FORM ABOVE IT: no carried-forward rows and
                  one JUMLAH, the employer's and the employee's contributions together, across the two
                  contribution columns, as the reporter's October KWSP 6 sample prints it. */}
              <tr>
                <td colSpan={5} className="px-4 py-2 text-right">
                  {t('grandTotal')}
                </td>
                <td colSpan={2} className="px-4 py-2 text-right tabular-nums" data-testid="borang-a-review-jumlah">
                  {money(form.totalContribution)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-3">
          {/* NO DOWNLOAD BUTTONS AT ALL while somebody is not ready — not disabled ones, which are still
              buttons and still get clicked at. The sentence beside them says why. */}
          {ready ? (
            <>
              <button className={btnPrimary} formAction="/payroll/borang-a/pdf" title={t('downloadPdfTitle')}>
                {t('downloadPdf')}
              </button>
              <button className={btnGhost} formAction="/payroll/borang-a/text" title={t('downloadTextTitle')}>
                {t('downloadText')}
              </button>
              {fileReadiness.ok ? (
                <>
                  <button className={btnGhost} formAction="/payroll/borang-a/file" title={t('downloadFileTitle')}>
                    {t('downloadFile')}
                  </button>
                  {/* THE SAME ROUTE, ASKED FOR THE CHECK INSTEAD OF THE FILE. `name`/`value` on a submit button
                      are sent only when that button submits the form. */}
                  <button
                    className={btnGhost}
                    formAction="/payroll/borang-a/file"
                    name="report"
                    value="1"
                    title={t('downloadReportTitle')}
                  >
                    {t('downloadReport')}
                  </button>
                </>
              ) : (
                <span className="text-xs italic text-muted-foreground">{t('fileBlocked')}</span>
              )}
            </>
          ) : (
            <span className="text-xs italic text-muted-foreground">{t('downloadsBlocked')}</span>
          )}
        </div>
      </form>
    </Card>
  );

  const subtitle = `${companyName} · ${periodLabel} · ${cyclesText}`;

  if (!ready) {
    // NOT READY: no drawn form at all — the PDF route would refuse it, and a framed refusal is not a preview.
    // The names and what each is missing, exactly as before, and the table that shows them.
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
        pdfUrl={`/payroll/borang-a/pdf?${documentQuery}&disposition=inline`}
        downloads={[
          { href: `/payroll/borang-a/pdf?${documentQuery}`, label: t('downloadPdf') },
          { href: `/payroll/borang-a/text?${documentQuery}`, label: t('downloadText') },
          ...(fileReadiness.ok ? [{ href: `/payroll/borang-a/file?${documentQuery}`, label: t('downloadFile') }] : []),
        ]}
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
