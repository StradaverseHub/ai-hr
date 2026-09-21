import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listStatutoryCatalog, reportPreview } from '@/core/reporting';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { Card, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
// THE PICKER IS SHARED, NOT FORKED. `EaEmployeePicker` is form-agnostic — rows, a destination href,
// hidden fields and pre-translated strings — and its `Ea` prefix is historical: it was written for the
// C.P.8A and is the second screen to use it, not a second copy of it. A lookalike picker here would be
// the "six slightly different employee pickers" this repo keeps consolidating away from (r320).
import { EaEmployeePicker, type EaPickerRow } from '../ea/employee-picker';
import { MAX_EA_SELECTION } from '../ea/limits';

/**
 * 72b100cd (r323) — PCB 2(II)'s SECOND STEP: pick the people, then generate.
 *
 * WHY THIS FORM NEEDS ITS OWN SCREEN, and it is the same reason the EA does. Every other entry on the
 * statutory shelf produces ONE document for a company and a period. PCB 2(II) does not: it is one
 * statement per EMPLOYEE for a YEAR, so "the PCB 2(II) for ABC Sdn Bhd 2026" is forty documents. The flow
 * is therefore the EA's: company + year (no month — the form has none) on `open/page.tsx`, then this.
 *
 * ⚠️ IT GENERATES NOTHING ON ARRIVAL. This page reads the year's population and renders a list. The forms
 * are produced by `download/route.ts` when the button is pressed.
 *
 * THE POPULATION IS THE PACK'S, NOT THIS FILE'S. The shelf entries declare `populationReportId`
 * (`my.cp8d` for Malaysia) and this screen resolves it — the question "who did this employer pay in this
 * tax year" is the same one the EA asks, so it is the same report and emphatically not a second
 * implementation of it. Hardcoding the id here would be the app naming one jurisdiction's report, which
 * is what the catalog exists to prevent.
 *
 * ⚠️ AND THE POPULATION IS DELIBERATELY NOT "EVERY EMPLOYEE". Only somebody with payroll behind them in
 * that year has tax deducted to declare; offering the rest would hand an operator a tax document with
 * twelve empty months under a named person's name. The read will happily produce that statement — an
 * employee who genuinely had nothing deducted is a legitimate one — but the LIST must not invite it.
 *
 * `lang` IS ALLOWLISTED AND CARRIED, NEVER ECHOED. LHDN publishes this form in English and Bahasa
 * Malaysia, and which one was asked for must not become "whatever the screen was set to". The download
 * route allowlists it a second time.
 */
const PCB2II_LANGS = ['en', 'ms'] as const;
type Pcb2iiPageLang = (typeof PCB2II_LANGS)[number];

export default async function Pcb2iiEmployeeSelectionPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; year?: string; lang?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  const tStatus = await getTranslations('people.employeeStatus');
  const sp = await searchParams;

  const lang: Pcb2iiPageLang | null = PCB2II_LANGS.includes(sp.lang as Pcb2iiPageLang)
    ? (sp.lang as Pcb2iiPageLang)
    : null;
  const catalog = await listStatutoryCatalog(s, scopeIds);
  // Matched on its DESTINATION and its language, so no entry id is written down here.
  const entry =
    catalog.links.find(
      (l) => l.href.startsWith('/payroll/statutory-forms/pcb2ii') && (!lang || l.href.includes(`lang=${lang}`)),
    ) ?? null;
  if (!entry) notFound();

  // An out-of-scope companyId in the URL is treated as absent rather than honoured.
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : '';
  if (!companyId || !year) redirect(`/payroll/statutory-forms/open?form=${encodeURIComponent(entry.id)}`);

  const reportId = entry.populationReportId;
  if (!reportId || !catalog.reports.some((r) => r.id === reportId)) notFound();

  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const today = todayInKualaLumpur();

  const population = await reportPreview(s, { companyId, reportId, periodKey: year });
  const roster = new Map((await listEmployees(s, [companyId])).map((e) => [e.employmentId, e]));

  const rows: EaPickerRow[] = population.rows
    .map((r): EaPickerRow | null => {
      const employmentId = typeof r.employmentId === 'string' ? r.employmentId : '';
      if (!employmentId) return null;
      const person = roster.get(employmentId);
      const status = person ? deriveEmploymentStatus(person, today) : 'active';
      return {
        employmentId,
        name: String(r.name ?? person?.name ?? ''),
        code: person?.employeeCode ?? '',
        department: person?.department ?? '',
        status,
        statusLabel: tStatus(status as 'active'),
      };
    })
    .filter((r): r is EaPickerRow => r !== null);

  const heading = t(entry.labelKey as 'link_pcb2ii_en');
  const backHref = `/payroll/statutory-forms/open?form=${encodeURIComponent(entry.id)}`;

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: backHref, label: t('criteria_back') }}
        title={heading}
        description={t('eaPickPeople', { company: companyName, year })}
      />

      <Card className="overflow-hidden">
        <SectionHeader title={t('eaSelectTitle')} count={rows.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('pcb2iiSelectHint')}</p>
        <div className="px-4 py-4">
          {rows.length === 0 ? (
            /* An honest empty year beats a list of people whose statements would come out blank: this form
               declares what was DEDUCTED, and a year with no payroll behind it has nothing to declare.
               ITS OWN MESSAGE, not the EA's — `eaNoneForYear` says "there is no EA statement to produce",
               which is the wrong document's name on this screen. Caught by the render check, which is the
               only place a reused key that TYPECHECKS reveals itself. */
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('pcb2iiNoneForYear', { company: companyName, year })}
            </p>
          ) : (
            <EaEmployeePicker
              rows={rows}
              action="/payroll/statutory-forms/pcb2ii/download"
              hidden={[
                { name: 'companyId', value: companyId },
                { name: 'year', value: year },
                ...(lang ? [{ name: 'lang', value: lang }] : []),
              ]}
              strings={{
                searchName: t('eaSearchName'),
                searchNamePlaceholder: t('eaSearchNamePlaceholder'),
                searchCode: t('eaSearchCode'),
                searchCodePlaceholder: t('eaSearchCodePlaceholder'),
                selectAll: t('eaSelectAll'),
                clear: t('eaClear'),
                selectedTemplate: t('eaSelectedCount', { count: '{count}' }),
                generate: t('eaGenerate'),
                colSelect: t('eaColSelect'),
                colCode: t('eaColCode'),
                colName: t('colEmployee'),
                colDepartment: t('eaColDepartment'),
                colStatus: t('colStatus'),
                noMatch: t('eaNoMatch'),
                tooMany: t('eaTooMany', { max: MAX_EA_SELECTION }),
              }}
            />
          )}
        </div>
      </Card>
    </div>
  );
}
