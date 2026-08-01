import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listHolidays, listHolidayYears } from '@/core/admin';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { HolidayTabs } from '@/components/holiday-tabs';
import { createHolidayAction, deleteHolidayAction, updateHolidayAction } from '../actions';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Holiday tab (66b8f5a8, simplified 3e831868) — the centralized Holiday MASTER. One tab of the two-tab
 * Holiday module (Holiday · Holiday Group).
 *
 * 3e831868 (Holiday Master Simplification): the master keeps only the fields attendance/leave actually
 * use. Holiday Code + Description are REMOVED from the form and list (the nullable columns stay in the DB
 * for backward compatibility — the resolver never read them). The list is a compact single-row table
 * (Holiday Date · Name · National/State · Type · Status · Action) so HR sees far more holidays per screen.
 * Each row is an inline edit form associated by the `form=` attribute (the <form> element lives outside the
 * <table> so table markup stays valid HTML). Holiday Type value 'company' is relabelled "Replacement
 * holiday" in i18n only — the stored value + CHECK constraint are unchanged.
 */
export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; country?: string; year?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.holidays');
  const { error, country: countryParam, year: yearParam } = await searchParams;

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

  const today = todayInKualaLumpur();
  const defaultCountry = country ?? countries[0] ?? 'MY';
  // Hidden fields echo the active filter so actions redirect back into the same view.
  const filterFields = (
    <>
      <input type="hidden" name="filterCountry" value={country ?? ''} />
      <input type="hidden" name="filterYear" value={year ?? ''} />
    </>
  );
  const typeOf = (v: string | null): (typeof HOLIDAY_TYPES)[number] =>
    v && (HOLIDAY_TYPES as readonly string[]).includes(v) ? (v as (typeof HOLIDAY_TYPES)[number]) : 'public';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
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
          <div className="sm:col-span-2">
            <button className={btnPrimary}>{t('applyFilter')}</button>
          </div>
        </form>
      </Card>

      {/* Master list — compact single-row table (3e831868). Add-holiday button top-right. */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="text-sm font-medium">
            {t('listTitle')}
            <span className="ml-2 text-muted-foreground">({holidays.length})</span>
          </div>
          <a href="#add-holiday" className={btnPrimary}>
            {t('addHoliday')}
          </a>
        </div>

        {holidays.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            {/* Detached inline-edit forms — one per holiday. Kept OUTSIDE the <table> (valid HTML); the row's
                inputs/buttons attach via the `form=` attribute. Save posts updateHolidayAction, Delete posts
                deleteHolidayAction. holidayCode/description are intentionally NOT posted here, so the service
                preserves their stored values (backward compatible) while the UI no longer edits them. */}
            {holidays.map((h) => (
              <form key={`f-${h.id}`} id={`hf-${h.id}`} action={updateHolidayAction} className="hidden">
                <input type="hidden" name="id" value={h.id} />
                {filterFields}
              </form>
            ))}
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
                  {holidays.map((h) => (
                    <tr key={h.id} className="align-middle">
                      <td className="px-4 py-1.5">
                        <input
                          form={`hf-${h.id}`}
                          name="holidayDate"
                          type="date"
                          required
                          defaultValue={h.holidayDate}
                          className={`${inputCls} w-40 font-mono tabular-nums`}
                        />
                      </td>
                      <td className="px-4 py-1.5">
                        <div className="flex items-center gap-2">
                          <input form={`hf-${h.id}`} name="name" required defaultValue={h.name} className={inputCls} />
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {h.country}
                          </span>
                          {(h.companyId || h.holidayGroupId) && (
                            // Legacy scope badge (read-only) — company / holiday-group scoped rows.
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {h.companyId
                                ? t('scopeBadge', { label: t('scope.group'), name: h.companyName ?? '' })
                                : t('scopeBadge', { label: t('scope.holidayGroup'), name: h.holidayGroupName ?? '' })}
                            </span>
                          )}
                          {h.tentative && (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                              {t('tentativeBadge')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-1.5 text-muted-foreground">
                        {h.state ? h.state : t('national')}
                      </td>
                      <td className="px-4 py-1.5">
                        <select
                          form={`hf-${h.id}`}
                          name="holidayType"
                          defaultValue={typeOf(h.holidayType)}
                          className={`${inputCls} w-44`}
                        >
                          {HOLIDAY_TYPES.map((ty) => (
                            <option key={ty} value={ty}>
                              {typeLabel[ty]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="whitespace-nowrap px-4 py-1.5">
                        <div className="flex flex-col gap-1">
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <input
                              form={`hf-${h.id}`}
                              type="checkbox"
                              name="active"
                              defaultChecked={h.active}
                              className="size-3.5"
                            />
                            {t('activeLabel')}
                          </label>
                          {/* ADR-0063: preserve the tentative (not-yet-gazetted) flag as an inline toggle. */}
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <input
                              form={`hf-${h.id}`}
                              type="checkbox"
                              name="tentative"
                              defaultChecked={h.tentative}
                              className="size-3.5"
                            />
                            {t('tentativeLabel')}
                          </label>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-1.5 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button form={`hf-${h.id}`} className={btnPrimary}>
                            {t('save')}
                          </button>
                          <button
                            form={`hf-${h.id}`}
                            formAction={deleteHolidayAction}
                            title={t('remove')}
                            className="text-sm text-muted-foreground transition-colors hover:text-red-500"
                          >
                            {t('remove')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {/* Add — simplified master fields only: Name, Date, Type, Country, Status. No code / description. */}
      <Card id="add-holiday">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="text-sm font-medium">{t('addTitle')}</div>
          <button form="add-holiday-form" className={btnPrimary}>
            {t('addHoliday')}
          </button>
        </div>
        <form
          id="add-holiday-form"
          action={createHolidayAction}
          className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2 md:grid-cols-4"
        >
          {filterFields}
          <Field label={t('nameLabel')}>
            <input name="name" required placeholder={t('namePlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('dateLabel')}>
            <input name="holidayDate" type="date" required defaultValue={today} className={inputCls} />
          </Field>
          <Field label={t('holidayTypeLabel')}>
            <select name="holidayType" defaultValue="public" className={inputCls}>
              {HOLIDAY_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {typeLabel[ty]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('countryLabel')}>
            <select name="country" defaultValue={defaultCountry} className={inputCls}>
              {countries.length === 0 && <option value="MY">MY</option>}
              {countries.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-muted-foreground">
            <input type="checkbox" name="active" defaultChecked className="size-4" />
            {t('activeLabel')}
          </label>
          {/* ADR-0063: load a not-yet-gazetted date provisionally — it still counts as a holiday. */}
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-muted-foreground">
            <input type="checkbox" name="tentative" className="size-4" />
            {t('tentativeCreateLabel')}
          </label>
        </form>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('addHint')}</p>
      </Card>
    </div>
  );
}
