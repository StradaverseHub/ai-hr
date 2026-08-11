import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listLocations, listUnmappedBranches } from '@/core/location';
import { listClockingLocations } from '@/core/clocking-location';
import { listProfileOptions } from '@/core/profile-options';
import { listHolidayGroups } from '@/core/admin';
import { countryPacks } from '@/localization/registry';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
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
  // `addPoint` = the location the "Add a clocking point" link inside an empty group asked to file the new
  // point under. It only pre-selects the create form's Location picker (the /admin/attendance ?editShift=
  // pattern) — nothing is written by a GET.
  searchParams: Promise<{ error?: string; addPoint?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const { error, addPoint } = await searchParams;

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
  // Rung 5c — the state pick-list comes from the country packs via the registry (union-read, the
  // rung-5a `countryPacks()` precedent for tenant-level vocabulary with no acting company). MY-only
  // today ⇒ byte-identical to the old MY_STATES import.
  const stateOptions = countryPacks().flatMap((p) => p.states);
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

  // 1fff489c — clocking points now sit GROUPED under the location they belong to (the mockup's "HQ · North
  // Gate / South Gate" reading) instead of a flat list, so a compound with two entrances reads as one site.
  // Keyed by locationId; the `null` bucket holds any point with no link, which cannot be created any more
  // but must stay visible if one ever exists (see listClockingLocations' LEFT-join note).
  const clockingByLocation = new Map<string | null, typeof clockingLocations>();
  for (const cl of clockingLocations) {
    const key = cl.locationId ?? null;
    const arr = clockingByLocation.get(key);
    if (arr) arr.push(cl);
    else clockingByLocation.set(key, [cl]);
  }

  // 1fff489c PHASE 2 — Branch. The dropdown is the tenant's ACTIVE profile_option 'branch' catalogue, the
  // same list the Employment tab writes employment.org_branch from; core/location.ts validates against it
  // with the same legacy-value tolerance, so the two can never drift into different vocabularies.
  const branchOptions = await listProfileOptions(s, 'branch', { activeOnly: true });
  // …and the count the plan promises: branches live employees actually carry that no live location claims,
  // so HR fixes the mapping once instead of chasing it person by person.
  const unmappedBranches = await listUnmappedBranches(s, visible.map((c) => c.id));
  const unmappedByCompany = new Map<string, typeof unmappedBranches>();
  for (const u of unmappedBranches) {
    const arr = unmappedByCompany.get(u.companyId);
    if (arr) arr.push(u);
    else unmappedByCompany.set(u.companyId, [u]);
  }

  return (
    <div className={pageWideCls}>
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
                            {stateOptions.map((st) => (
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
                        {/* 1fff489c — the Branch this location serves. A LEGACY value (recorded before the
                            catalogue tightened) is rendered as its own option so a plain Save cannot
                            silently blank it — the same tolerance core/location.ts applies server-side. */}
                        <Field label={t('branch')}>
                          <select name="branch" defaultValue={l.branch ?? ''} className={`${inputCls} min-w-[10rem]`}>
                            <option value="">{t('branchNone')}</option>
                            {l.branch && !branchOptions.some((o) => o.value === l.branch) && (
                              <option value={l.branch}>{l.branch}</option>
                            )}
                            {branchOptions.map((o) => (
                              <option key={o.id} value={o.value}>
                                {o.label}
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

              <form action={createLocationAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-7">
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
                    {stateOptions.map((st) => (
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
                <Field label={t('branch')}>
                  <select name="branch" defaultValue="" className={inputCls}>
                    <option value="">{t('branchNone')}</option>
                    {branchOptions.map((o) => (
                      <option key={o.id} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div>
                  <button className={btnPrimary}>{t('add')}</button>
                </div>
              </form>

              {/* 1fff489c — "fix it once instead of chasing it person by person": the branches this
                  company's live employees actually carry that no live location claims. Their Attendance
                  tab can propose nothing until one of them is mapped above. */}
              {(unmappedByCompany.get(c.id) ?? []).length > 0 && (
                <div className="border-t border-border bg-muted/40 px-4 py-3">
                  <p className="text-xs font-medium text-foreground">{t('unmappedBranchesHeading')}</p>
                  <ul className="mt-1 space-y-0.5">
                    {(unmappedByCompany.get(c.id) ?? []).map((u) => (
                      <li key={u.branch} className="text-xs text-muted-foreground">
                        {t('unmappedBranchRow', { branch: u.branch, count: u.headcount })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
          // The location headers this company groups its points under. Archived locations still appear IF
          // they hold points, so an archived site's history stays reachable; otherwise only live ones.
          const companyLocations = (byCompany.get(c.id) ?? []).filter(
            (l) => !l.archivedAt || (clockingByLocation.get(l.id) ?? []).length > 0,
          );
          const orphans = (clockingByLocation.get(null) ?? []).filter((cl) => cl.companyId === c.id);
          // Only LIVE locations can take a new point (the service rejects an archived one), so the create
          // form's picker and the "no locations at all" empty state both read from this list.
          const assignableLocations = (byCompany.get(c.id) ?? []).filter((l) => !l.archivedAt);

          /** One clocking point: the inline edit form plus its archive / restore / delete controls. */
          const pointRow = (cl: (typeof rows)[number]) => (
            <li
              key={cl.id}
              className={`flex flex-wrap items-end gap-2 border-t border-border px-4 py-3 ${cl.archivedAt ? 'opacity-60' : ''}`}
            >
              <form action={updateClockingLocationAction} className="flex flex-1 flex-wrap items-end gap-2">
                <input type="hidden" name="clockingLocationId" value={cl.id} />
                {/* The point keeps its OWN name. The spec asked for the name to be pulled read-only from
                    the linked location, but its own multi-point example calls them "HQ — North Gate" and
                    "HQ — South Gate", which are not the location's name. The business half of the plan
                    records that reading explicitly. */}
                <Field label={t('name')}>
                  <input name="name" defaultValue={cl.name} required className={`${inputCls} min-w-[10rem]`} />
                </Field>
                <Field label={t('lat')}>
                  <input name="lat" type="number" step="any" defaultValue={cl.lat} required className={`${inputCls} w-28`} />
                </Field>
                <Field label={t('lng')}>
                  <input name="lng" type="number" step="any" defaultValue={cl.lng} required className={`${inputCls} w-28`} />
                </Field>
                {/* 1fff489c — the allowed distance, per site. Required by the form AND by the service;
                    min=1 is the DB CHECK, and the 10..5000 advisory is a toast, never a block. */}
                <Field label={t('radius')}>
                  <input
                    name="radiusM"
                    type="number"
                    min={1}
                    step={1}
                    defaultValue={cl.radiusM ?? ''}
                    required
                    className={`${inputCls} w-24`}
                  />
                </Field>
                <Field label={t('clockingLocationLink')}>
                  <select
                    name="locationId"
                    defaultValue={cl.locationId ?? ''}
                    required
                    className={`${inputCls} min-w-[10rem]`}
                  >
                    <option value="">{t('clockingLocationPick')}</option>
                    {assignableLocations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.code} · {l.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('address')}>
                  <input name="address" defaultValue={cl.address ?? ''} className={`${inputCls} min-w-[10rem]`} />
                </Field>
                <Field label={t('remarks')}>
                  <input name="remarks" defaultValue={cl.remarks ?? ''} className={`${inputCls} min-w-[8rem]`} />
                </Field>
                <span className="pb-2 text-xs text-muted-foreground">{t('assignedCount', { count: cl.assignedCount })}</span>
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
          );

          return (
            <Card key={`clocking-${c.id}`} className="overflow-hidden">
              <SectionHeader title={c.name} count={rows.length} />

              {/* EMPTY STATE 1 of 4 (spec section E): this company has no LIVE locations, so there is
                  nothing to file a clocking point under and the create form below cannot be completed.
                  Shown alongside any groups rather than instead of them — a company whose only locations
                  are archived-but-still-holding-points must still see those points to fix them. */}
              {assignableLocations.length === 0 && (
                <p className="px-4 py-3 text-sm text-muted-foreground">{t('noLocationsForCompany')}</p>
              )}
              {(companyLocations.length > 0 || orphans.length > 0) && (
                <div className="space-y-3 p-4">
                  {companyLocations.map((l) => {
                    const points = clockingByLocation.get(l.id) ?? [];
                    return (
                      <div key={l.id} className="overflow-hidden rounded-lg border border-border">
                        <div className="flex flex-wrap items-center gap-2 bg-muted px-3 py-2 text-sm font-medium">
                          <span>
                            {l.code} · {l.name}
                          </span>
                          <span className="rounded-full bg-background px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                            {l.branch ? t('branchPill', { branch: l.branch }) : t('branchPillUnmapped')}
                          </span>
                          <span className="rounded-full bg-background px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                            {l.archivedAt ? t('statusArchived') : t('statusActive')}
                          </span>
                        </div>
                        {points.length === 0 ? (
                          /* EMPTY STATE 3 of 4: the location exists but nobody has dropped a gate under
                             it, so nobody can clock in at this site however it is assigned. The mockup
                             puts the way OUT of the empty state inside it — the link jumps to the create
                             form below with this location already picked (a GET; nothing is written). An
                             empty group is always a LIVE location, so the form it targets is always
                             rendered (see the companyLocations filter above). */
                          <p className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                            {t('groupNoPoints')}
                            {/* btnGhost's tokens at this row's xs scale — the mockup draws a small
                                bordered button here, and h-9 would double the height of the row. */}
                            <Link
                              href={`/admin/locations?addPoint=${l.id}#clocking-form-${c.id}`}
                              className="inline-flex h-7 items-center rounded-md border border-input px-2 text-xs font-medium transition duration-150 ease-snappy hover:bg-accent hover:text-accent-foreground"
                            >
                              {t('addPointCta')}
                            </Link>
                          </p>
                        ) : (
                          <ul>{points.map(pointRow)}</ul>
                        )}
                      </div>
                    );
                  })}

                  {/* Only reachable for a row written before migration 0419 — none exist. Rendered rather
                      than filtered so such a point can be edited back into a group instead of vanishing. */}
                  {orphans.length > 0 && (
                    <div className="overflow-hidden rounded-lg border border-dashed border-border">
                      <div className="bg-muted px-3 py-2 text-sm font-medium">{t('unlinkedGroupTitle')}</div>
                      <ul>{orphans.map(pointRow)}</ul>
                    </div>
                  )}
                </div>
              )}

              {assignableLocations.length > 0 && (
                <form
                  action={createClockingLocationAction}
                  id={`clocking-form-${c.id}`}
                  // THE KEY IS LOAD-BEARING, not decoration. The Location <select> below is
                  // UNCONTROLLED (defaultValue, no value), and "Add a clocking point" is a next/link
                  // SOFT navigation to the same route — so React reuses this form at the same tree
                  // position and never re-applies defaultValue (react-dom's update path skips
                  // updateOptions when value == null). Without a key the pre-pick silently no-ops on
                  // the exact path users take, and works only after a hard reload. Every other
                  // searchParams-driven form in this repo carries one: /admin/attendance
                  // key={editing?.id ?? 'new'}, pay-components/new, payroll-cycle, claims. Same
                  // failure the entitlement bands editor shipped with (4a1abc4a).
                  key={addPoint ?? 'new'}
                  className="grid scroll-mt-6 grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-7"
                >
                  <input type="hidden" name="companyId" value={c.id} />
                  <Field label={t('name')}>
                    <input name="name" required placeholder={t('clockingNamePlaceholder')} className={inputCls} />
                  </Field>
                  <Field label={t('clockingLocationLink')}>
                    {/* Pre-picked when the admin arrived from an empty group's "Add a clocking point"
                        link, and only ever to a location THIS form can accept. */}
                    <select
                      name="locationId"
                      defaultValue={assignableLocations.some((l) => l.id === addPoint) ? addPoint : ''}
                      required
                      className={inputCls}
                    >
                      <option value="">{t('clockingLocationPick')}</option>
                      {assignableLocations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.code} · {l.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('lat')}>
                    <input name="lat" type="number" step="any" required placeholder="3.1390" className={inputCls} />
                  </Field>
                  <Field label={t('lng')}>
                    <input name="lng" type="number" step="any" required placeholder="101.6869" className={inputCls} />
                  </Field>
                  <Field label={t('radius')}>
                    <input name="radiusM" type="number" min={1} step={1} required placeholder="150" className={inputCls} />
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
              )}
            </Card>
          );
        })
      )}
      <p className="px-1 text-xs text-muted-foreground">{t('clockingNote')}</p>
      <p className="px-1 text-xs text-muted-foreground">{t('radiusNote')}</p>
    </div>
  );
}
