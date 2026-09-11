import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listHolidays, listHolidayYears } from '@/core/admin';
import { Badge, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { rowActionCls, rowActionMutedCls, rowActionsCls } from '@/components/settings-list';
import { HolidayTabs } from '@/components/holiday-tabs';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { Pager } from '@/components/pager';
import { deleteHolidayAction } from '../actions';
import { HolidayDialog, type HolidayDialogFilter, type HolidayDialogLabels } from './holiday-dialog';
import { holidayStatesByCountry } from './holiday-state-options';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Holiday tab (66b8f5a8, simplified 3e831868) — the centralized Holiday MASTER. One tab of the two-tab
 * Holiday module (Holiday · Holiday Group).
 *
 * 3e831868 (Holiday Master Simplification): the master keeps only the fields attendance/leave actually
 * use. Holiday Code + Description are REMOVED from the form and list (the nullable columns stay in the DB
 * for backward compatibility — the resolver never read them). The list is a compact single-row table
 * (Holiday Date · Name · National/State · Type · Status · Action) so HR sees far more holidays per screen.
 * Holiday Type value 'company' is relabelled "Replacement holiday" in i18n only — the stored value + CHECK
 * constraint are unchanged.
 *
 * def44f29 — ADD / EDIT IS A DIALOG OVER THE LIST, AND NATIONAL / STATE IS CHANGEABLE. "Add holiday" was
 * an anchor jump to a form card BELOW the paged list, and every row was an inline edit form attached by
 * `form=`; National / State was read-only text with no way to set it. The reporter asked for the form in
 * a window over the list and for National / State to be changeable. So:
 *   • The rows are READ-ONLY cells now, with Edit and Remove. Edit opens holiday-dialog.tsx pre-filled;
 *     the Add button at the top of the list opens the same dialog empty. The bottom card and the detached
 *     `form=` edit forms are gone, not hidden: two ways to edit one row is how the bottom form grows back.
 *   • The dialog is a client island (the movement-type dialog's shape, 1b87e8a0) and THIS PAGE STAYS A
 *     SERVER COMPONENT feeding it serialisable values only — strings, booleans, arrays of {value,label},
 *     never a function (test/server-client-boundary.test.ts). Every label is translated HERE.
 *   • National / State options come from the country PACK's state list (countryPacks(), the same source
 *     components/holiday-group-form.tsx uses) — never a hand-typed second copy.
 *   • Remove stays a plain row form post (deleteHolidayAction): nothing on screen to lose.
 *
 * PAGED SINCE 9da61c86. A holiday master accumulates a country's calendar year after year, so it is a
 * list of records and pages like every other one. The hidden filter fields below ride in the Remove form
 * AND in the dialog (as the `filter` prop) so both actions can return the admin to the view they were in.
 */
export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; country?: string; year?: string; page?: string; size?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.holidays');
  const sp = await searchParams;
  const { error, country: countryParam, year: yearParam } = sp;

  const [companies, years] = await Promise.all([listCompanies(s), listHolidayYears(s)]);
  const countries = [...new Set(companies.map((c) => c.country))].sort();
  const country = countryParam && countries.includes(countryParam) ? countryParam : undefined;
  const year = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : undefined;

  const holidays = await listHolidays(s, { country, year });

  // STATIC holiday-type key map (never t(`holidayType.${x}`) — the i18n coverage test requires literal keys).
  // 3e831868: 'company' now renders "Replacement holiday" (i18n-only relabel; stored value stays 'company').
  const HOLIDAY_TYPES = ['public', 'company', 'optional'] as const;
  const typeLabel: Record<(typeof HOLIDAY_TYPES)[number], string> = {
    public: t('holidayType.public'),
    company: t('holidayType.company'),
    optional: t('holidayType.optional'),
  };
  const typeOptions = HOLIDAY_TYPES.map((ty) => ({ value: ty as string, label: typeLabel[ty] }));

  const pq = parsePageQuery(sp);
  const { rows: pageRows, state: pgState } = paginateRows(holidays, pq);

  const today = todayInKualaLumpur();
  const countryOptions = countries.length ? countries : ['MY'];
  const defaultCountry = country ?? countryOptions[0];
  // def44f29 — the National / State vocabulary, per country, from the registered packs (rung 5b, D6): the
  // island lists the states of whichever country is selected. A country with no pack lists none. The
  // helper is pinned against the pack's own list by test/holiday-dialog-shape.test.ts.
  const statesByCountry = holidayStatesByCountry();

  // Hidden fields echo the active filter AND the page so actions land back in the same view. A server
  // action cannot read the address it was posted from, so anything that must survive a Save or Remove has
  // to travel in the form — see holidaysPath in app/admin/actions.ts, the other half. The Remove form
  // carries them as these hidden inputs; the dialog carries the SAME four values as its `filter` prop.
  const filterFields = (
    <>
      <input type="hidden" name="filterCountry" value={country ?? ''} />
      <input type="hidden" name="filterYear" value={year ?? ''} />
      <input type="hidden" name="filterPage" value={String(pq.page)} />
      {/* Only when the READER chose one. pq.size resolves to the default whether or not the address says
          anything, so posting it unconditionally made the first Save rewrite a bare /admin/holidays into
          ?size=25 — an address claiming a choice nobody made. The filter form above follows the same rule. */}
      {sp.size && <input type="hidden" name="filterSize" value={String(pq.size)} />}
    </>
  );
  const dialogFilter: HolidayDialogFilter = {
    country: country ?? '',
    year: year ? String(year) : '',
    page: String(pq.page),
    size: sp.size ? String(pq.size) : '',
  };
  const typeOf = (v: string | null): (typeof HOLIDAY_TYPES)[number] =>
    v && (HOLIDAY_TYPES as readonly string[]).includes(v) ? (v as (typeof HOLIDAY_TYPES)[number]) : 'public';

  /** Add and Edit differ only in their words; the dialog itself is one component. */
  const addLabels: HolidayDialogLabels = {
    title: t('addTitle'),
    hint: t('addHint'),
    name: t('nameLabel'),
    namePlaceholder: t('namePlaceholder'),
    date: t('dateLabel'),
    nationalState: t('nationalStateLabel'),
    nationalStateHint: t('nationalStateHint'),
    national: t('national'),
    scopeFixedHint: t('scopeFixedHint'),
    holidayType: t('holidayTypeLabel'),
    country: t('countryLabel'),
    active: t('activeLabel'),
    tentative: t('tentativeCreateLabel'),
    submit: t('save'),
    saving: t('saving'),
    cancel: t('cancel'),
    close: t('close'),
  };
  const editLabels: HolidayDialogLabels = { ...addLabels, title: t('editTitle'), hint: t('editHint') };

  /** A business-group / holiday-group row's scope, as the badge already shows it; null for national/state
   *  rows. Static keys only (never t(`scope.${x}`) — test/i18n-coverage.test.ts). */
  const fixedScopeOf = (h: (typeof holidays)[number]): string | null =>
    h.companyId
      ? t('scopeBadge', { label: t('scope.group'), name: h.companyName ?? '' })
      : h.holidayGroupId
        ? t('scopeBadge', { label: t('scope.holidayGroup'), name: h.holidayGroupName ?? '' })
        : null;

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <HolidayTabs active="holidays" />
      <ErrorBanner message={error} />

      {/* Filters */}
      <Card>
        <SectionHeader title={t('filtersTitle')} />
        <form method="get" className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <Field label={t('countryLabel')}>
            <select name="country" defaultValue={country ?? ''} className={inputCls}>
              <option value="">{t('allCountries')}</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('yearLabel')}>
            <select name="year" defaultValue={year ? String(year) : ''} className={inputCls}>
              <option value="">{t('allYears')}</option>
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          {/* The chosen rows-per-page survives a filter change; the PAGE deliberately does not, because
              page 4 of one country's calendar is not page 4 of another's. */}
          {sp.size && <input type="hidden" name="size" value={String(pq.size)} />}
          <div className="sm:col-span-2">
            <button className={btnPrimary}>{t('applyFilter')}</button>
          </div>
        </form>
      </Card>

      {/* Master list — compact single-row table (3e831868). Add opens the dialog over the list (def44f29). */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="text-sm font-medium">
            {t('listTitle')}
            <span className="ml-2 text-muted-foreground">({holidays.length})</span>
          </div>
          <HolidayDialog
            triggerLabel={t('addHoliday')}
            triggerClassName={btnPrimary}
            id={null}
            initial={{
              name: '',
              holidayDate: today,
              state: '',
              holidayType: 'public',
              country: defaultCountry,
              active: true,
              tentative: false,
            }}
            fixedScope={null}
            countryOptions={countryOptions}
            statesByCountry={statesByCountry}
            typeOptions={typeOptions}
            filter={dialogFilter}
            labels={addLabels}
          />
        </div>

        {holidays.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('dateLabel')}</th>
                    <th className="px-4 py-2 font-medium">{t('nameLabel')}</th>
                    <th className="px-4 py-2 font-medium">{t('nationalStateColumn')}</th>
                    <th className="px-4 py-2 font-medium">{t('holidayTypeLabel')}</th>
                    <th className="px-4 py-2 font-medium">{t('statusLabel')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('actionLabel')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pageRows.map((h) => (
                    <tr key={h.id} className="align-middle">
                      <td className="whitespace-nowrap px-4 py-2 font-mono tabular-nums">{h.holidayDate}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{h.name}</span>
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {h.country}
                          </span>
                          {(h.companyId || h.holidayGroupId) && (
                            // Legacy scope badge (read-only) — company / holiday-group scoped rows.
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {fixedScopeOf(h)}
                            </span>
                          )}
                          {h.tentative && (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                              {t('tentativeBadge')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                        {h.state ? h.state : t('national')}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">{typeLabel[typeOf(h.holidayType)]}</td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <Badge variant={h.active ? 'success' : 'default'}>
                          {h.active ? t('activeLabel') : t('inactiveBadge')}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <div className={rowActionsCls}>
                          {/* Edit opens over the list, pre-filled. Closing it returns focus to THIS
                              button, so the row you were working on is still the row you are looking at. */}
                          <HolidayDialog
                            triggerLabel={t('edit')}
                            triggerClassName={rowActionCls}
                            id={h.id}
                            initial={{
                              name: h.name,
                              holidayDate: h.holidayDate,
                              state: h.state ?? '',
                              holidayType: typeOf(h.holidayType),
                              country: h.country,
                              active: h.active,
                              tentative: h.tentative,
                            }}
                            fixedScope={fixedScopeOf(h)}
                            countryOptions={countryOptions}
                            statesByCountry={statesByCountry}
                            typeOptions={typeOptions}
                            filter={dialogFilter}
                            labels={editLabels}
                          />
                          <form action={deleteHolidayAction} className="inline-flex">
                            <input type="hidden" name="id" value={h.id} />
                            {filterFields}
                            <button
                              title={t('remove')}
                              className={`${rowActionMutedCls} cursor-pointer hover:text-red-500`}
                            >
                              {t('remove')}
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager basePath="/admin/holidays" params={{ country, year }} state={pgState} />
          </>
        )}
      </Card>
    </div>
  );
}
