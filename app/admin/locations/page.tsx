import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
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
  // `location` list above (see ADR-0070 §1 for why). f9afd1ce (migration 0459): a SHARED, TENANT-LEVEL
  // register — no company parameter, every site in the tenant, rendered ONCE below the per-company
  // location sections rather than once per company. Tenant-catalog read (RLS lets every tenant member
  // through), but this admin-only route only ever renders it for an admin.
  const clockingLocations = await listClockingLocations(s, { includeArchived: true });
  // f9afd1ce — WRITE authority is the group administrator's (core assertGroupAdmin + RLS
  // app.is_group_admin()). The create/edit/archive/delete forms render for group admins only; a
  // company-scoped admin sees the register read-only plus a one-line note. requireAdmin stays the page
  // guard: company admins still manage their own `location` rows above and still assign sites on the
  // personnel page.
  const groupAdmin = isGroupAdmin(s);
  // The location picker for the shared forms: every LIVE location the caller can see. Deliberately NOT the
  // scope-cookie-narrowed `visible` list — the link may point at any company's location, and a group
  // admin's RLS on `location` reaches every company.
  const linkableLocations = groupAdmin ? await listLocations(s, [], {}) : [];

  // 1fff489c — clocking points sit GROUPED under the location they are linked to (the mockup's "HQ · North
  // Gate / South Gate" reading) so a compound with two entrances reads as one site. Three buckets, decided
  // per row, because the link is now OPTIONAL and `location` is admin-only-read while this register is
  // tenant-wide:
  //   • locationId set AND the location resolved → under that location (code · name · company heading);
  //   • locationId set BUT the location came back null → linked to a location this caller's RLS cannot
  //     see (another company's, for a company-scoped admin). Its OWN group, so it is never mistaken for
  //     "unlinked" and never silently re-homed by a Save;
  //   • locationId null → the "Not linked to a location" group.
  type ClockingRow = (typeof clockingLocations)[number];
  type Group = { id: string; code: string; name: string; companyName: string | null; archived: boolean; rows: ClockingRow[] };
  const byLinkedLocation = new Map<string, Group>();
  const linkedOutOfScope: ClockingRow[] = [];
  const unlinked: ClockingRow[] = [];
  for (const cl of clockingLocations) {
    if (!cl.locationId) unlinked.push(cl);
    else if (cl.locationCode == null) linkedOutOfScope.push(cl);
    else {
      const g = byLinkedLocation.get(cl.locationId);
      if (g) g.rows.push(cl);
      else {
        byLinkedLocation.set(cl.locationId, {
          id: cl.locationId,
          code: cl.locationCode,
          name: cl.locationName ?? '',
          companyName: cl.locationCompanyName,
          archived: locations.some((l) => l.id === cl.locationId && !!l.archivedAt),
          rows: [cl],
        });
      }
    }
  }
  // EMPTY GROUPS: every LIVE location in the caller's scope that holds no point yet still gets a heading,
  // so the way out of that empty state ("Add a clocking point") stays where 1fff489c put it. An archived
  // location appears only while it holds points (its history stays reachable); an archived, empty one is
  // nobody's concern on this screen.
  for (const l of locations) {
    if (!l.archivedAt && !byLinkedLocation.has(l.id)) {
      byLinkedLocation.set(l.id, { id: l.id, code: l.code, name: l.name, companyName: l.companyName, archived: false, rows: [] });
    }
  }
  const groups = [...byLinkedLocation.values()].sort(
    (a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name),
  );

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

  /** The "Used by" chips (f9afd1ce mockup): the companies whose employees are assigned here; a dash when none. */
  const usedBy = (cl: ClockingRow) =>
    cl.usedByCompanies.length === 0 ? (
      <span className="text-xs text-muted-foreground">—</span>
    ) : (
      <span className="flex flex-wrap gap-1">
        {cl.usedByCompanies.map((name) => (
          <span key={name} className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {name}
          </span>
        ))}
      </span>
    );

  /** A clocking point as a COMPANY-SCOPED admin sees it: the mockup's columns, nothing editable. */
  const readOnlyPointRow = (cl: ClockingRow) => (
    <li
      key={cl.id}
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-3 text-sm ${cl.archivedAt ? 'opacity-60' : ''}`}
    >
      <span className="min-w-[10rem] font-medium">{cl.name}</span>
      <span className="text-muted-foreground">
        <span className="text-xs uppercase tracking-wide">{t('coordinates')}</span> {cl.lat}, {cl.lng}
      </span>
      <span className="text-muted-foreground">
        <span className="text-xs uppercase tracking-wide">{t('radius')}</span>{' '}
        {cl.radiusM != null ? t('radiusMetres', { radius: cl.radiusM }) : '—'}
      </span>
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className="text-xs uppercase tracking-wide">{t('usedBy')}</span>
        {usedBy(cl)}
      </span>
      <span className="text-xs text-muted-foreground">{t('assignedCount', { count: cl.assignedCount })}</span>
      {cl.archivedAt && (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
          {t('statusArchived')}
        </span>
      )}
      {cl.address && <span className="basis-full text-xs text-muted-foreground">{cl.address}</span>}
    </li>
  );

  /** One clocking point for a GROUP admin: the inline edit form plus its archive / restore / delete controls. */
  const pointRow = (cl: ClockingRow) => {
    // A link the picker cannot offer (an archived location — a group admin sees every company's live
    // rows) is kept as its own option so a plain Save cannot silently unlink the point. The service still
    // refuses an archived link on save, and says so; the form just never LIES about what is linked.
    const linkNotOffered = cl.locationId != null && !linkableLocations.some((l) => l.id === cl.locationId);
    return (
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
          {/* f9afd1ce — OPTIONAL, and any company's location: a site shared by five companies cannot be
              required to belong to one company's holiday-calendar record. */}
          <Field label={t('clockingLocationLinkOptional')}>
            <select name="locationId" defaultValue={cl.locationId ?? ''} className={`${inputCls} min-w-[10rem]`}>
              <option value="">{t('clockingLocationNone')}</option>
              {linkNotOffered && (
                <option value={cl.locationId ?? ''}>
                  {cl.locationCode ?? '?'} · {cl.locationName ?? '?'} · {t('statusArchived')}
                </option>
              )}
              {linkableLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} · {l.name} · {l.companyName}
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
          <span className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
            <span className="uppercase tracking-wide">{t('usedBy')}</span>
            {usedBy(cl)}
          </span>
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
  };
  const renderRow = groupAdmin ? pointRow : readOnlyPointRow;

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
          locations above (see ADR-0070 §1). f9afd1ce — ONE tenant-level block, not one per company: a
          clocking location is created once and available to every company. Plain numeric lat/lng inputs —
          a map picker is Phase 2 and its own item. */}
      <div className="pt-2">
        <PageHeader title={t('clockingHeading')} description={t('clockingDescription')} />
      </div>
      <Card className="overflow-hidden">
        <SectionHeader title={t('clockingSharedTitle')} count={clockingLocations.length} />

        {!groupAdmin && (
          <p className="border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            {t('sharedManagedByGroupAdmin')}
          </p>
        )}

        {clockingLocations.length === 0 && groups.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('noSharedSites')}</p>
        )}

        {(groups.length > 0 || linkedOutOfScope.length > 0 || unlinked.length > 0) && (
          <div className="space-y-3 p-4">
            {groups.map((g) => (
              <div key={g.id} className="overflow-hidden rounded-lg border border-border">
                <div className="flex flex-wrap items-center gap-2 bg-muted px-3 py-2 text-sm font-medium">
                  <span>
                    {g.code} · {g.name}
                    {g.companyName ? ` · ${g.companyName}` : ''}
                  </span>
                  <span className="rounded-full bg-background px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                    {g.archived ? t('statusArchived') : t('statusActive')}
                  </span>
                </div>
                {g.rows.length === 0 ? (
                  /* EMPTY STATE (spec section E, state 3): the location exists but nobody has dropped a
                     gate under it, so nobody can clock in at THIS site however it is assigned. The way
                     OUT of the empty state sits inside it — for a group admin, the link jumps to the
                     create form below with this location already picked (a GET; nothing is written).
                     A company admin has no form to jump to, so they get the sentence alone. */
                  <p className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                    {t('groupNoPoints')}
                    {groupAdmin && (
                      /* btnGhost's tokens at this row's xs scale — the mockup draws a small bordered
                         button here, and h-9 would double the height of the row. */
                      <Link
                        href={`/admin/locations?addPoint=${g.id}#clocking-form`}
                        className="inline-flex h-7 items-center rounded-md border border-input px-2 text-xs font-medium transition duration-150 ease-snappy hover:bg-accent hover:text-accent-foreground"
                      >
                        {t('addPointCta')}
                      </Link>
                    )}
                  </p>
                ) : (
                  <ul>{g.rows.map(renderRow)}</ul>
                )}
              </div>
            ))}

            {/* Linked to a location this caller cannot see: `location` is admin-only-read per company,
                this register is tenant-wide. Rendered as its own group so a company admin never reads a
                sister company's site as "unlinked". */}
            {linkedOutOfScope.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-dashed border-border">
                <div className="bg-muted px-3 py-2 text-sm font-medium">{t('linkedOutOfScopeGroupTitle')}</div>
                <ul>{linkedOutOfScope.map(renderRow)}</ul>
              </div>
            )}

            {/* f9afd1ce — the link is OPTIONAL now, so this group is a normal home, not a legacy net. */}
            {unlinked.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-dashed border-border">
                <div className="bg-muted px-3 py-2 text-sm font-medium">{t('unlinkedGroupTitle')}</div>
                <ul>{unlinked.map(renderRow)}</ul>
              </div>
            )}
          </div>
        )}

        {groupAdmin && (
          <form
            action={createClockingLocationAction}
            id="clocking-form"
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
            <Field label={t('name')}>
              <input name="name" required placeholder={t('clockingNamePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('clockingLocationLinkOptional')}>
              {/* Pre-picked when the admin arrived from an empty group's "Add a clocking point" link,
                  and only ever to a location this form can accept. Every LIVE location the caller can
                  see, across companies — the link is optional and not company-bound. */}
              <select
                name="locationId"
                defaultValue={linkableLocations.some((l) => l.id === addPoint) ? addPoint : ''}
                className={inputCls}
              >
                <option value="">{t('clockingLocationNone')}</option>
                {linkableLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} · {l.name} · {l.companyName}
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
      <p className="px-1 text-xs text-muted-foreground">{t('clockingNote')}</p>
      <p className="px-1 text-xs text-muted-foreground">{t('radiusNote')}</p>
    </div>
  );
}
