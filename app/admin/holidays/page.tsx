import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listHolidays, listHolidayYears } from '@/core/admin';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { HolidayTabs } from '@/components/holiday-tabs';
import { createHolidayAction, deleteHolidayAction, updateHolidayAction } from '../actions';

/**
 * Holiday tab (66b8f5a8) — the centralized Holiday MASTER. One tab of the two-tab Holiday module
 * (Holiday · Holiday Group). The Add-Holiday form is simplified: it no longer collects Scope, State,
 * Business Group or Holiday Group (those columns stay in the DB — backward compatible — but default to
 * null); instead it collects the master fields (code, type, description, active). Existing scoped rows keep
 * their scope and show it as a read-only badge.
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
  const byYear = new Map<number, typeof holidays>();
  for (const h of holidays) {
    const y = Number(h.holidayDate.slice(0, 4));
    const arr = byYear.get(y);
    if (arr) arr.push(h);
    else byYear.set(y, [h]);
  }
  const groups = [...byYear.entries()].sort((a, b) => b[0] - a[0]);

  // STATIC holiday-type key map (never t(`holidayType.${x}`) — the i18n coverage test requires literal keys).
  const HOLIDAY_TYPES = ['public', 'company', 'optional'] as const;
  const typeLabel: Record<(typeof HOLIDAY_TYPES)[number], string> = {
    public: t('holidayType.public'),
    company: t('holidayType.company'),
    optional: t('holidayType.optional'),
  };

  const today = new Date().toISOString().slice(0, 10);
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
    <div className="mx-auto max-w-4xl space-y-6">
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

      {/* Master list */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('listTitle')} count={holidays.length} />
        {holidays.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          groups.map(([y, items]) => (
            <div key={y}>
              <div className="bg-muted/40 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {y}
              </div>
              <div className="divide-y divide-border">
                {items.map((h) => (
                  // 66b8f5a8: inline edit of the master fields. Scope (state/company/holiday-group) is
                  // IMMUTABLE here and shown read-only as a badge for legacy rows.
                  <form
                    key={h.id}
                    action={updateHolidayAction}
                    className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-[auto_1fr_auto_auto]"
                  >
                    <input type="hidden" name="id" value={h.id} />
                    {filterFields}
                    <Field label={t('dateLabel')}>
                      <input
                        name="holidayDate"
                        type="date"
                        required
                        defaultValue={h.holidayDate}
                        className={`${inputCls} font-mono tabular-nums`}
                      />
                    </Field>
                    <Field label={t('nameLabel')}>
                      <div className="flex items-center gap-2">
                        <input name="name" required defaultValue={h.name} className={inputCls} />
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {h.country}
                        </span>
                        {(h.state || h.companyId || h.holidayGroupId) && (
                          // Legacy scope badge (read-only) — new holidays are national-country master rows.
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {h.companyId
                              ? t('scopeBadge', { label: t('scope.group'), name: h.companyName ?? '' })
                              : h.holidayGroupId
                                ? t('scopeBadge', { label: t('scope.holidayGroup'), name: h.holidayGroupName ?? '' })
                                : t('scopeBadge', { label: t('scope.state'), name: h.state ?? '' })}
                          </span>
                        )}
                        {!h.active && (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t('inactiveBadge')}
                          </span>
                        )}
                        {h.tentative && (
                          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                            {t('tentativeBadge')}
                          </span>
                        )}
                      </div>
                    </Field>
                    <Field label={t('holidayCodeLabel')}>
                      <input
                        name="holidayCode"
                        defaultValue={h.holidayCode ?? ''}
                        placeholder={t('holidayCodePlaceholder')}
                        className={`${inputCls} w-24`}
                      />
                    </Field>
                    <Field label={t('holidayTypeLabel')}>
                      <select name="holidayType" defaultValue={typeOf(h.holidayType)} className={inputCls}>
                        {HOLIDAY_TYPES.map((ty) => (
                          <option key={ty} value={ty}>
                            {typeLabel[ty]}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('descriptionLabel')}>
                      <input
                        name="description"
                        defaultValue={h.description ?? ''}
                        placeholder={t('descriptionPlaceholder')}
                        className={inputCls}
                      />
                    </Field>
                    <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
                      <input type="checkbox" name="active" defaultChecked={h.active} className="size-3.5" />
                      {t('activeLabel')}
                    </label>
                    <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
                      <input type="checkbox" name="tentative" defaultChecked={h.tentative} className="size-3.5" />
                      {t('tentativeLabel')}
                    </label>
                    <div className="flex items-center gap-2 pb-1 sm:col-span-2">
                      <button className={btnPrimary}>{t('save')}</button>
                      <button
                        formAction={deleteHolidayAction}
                        title={t('remove')}
                        className="text-sm text-muted-foreground transition-colors hover:text-red-500"
                      >
                        {t('remove')}
                      </button>
                    </div>
                  </form>
                ))}
              </div>
            </div>
          ))
        )}
      </Card>

      {/* Add — simplified: master fields only (no Scope / State / Business Group / Holiday Group). */}
      <Card>
        <SectionHeader title={t('addTitle')} />
        <form action={createHolidayAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3">
          {filterFields}
          <Field label={t('holidayCodeLabel')}>
            <input name="holidayCode" placeholder={t('holidayCodePlaceholder')} className={inputCls} />
          </Field>
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
          <Field label={t('descriptionLabel')}>
            <input name="description" placeholder={t('descriptionPlaceholder')} className={inputCls} />
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
          <div className="sm:col-span-3">
            <button className={btnPrimary}>{t('addHoliday')}</button>
          </div>
        </form>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('addHint')}</p>
      </Card>
    </div>
  );
}
