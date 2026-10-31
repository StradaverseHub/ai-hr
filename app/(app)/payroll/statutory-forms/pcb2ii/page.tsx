import Link from 'next/link';
import { validPcb2iiSelectedDate } from '@/lib/pcb2ii-form';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listStatutoryCatalog, reportPreview } from '@/core/reporting';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { Card, PageHeader, SectionHeader, btnGhost, pageWideCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
// THE PICKER IS SHARED, NOT FORKED. `EaEmployeePicker` is form-agnostic — rows, a destination href,
// hidden fields and pre-translated strings — and its `Ea` prefix is historical: it was written for the
// C.P.8A and is the second screen to use it, not a second copy of it. A lookalike picker here would be
// the "six slightly different employee pickers" this repo keeps consolidating away from (r320).
import { EaEmployeePicker, type EaPickerRow } from '../ea/employee-picker';
import { defaultVersion } from '../criteria';
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
 * are produced by `download/route.ts` when the button is pressed, or by `preview/route.ts` when the
 * Preview button is — the SAME document, served `inline` so the browser opens it instead of saving it.
 * r328 added the second button; both go through `./shared.ts`, so there is one gate and one renderer.
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
  searchParams: Promise<{ companyId?: string; year?: string; lang?: string; selectedDate?: string; id?: string | string[]; error?: string; field?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  const tStatus = await getTranslations('people.employeeStatus');
  const sp = await searchParams;

  const catalog = await listStatutoryCatalog(s, scopeIds);
  // The shelf entry that owns this screen — matched on its DESTINATION, so no report id and no entry id is
  // written down here. r402 (item f3cf2444): there is ONE entry per form now, and the language is its
  // Version, so the entry is no longer narrowed by `lang`.
  const entry = catalog.links.find((l) => l.href.startsWith('/payroll/statutory-forms/pcb2ii?')) ?? null;
  if (!entry) notFound();
  // `lang` is allowlisted twice — by this screen's own list and by the entry's declared versions — and an
  // absent or unknown one becomes the entry's FIRST version (English), never the viewer's UI language.
  const lang = defaultVersion(
    entry.versions,
    PCB2II_LANGS.includes(sp.lang as Pcb2iiPageLang) ? sp.lang : undefined,
  ) as Pcb2iiPageLang;
  const versionLabelKey = entry.versions?.find((v) => v.value === lang)?.labelKey;

  // An out-of-scope companyId in the URL is treated as absent rather than honoured.
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : '';
  if (!companyId || !year) redirect(`/payroll/statutory-forms/open?form=${encodeURIComponent(entry.id)}&lang=${lang}`);

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

  const selectedDate = validPcb2iiSelectedDate(sp.selectedDate) ? sp.selectedDate : '';
  const preparationError = ['selectedDate', 'signatory', 'fit'].includes(sp.error ?? '') ? sp.error : null;
  const fitFields: Record<string, string> = {
    employeeName: t('pcb2iiField_employeeName'),
    identifier: t('pcb2iiField_identifier'),
    officerName: t('pcb2iiField_officerName'),
    officerDesignation: t('pcb2iiField_officerDesignation'),
    phone: t('pcb2iiField_phone'),
    employerNameAddress: t('pcb2iiField_employerNameAddress'),
    receiptRef: t('pcb2iiField_receiptRef'),
    amount: t('pcb2iiField_amount'),
    branch: t('pcb2iiField_branch'),
    date: t('pcb2iiField_date'),
    details: t('pcb2iiField_details'),
  };
  const fitFieldKey = sp.field ?? 'details';
  const fitField = Object.hasOwn(fitFields, fitFieldKey) ? fitFields[fitFieldKey] : fitFields.details;
  // r402 — the merged entry's name plus the Version chosen.
  const heading = versionLabelKey
    ? `${t(entry.labelKey as 'link_pcb2ii')} · ${t(versionLabelKey as 'version_en')}`
    : t(entry.labelKey as 'link_pcb2ii');
  const backHref = `/payroll/statutory-forms/open?form=${encodeURIComponent(entry.id)}&lang=${lang}`;
  // r402 — coming BACK from the in-app viewer: the ticked people ride in the URL as `id`, and the picker
  // starts with them ticked. Only ids that are in this year's population survive, so a hand-edited URL
  // cannot tick somebody the list does not offer.
  const asked = new Set(Array.isArray(sp.id) ? sp.id : sp.id ? [sp.id] : []);
  const initialSelected = rows.filter((r) => asked.has(r.employmentId)).map((r) => r.employmentId);
  /* r331 (72b100cd) — THE DOOR TO THE RECEIPTS SCREEN, and it is here because this is the form that
     PRINTS them. Section 2 of PCB 2(II) reports, per month, the receipt / bank slip / transaction number
     and the payment date; until r331 the only place to key one was the bottom of the CP39 screen for one
     month at a time, so an operator maintaining a fact THIS form prints had to know to go to a different
     form to do it. The company and year travel with the link (and `lang`, so coming back lands on the
     same language's entry) — the receipts screen would otherwise default to a company and a year that
     are not the ones being looked at here. */
  const receiptsHref = `/payroll/statutory-forms/pcb2ii/receipts?companyId=${encodeURIComponent(companyId)}&year=${encodeURIComponent(year)}${lang ? `&lang=${lang}` : ''}${selectedDate ? `&selectedDate=${encodeURIComponent(selectedDate)}` : ''}`;

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: backHref, label: t('criteria_back') }}
        actions={rows.length === 0 ?
          <Link href={receiptsHref} className={btnGhost}>
            {t('pcb2iiReceiptsLink')}
          </Link> : undefined
        }
        title={heading}
        /* ⚠️ ITS OWN SENTENCE, NOT THE EA'S — r328. `eaPickPeople` reads "tick the people whose EA you
           need", which is the WRONG statutory document's name on the PCB 2(II) screen. Third instance of
           the same defect on this one page (the button and the empty state were the others), and the
           reason the empty state got its own key in r323 in the first place. */
        description={t('pcb2iiPickPeople', { company: companyName, year })}
      />

      {preparationError && <p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">{t(preparationError === 'selectedDate' ? 'pcb2iiDateInvalid' : preparationError === 'signatory' ? 'pcb2iiSignatoryMissing' : 'pcb2iiFitRefused', { field: fitField })}</p>}
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
              selectedDateField={{label: t('pcb2iiSelectedDate'), value: selectedDate, help: t('pcb2iiDateHelp'), receiptsHref: `/payroll/statutory-forms/pcb2ii/receipts?companyId=${encodeURIComponent(companyId)}&year=${encodeURIComponent(year)}${lang ? `&lang=${lang}` : ''}`, receiptsLabel: t('pcb2iiReceiptsLink')}}
              action="/payroll/statutory-forms/pcb2ii/download"
              previewAction="/payroll/statutory-forms/pcb2ii/view"
              initialSelected={initialSelected}
              hidden={[
                { name: 'companyId', value: companyId },
                { name: 'year', value: year },
                { name: 'lang', value: lang },
              ]}
              strings={{
                searchName: t('eaSearchName'),
                searchNamePlaceholder: t('eaSearchNamePlaceholder'),
                searchCode: t('eaSearchCode'),
                searchCodePlaceholder: t('eaSearchCodePlaceholder'),
                selectAll: t('eaSelectAll'),
                clear: t('eaClear'),
                selectedTemplate: t('eaSelectedCount', { count: '{count}' }),
                /* ⚠️ THE BUTTON NAMES THIS FORM, NOT THE EA'S. r323 passed `eaGenerate` here, which reads
                   "Generate C.P.8A (EA)" — the WRONG statutory document's name on the PCB 2(II) screen,
                   the same defect this file's empty state already refuses two blocks down. Both keys are
                   PCB 2(II)'s own now. It says DOWNLOAD because that is what the button does: the route
                   answers `Content-Disposition: attachment`. */
                generate: t('pcb2iiGenerate'),
                preview: t('pcb2iiPreview'),
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
