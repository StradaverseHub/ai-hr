import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { complianceWorklist, listReports, listStatutoryLinks, submissionDueFor } from '@/core/reporting';
import type { StatutoryBodyKey } from '@/localization/country-pack';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';

/**
 * Payroll → Statutory Forms: the shelf, by the authority you file with (6babf4f6, redesigning 956cec85).
 *
 * THE REQUEST'S PREMISE IS WRONG, AND THE SCREEN SAYS SO BY WHAT IT DOES NOT DRAW. The item asks for a
 * redesign on the grounds that "the current module contains the required functionality" — it does not.
 * The pack registers FIVE reports (my.contributions, my.cp39, my.epf, my.socso-eis, my.cp8d) plus the
 * per-employee EA and the CP22/CP22A worklist. Borang BBCB, PERKESO 8B, SIP 2 / 2A, TP3, PCB 2(II),
 * CP21, CP39A and every Other-Statutory report on the reporter's list were NEVER BUILT. A greyed-out row
 * for each would read as broken software rather than as an unbuilt form, so there are none: the catalog's
 * five are the five, and the Other shelf says plainly that nothing is filed there yet.
 *
 * WHAT WAS ACTUALLY WRONG. The forms were one flat list; nothing said which authority a form belonged to
 * unless you read across to "Submitted to"; and "Open form" took you OFF this screen to the general
 * Reports page, beside a dropdown of every other report and a generation history — so getting to the
 * next form meant starting again. That is what the shelves and the per-form screen fix.
 *
 * STILL GENERATES NOTHING. This page calls `listReports`, `listStatutoryLinks`, `submissionDueFor` and
 * the CP22/CP22A worklist — metadata and lifecycle dates. The figures live one click away on
 * `[formId]`, which calls the SHARED generator. A second generator for the same statutory figures is the
 * duplication 241817ef spent two rounds undoing, and test/statutory-forms-page.test.ts pins that.
 *
 * DRIVEN OFF THE CATALOG, WHICH IS THE SCALABILITY THE REPORTER ASKED FOR. A form appears on a shelf
 * because it declares `submission.body`, not because this file names it. Build the next form, declare
 * its body, and it turns up here with its own deadline and its own buttons — no edit to this screen.
 */

/**
 * The shelves, in the reporter's own order — and the ONE place that order lives.
 *
 * A `Record` keyed by the union rather than an array, deliberately: add a body to `StatutoryBodyKey` and
 * tsc fails HERE until the shelf has a heading, instead of the new authority's forms silently vanishing
 * from a page that renders only the bodies it happens to list.
 */
const BODY_SHELVES: Record<StatutoryBodyKey, true> = { epf: true, perkeso: true, lhdn: true, other: true };
const BODY_ORDER = Object.keys(BODY_SHELVES) as StatutoryBodyKey[];

