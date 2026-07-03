import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listLocations } from '@/core/location';
import { listClockingLocations } from '@/core/clocking-location';
import { listHolidayGroups } from '@/core/admin';
import { MY_STATES } from '@/localization/my/holidays';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import {
  createLocationAction,
  updateLocationAction,
  archiveLocationAction,
  restoreLocationAction,
  createClockingLocationAction,
  updateClockingLocationAction,
  archiveClockingLocationAction,
  restoreClockingLocationAction,
  deleteClockingLocationAction,
} from '../actions';

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const { error } = await searchParams;

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const locations = await listLocations(s, visible.map((c) => c.id), { includeArchived: true });
  // Named holiday calendars (holiday_group rows) to populate the per-location Calendar dropdown (ADR-0067).
  const calendars = await listHolidayGroups(s);
  const byCompany = new Map<string, typeof locations>();
  for (const l of locations) {
    const arr = byCompany.get(l.companyId);
    if (arr) arr.push(l);
    else byCompany.set(l.companyId, [l]);
  }
  // Country/state are rendered through label maps (not raw strings) so a value isn't shown untranslated.
  const stateLabel = (st: string | null) => (st ? st : t('stateNational'));

  // ADR-0070 — Clocking Location Management: a SEPARATE site register from the holiday-calendar
  // `location` list above (see ADR-0070 §1 for why). Tenant-catalog read (RLS lets every tenant member
  // through), but this admin-only route only ever renders it for an admin.
  const clockingLocations = await listClockingLocations(s, visible.map((c) => c.id), { includeArchived: true });
  const clockingByCompany = new Map<string, typeof clockingLocations>();
  for (const cl of clockingLocations) {
    const arr = clockingByCompany.get(cl.companyId);
    if (arr) arr.push(cl);
    else clockingByCompany.set(cl.companyId, [cl]);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        visible.map((c) => {
          const rows = byCompany.get(c.id) ?? [];
          return (
            <Card key={c.id} className="overflow-hidden">
              <SectionHeader title={c.name} count={rows.length} />

              {rows.length > 0 && (
                <ul className="divide-y divide-border">
                  {rows.map((l) => (
                    <li
                      key={l.id}
                      className={`flex flex-wrap items-end gap-2 px-4 py-3 ${l.archivedAt ? 'opacity-60' : ''}`}
                    >
                      {/* Inline edit: one form per location row (valid HTML, no table-nesting). */}
                      <form action={updateLocationAction} className="flex flex-1 flex-wrap items-end gap-2">
                        <input type="hidden" name="locationId" value={l.id} />
                        <Field label={t('code')}>
                          <input name="code" defaultValue={l.code} required className={`${inputCls} w-24 uppercase`} />
                        </Field>
                        <Field label={t('name')}>
                          <input name="name" defaultValue={l.name} required className={`${inputCls} min-w-[10rem]`} />
                        </Field>
                        <Field label={t('country')}>
                          <input name="country" defaultValue={l.country} required className={`${inputCls} w-16 uppercase`} />
                        </Field>
                        <Field label={t('state')}>
                          <select name="state" defaultValue={l.state ?? ''} className={`${inputCls} min-w-[8rem]`}>
                            <option value="">{t('stateNational')}</option>
                            {MY_STATES.map((st) => (
                              <option key={st} value={st}>
                                {st}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t('calendar')}>
                          <select
                            name="holidayGroupId"
                            defaultValue={l.holidayGroupId ?? ''}
                            className={`${inputCls} min-w-[10rem]`}
                          >
                            <option value="">{t('calendarNone')}</option>
                            {calendars.map((cal) => (
                              <option key={cal.id} value={cal.id}>
                                {cal.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <span className="pb-2 text-xs text-muted-foreground">
                          {t('headcountLabel', { count: l.headcount })}
                          {' · '}
                          {stateLabel(l.state)}
                          {l.holidayGroupName ? ` · ${l.holidayGroupName}` : ''}
                        </span>
                        <button className={btnGhost}>{t('save')}</button>
                      </form>
                      {l.archivedAt ? (
                        <form action={restoreLocationAction}>
                          <input type="hidden" name="locationId" value={l.id} />
                          <button className={btnGhost}>{t('restore')}</button>
                        </form>
                      ) : (
                        <form action={archiveLocationAction}>
                          <input type="hidden" name="locationId" value={l.id} />
                          <button className={btnGhost}>{t('archive')}</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <form action={createLocationAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-6">
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={t('code')}>
                  <input name="code" required placeholder={t('codePlaceholder')} className={`${inputCls} uppercase`} />
                </Field>
                <Field label={t('name')}>
                  <input name="name" required placeholder={t('namePlaceholder')} className={inputCls} />
                </Field>
                <Field label={t('country')}>
                  <input name="country" defaultValue="MY" className={`${inputCls} uppercase`} />
                </Field>
                <Field label={t('state')}>
                  <select name="state" defaultValue="" className={inputCls}>
                    <option value="">{t('stateNational')}</option>
                    {MY_STATES.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('calendar')}>
                  <select name="holidayGroupId" defaultValue="" className={inputCls}>
                    <option value="">{t('calendarNone')}</option>
                    {calendars.map((cal) => (
                      <option key={cal.id} value={cal.id}>
                        {cal.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div>
                  <button className={btnPrimary}>{t('add')}</button>
                </div>
              </form>
            </Card>
          );
        })
      )}

      <p className="px-1 text-xs text-muted-foreground">{t('stateNote')}</p>

      {/* ADR-0070 — Clocking Location Management. Deliberately a SEPARATE register from the holiday-calendar
          locations above (see ADR-0070 §1). Plain numeric lat/lng inputs — a map picker is Phase 2. */}
      <div className="pt-2">
        <PageHeader title={t('clockingHeading')} description={t('clockingDescription')} />
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        visible.map((c) => {
          const rows = clockingByCompany.get(c.id) ?? [];
          return (
            <Card key={`clocking-${c.id}`} className="overflow-hidden">
              <SectionHeader title={c.name} count={rows.length} />

              {rows.length > 0 && (
                <ul className="divide-y divide-border">
                  {rows.map((cl) => (
                    <li
                      key={cl.id}
                      className={`flex flex-wrap items-end gap-2 px-4 py-3 ${cl.archivedAt ? 'opacity-60' : ''}`}
                    >
                      <form action={updateClockingLocationAction} className="flex flex-1 flex-wrap items-end gap-2">
                        <input type="hidden" name="clockingLocationId" value={cl.id} />
                        <Field label={t('name')}>
                          <input name="name" defaultValue={cl.name} required className={`${inputCls} min-w-[10rem]`} />
                        </Field>
                        <Field label={t('lat')}>
                          <input
                            name="lat"
                            type="number"
                            step="any"
                            defaultValue={cl.lat}
                            required
                            className={`${inputCls} w-28`}
                          />
                        </Field>
                        <Field label={t('lng')}>
                          <input
                            name="lng"
                            type="number"
                            step="any"
                            defaultValue={cl.lng}
                            required
                            className={`${inputCls} w-28`}
                          />
                        </Field>
                        <Field label={t('address')}>
                          <input name="address" defaultValue={cl.address ?? ''} className={`${inputCls} min-w-[10rem]`} />
                        </Field>
                        <Field label={t('remarks')}>
                          <input name="remarks" defaultValue={cl.remarks ?? ''} className={`${inputCls} min-w-[8rem]`} />
                        </Field>
                        <span className="pb-2 text-xs text-muted-foreground">
                          {t('assignedCount', { count: cl.assignedCount })}
                        </span>
                        <button className={btnGhost}>{t('save')}</button>
                      </form>
                      <div className="flex gap-2">
                        {cl.archivedAt ? (
                          <form action={restoreClockingLocationAction}>
                            <input type="hidden" name="clockingLocationId" value={cl.id} />
                            <button className={btnGhost}>{t('restore')}</button>
                          </form>
                        ) : (
                          <form action={archiveClockingLocationAction}>
                            <input type="hidden" name="clockingLocationId" value={cl.id} />
                            <button className={btnGhost}>{t('archive')}</button>
                          </form>
                        )}
                        <form action={deleteClockingLocationAction}>
                          <input type="hidden" name="clockingLocationId" value={cl.id} />
                          <ConfirmSubmit
                            title={t('deleteConfirmTitle')}
                            description={t('deleteConfirmDescription', { name: cl.name })}
                            confirmLabel={t('delete')}
                            size="sm"
                            variant="ghost"
                          >
                            {t('delete')}
                          </ConfirmSubmit>
                        </form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <form
                action={createClockingLocationAction}
                className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-6"
              >
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={t('name')}>
                  <input name="name" required placeholder={t('namePlaceholder')} className={inputCls} />
                </Field>
                <Field label={t('lat')}>
                  <input name="lat" type="number" step="any" required placeholder="3.1390" className={inputCls} />
                </Field>
                <Field label={t('lng')}>
                  <input name="lng" type="number" step="any" required placeholder="101.6869" className={inputCls} />
                </Field>
                <Field label={t('address')}>
                  <input name="address" className={inputCls} />
                </Field>
                <Field label={t('remarks')}>
                  <input name="remarks" className={inputCls} />
                </Field>
                <div>
                  <button className={btnPrimary}>{t('add')}</button>
                </div>
              </form>
            </Card>
          );
        })
      )}
      <p className="px-1 text-xs text-muted-foreground">{t('clockingNote')}</p>
    </div>
  );
}
