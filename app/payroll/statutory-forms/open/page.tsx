import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listStatutoryCatalog } from '@/core/reporting';
import { Card, PageHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { Field } from '@/components/monolith/field';
import { MONO_UNDERLINE_FIELD as MONO_FIELD } from '@/components/monolith/classes';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
import { parseRunSelection } from '@/lib/payroll-run-selection';
import { CyclesCriterion } from './cycles-criterion';
import {
  CYCLES_ENDPOINT,
  cyclesRefusalFrom,
  defaultCriteria,
  defaultVersion,
  destinationReportId,
  formerIdRedirect,
  parseDestination,
  reportDestination,
  type CriterionKind,
} from '../criteria';

/**
 * r256 (item 858a1128) — ONE FORM'S CRITERIA, ASKED AFTER THE FORM IS CHOSEN AND BEFORE ANYTHING IS MADE.
 *
 * WHY THIS PAGE EXISTS. Statutory Forms used to open with Company, Payroll Year and Payroll Month and
 * would not name a single form until all three were answered — the period chosen before the form, which
 * is the reverse of the order an HR operator works in, and the whole of what the reporter asked us to
 * turn around. The directory now lists the forms with no period on it at all; this is the step that asks
 * each form for what it needs, and it is the step that makes "generate" a decision rather than a side
 * effect of arriving.
 *
 * ⚠️ IT PRODUCES NOTHING ITSELF, AND THAT IS THE POINT. There is no generator call on this page, no
 * `reportPreview`, no export route: it renders a GET form whose `action` is the destination the catalog
 * declares. Pressing the button navigates; the destination generates. So the answer to "when is the form
 * produced" is "when you press it", enforced by there being nothing here that could produce one earlier.
 *
 * IT ASKS FOR EXACTLY THE PLACEHOLDERS THE DESTINATION DECLARES, AND NEVER FOR A FIELD THE DESTINATION
 * WOULD IGNORE. A catalog link's href carries `{companyId}` / `{year}` / `{month}` where it needs them, so
 * Form TP1 (`/payroll/transactions/tp1?year={year}`) asks for a year and not a company, the two C.P.8A
 * (EA) rows ask for a company and a year and NEVER a month, and a monthly report asks for all three. The
 * alternative — a fixed three-box prompt on every form — is exactly the "asks for a Payroll Month on an
 * annual form" complaint one level down.
 *
 * A REPORT HAS NO HREF, so its criteria come from its own `periodKind`: `month` ⇒ company + year + month,
 * `year` ⇒ company + year. That is the SAME field `[formId]` uses to decide whether to draw a month
 * select beside the figures, so the step and the screen it opens cannot disagree about what a form
 * covers.
 *
 * THE BUTTON'S WORDING IS THE CATALOG'S, NOT THIS FILE'S. "Generate form" is a lie on a two-step flow, so
 * the two EA entries declare `criteriaLabelKey: 'criteria_continue'` — company and year is their first
 * step and the employee selection is their second. A step that decided this from the destination path
 * would be the screen naming forms again, which is what the catalog exists to prevent.
 *
 * ⚠️ AGENTS 28b — THE FIDELITY CHIP IS RE-RENDERED HERE, WORD FOR WORD. It is the third surface to carry
 * it (the shelf card, this step, the form screen) and not one string was reworded on the way: a shared
 * caption may only say what is true of EVERY form that carries it, and r218 shipped an unsourced claim
 * about an agency by rewording one in a new place. Nothing here promotes a form between statuses either;
 * the value comes off the catalog entry and is displayed.
 *
 * IT ARRIVES ON A PERIOD THAT HAS ALREADY HAPPENED. The selects open on the last CLOSED filing period —
 * the month just ended for a monthly form, and for an annual return the year being filed FOR, which
 * through the January-to-March C.P.8A / Form E season is the year that closed rather than the one that has
 * just begun. `defaultCriteria` in `../criteria` holds the rules and the arithmetic; both are driven off
 * the TENANT's clock, because between 00:00 and 08:00 MYT the UTC date is still yesterday's.
 *
 * r402 (item f3cf2444) — A VERSION BOX, AND THE FULL WIDTH. The C.P.8A (EA) and PCB 2(II) are one shelf
 * entry each now; their href carries `{lang}`, so this step draws a Version select whose options are the
 * entry's own `versions`, arriving on `?lang=` when the entry publishes it and on the entry's first version
 * otherwise (never the viewer's UI language). A former id (`my.ea.ms`) redirects here with its version
 * chosen. The step was `max-w-3xl` and is now on `pageWideCls` with the boxes in one row — the reporter
 * asked for the full width, which reverses r256's cap on this screen.
 *
 * r407 (item 4f45f9b0) — A PAYROLL CYCLE BOX, AND THE WAY BACK FROM A REFUSAL. A monthly report whose pack
 * declares `runSelection` (Borang A first) gets a `cycles` criterion: the shared run picker, Select All
 * ticked, listing only the processed runs of the company and month chosen above it. Continue goes to the
 * form's own preview, whose server-side gate sends an empty or invalid selection BACK HERE with
 * `?error=cycles_…` and the criteria it was given — so the step re-opens on the operator's own company,
 * year, month and ticks, with the refusal said in words, and nothing was produced. The prefill is honoured
 * for every form (a company outside this admin's scope, a malformed year or month are ignored, never
 * echoed); the error is allowlisted by `cyclesRefusalFrom`.
 *
 * AN UNKNOWN OR UNBUILT FORM 404s. `form` comes from the URL, so it is attacker-controlled; it is
 * resolved against the catalog of the jurisdictions this admin's OWN company scope reaches, and a
 * `PlannedFormDef` can never match because planned entries are not in the two collections searched — the
 * type carries no href, so there is nothing here that could give one an action.
 */
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/** r407 — the Continue gate's refusals, through an EXPLICIT map (a computed key renders MISSING_MESSAGE). */
const REFUSAL_KEY = {
  cycles_no_runs: 'refusal_cycles_no_runs',
  cycles_no_data: 'refusal_cycles_no_data',
  cycles_invalid: 'refusal_cycles_invalid',
} as const;

const FIDELITY_KEY: Record<string, string> = {
  official: 'fidelity_official',
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
  official:
    'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  'agency-layout':
    'border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300',
  figures: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300',
  'draft-file':
    'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
};

export default async function StatutoryFormCriteriaPage({
  searchParams,
}: {
  searchParams: Promise<{
    form?: string;
    body?: string;
    lang?: string;
    /** r407 — the criteria a refused Continue came back with. Validated below; never echoed raw. */
    companyId?: string;
    year?: string;
    month?: string;
    run?: string | string[];
    error?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  const locale = await getLocale();
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const sp = await searchParams;
  const formId = sp.form ?? '';

  const catalog = await listStatutoryCatalog(s, scopeIds);
  const report = catalog.reports.find((r) => r.id === formId);
  const link = catalog.links.find((l) => l.id === formId);
  if (!report && !link) {
    // r402 — a former id (a bookmark to `my.ea.ms`) lands on the merged entry with its version chosen.
    const moved = formerIdRedirect(catalog.links, formId, sp.body);
    if (moved) redirect(moved);
    notFound();
  }

  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // THE TENANT'S CLOCK, NOT THE HOST'S. Between 00:00 and 08:00 MYT the UTC date is still yesterday's, and
  // on 1 January that is a whole year out — the defaults below are built from this and nothing else.
  const today = todayInKualaLumpur();

  // Both branches come out of `../criteria`, which is also what the directory reads to decide whether a
  // card comes here at all — one rule, three readers, so a card cannot be sent to a step that then asks
  // for something the destination does not take.
  const parsed = link
    ? parseDestination(link.href)
    : reportDestination(report!.id, report!.periodKind, report!.runSelection);

  /**
   * THE PERIOD THIS STEP ARRIVES SHOWING — the last one that has actually HAPPENED, never "now".
   *
   * Whatever these selects are set to is what an operator who presses the button without reading gets, so
   * a default that names a future period is a generated statutory form for a month or a year that has not
   * finished. `defaultCriteria` owns the three rules (see `../criteria`); this page's only job is to hand
   * it the destination's own report, resolved from the PACK — the href for a link that opens a report
   * (`my.borang-e` → `my.cp8d`) or `populationReportId` for one that opens the people in it (the two
   * C.P.8A rows). No form id is written down here, which is the point: Form TP1 resolves to nothing and
   * keeps the year in progress precisely because its destination is not one of this pack's reports.
   */
  const target = catalog.reports.find(
    (r) => r.id === destinationReportId(parsed.action, link?.populationReportId),
  );
  const defaults = defaultCriteria(today, parsed.criteria, target);
  // r407 — criteria handed back by a refused Continue win over the defaults, when they are well formed.
  const backCompany = sp.companyId && companies.some((c) => c.id === sp.companyId) ? sp.companyId : '';
  const defaultYear = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : defaults.year;
  const defaultMonth = MONTHS.includes(sp.month as (typeof MONTHS)[number]) ? sp.month! : defaults.month;
  const defaultCompany = backCompany || companies[0]?.id || '';
  const years = yearOptions(today, defaultYear);
  const backRuns = parseRunSelection(
    new URLSearchParams((Array.isArray(sp.run) ? sp.run : sp.run ? [sp.run] : []).map((v) => ['run', v])),
  );
  const refusal = cyclesRefusalFrom(sp.error);

  const name = report ? report.label : t(link!.labelKey as 'link_cp22');
  const description = report
    ? report.descriptionKey
      ? t(report.descriptionKey as 'desc_cp39')
      : null
    : link!.descriptionKey
      ? t(link!.descriptionKey as 'desc_cp22')
      : null;
  const hint = link ? t(link.hintKey as 'link_cp22_hint') : null;
  const fidelity = (report ? report.fidelity : link!.fidelity) ?? null;
  // r407 — a form filed per payroll cycle CONTINUES to its preview; it does not generate on this press.
  const continues = parsed.criteria.some((c) => c.kind === 'cycles');
  const buttonLabel = t(
    (link?.criteriaLabelKey ?? (continues ? 'criteria_continue' : 'criteria_generate')) as 'criteria_generate',
  );
  const backHref = `/payroll/statutory-forms${sp.body ? `?body=${encodeURIComponent(sp.body)}` : ''}`;
  const field = (kind: CriterionKind) => parsed.criteria.find((c) => c.kind === kind);
  // r402 — the Version options are the ENTRY's, so the step offers exactly what the destination allowlists.
  const versions = link?.versions ?? [];
  const chosenVersion = defaultVersion(versions, sp.lang);
  const selectCls = `${inputCls} ${MONO_FIELD}`;

  return (
    <div className={pageWideCls}>
      <PageHeader back={{ href: backHref, label: t('pageTitle') }} title={t('criteriaTitle', { form: name })} />

      <Card className="overflow-hidden">
        <div className="space-y-2 border-b border-border px-4 py-4">
          <div className="text-sm font-medium">{name}</div>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>

        {/* AGENTS 28b — the SAME status and the SAME sentence the shelf card carried, so nobody arrives
            here having forgotten what this form can honestly give them. Absent entirely for an entry whose
            catalog record declares no fidelity, rather than guessed. */}
        {fidelity && (
          <div className={`mx-4 mt-4 rounded-lg border px-4 py-3 text-xs ${FIDELITY_CLS[fidelity]}`}>
            <span className="font-medium uppercase tracking-wide">{t(FIDELITY_KEY[fidelity] as 'fidelity_official')}</span>{' '}
            <span>{t(FIDELITY_HINT_KEY[fidelity] as 'fidelity_official_hint')}</span>
          </div>
        )}

        <p className="px-4 pt-4 text-xs text-muted-foreground">{t('criteriaHint')}</p>

        {/* A PLAIN GET FORM WHOSE ACTION IS THE DESTINATION. No server action and no client state: the
            criteria end up in the address bar of the screen that uses them, so the generated view is
            refreshable, bookmarkable and can be sent to somebody — which is the property every existing
            deep link into `[formId]` depends on. */}
        <form method="get" action={parsed.action} className="space-y-4 px-4 py-4 monolith:px-0">
          {parsed.hidden.map((h) => (
            <input key={h.name} type="hidden" name={h.name} value={h.value} />
          ))}
          {/* r402 — ONE ROW across the full width: Company, Year and (for a form published in more than one
              language) Version, stacking on a phone. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 monolith:border-t monolith:border-ink monolith:pt-4">
          {field('company') && (
            <Field label={t('company')}>
              <select name={field('company')!.field} defaultValue={defaultCompany} className={selectCls} required>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {field('year') && (
            <Field label={t('year')}>
              <select name={field('year')!.field} defaultValue={defaultYear} className={selectCls} required>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {/* NO MONTH BOX WHEN THE DESTINATION DOES NOT TAKE ONE. The annual C.P.8A (EA) is the row this
              was written for: a month select on it is a question with no answer, and the reporter said so
              in as many words. */}
          {field('month') && (
            <Field label={t('month')}>
              <select name={field('month')!.field} defaultValue={defaultMonth} className={selectCls} required>
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {monthName(m)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {/* r402 (item f3cf2444) — VERSION: the language the form is printed in. Drawn only for an entry
              whose href takes `{lang}`, with the entry's own options; the field name is the destination's. */}
          {field('version') && versions.length > 0 && (
            <Field label={t('version')} hint={t('version_hint')}>
              <select name={field('version')!.field} defaultValue={chosenVersion} className={selectCls} required>
                {versions.map((v) => (
                  <option key={v.value} value={v.value}>
                    {t(v.labelKey as 'version_en')}
                  </option>
                ))}
              </select>
            </Field>
          )}
          </div>
          {/* r407 (item 4f45f9b0) — PAYROLL CYCLE, for a monthly form filed per cycle. Below the row of
              selects because it is a list, not a box; it re-lists whenever Company, Year or Month changes. */}
          {field('cycles') && field('company') && field('year') && field('month') && (
            <Field label={t('cycles')} hint={t('cycles_hint')}>
              <CyclesCriterion
                companyField={field('company')!.field}
                yearField={field('year')!.field}
                monthField={field('month')!.field}
                initialCompanyId={defaultCompany}
                initialYear={defaultYear}
                initialMonth={defaultMonth}
                endpoint={CYCLES_ENDPOINT}
                initialRunSeqs={backRuns.ok ? backRuns.runSeqs : undefined}
                strings={{
                  noRuns: t('cycles_noRuns'),
                  nonePicked: t('cycles_nonePicked'),
                  partialWarning: t('cycles_partial'),
                }}
              />
            </Field>
          )}
          {/* r407 — THE CONTINUE GATE'S ANSWER, on the step it refused from. Allowlisted; nothing produced. */}
          {refusal && (
            <p
              role="alert"
              data-criteria-refusal={refusal}
              className="border-l-2 border-red-600 pl-3 text-sm text-red-700 dark:border-red-400 dark:text-red-400 monolith:border-signal monolith:text-signal-text"
            >
              {t(REFUSAL_KEY[refusal])}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3 monolith:border-t monolith:border-hairline monolith:pt-4">
            <Link
              href={backHref}
              className="h-9 rounded-md px-3 text-sm leading-9 text-muted-foreground hover:text-foreground monolith:h-auto monolith:rounded-none monolith:border-b monolith:border-ink monolith:px-0.5 monolith:leading-normal monolith:text-ink"
            >
              {t('criteria_cancel')}
            </Link>
            <button
              data-criteria-submit
              className={`${btnPrimary} disabled:cursor-not-allowed disabled:opacity-50 monolith:h-11 monolith:rounded-full monolith:bg-ink monolith:px-5 monolith:text-bone`}
            >
              {buttonLabel}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
