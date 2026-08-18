import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { scopedAdmin } from '@/lib/scope';
import { money } from '@/lib/cp39-form';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
import { Card, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { loadCp39Form } from '../shared';

/**
 * e0cd4583 — the CP39 review screen: pick a payroll cycle month, check the statement, fill in the
 * preparer block, then download it two ways.
 *
 * "FILTER → PREVIEW (auto-filled data shown, the preparer block and payment fields editable) → DOWNLOAD"
 * is the request's own workflow, and it is why this screen exists beside the generic [formId] figures
 * screen rather than instead of it. The generic screen renders any form's table and can render this one;
 * what it cannot do is carry the preparer inputs, because it does not know what a CP39 is. So the shelf
 * card opens the figures screen as every other form does, and the figures screen hands you this one for
 * the printed document itself.
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

/** Default to the month just ENDED — the one whose CP39 payment is actually due. Same rule as the shelf. */
function previousMonth(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

type Search = Record<string, string | string[] | undefined>;

/** The screen's own params → the URLSearchParams the shared loader reads. One conversion, here. */
function toQuery(sp: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') q.set(k, v);
  return q;
}

export default async function Cp39PreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.cp39Form');
  const locale = await getLocale();
  const sp = await searchParams;

  const { scopeIds, s } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // An out-of-scope companyId in the URL falls back to the first company this admin CAN administer rather
  // than being honoured — the same rule the [formId] screen and the download routes apply, so the three
  // cannot disagree about which company is being looked at.
  const requested = typeof sp.companyId === 'string' && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const companyId = requested || companies[0]?.id || '';

  const today = todayInKualaLumpur();
  const spPeriod = typeof sp.periodKey === 'string' ? sp.periodKey : '';
  const fallback = /^\d{4}-\d{2}$/.test(spPeriod) ? spPeriod : previousMonth(today);
  const year = typeof sp.year === 'string' && /^\d{4}$/.test(sp.year) ? sp.year : fallback.slice(0, 4);
  const month = MONTHS.includes(sp.month as (typeof MONTHS)[number]) ? (sp.month as string) : fallback.slice(5, 7);
  const periodKey = `${year}-${month}`;
  const years = yearOptions(today, year);
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const periodLabel = `${monthName(month)} ${year}`;
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';

  // `includeIncomplete` — this screen must be able to RENDER the table in order to name who is missing.
  // The download routes call the same function without it and are refused.
  const loaded = companyId
    ? await loadCp39Form({ companyId, periodKey, query: toQuery(sp), includeIncomplete: true })
    : ({ ok: false, reason: 'not-found' } as const);

  const filter = (
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
        <Field label={t('month')}>
          <select name="month" defaultValue={month} className={inputCls}>
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </select>
        </Field>
        <button className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent">
          {t('show')}
        </button>
      </form>
    </Card>
  );

  const header = (
    <PageHeader
      title={t('title')}
      description={`${companyName} · ${periodLabel}`}
      back={{ href: `/payroll/statutory-forms?companyId=${encodeURIComponent(companyId)}&body=lhdn`, label: t('back') }}
    />
  );

  // THE PROVENANCE NOTICE, above everything and never in a tooltip: what comes off this screen looks like
  // a government form and is not one — and unlike the EPF and PERKESO forms beside it, we do not even
  // hold a completed specimen of the agency's page to have drawn from. That is the single claim the
  // statutory-forms fidelity vocabulary exists to keep honest, and the screen that produces the document
  // is where it has to be said.
  const provenance = (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
      <span className="font-medium">{t('notArtworkTitle')}</span>{' '}
      <span className="text-muted-foreground">{t('notArtwork')}</span>
    </div>
  );

  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-[100rem] space-y-6">
        {header}
        {provenance}
        {filter}
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {loaded.reason === 'no-batch' ? t('noBatch', { company: companyName, period: periodLabel }) : t('notFound')}
          </p>
        </Card>
      </div>
    );
  }

  const { form, missing, headerMissing, preparerMissing, notes } = loaded;
  const ready = missing.length === 0 && headerMissing.length === 0;
  const rows = form.pages.flatMap((p) => p.rows);

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      {header}
      {provenance}
      {filter}

      {/* The deduction month, stated where the statement is produced. It is the fact most likely to be
          "corrected" into the EPF +1 rule by somebody comparing the two forms. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileMonth')}</div>
          <div className="text-lg font-semibold">
            {form.deductionMonth} {form.deductionYear}
          </div>
          <div className="text-xs text-muted-foreground">{t('tileMonthHint')}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tilePcb')}</div>
          <div className="text-lg font-semibold tabular-nums">RM {money(form.totalPcb)}</div>
          <div className="text-xs text-muted-foreground">{t('tilePcbHint', { count: form.pcbEmployees })}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileCp38')}</div>
          <div className="text-lg font-semibold tabular-nums">RM {money(form.totalCp38)}</div>
          <div className="text-xs text-muted-foreground">{t('tileCp38Hint', { count: form.cp38Employees })}</div>
        </div>
        <div className="bg-card p-4">
          <div className="text-xs text-muted-foreground">{t('tileAmount')}</div>
          <div className="text-lg font-semibold tabular-nums">RM {money(form.totalAmount)}</div>
          <div className="text-xs text-muted-foreground">{t('tileEmployer', { ref: form.employerNo || '—' })}</div>
        </div>
      </div>

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

      {/* THE TWO COLUMNS WE CANNOT FILL, SAID ONCE, HERE. A blank column with no explanation reads as a
          bug and invites somebody to "fix" it by guessing a country code onto a tax document. */}
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <p className="font-medium">{t('blankColumnsTitle')}</p>
        <p className="mt-1">{t('blankColumnsHint')}</p>
      </div>

      <Card className="overflow-hidden">
        <SectionHeader title={t('scheduleTitle')} count={form.employees} />

        {/* SIBLING of the filter form above, never nested inside it. Carries its own companyId +
            periodKey so a download always asks for the month that is on screen. */}
        <form method="get" action="/payroll/cp39/preview">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="periodKey" value={periodKey} />
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
                defaultValue={typeof sp.date === 'string' ? sp.date : today}
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
                    <td className="px-3 py-2 font-mono text-xs">{r.newIc || <span className="text-red-600">—</span>}</td>
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
                      {t('noEmployees')}
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
              </>
            ) : (
              <span className="text-xs italic text-muted-foreground">{t('downloadsBlocked')}</span>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