const STATUS_CLS: Record<string, string> = {
  overdue: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  due_soon: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  upcoming: 'bg-muted text-muted-foreground',
  unknown: 'bg-muted text-muted-foreground',
};
const WL_STATUS: Record<string, string> = {
  overdue: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  due_soon: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  upcoming: 'bg-muted text-muted-foreground',
};

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/** Default to the month just ENDED — the one whose submission is actually open. */
function previousMonth(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export default async function StatutoryFormsPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string;
    periodKey?: string;
    year?: string;
    month?: string;
    body?: string;
    error?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  // d3a9383c — the CP22 document's own labels. Its own namespace rather than more keys on this screen's:
  // they describe a FORM, and CP22A will want the same set when it is built.
  const tCp22 = await getTranslations('payroll.cp22');
  const locale = await getLocale();
  // Month NAMES, in the viewer's language, from Intl rather than twelve translated keys per locale —
  // the same `Intl.DateTimeFormat(locale, …)` the roster and scheduled-actions screens use. UTC so a
  // month cannot shift by one in a negative-offset render.
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const sp = await searchParams;
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt);
  const companyId = sp.companyId || companies[0]?.id || '';
  const today = todayInKualaLumpur();

  // The month is now two selects, but `periodKey` is still ACCEPTED: links to this screen exist in the
  // wild (the nav, bookmarks, the CP22 shelf entry), and a redesign that quietly stops resolving them
  // turns every one of those into the default month without saying so.
  const fallback = /^\d{4}-\d{2}$/.test(sp.periodKey ?? '') ? sp.periodKey! : previousMonth(today);
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : fallback.slice(0, 4);
  const month = MONTHS.includes(sp.month as (typeof MONTHS)[number]) ? sp.month! : fallback.slice(5, 7);
  const periodKey = `${year}-${month}`;
  // Six years back plus the current one, and ALWAYS the selected year — a link carrying an older year
  // would otherwise resolve correctly while the select silently displayed a different one.
  const years = yearOptions(today, year);
  const activeBody = BODY_ORDER.includes(sp.body as StatutoryBodyKey) ? (sp.body as StatutoryBodyKey) : null;

  // Only the pack entries that ARE submissions. The monthly contributions overview has no `submission`
  // and is correctly absent here: it is an internal reconciliation view, not a form anybody files.
  const all = companyId ? await listReports(s, companyId) : [];
  const submissions = all.filter((r) => r.submission != null);
  const links = companyId ? await listStatutoryLinks(s, companyId) : [];
  const worklist = companyId ? await complianceWorklist(s, { companyId }) : [];
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';

  const qs = `companyId=${encodeURIComponent(companyId)}&year=${year}&month=${month}`;
  const formHref = (reportId: string, kind: 'month' | 'year' | 'event') =>
    kind === 'year'
      ? `/payroll/statutory-forms/${encodeURIComponent(reportId)}?companyId=${encodeURIComponent(companyId)}&year=${year}`
      : `/payroll/statutory-forms/${encodeURIComponent(reportId)}?${qs}`;
  const linkHref = (href: string) =>
    href.replace('{companyId}', encodeURIComponent(companyId)).replace('{year}', year);

  const shelves = BODY_ORDER.filter((b) => activeBody == null || b === activeBody).map((body) => ({
    body,
    forms: submissions.filter((r) => r.submission!.body === body),
    links: links.filter((l) => l.body === body),
  }));

  return (
    // c002b3c3 — the house full-width value, the same one Personnel, Leave and the Payroll dashboard use.
    // The reporter's "the page layout does not fully utilize the available screen width", answered.
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-4">
          {activeBody && <input type="hidden" name="body" value={activeBody} />}
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

      {/* Plain links, not a client filter: the chosen shelf is then in the address, so it survives a
          refresh and can be sent to somebody. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('selectBody')}</span>
        <Link
          href={`/payroll/statutory-forms?${qs}`}
          className={`rounded-full border px-3 py-1 text-sm ${
            activeBody == null ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:bg-accent'
          }`}
        >
          {t('allBodies')}
        </Link>
        {BODY_ORDER.map((b) => (
          <Link
            key={b}
            href={`/payroll/statutory-forms?${qs}&body=${b}`}
            className={`rounded-full border px-3 py-1 text-sm ${
              activeBody === b ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:bg-accent'
            }`}
          >
            {t(`body_${b}` as 'body_epf')}
          </Link>
        ))}
      </div>

      {companyId && all.length === 0 && (
        <Card>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noneForCountry')}</p>
        </Card>
      )}

      {shelves.map(({ body, forms, links: shelfLinks }) => (
        <Card key={body} className="overflow-hidden">
          <SectionHeader title={t(`body_${body}` as 'body_epf')} count={forms.length + shelfLinks.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">{t(`body_${body}_hint` as 'body_epf_hint')}</p>

          {forms.length === 0 && shelfLinks.length === 0 ? (
            /* An honest empty shelf beats a row that opens nothing. Nothing is filed with this body yet;
               when a form for it is built it declares its body and appears here on its own. */
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('shelfEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {forms.map((r) => {
                const annual = r.periodKind === 'year';
                // `submissionDueFor` only models a monthly deadline (day N of the month AFTER the
                // period), so a YEAR period correctly comes back "unknown" — which is the honest
                // answer for the annual Form E, whose real statutory date was never stated to us. An
                // invented deadline is worse than an absent one: somebody files against it.
                const due = submissionDueFor(
                  annual ? year : periodKey,
                  r.submission!.dueDayOfNextMonth,
                  today,
                );
                return (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium">{r.label}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t(`cadence_${r.cadence}` as 'cadence_monthly')} · {r.submission!.channel}
                        {annual ? ` · ${year}` : ` · ${periodKey}`}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {due.dueBy && (
                        <span className="font-mono text-xs text-muted-foreground">
                          {t('dueByShort', { date: due.dueBy })}
                        </span>
                      )}
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLS[due.status]}`}
                      >
                        {t(`status_${due.status}` as 'status_upcoming')}
                      </span>
                      <Link href={formHref(r.id, r.periodKind)} className="text-primary hover:underline">
                        {t('openForm')}
                      </Link>
                    </div>
                  </li>
                );
              })}
              {/* Catalog entries that are not generatable reports (the per-employee EA, the CP22/CP22A
                  worklist). Rendered from the SAME data as the forms above — this screen used to
                  hardcode the EA row, which is why it had to be edited whenever the catalog moved. */}
              {shelfLinks.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{t(l.labelKey as 'link_ea')}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t(`cadence_${l.cadence}` as 'cadence_monthly')} · {t(l.hintKey as 'link_ea_hint')}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {/* d3a9383c — a second action, when the catalog entry declares one (today: the blank
                        fillable CP22). Rendered from the SAME data as the action beside it. */}
                    {l.secondaryHref && l.secondaryLabelKey && (
                      <Link
                        href={linkHref(l.secondaryHref)}
                        title={tCp22('blankTitle')}
                        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                      >
                        {t(l.secondaryLabelKey as 'link_cp22_blank')}
                      </Link>
                    )}
                    {/* The row's OWN action wording when it declares one — the CP22 row scrolls to the
                        worklist, it does not open a form. Every other row falls back to the shared label. */}
                    <Link href={linkHref(l.href)} className="text-primary hover:underline">
                      {t((l.actionLabelKey ?? 'openForm') as 'openForm')}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}

      {/* CP22 / CP22A live HERE now, not on Reports: they are LHDN statutory notices, and this is where
          somebody looking for a statutory form goes. Driven by the hire/termination lifecycle rather than
          a payroll period, which is why they are a worklist and not a form you pick a month for. */}
      <Card id="worklist" data-tour="payroll-worklist" className="scroll-mt-6 overflow-hidden">
        <SectionHeader title={t('worklistTitle')} count={worklist.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {t('worklistDescription', { company: companyName })}
        </p>
        {worklist.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('worklistEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-4 py-2 font-medium">{t('colForm')}</th>
                  <th className="px-4 py-2 font-medium">{t('colReason')}</th>
                  <th className="px-4 py-2 font-medium">{t('colEventDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('colNotifyBy')}</th>
                  <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                  {/* d3a9383c — the document itself. Headed for screen readers only: the mockup the
                      reporter approved shows the buttons under no visible heading. */}
                  <th className="px-4 py-2 font-medium">
                    <span className="sr-only">{tCp22('columnHeading')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {worklist.map((w) => (
                  <tr key={`${w.employmentId}-${w.form}`}>
                    <td className="px-4 py-2.5 font-medium">{w.name}</td>
                    <td className="px-4 py-2.5">{w.form}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{w.reason}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{w.eventDate}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{w.dueBy}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${WL_STATUS[w.status]}`}
                      >
                        {t(`status_${w.status}` as 'status_upcoming')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {/* CP22 ONLY. The CP22A leaver notice is a later round and this row says so plainly
                          rather than offering a button that would download the wrong form. */}
                      {w.form === 'CP22' ? (
                        <Link
                          href={`/payroll/cp22/${w.employmentId}/pdf`}
                          title={tCp22('downloadTitle')}
                          className="inline-flex rounded-md border border-border px-2.5 py-1 text-xs font-medium text-primary hover:bg-accent"
                        >
                          {tCp22('download')}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground" title={tCp22('cp22aNotYet')}>
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
