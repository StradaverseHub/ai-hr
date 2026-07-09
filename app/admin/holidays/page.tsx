import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listGroupEffectiveHolidays, listHolidayGroups, listHolidays, listHolidayYears } from '@/core/admin';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { MY_STATES } from '@/localization/my/holidays';
import {
  createHolidayAction,
  createHolidayGroupAction,
  deleteHolidayAction,
  deleteHolidayGroupAction,
  updateHolidayAction,
  updateHolidayGroupAction,
} from '../actions';

export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; country?: string; year?: string; group?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.holidays');
  const { error, country: countryParam, year: yearParam, group: groupParam } = await searchParams;

  const [companies, years, holidayGroups] = await Promise.all([
    listCompanies(s),
    listHolidayYears(s),
    listHolidayGroups(s),
  ]);
  // Countries in play come from the configured companies (holidays match on company.country).
  const countries = [...new Set(companies.map((c) => c.country))].sort();
  const country = countryParam && countries.includes(countryParam) ? countryParam : undefined;
  const year = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : undefined;
  // R18 a519a96e: ?group=<id> opens a group's EFFECTIVE calendar (inherited rows read-only + own extras).
  const viewedGroup = groupParam && holidayGroups.some((g) => g.id === groupParam) ? groupParam : undefined;
  const effectiveCalendar = viewedGroup ? await listGroupEffectiveHolidays(s, { groupId: viewedGroup, year }) : null;
  // Only PARENTLESS groups can be picked as a parent (single-level nesting, service-enforced too).
  const parentCandidates = holidayGroups.filter((g) => !g.parentGroupId);

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

  // STATIC archetype key map (never t(`archetype.${x}`) — the i18n coverage test check C requires literal keys).
  const ARCHETYPES = ['standard', 'extended', 'custom'] as const;
  const archetypeLabel: Record<(typeof ARCHETYPES)[number], string> = {
    standard: t('archetype.standard'),
    extended: t('archetype.extended'),
    custom: t('archetype.custom'),
  };

  const today = new Date().toISOString().slice(0, 10);
  const defaultCountry = country ?? countries[0] ?? 'MY';
  // Hidden fields echo the active filter so actions can redirect back into the same view.
  const filterFields = (
    <>
      <input type="hidden" name="filterCountry" value={country ?? ''} />
      <input type="hidden" name="filterYear" value={year ?? ''} />
      <input type="hidden" name="filterGroup" value={viewedGroup ?? ''} />
    </>
  );
  /** Querystring for links that keep the country/year filter while switching the viewed group. */
  const groupHref = (groupId?: string) => {
    const sp = new URLSearchParams();
    if (country) sp.set('country', country);
    if (year) sp.set('year', String(year));
    if (groupId) sp.set('group', groupId);
    const qs = sp.toString();
    return qs ? `?${qs}` : '/admin/holidays';
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      {/* Holiday groups — named multi-state bundles, assigned per employee on their profile. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('groupsTitle')} count={holidayGroups.length} />
        {holidayGroups.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('groupEmpty')}</p>
        ) : (
          <div className="divide-y divide-border">
            {holidayGroups.map((g) => (
              <form
                key={g.id}
                action={updateHolidayGroupAction}
                className="grid grid-cols-1 items-start gap-3 p-4 sm:grid-cols-[1fr_1fr_1fr_2fr_auto]"
              >
                <input type="hidden" name="id" value={g.id} />
                <Field label={t('groupNameLabel')}>
                  <input name="name" required defaultValue={g.name} className={inputCls} />
                </Field>
                <Field label={t('archetypeLabel')}>
                  <select name="archetype" defaultValue={g.archetype ?? 'standard'} className={inputCls}>
                    {ARCHETYPES.map((a) => (
                      <option key={a} value={a}>
                        {archetypeLabel[a]}
                      </option>
                    ))}
                  </select>
                </Field>
                {/* R18 a519a96e: parent group — the child inherits the parent's whole calendar live and
                    only adds its own extras. Only parentless groups (excluding self) are offered. */}
                <Field label={t('parentGroupLabel')}>
                  <select name="parentGroupId" defaultValue={g.parentGroupId ?? ''} className={inputCls}>
                    <option value="">{t('parentGroupNone')}</option>
                    {parentCandidates
                      .filter((p) => p.id !== g.id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label={t('groupStatesLabel')}>
                  <select
                    name="states"
                    multiple
                    defaultValue={(g.states as string[]) ?? []}
                    className={`${inputCls} h-32`}
                  >
                    {MY_STATES.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="flex flex-col items-start gap-2 self-stretch pt-6">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {archetypeLabel[(g.archetype as (typeof ARCHETYPES)[number]) ?? 'standard']}
                  </span>
                  {g.parentGroupId && (
                    // Inheritance badge: this group starts from its parent's calendar (read live).
                    <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">
                      {t('inheritsFrom', { name: g.parentName ?? '' })}
                    </span>
                  )}
                  <a
                    href={groupHref(g.id)}
                    className="text-sm font-medium text-indigo-600 transition-colors hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                  >
                    {t('viewCalendar')}
                  </a>
                  <button className={btnPrimary}>{t('editGroup')}</button>
                  <button
                    formAction={deleteHolidayGroupAction}
                    className="text-sm text-muted-foreground transition-colors hover:text-red-500"
                  >
                    {t('deleteGroup')}
                  </button>
                </div>
              </form>
            ))}
          </div>
        )}
        <form
          action={createHolidayGroupAction}
          className="grid grid-cols-1 items-start gap-3 border-t border-border p-4 sm:grid-cols-[1fr_1fr_1fr_2fr_auto]"
        >
          <Field label={t('groupNameLabel')}>
            <input name="name" required placeholder={t('groupNamePlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('archetypeLabel')}>
            <select name="archetype" defaultValue="standard" className={inputCls}>
              {ARCHETYPES.map((a) => (
                <option key={a} value={a}>
                  {archetypeLabel[a]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('parentGroupLabel')}>
            <select name="parentGroupId" defaultValue="" className={inputCls}>
              <option value="">{t('parentGroupNone')}</option>
              {parentCandidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('groupStatesLabel')}>
            <select name="states" multiple className={`${inputCls} h-32`}>
              {MY_STATES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end self-stretch pt-6">
            <button className={btnPrimary}>{t('addGroup')}</button>
          </div>
        </form>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('archetypeHint')}</p>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('groupsHint')}</p>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('parentGroupHint')}</p>
      </Card>

      {/* R18 a519a96e — the viewed group's EFFECTIVE calendar: inherited rows (parent extras + gazette +
          company ad-hoc days) are read-only with an "Inherited" badge; the group's OWN extras are editable
          inline. Because the parent is read live, a holiday added to the parent shows here immediately. */}
      {effectiveCalendar && (
        <Card className="overflow-hidden">
          <SectionHeader
            title={t('calendarTitle', { name: effectiveCalendar.group.name })}
            count={effectiveCalendar.rows.length}
          />
          {effectiveCalendar.group.parentName && (
            <p className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
              {t('inheritsFrom', { name: effectiveCalendar.group.parentName })}
            </p>
          )}
          {effectiveCalendar.rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('calendarEmpty')}</p>
          ) : (
            <div className="divide-y divide-border">
              {effectiveCalendar.rows.map((h) =>
                h.source === 'own' ? (
                  // The group's OWN additional day — editable, same inline pattern as the main list.
                  <form
                    key={h.id}
                    action={updateHolidayAction}
                    className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-[auto_1fr_auto]"
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
                          {t('ownBadge')}
                        </span>
                      </div>
                    </Field>
                    <div className="flex items-center gap-2 pb-1">
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
                ) : (
                  // Inherited row — read-only by design (edit it at its source: the parent group, the
                  // public gazette list below, or the owning company's ad-hoc days).
                  <div key={h.id} className="flex flex-wrap items-center gap-2 p-4 text-sm">
                    <span className="font-mono tabular-nums text-muted-foreground">{h.holidayDate}</span>
                    <span className="font-medium text-foreground">{h.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {h.companyId
                        ? t('scopeBadge', { label: t('scope.group'), name: h.companyName ?? '' })
                        : h.holidayGroupId
                          ? t('scopeBadge', {
                              label: t('scope.holidayGroup'),
                              name: effectiveCalendar.group.parentName ?? '',
                            })
                          : h.state
                            ? t('scopeBadge', { label: t('scope.state'), name: h.state })
                            : t('scope.national')}
                    </span>
                    <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
                      {t('inheritedBadge')}
                    </span>
                    {h.tentative && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        {t('tentativeBadge')}
                      </span>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
            <p className="text-xs text-muted-foreground">{t('calendarHint')}</p>
            <a
              href={groupHref()}
              className="shrink-0 text-xs font-medium text-indigo-600 transition-colors hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              {t('calendarBack')}
            </a>
          </div>
        </Card>
      )}

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
              <div className="divide-y divide-border">
                {items.map((h) => (
                  // ADR-0063: each row is an inline edit form (date + name + Tentative toggle) wired to
                  // updateHolidayAction. Scope stays fixed (a scope change is delete + re-add) and is shown
                  // read-only via the badges. Delete posts to deleteHolidayAction from the same row.
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
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {/* Scope badge via a STATIC i18n key map (scope.national/state/group), name
                              interpolated through the ICU "{label}: {name}" template — never a dynamic
                              `scope.${type}` key (those escape the coverage test and fall back to English). */}
                          {h.companyId
                            ? t('scopeBadge', { label: t('scope.group'), name: h.companyName ?? '' })
                            : h.holidayGroupId
                              ? t('scopeBadge', { label: t('scope.holidayGroup'), name: h.holidayGroupName ?? '' })
                              : h.state
                                ? t('scopeBadge', { label: t('scope.state'), name: h.state })
                                : t('scope.national')}
                        </span>
                        {h.tentative && (
                          // Distinct, muted "Tentative" badge: a provisional state date HR must still confirm.
                          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                            {t('tentativeBadge')}
                          </span>
                        )}
                      </div>
                    </Field>
                    <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
                      <input type="checkbox" name="tentative" defaultChecked={h.tentative} className="size-3.5" />
                      {t('tentativeLabel')}
                    </label>
                    <div className="flex items-center gap-2 pb-1">
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

      {/* Add */}
      <Card>
        <SectionHeader title={t('addTitle')} />
        <form
          action={createHolidayAction}
          className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3"
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
          {/* Scope (ADR-0055 + R18 a519a96e): National · State · Business group · Holiday group. The
              action reads `scope` and only honours the matching field below, so leaving a stray selection
              on another scope is harmless. Single-axis scope is also enforced by the service + DB CHECK.
              When a group's calendar is open, the scope defaults to that group so "add a location-specific
              holiday" is one straight entry. */}
          <Field label={t('scopeLabel')}>
            <select name="scope" defaultValue={viewedGroup ? 'holidayGroup' : 'national'} className={inputCls}>
              <option value="national">{t('scope.national')}</option>
              <option value="state">{t('scope.state')}</option>
              <option value="group">{t('scope.group')}</option>
              <option value="holidayGroup">{t('scope.holidayGroup')}</option>
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
          <Field label={t('companyLabel')}>
            <select name="companyId" defaultValue="" className={inputCls}>
              <option value="">{t('companyPlaceholder')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('holidayGroupLabel')}>
            <select name="holidayGroupId" defaultValue={viewedGroup ?? ''} className={inputCls}>
              <option value="">{t('holidayGroupPlaceholder')}</option>
              {holidayGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          {/* ADR-0063: load a not-yet-gazetted state date provisionally — it still counts as a holiday. */}
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-muted-foreground sm:col-span-3">
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
