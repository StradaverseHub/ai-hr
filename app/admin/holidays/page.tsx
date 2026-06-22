import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listHolidays, listHolidayYears } from '@/core/admin';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { MY_STATES } from '@/localization/my/holidays';
import { createHolidayAction, deleteHolidayAction } from '../actions';

export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; country?: string; year?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.holidays');
  const { error, country: countryParam, year: yearParam } = await searchParams;

  const [companies, years] = await Promise.all([listCompanies(s), listHolidayYears(s)]);
  // Countries in play come from the configured companies (holidays match on company.country).
  const countries = [...new Set(companies.map((c) => c.country))].sort();
  const country = countryParam && countries.includes(countryParam) ? countryParam : undefined;
  const year = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : undefined;

  const holidays = await listHolidays(s, { country, year });
  // Group by calendar year (descending) for a scannable, sectioned list.
  const byYear = new Map<number, typeof holidays>();
  for (const h of holidays) {
    const y = Number(h.holidayDate.slice(0, 4));
    const arr = byYear.get(y);
    if (arr) arr.push(h);
    else byYear.set(y, [h]);
  }
  const groups = [...byYear.entries()].sort((a, b) => b[0] - a[0]);

  const today = new Date().toISOString().slice(0, 10);
  const defaultCountry = country ?? countries[0] ?? 'MY';
  // Hidden fields echo the active filter so actions can redirect back into the same view.
  const filterFields = (
    <>
      <input type="hidden" name="filterCountry" value={country ?? ''} />
      <input type="hidden" name="filterYear" value={year ?? ''} />
    </>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
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

      {/* List */}
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
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {items.map((h) => (
                    <tr key={h.id} className="hover:bg-muted/40">
                      <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-muted-foreground">
                        {h.holidayDate}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-foreground">{h.name}</td>
                      <td className="px-4 py-2.5">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {h.country}
                        </span>
                        <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {h.state ?? t('national')}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <form action={deleteHolidayAction} className="inline">
                          <input type="hidden" name="id" value={h.id} />
                          {filterFields}
                          <button
                            type="submit"
                            title={t('remove')}
                            className="text-muted-foreground transition-colors hover:text-red-500"
                          >
                            {t('remove')}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </Card>

      {/* Add */}
      <Card>
        <SectionHeader title={t('addTitle')} />
        <form
          action={createHolidayAction}
          className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-5"
        >
          {filterFields}
          <Field label={t('dateLabel')}>
            <input name="holidayDate" type="date" required defaultValue={today} className={inputCls} />
          </Field>
          <Field label={t('nameLabel')}>
            <input name="name" required placeholder={t('namePlaceholder')} className={inputCls} />
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
          <Field label={t('stateLabel')}>
            <select name="state" defaultValue="" className={inputCls}>
              <option value="">{t('national')}</option>
              {MY_STATES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </Field>
          <button className={btnPrimary}>{t('addHoliday')}</button>
        </form>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('addHint')}</p>
      </Card>
    </div>
  );
}
