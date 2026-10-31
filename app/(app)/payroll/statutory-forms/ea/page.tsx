import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listStatutoryCatalog, reportPreview } from '@/core/reporting';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { Card, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { EaEmployeePicker, type EaPickerRow } from './employee-picker';
import { defaultVersion } from '../criteria';
import { MAX_EA_SELECTION } from './limits';

/**
 * r256 (item 858a1128) — THE C.P.8A (EA)'s SECOND STEP: pick the people, then generate.
 *
 * WHAT THE REPORTER ASKED FOR, AND WHY THE EA IS THE ONE FORM THAT NEEDED ITS OWN SCREEN. Every other
 * entry on the statutory shelf produces ONE document for a company and a period. An EA does not: it is one
 * statement per employee, so "the EA for ABC Sdn Bhd 2026" is forty documents. The old route asked for a
 * Payroll Month the annual form does not use, then landed on the CP8D figures table with the employee
 * names turned into links — a table of numbers standing in for a list of people. The flow is now the two
 * steps the reporter described: company + year (no month, on `open/page.tsx`), then this.
 *
 * ⚠️ IT GENERATES NOTHING ON ARRIVAL. This page reads the year's population and renders a list. The forms
 * are produced by `download/route.ts` when the button is pressed, which is the whole point of the round:
 * the operator chooses the form, then the criteria, then the people, and only then is anything made.
 *
 * THE POPULATION IS THE PACK'S, NOT THIS FILE'S. The EA rows in the catalog declare `populationReportId`
 * (`my.cp8d` for Malaysia) and this screen resolves it — the EA population IS the CP8D population, one row
 * per employee for the tax year, which is the fact the rows' old hrefs encoded by pointing straight at that
 * report. Hardcoding the id here would be the app naming one jurisdiction's report, which is exactly what
 * the catalog exists to prevent. A company whose jurisdiction registers no such row 404s rather than
 * rendering an empty list under an EA heading.
 *
 * ⚠️ AND THE POPULATION IS DELIBERATELY NOT "EVERY EMPLOYEE". Only somebody with payroll behind them in
 * that year has an EA to produce; offering the rest would hand an operator a statement with nothing on it
 * under a tax document's name (AGENTS 28: a control that produces a confidently wrong artefact is worse
 * than an absent one). The employee ID, department and status beside each name come from the personnel
 * read, joined on the employment — the CP8D row carries a name and an id and has no column for them.
 *
 * ARRIVING WITH NOTHING CHOSEN IS NOT AN ERROR — IT IS THE FIRST STEP. A bare `/payroll/statutory-forms/ea`
 * (a bookmark from before the criteria existed, or a hand-typed URL) redirects to this entry's own criteria
 * step rather than 404ing, and the entry it redirects to is found by MATCHING THE CATALOG HREF, so the id
 * stays in the pack here too.
 *
 * `lang` IS ALLOWLISTED AND CARRIED, NEVER ECHOED. It rides from the shelf row through the criteria step to
 * the download route, which allowlists it a second time — LHDN accepts the C.P.8A in English or Bahasa
 * Malaysia, and which one you asked for must not become "whatever the screen was set to".
 */
const EA_LANGS = ['en', 'ms'] as const;
type EaLang = (typeof EA_LANGS)[number];

export default async function EaEmployeeSelectionPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; year?: string; lang?: string; id?: string | string[] }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  // The status badges' words, from the namespace that already owns them in all six locales — a second
  // set of "Active / Resigned" keys on this screen would be the same six strings twice.
  const tStatus = await getTranslations('people.employeeStatus');
  const sp = await searchParams;

  const catalog = await listStatutoryCatalog(s, scopeIds);
  // The shelf entry that owns this screen — matched on its DESTINATION, so no report id and no entry id is
  // written down here. r402 (item f3cf2444): there is ONE entry per form now, and the language is its
  // Version, so the entry is no longer narrowed by `lang`.
  const entry = catalog.links.find((l) => l.href.startsWith('/payroll/statutory-forms/ea?')) ?? null;
  if (!entry) notFound();
  // `lang` is allowlisted twice — by this screen's own list and by the entry's declared versions — and an
  // absent or unknown one becomes the entry's FIRST version (English), never the viewer's UI language.
  const lang = defaultVersion(
    entry.versions,
    EA_LANGS.includes(sp.lang as EaLang) ? sp.lang : undefined,
  ) as EaLang;
  const versionLabelKey = entry.versions?.find((v) => v.value === lang)?.labelKey;

  // An out-of-scope companyId in the URL is treated as absent rather than honoured — the same rule the
  // export route and `[formId]` apply, so the three cannot disagree about who may reach a company.
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : '';
  if (!companyId || !year) redirect(`/payroll/statutory-forms/open?form=${encodeURIComponent(entry.id)}&lang=${lang}`);

  const reportId = entry.populationReportId;
  // An entry with no declared population cannot list anybody, and a jurisdiction that registers no such
  // report is not one this screen can serve. One 404 for both, so the URL cannot be used to enumerate
  // which packs register what.
  if (!reportId || !catalog.reports.some((r) => r.id === reportId)) notFound();

  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const today = todayInKualaLumpur();

  // The SHARED generator, resolved through the same seam every other statutory screen uses. No second
  // implementation of the year population lives here — 241817ef spent two rounds undoing exactly that.
  const population = await reportPreview(s, { companyId, reportId, periodKey: year });
  const roster = new Map((await listEmployees(s, [companyId])).map((e) => [e.employmentId, e]));

  const rows: EaPickerRow[] = population.rows
    .map((r): EaPickerRow | null => {
      // `ReportRow` is `Record<string, string | number | null>`, so the id is narrowed here rather than
      // asserted: a row without one is dropped, never rendered as a checkbox that submits "null".
      const employmentId = typeof r.employmentId === 'string' ? r.employmentId : '';
      if (!employmentId) return null;
      const person = roster.get(employmentId);
      // THE WHOLE ROW, not one field of it. Handing the deriver `{ terminatedOn }` alone left four of its
      // six buckets unreachable — a probationer, a blacklisted employment, a recorded resignation with no
      // termination date and a last working day ALL printed "Active" here while Personnel said otherwise
      // about the same person on the same day. `listEmployees` now carries the full lifecycle set, and this
      // reads it the way every other status badge in the product does.
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

  // r402 — the merged entry's name plus the Version chosen, so the operator can see which language
  // they are about to produce.
  const heading = versionLabelKey
    ? `${t(entry.labelKey as 'link_ea')} · ${t(versionLabelKey as 'version_en')}`
    : t(entry.labelKey as 'link_ea');
  const backHref = `/payroll/statutory-forms/open?form=${encodeURIComponent(entry.id)}&lang=${lang}`;
  // r402 — coming BACK from the in-app viewer: the ticked people ride in the URL as `id`, and the picker
  // starts with them ticked. Only ids that are in this year's population survive, so a hand-edited URL
  // cannot tick somebody the list does not offer.
  const asked = new Set(Array.isArray(sp.id) ? sp.id : sp.id ? [sp.id] : []);
  const initialSelected = rows.filter((r) => asked.has(r.employmentId)).map((r) => r.employmentId);

  return (
    // 152fea7f — `pageWideCls`, the Payroll module's one full-width container. This screen is a TABLE of
    // people with five columns and a search over it, which is exactly the shape that round widened; a cap
    // here would put the tick box at one edge of a wide monitor and the status at the other.
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: backHref, label: t('criteria_back') }}
        title={heading}
        /* r256 — `eaPickPeople`, not `eaPickPerson`: the CP8D arrival on `[formId]` still says "choose a
           person" because that list opens ONE statement per click, and this screen ticks many. Two
           sentences because they describe two different actions; rewording the old one would have made it
           wrong on the screen that still uses it. */
        description={t('eaPickPeople', { company: companyName, year })}
      />

      <Card className="overflow-hidden">
        <SectionHeader title={t('eaSelectTitle')} count={rows.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('eaSelectHint')}</p>
        <div className="px-4 py-4">
          {rows.length === 0 ? (
            /* An honest empty year beats a list of people whose statements would come out blank. The EA
               covers what payroll paid; a year with no payroll behind it has no statement to produce, and
               saying so names the fix (run the year's payroll) rather than offering a download. */
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('eaNoneForYear', { company: companyName, year })}
            </p>
          ) : (
            <EaEmployeePicker
              rows={rows}
              action="/payroll/statutory-forms/ea/download"
              /* 2a1a6f42 (r331) — LOOK BEFORE YOU SEND. The picker has carried an optional Preview since
                 r328 and this screen passed neither prop, which made the EA the ONE form on the statutory
                 shelf that could not be looked at before it was downloaded. It passes both now. The route
                 serves the download's own bytes `inline` — see ./shared.ts, which both doors are four
                 lines over, so the preview cannot become a lighter gate onto the same tax figures. */
              previewAction="/payroll/statutory-forms/ea/view"
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
                // Kept as a template on purpose — the count changes with every tick, on the client.
                selectedTemplate: t('eaSelectedCount', { count: '{count}' }),
                generate: t('eaGenerate'),
                // 2a1a6f42 (r331) — the second submit's label. Its own key, not `pcb2iiPreview`: a screen
                // that borrows a string named after another statutory document is the defect r328 fixed in
                // the other direction, and this one is a plain verb in all six locales.
                preview: t('eaPreview'),
                colSelect: t('eaColSelect'),
                colCode: t('eaColCode'),
                colName: t('colEmployee'),
                colDepartment: t('eaColDepartment'),
                colStatus: t('colStatus'),
                noMatch: t('eaNoMatch'),
                // Interpolated HERE, on the server: the ceiling is a constant, unlike the running count.
                tooMany: t('eaTooMany', { max: MAX_EA_SELECTION }),
              }}
            />
          )}
        </div>
      </Card>
    </div>
  );
}
