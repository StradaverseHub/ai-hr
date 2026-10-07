import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { complianceWorklist, listStatutoryCatalog } from '@/core/reporting';
import { Card, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { Field } from '@/components/monolith/field';
import { MONO_LABEL, MONO_UNDERLINE_FIELD as MONO_FIELD } from '@/components/monolith/classes';
import { EventCompanySelect } from './company-select';
import { EVENT_CONTINUE, EVENT_SCREEN, eventLinkOf, eventRefusalFrom } from './shared';

/**
 * r413 (item 79f3f64d, step 2) — FORMS ABOUT ONE PERSON: CHOOSE THE COMPANY, THEN THE PERSON.
 *
 * The approved plan: "choose the Company, then pick the employee from a list of people who recently joined
 * or are about to leave, with a name search, then preview and download". CP22 (a new employee) and CP22A
 * (an employee leaving) both open here; their shelf entries declare `event` and this screen reads it, so
 * it names no form (`?form=` is resolved against the catalog the admin's own company scope reaches).
 *
 * THE LIST IS THE COMPLIANCE WORKLIST, NARROWED, NOT A SECOND READ. `complianceWorklist` with `form` (and
 * the name search) — the same window, due dates and statuses as the worklist at the foot of the directory,
 * so the two can never list different people for the same form.
 *
 * IT PRODUCES NOTHING. Two GET forms: the filters re-list this screen; Continue goes to a handler that
 * redirects to the form's own preview (CP22's review screen, unchanged; CP22A's viewer). Nobody chosen
 * brings the operator back here with the refusal in words, and an empty list says why it is empty and
 * offers no Continue — no blank form is produced.
 *
 * GATED like the directory: `scopedAdmin`, an out-of-scope company is never listed or honoured, and the
 * list is RLS-read. It shows names and leaving/joining dates, so it is registered in the function-access
 * matrix on the Statutory Forms key (lib/permissions.ts).
 */
export const dynamic = 'force-dynamic';

const STATUS_CLS = {
  overdue: 'text-red-700 dark:text-red-400 monolith:text-signal-text',
  due_soon: 'text-foreground monolith:text-ink',
  upcoming: 'text-muted-foreground monolith:text-mid',
  on_notice: 'text-foreground monolith:text-ink',
} as const;

export default async function EventSelectPage({
  searchParams,
}: {
  searchParams: Promise<{ form?: string; companyId?: string; q?: string; refusal?: string }>;
}) {
  const sp = await searchParams;
  const formId = sp.form ?? '';
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.eventSelect');
  const tf = await getTranslations('payroll.statutoryForms');

  const catalog = await listStatutoryCatalog(s, scopeIds);
  const link = eventLinkOf(catalog.links, formId);
  if (!link) notFound();

  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  const companyId = sp.companyId && companies.some((c) => c.id === sp.companyId) ? sp.companyId : (companies[0]?.id ?? '');
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const q = (sp.q ?? '').slice(0, 100).trim();
  const rows = companyId ? await complianceWorklist(s, { companyId, form: link.event.form, nameQuery: q }) : [];
  const refusal = eventRefusalFrom(sp.refusal);

  // The form's own short name, as the mockup heads the screen ("CP22A — choose the employee"); the full
  // catalog title is the shelf card's.
  const formName = link.event.form;
  // dd/mm/yyyy, as the mockup and LHDN's own forms write a date — never the viewer locale's month-first order.
  const human = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const isLeaving = link.event.form === 'CP22A';
  const backHref = '/payroll/statutory-forms';

  return (
    <div className={pageWideCls}>
      <div className="space-y-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground monolith:border-b monolith:border-ink monolith:text-ink"
        >
          ← {t('back')}
        </Link>
        <p className={`text-xs uppercase tracking-wide text-muted-foreground ${MONO_LABEL}`}>{t('eyebrow')}</p>
        <h1 data-event-title className="text-xl font-semibold tracking-tight monolith:text-[28px] monolith:font-medium">
          {t('title', { form: formName })}
        </h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <Card className="overflow-hidden">
        {/* FILTERS — re-list this screen. Company submits on change; Search for the name box. */}
        <form
          method="get"
          action={EVENT_SCREEN}
          className="grid gap-4 border-b border-border px-4 py-4 sm:grid-cols-2 monolith:border-ink monolith:px-0"
        >
          <input type="hidden" name="form" value={formId} />
          <Field label={t('company')}>
            <EventCompanySelect
              name="companyId"
              value={companyId}
              options={companies.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Field label={t('search')} className="min-w-0 flex-1">
              <input
                type="search"
                name="q"
                defaultValue={q}
                maxLength={100}
                placeholder={t('searchPlaceholder')}
                className={`${inputCls} ${MONO_FIELD}`}
              />
            </Field>
            <button className="h-9 shrink-0 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-ink">
              {t('searchButton')}
            </button>
          </div>
        </form>

        {/* THE PEOPLE, AND CONTINUE. */}
        <form method="get" action={EVENT_CONTINUE} className="space-y-4 px-4 py-4 monolith:px-0">
          <input type="hidden" name="form" value={formId} />
          <input type="hidden" name="companyId" value={companyId} />
          {q && <input type="hidden" name="q" value={q} />}
          <p className="text-xs text-muted-foreground">{t(isLeaving ? 'windowCP22A' : 'windowCP22')}</p>

          {rows.length === 0 ? (
            <p data-event-empty className="py-6 text-center text-sm text-muted-foreground">
              {q ? t('emptySearch', { q }) : t(isLeaving ? 'emptyCP22A' : 'emptyCP22', { company: companyName })}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm sm:min-w-[36rem]">
                <thead className={`border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground monolith:border-ink ${MONO_LABEL}`}>
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('colName')}</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">{t('colEvent')}</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">{t('colEventDate')}</th>
                    <th className="px-3 py-2 font-medium">{t('colDueBy')}</th>
                    <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('colSelect')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border monolith:divide-hairline">
                  {rows.map((w, i) => {
                    const id = `event-pick-${w.employmentId}`;
                    return (
                      <tr key={`${w.employmentId}-${w.form}`} data-event-row>
                        <td className="px-3 py-3 font-medium">
                          <label htmlFor={id} className="cursor-pointer">
                            {w.name}
                          </label>
                        </td>
                        <td className="hidden px-3 py-3 sm:table-cell">{t(isLeaving ? 'event_CP22A' : 'event_CP22')}</td>
                        <td className="hidden px-3 py-3 font-mono text-xs tabular-nums sm:table-cell">{human(w.eventDate)}</td>
                        <td className="px-3 py-3 font-mono text-xs tabular-nums">
                          {/* A death's deadline runs from when the employer is TOLD, which is not recorded: no date, and why. */}
                          {w.dueBy ? human(w.dueBy) : <span data-due-on-notice className="font-sans">{tf('dueOnNotice')}</span>}
                        </td>
                        <td className={`px-3 py-3 font-mono text-xs uppercase tracking-wide ${STATUS_CLS[w.status]}`}>
                          {tf(`status_${w.status}` as 'status_upcoming')}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <input
                            id={id}
                            type="radio"
                            name="employmentId"
                            value={w.employmentId}
                            defaultChecked={rows.length === 1 && i === 0}
                            aria-label={t('selectLabel', { name: w.name })}
                            className="h-5 w-5 cursor-pointer accent-primary monolith:accent-ink"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {refusal && (
            <p
              role="alert"
              data-event-refusal={refusal}
              className="border-l-2 border-red-600 pl-3 text-sm text-red-700 dark:border-red-400 dark:text-red-400 monolith:border-signal monolith:text-signal-text"
            >
              {t(`refusal_${refusal}`)}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4 monolith:border-hairline">
            <Link
              href={backHref}
              className="h-9 rounded-md px-3 text-sm leading-9 text-muted-foreground hover:text-foreground monolith:h-auto monolith:rounded-none monolith:border-b monolith:border-ink monolith:px-0.5 monolith:leading-normal monolith:text-ink"
            >
              {t('cancel')}
            </Link>
            <button
              data-event-continue
              disabled={rows.length === 0}
              className={`${btnPrimary} disabled:cursor-not-allowed disabled:opacity-50 monolith:h-11 monolith:rounded-full monolith:bg-ink monolith:px-5 monolith:text-bone`}
            >
              {t('continue')}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
