import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { payslipCycleLabel } from '@/core/payslip-cycle-label';
import { listFilableRunsForPeriod } from '@/packs/payroll/service';
import { scopedAdmin } from '@/lib/scope';
import { formatMyIc, money } from '@/lib/cp39-form';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { parseRunSelection } from '@/lib/payroll-run-selection';
import { Card, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { criteriaHref, criteriaReturnHref, cyclesRefusalHref } from '../../statutory-forms/criteria';
import { CP39_REPORT_ID, loadCp39Form } from '../shared';
import { cp39DocumentPairs, cp39DocumentQuery, cp39Query, type Search } from '../query';
// 72b100cd — the payment reference this month's PCB 2(II) will print, read beside the return it settles.
import { pcbPaymentsForYear } from '@/core/pcb-payment';
import { recordPcbPaymentAction } from '../../pcb-payment-actions';

/**
 * e0cd4583 — the CP39 review screen: check the statement for the company, month and payroll cycles chosen
 * on the criteria step, fill in the preparer block, then download it (the drawn statement, its text twin
 * and the e-Data PCB upload file).
 *
 * "FILTER → PREVIEW (auto-filled data shown, the preparer block and payment fields editable) → DOWNLOAD"
 * is the request's own workflow, and it is why this screen exists beside the generic [formId] figures
 * screen rather than instead of it. The generic screen renders any form's table and can render this one;
 * what it cannot do is carry the preparer inputs, because it does not know what a CP39 is. So the shelf
 * card opens the figures screen as every other form does, and the figures screen hands you this one for
 * the printed document itself.
 *
 * ── r409 (item 79f3f64d): CHOOSE, CONTINUE, LOOK, DOWNLOAD — Borang A's r407 path, copied ───────────
 * This is now where the CP39 criteria step's Continue lands (`runSelection.action` on `my.cp39`): Company,
 * Year, Month and Payroll Cycle (Select All ticked) are chosen THERE, and "Change selection" goes back to it
 * with the choice kept. The old Company / Year / Month filter card on this screen is gone, and an arrival
 * that names no company or no month goes to the step rather than defaulting to one (r256).
 *
 *   • THE CONTINUE GATE RUNS HERE, BEFORE ANYTHING IS DRAWN. No processed run for the month, an invalid
 *     cycle selection, ticked cycles that are not in the month, or a selection on which nobody had PCB or
 *     CP38 deducted sends the operator BACK to the step (`cyclesRefusalHref`) with the refusal in words.
 *     No empty statement is produced.
 *   • THE STATEMENT IS SHOWN IN THE APP: the shared viewer frames `../pdf?…&disposition=inline`, the
 *     download route's own bytes served inline. Its Download buttons are the same routes, same parameters.
 *   • THE SELECTION REACHES EVERY SURFACE: frame, the three downloads and the schedule form's hidden
 *     inputs are all built from `cp39DocumentPairs` (../query.ts), which carries `run`.
 *   • UNCHANGED: the readiness lists, the warnings, the schedule table, the preparer and payment inputs and
 *     the PCB payment reference cards. The 72b100cd cards stay on this path because
 *     app/payroll/pcb-payment-actions.ts revalidates it.
 *
 * GET-DRIVEN, NO CLIENT STATE, NO SERVER ACTION — r191's CP22 and r194's Borang A review screens' shape.
 * The typed inputs travel in the query string, so the reviewed statement is a URL: it re-opens, bookmarks,
 * sends to a colleague, and the back button works. It also means this file is a server component with no
 * interactivity to hand across the boundary, so no closure ever reaches a client component.
 *
 * TWO SIBLING FORMS, NEVER NESTED. A form inside a form is invalid HTML and browsers drop the inner one,
 * which would silently turn the download buttons into a second "Show". The filter form owns company /
 * year / month; the schedule form owns the preparer block, the print date and the two downloads, and
 * carries its own hidden companyId + periodKey for exactly that reason.
 *
 * THE READINESS GATE IS ENFORCED TWICE, AND THAT IS NOT BELT-AND-BRACES. This screen hides the download
 * buttons while anyone is missing a tax reference number; `loadCp39Form` refuses to produce the document
 * at all. Hiding a button is a UI courtesy — a bookmarked download URL would sail straight past it.
 *
 * GATED LIKE ITS SIBLING ROUTES: `scopedAdmin`, not `isAdmin` — an hr_admin grant on ANY company makes
 * `isAdmin` true, and this screen lists every employee's name, identity card number, tax reference number,
 * employee number, passport number and monthly deduction. Registered in the function-access matrix under
 * the payroll `statutoryForms` screen key (lib/permissions.ts): a guarded page.tsx with no column fails
 * test/function-access.test.ts.
 */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/**
 * The header fields an operator can actually go and fill in, named in their language.
 *
 * A PARTIAL MAP, DELIBERATELY. `missingCp39FormHeader` also reports the computed fields (the deduction
 * month, the period key, the print date), which cannot be blank in practice and which nobody can "go and
 * set" if they somehow are. Those fall through to the raw key rather than being given a reassuring label
 * that would send somebody looking for a field that does not exist on any screen.
 */
const HEADER_FIELD_LABEL: Record<string, string> = {
  employerNo: 'headerField_employerNo',
  employerName: 'headerField_employerName',
};

const PREPARER_FIELD_LABEL: Record<string, string> = {
  preparerName: 'prepField_name',
  preparerIc: 'prepField_ic',
  preparerPosition: 'prepField_position',
  preparerPhone: 'prepField_phone',
};

/** The run-type word for a cycle label, through an EXPLICIT map (the shared picker's own words). */
const RUN_TYPE_KEY: Record<string, 'runTypeRegular' | 'runTypeOffCycle' | 'runTypeBonus' | 'runTypeAdjustment'> = {
  regular: 'runTypeRegular',
  off_cycle: 'runTypeOffCycle',
  bonus: 'runTypeBonus',
  adjustment: 'runTypeAdjustment',
};

export default async function Cp39PreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.cp39Form');
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

  const today = todayInKualaLumpur();
  // The legacy `periodKey` (YYYY-MM) is still accepted — the [formId] figures screen's link carries it.
  const legacy = /^\d{4}-(0[1-9]|1[0-2])$/.test(one('periodKey')) ? one('periodKey') : '';
  const year = /^\d{4}$/.test(one('year')) ? one('year') : legacy.slice(0, 4);
  const month = MONTHS.includes(one('month') as (typeof MONTHS)[number]) ? one('month') : legacy.slice(5, 7);
  if (!companyId || !year || !month) redirect(criteriaHref(CP39_REPORT_ID));
  const periodKey = `${year}-${month}`;

  // EVERY value of a repeated `run` (the old conversion kept strings only and dropped the array).
  const query = cp39Query(sp);
  const selection = parseRunSelection(query);
  const runSeqs = selection.ok ? selection.runSeqs : undefined;
  const criteria = { companyId, year, month, runSeqs };

  // ── THE CONTINUE GATE. Nothing below this block runs for a selection with nothing to file. ──────────
  if (!selection.ok) redirect(cyclesRefusalHref(CP39_REPORT_ID, criteria, 'cycles_invalid'));
  const filable = await listFilableRunsForPeriod(s, { companyIds: scopeIds, companyId, periodKey });
  if (filable.length === 0) redirect(cyclesRefusalHref(CP39_REPORT_ID, criteria, 'cycles_no_runs'));
  // `includeIncomplete` — this screen must be able to RENDER the table in order to name who is missing.
  // The download routes call the same function without it and are refused.
  const loaded = await loadCp39Form({ companyId, periodKey, query, includeIncomplete: true });
  if (!loaded.ok) {
    if (loaded.reason === 'no-batch') redirect(cyclesRefusalHref(CP39_REPORT_ID, criteria, 'cycles_no_runs'));
    if (loaded.reason === 'selection-empty') redirect(cyclesRefusalHref(CP39_REPORT_ID, criteria, 'cycles_no_data'));
    if (loaded.reason === 'bad-selection') redirect(cyclesRefusalHref(CP39_REPORT_ID, criteria, 'cycles_invalid'));
    // Nobody on the ticked cycles had PCB or CP38 deducted. Decided in the loader, so every download route
    // refuses the same selection the same way.
    if (loaded.reason === 'no-deductions') {
      redirect(cyclesRefusalHref(CP39_REPORT_ID, criteria, 'cycles_no_deductions'));
    }
    // 'not-found': a company whose jurisdiction does not register this form. Same bare answer as the routes.
    notFound();
  }

  // 72b100cd — the year's payment references for this company, so the two cards below open on what was
  // recorded rather than blank. Keyed 'YYYY-MM|kind'; a month with no record simply has no entry.
  const pcbPayments = await pcbPaymentsForYear(s, { companyId, year: Number(year) });
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const periodLabel = `${monthFmt.format(new Date(Date.UTC(2000, Number(month) - 1, 1)))} ${year}`;
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  // The cycles this statement covers, by the names the criteria step showed — or "All payroll cycles".
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
  const subtitle = `${companyName} · ${periodLabel} · ${cyclesText}`;

  // ONE list of parameters for the frame, the three downloads and the schedule form's hidden inputs.
  const documentQuery = cp39DocumentQuery({ companyId, periodKey, runSeqs, query });
  const hiddenPairs = cp39DocumentPairs({ companyId, periodKey, runSeqs });
  const backToCriteria = criteriaReturnHref(CP39_REPORT_ID, criteria);

  // THE PROVENANCE NOTICE, above everything and never in a tooltip: what comes off this screen looks like
  // a government form and is not one. c99e8358 REWORDED IT RATHER THAN REMOVING IT — the old wording said
  // we held no specimen and did not reproduce LHDN's A / B / C notes, and page one now IS drawn to the
  // Pin.2015 arrangement with those notes on it, so the sentence had stopped being true. What has not
  // changed is the claim the notice exists for: the arrangement is the agency's, the PAPER is ours, and
  // `agency-layout` is as far as this goes. That is the single claim the statutory-forms fidelity
  // vocabulary exists to keep honest, and the screen that produces the document is where it is said.
  const provenance = (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs monolith:rounded-none monolith:border-hairline monolith:bg-transparent">
      <span className="font-medium">{t('notArtworkTitle')}</span>{' '}
      <span className="text-muted-foreground">{t('notArtwork')}</span>
    </div>
  );

  const { form, missing, headerMissing, preparerMissing, notes } = loaded;
  const ready = missing.length === 0 && headerMissing.length === 0;
  // 7ee14bbc — THE ROWS THE STATEMENT PRINTS, which is now the deducted rather than everyone the run
  // paid. `form.employees` is still the paid figure and is shown beside this one, never instead of it.
  const rows = form.pages.flatMap((p) => p.rows);

  // The deduction month, stated where the statement is produced. It is the fact most likely to be
  // "corrected" into the EPF +1 rule by somebody comparing the two forms. Two columns: it sits in the
  // viewer's side panel at 20rem.
  const tiles = (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border monolith:rounded-none">
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileMonth')}</div>
          <div className="text-base font-semibold">
            {form.deductionMonth} {form.deductionYear}
          </div>
          <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
        </div>
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tilePcb')}</div>
          <div className="text-base font-semibold tabular-nums">RM {money(form.totalPcb)}</div>
          <div className="text-xs text-muted-foreground">{t('tilePcbHint', { count: form.pcbEmployees })}</div>
        </div>
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileCp38')}</div>
          <div className="text-base font-semibold tabular-nums">RM {money(form.totalCp38)}</div>
          <div className="text-xs text-muted-foreground">{t('tileCp38Hint', { count: form.cp38Employees })}</div>
        </div>
        <div className="bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('tileAmount')}</div>
          <div className="text-base font-semibold tabular-nums">RM {money(form.totalAmount)}</div>
          <div className="text-xs text-muted-foreground">{t('tileEmployer', { ref: form.employerNo ? `E ${form.employerNo}` : '—' })}</div>
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

      {/* NAMED BEFORE THE DOWNLOAD, NOT DISCOVERED AFTER IT. While either list is non-empty there are no
          download buttons below, and the routes refuse the request as well.

          THREE SEPARATE BANNERS, because they are three different problems fixed in three different
          places: the LHDN employer number is set ONCE under Organization; a tax reference number is fixed
          on one person's own record; and the preparer block is a company-level detail that does NOT block
          anything. Merging them would send an operator to the wrong screen. */}
      {headerMissing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('headerMissingTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {headerMissing.map((f) => (
              <li key={f}>{HEADER_FIELD_LABEL[f] ? t(HEADER_FIELD_LABEL[f] as 'headerField_employerNo') : f}</li>
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
      {/* ADVISORY, NEVER BLOCKING. The page is signed by hand and the request itself leaves the signature
          blank, so an empty preparer block prints a rule to write on rather than refusing the download. */}
      {preparerMissing.length > 0 && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium">{t('prepMissingTitle')}</p>
          <p className="mt-1">
            {preparerMissing
              .map((f) => (PREPARER_FIELD_LABEL[f] ? t(PREPARER_FIELD_LABEL[f] as 'prepField_name') : f))
              .join(', ')}
          </p>
          <p className="mt-1">{t('prepMissingHint')}</p>
        </div>
      )}

      {/* 7ee14bbc — DUPLICATED TAX REFERENCE NUMBERS, NAMING EVERYBODY FILED UNDER EACH ONE.
          ADVISORY, NEVER BLOCKING, and a different banner from the amber one above on purpose: a
          MISSING number stops the filing (the e-Data PCB file refuses without it), a SHARED one does
          not — it is the staff records disagreeing with themselves, and the statement must go on
          printing what is filed under each person. Naming both people is the whole deliverable: it is
          the only way to tell which of the two records is the wrong one. */}
      {form.duplicateTaxNumbers.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('dupTinTitle', { count: form.duplicateTaxNumbers.length })}</p>
          <ul className="mt-1 space-y-0.5">
            {form.duplicateTaxNumbers.map((d) => (
              <li key={d.tin}>
                <span className="font-mono">{d.tin}</span> — {d.names.join(' · ')}
              </li>
            ))}
          </ul>
          <p className="mt-1">{t('dupTinHint')}</p>
        </div>
      )}

      {/* 7ee14bbc — UNFINISHED EMPLOYEE NAMES, the plan's second "before you file rather than after"
          warning ("warns you about duplicated tax numbers and unfinished employee names"). 22 of the
          reporter's 40 people are named TEST followed by a number, and a CP39 filed under those names
          is filed under those names. ADVISORY and NEVER BLOCKING, exactly like the banner above and for
          the same reason: it is their data, the statement prints the name on file, and the correction
          belongs on the staff record. The employee number rides along because a BLANK name leaves
          nothing else to find the person by. NOT printed on the document — see `unfinishedCp39Names`. */}
      {form.unfinishedNames.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('unfinishedNameTitle', { count: form.unfinishedNames.length })}</p>
          <ul className="mt-1 space-y-0.5">
            {form.unfinishedNames.map((u) => (
              <li key={u.employmentId}>
                <span className="font-mono">{u.name || '—'}</span>
                {u.employeeNo ? ` — ${u.employeeNo}` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-1">{t('unfinishedNameHint')}</p>
        </div>
      )}

      {/* THE TWO COLUMNS, SAID ONCE, HERE — AND WHAT THEY MEAN CHANGED WITH MIGRATION 0450. They are no
          longer unfillable: `old_ic_number` and `passport_issuing_country_code` are real columns an admin
          types on the Profile tab, so a blank one means the staff record has none. The half that did not
          change is why Kod Negara is typed rather than derived — guessing a country code onto a tax
          document from the nationality text beside it is the failure this notice exists to prevent. */}
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <p className="font-medium">{t('blankColumnsTitle')}</p>
        <p className="mt-1">{t('blankColumnsHint')}</p>
      </div>
    </>
  );

  const schedule = (
      <Card className="overflow-hidden">
        {/* THE COUNT ON THE HEADING IS THE COUNT OF ROWS BELOW IT. It used to be `form.employees` —
            everyone the run paid — over a table that also printed everyone, and the two Bilangan Pekerja
            tiles above already counted only the deducted. That is 7ee14bbc: 38 against 7. */}
        <SectionHeader title={t('scheduleTitle')} count={form.deductedEmployees} />

        {/* THE SCHEDULE FORM. Its hidden inputs are `cp39DocumentPairs` — company, payroll month AND the
            payroll cycles — so Apply re-reviews the same selection and every download below is built from it.
            Before r409 it carried companyId / periodKey / year / month only, and a download was the whole
            month whatever had been ticked. */}
        <form method="get" action="/payroll/cp39/preview">
          {hiddenPairs.map((h, i) => (
            <input key={`${h.name}-${i}`} type="hidden" name={h.name} value={h.value} />
          ))}
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="month" value={month} />

          <div className="flex flex-wrap items-end gap-3 px-4 pt-4">
            {/* READ BY VALUE, never by presence: every one of these is submitted on every request whether
                or not it was touched, so `has()` would report an override for everybody. A blank box means
                "keep the company default" — see `withPreparer`. */}
            <Field label={t('prepName')}>
              <input
                type="text"
                name="prepName"
                defaultValue={form.preparerName}
                className={`${inputCls} w-56`}
              />
            </Field>
            <Field label={t('prepIc')}>
              <input type="text" name="prepIc" defaultValue={form.preparerIc} className={`${inputCls} w-40`} />
            </Field>
            <Field label={t('prepPosition')}>
              <input
                type="text"
                name="prepPosition"
                defaultValue={form.preparerPosition}
                className={`${inputCls} w-44`}
              />
            </Field>
            <Field label={t('prepPhone')}>
              <input type="text" name="prepPhone" defaultValue={form.preparerPhone} className={`${inputCls} w-36`} />
            </Field>
            <Field label={t('printDate')}>
              <input
                type="date"
                name="date"
                defaultValue={one('date') || today}
                className={inputCls}
              />
            </Field>
            {/* BUTIR-BUTIR PEMBAYARAN — the payment instrument, which the approved plan lists as editable
                on this screen. `defaultValue` off the FORM rather than off `sp`, so these behave like
                every other box here: what you see is what the PDF will carry. Unlike the preparer boxes
                they have no company default, so clearing one really does clear it and the statement goes
                back to printing a ruled line. */}
            <Field label={t('payRef')}>
              <input type="text" name="payRef" defaultValue={form.paymentRef} className={`${inputCls} w-52`} />
            </Field>
            <Field label={t('payBranch')}>
              <input
                type="text"
                name="payBranch"
                defaultValue={form.paymentBranch}
                className={`${inputCls} w-44`}
              />
            </Field>
            <button className={btnGhost}>{t('apply')}</button>
          </div>
          <p className="px-4 pt-2 text-xs text-muted-foreground">{t('inputsHint')}</p>
          <p className="px-4 pt-1 text-xs text-muted-foreground">{t('paymentHint')}</p>
          {/* Both numbers, always, even when they agree: "12 of 12" is a reconciliation, "12" is a claim
              somebody has to go and check. The dropped rows are not lost — they are the people the run
              paid with nothing deducted, and a CP39 is a statement of deductions. */}
          <p className="px-4 pt-1 text-xs text-muted-foreground">
            {t('deductedOnly', { count: form.deductedEmployees, paid: form.employees })}
          </p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colBil')}</th>
                  <th className="px-3 py-2 font-medium">{t('colTin')}</th>
                  <th className="px-3 py-2 font-medium">{t('colName')}</th>
                  <th className="px-3 py-2 font-medium">{t('colOldIc')}</th>
                  <th className="px-3 py-2 font-medium">{t('colNewIc')}</th>
                  <th className="px-3 py-2 font-medium">{t('colEmployeeNo')}</th>
                  <th className="px-3 py-2 font-medium">{t('colPassport')}</th>
                  <th className="px-3 py-2 font-medium">{t('colCountry')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colPcb')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colCp38')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r, i) => (
                  <tr key={r.employmentId}>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.tin || <span className="text-red-600">—</span>}
                    </td>
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    {/* Not an error state: there is no old-IC field to be missing. Rendered as a neutral
                        dash rather than the red one a genuinely absent value gets. */}
                    <td className="px-3 py-2 text-muted-foreground">{r.oldIc || '—'}</td>
                    {/* 7ee14bbc / r409 — DASHED HERE, ON THE SCREEN, AND NOWHERE ELSE. A person reading the
                        number checks it more easily in the card's own grouping. Since r409 the drawn page
                        prints the twelve digits LHDN's instructions write (`cp39IcForForm`), the text twin
                        and the e-Data PCB file print digits too, and `formatMyIc` touches none of them. */}
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.newIc ? formatMyIc(r.newIc) : <span className="text-red-600">—</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{r.employeeNo || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.passport || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.countryCode || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.pcb)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.cp38)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {/* TWO DIFFERENT EMPTY STATES since the table started printing only the deducted.
                          "No employees in this run" and "this run paid 38 people and deducted tax from
                          none of them" are not the same fact, and telling an operator the first when the
                          second is true sends them to look for a payroll run that is right there. */}
                      {form.employees > 0 ? t('noDeductions', { paid: form.employees }) : t('noEmployees')}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot className="border-t-2 border-border bg-muted/30 text-sm font-semibold">
                {form.pages.length > 1 &&
                  form.pages.map((p) => (
                    <tr key={p.sheet}>
                      <td colSpan={8} className="px-3 py-2">
                        {t('pageTotal', { sheet: p.sheet, of: p.of })}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(p.pagePcb)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(p.pageCp38)}</td>
                    </tr>
                  ))}
                <tr>
                  <td colSpan={8} className="px-3 py-2">
                    {t('grandTotal')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(form.totalPcb)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(form.totalCp38)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-3">
            {/* NO DOWNLOAD BUTTONS AT ALL while somebody is not ready — not disabled ones, which are still
                buttons and still get clicked at. The sentence beside them says why. */}
            {ready ? (
              <>
                <button className={btnPrimary} formAction="/payroll/cp39/pdf" title={t('downloadPdfTitle')}>
                  {t('downloadPdf')}
                </button>
                <button className={btnGhost} formAction="/payroll/cp39/text" title={t('downloadTextTitle')}>
                  {t('downloadText')}
                </button>
                {/* 00806b4c — THE FILE LHDN ACTUALLY INGESTS, BESIDE THE COPY THAT ONLY LOOKS LIKE IT.
                    The reporter compared the readable text export against LHDN's e-Data PCB specification
                    and reported it as non-conforming; it never could conform, because it is laid out for a
                    person to read. The conforming file existed all along, on a different screen. Two
                    downloads a click apart, one of them named "…not for upload", is what stops that
                    confusion recurring — the same arrangement Borang A and Borang 8A already have.

                    A PLAIN SUBMIT BUTTON ON THE EXISTING FORM, not a third <form>: a nested form is
                    invalid HTML and browsers drop the inner one. `formAction` retargets THIS submit only,
                    and the route reads companyId + periodKey from the query the GET form already carries.
                    Its own refusals are stricter than this screen's (mandatory TIN, a 10-character
                    employee number, an identity number of some kind), so a file that cannot be produced
                    answers 422 naming the employees rather than downloading something incomplete. */}
                <button
                  className={btnGhost}
                  formAction="/payroll/reports/cp39-file"
                  title={t('downloadFileTitle')}
                >
                  {t('downloadFile')}
                </button>
              </>
            ) : (
              <span className="text-xs italic text-muted-foreground">{t('downloadsBlocked')}</span>
            )}
          </div>
        </form>
      </Card>
  );

  const payments = (
    <>
      {/**
       * 72b100cd (r321) — WHAT YOU PAID LHDN FOR THIS MONTH, and the only place it is recorded.
       *
       * PCB 2(II) reports, per month, the receipt / bank slip / transaction number and the receipt date,
       * separately for MTD and for CP38. Nothing in this system held those: they are what LHDN gives the
       * employer on PAYMENT, while `statutory_report.ack_ref` beside it is the acknowledgement of the
       * RETURN. Two different facts about two different acts, so this is its own record.
       *
       * IT SITS HERE because this is the screen an operator is already on when they pay — the CP39 for
       * that month. Asking them to go somewhere else afterwards is how a box stays empty for a year and
       * is discovered at filing time.
       *
       * ⚠️ NOTHING IS DERIVED. Both values are typed in. A month with nothing recorded prints an EMPTY
       * box on PCB 2(II), never 0.00: an absent box asserts nothing, a zero asserts the money does not
       * exist, and those are different statements to LHDN.
       */}
      <Card>
        <SectionHeader title={t('pcbPaymentTitle')} subtitle={t('pcbPaymentHint')} />
        <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2">
          {(['mtd', 'cp38'] as const).map((kind) => {
            const rec = pcbPayments.get(`${periodKey}|${kind}`);
            return (
              <form key={kind} action={recordPcbPaymentAction} className="space-y-2 rounded-xl border border-border p-3">
                <input type="hidden" name="companyId" value={companyId} />
                <input type="hidden" name="periodKey" value={periodKey} />
                <input type="hidden" name="kind" value={kind} />
                <div className="text-sm font-medium">{kind === 'mtd' ? t('pcbPaymentKindMtd') : t('pcbPaymentKindCp38')}</div>
                <Field label={t('pcbPaymentReceiptRef')}>
                  <input name="receiptRef" defaultValue={rec?.receiptRef ?? ''} className={inputCls} />
                </Field>
                <Field label={t('pcbPaymentPaidOn')}>
                  <input type="date" name="paidOn" defaultValue={rec?.paidOn ?? ''} className={inputCls} />
                </Field>
                <button className={btnGhost}>{t('pcbPaymentSave')}</button>
              </form>
            );
          })}
        </div>
      </Card>
    </>
  );

  if (!ready) {
    // NOT READY: no drawn statement at all — the PDF route would refuse it, and a framed refusal is not a
    // preview. The names and what each is missing, exactly as before, and the table that shows them.
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('title')} description={subtitle} back={{ href: backToCriteria, label: t('viewerBack') }} />
        {provenance}
        {tiles}
        {checks}
        <p className="text-sm text-muted-foreground" data-preview-blocked>
          {t('previewBlocked')}
        </p>
        {schedule}
        {payments}
      </div>
    );
  }

  return (
    <div className={pageWideCls}>
      <StatutoryPdfViewer
        title={t('title')}
        subtitle={subtitle}
        pdfUrl={`/payroll/cp39/pdf?${documentQuery}&disposition=inline`}
        downloads={[
          { href: `/payroll/cp39/pdf?${documentQuery}`, label: t('downloadPdf') },
          { href: `/payroll/cp39/text?${documentQuery}`, label: t('downloadText') },
          // The e-Data PCB upload file reads company, month and `run` and ignores the rest.
          { href: `/payroll/reports/cp39-file?${documentQuery}`, label: t('downloadFile') },
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
      {schedule}
      {payments}
    </div>
  );
}
