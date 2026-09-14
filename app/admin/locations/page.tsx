import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listLocations, listUnmappedBranches } from '@/core/location';
import { listClockingLocations } from '@/core/clocking-location';
import { listProfileOptions } from '@/core/profile-options';
import { listHolidayGroups } from '@/core/admin';
// 0e276da0 (r269) — what a named calendar would COST the staff of a location attached to it. A pure
// presentational read; the resolver and the s.60D skip in core/holidays.ts are untouched.
import { holidayCalendarCoverage } from '@/core/holidays';
import { countryPacks } from '@/localization/registry';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { HolidayCoverageWarning } from '@/components/holiday-coverage-warning';
import {
  createLocationAction,
  updateLocationAction,
  archiveLocationAction,
  restoreLocationAction,
  archiveClockingLocationAction,
  restoreClockingLocationAction,
  deleteClockingLocationAction,
} from '../actions';
import { CLOCKING_NEW_PAGE, UUID_RE, clockingEditPage } from './clocking/form-fields';

/**
 * f9afd1ce rev 2 (r267) — THE CLOCKING REGISTER LEADS THIS PAGE. The "Clocking location" menu row
 * (packs/attendance/index.ts, nav.clockingLocation) opens this route, and until r267 it landed at the top
 * of a page whose upper half was the per-company holiday-calendar `location` register — the reporter
 * scrolled past it every time. The promise was "the row lands on the clocking list". A `#clocking`
 * fragment on the menu href was the planner's first idea and is the WRONG tool here: the sidebar's active
 * predicate (components/nav-flyout.tsx isHrefActive) splits hrefs on `?` only, so a fragment would stop
 * the row ever lighting up, and three exact-set nav guards pin the href verbatim (test/attendance-pack,
 * test/attendance-menu-relocation, test/sidebar-attendance-group). So the PAGE ORDER changed instead:
 * the shared clocking register renders first, the holiday-calendar register follows on the same page,
 * same route, same heading. Nothing about the `location` master moved — it is still here, still per
 * company, still edited inline as before; its own description sits above its cards now.
 *
 * ROWS ARE FOR READING. A clocking location is added and edited on a page of its own
 * (./clocking/new, ./clocking/[id]) in two sections; this list renders NO inline clocking form. Each row
 * carries Edit (a link), and Archive / Restore / Delete stay on the row as before. Save returns here with
 * `?saved=1&focus=<id>#row-<id>`: the saved note shows and the row is highlighted (the r265 idiom).
 */

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; focus?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  // 0e276da0 — the coverage sentence lives in its own namespace because the calendar's own screen says
  // exactly the same thing (components/holiday-coverage-warning.tsx is the single copy).
  const tc = await getTranslations('admin.holidayCoverage');
  const { error, saved, focus: rawFocus } = await searchParams;
  // `?focus=` addresses a uuid; junk is dropped rather than rendered (lib/calendar-focus.ts idiom).
  const focus = rawFocus && UUID_RE.test(rawFocus) ? rawFocus : undefined;

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const locations = await listLocations(s, visible.map((c) => c.id), { includeArchived: true });
  // Named holiday calendars (holiday_group rows) to populate the per-location Calendar dropdown (ADR-0067).
  const calendars = await listHolidayGroups(s);
  // 0e276da0 — ADR-0067 §custom: attaching a location to a Custom calendar gives its staff EXACTLY that
  // calendar's days and NO gazette, so an empty or thin one silently turns gazetted holidays into ordinary
  // working days (frozen attendance day-type ⇒ OT class, and the working-day leave count). Nothing warned,
  // because the s.60D completeness guard is deliberately skipped for Custom — correct for a populated
  // calendar, and that skip stays. This is the separate, presentational read: it WARNS, never refuses.
  const coverage = await holidayCalendarCoverage(s);
  const coverageById = new Map(coverage.map((c) => [c.groupId, c]));
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

  /**
   * 0e276da0 — the picker says what a calendar COSTS before it is chosen. A stand-alone (Custom)
   * calendar's option carries how many public holidays it holds this year and how many gazetted days it
   * leaves out; a Standard/Extended one reads exactly as it always did, because the gazette still applies
   * to it and it can never strip a day. Literal message keys (not a computed one) so
   * test/i18n-coverage.test.ts check C resolves every one of them.
   */
  const calendarOptionLabel = (calId: string, calName: string) => {
    const c = coverageById.get(calId);
    if (!c || !c.standalone) return calName;
    const summary =
      c.held === 0
        ? tc('summaryEmpty')
        : c.missing.length > 0
          ? tc('summaryMissing', { held: c.held, missing: c.missing.length })
          : tc('summaryComplete', { held: c.held });
    return `${calName} — ${summary}`;
  };

  // …and for a location that ALREADY carries a calendar, the full warning naming every gazetted day its
  // staff would work. Built here rather than inline so each row's JSX stays one expression.
  const calendarWarnings = new Map<string, ReactNode>();
  for (const l of locations) {
    const c = l.holidayGroupId ? coverageById.get(l.holidayGroupId) : undefined;
    if (c) calendarWarnings.set(l.id, <HolidayCoverageWarning coverage={c} className="mt-1 basis-full" />);
  }

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
          // From the row itself, not the scope-narrowed `locations` list — a location outside the
          // cookie scope would otherwise always read as live.
          archived: cl.locationArchivedAt != null,
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

  /**
   * ONE clocking location, READ-ONLY — the mockup's columns: name, report label, coordinates, radius,
   * "Used by", assigned count, address. For a GROUP admin the row also carries Edit (a link to the page
   * of its own) and the Archive / Restore / Delete forms; a COMPANY-SCOPED admin gets the same facts
   * and nothing to press.
   *
   * "Used by" and the assigned count are derived from employee_clocking_location, whose RLS is
   * can_see_employment — so a company admin's figures cover only the companies THEY manage, while the
   * note above says the site may be used by companies they do not. The captions say exactly that, rather
   * than a SECURITY DEFINER read widening what a company admin may see about other companies' staff.
   *
   * `id="row-<id>"` is what a Save / Cancel / Back lands on, and `?focus=` is what highlights it.
   */
  const pointRow = (cl: ClockingRow) => (
    <li
      key={cl.id}
      id={`row-${cl.id}`}
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-3 text-sm ${cl.archivedAt ? 'opacity-60' : ''} ${cl.id === focus ? 'bg-muted/50' : ''}`}
    >
      <span className="min-w-[10rem] font-medium">{cl.name}</span>
      {/* f9afd1ce rev 2 — the Attendance report's short name, when set. The list keeps printing the name. */}
      {cl.reportLabel && (
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          <span className="uppercase tracking-wide">{t('reportLabel')}</span> {cl.reportLabel}
        </span>
      )}
      <span className="text-muted-foreground">
        <span className="text-xs uppercase tracking-wide">{t('coordinates')}</span> {cl.lat}, {cl.lng}
      </span>
      <span className="text-muted-foreground">
        <span className="text-xs uppercase tracking-wide">{t('radius')}</span>{' '}
        {cl.radiusM != null ? t('radiusMetres', { radius: cl.radiusM }) : '—'}
      </span>
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className="text-xs uppercase tracking-wide">{groupAdmin ? t('usedBy') : t('usedByManaged')}</span>
        {usedBy(cl)}
      </span>
      <span className="text-xs text-muted-foreground">
        {groupAdmin ? t('assignedCount', { count: cl.assignedCount }) : t('assignedCountManaged', { count: cl.assignedCount })}
      </span>
      {/* r272 (0e8cf366) — STATUS IS ALWAYS STATED. An archived row carried a badge and a live one
          carried nothing, so "Active" was conveyed only by the ABSENCE of a badge plus 60% opacity on its
          neighbours — which is not a status a reader can point at, and the reporter asked for one they
          could. Same two strings the location group heading above already uses. */}
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
          cl.archivedAt ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'
        }`}
      >
        {cl.archivedAt ? t('statusArchived') : t('statusActive')}
      </span>
      {/* r272 — A WAY IN FOR A COMPANY ADMIN. The detail page already renders a read-only fact list for
          anyone who is not a group admin (clocking/[id]/page.tsx:48-57) — nothing linked to it, so the
          only readers who could open a site were the ones allowed to change it. */}
      {!groupAdmin && (
        <span className="ml-auto flex items-center gap-2">
          <Link href={clockingEditPage(cl.id)} className={btnGhost}>
            {t('view')}
          </Link>
        </span>
      )}
      {groupAdmin && (
        <span className="ml-auto flex items-center gap-2">
          {/* Edit opens the page of its own; nothing on this row is typed into. */}
          <Link href={clockingEditPage(cl.id)} className={btnGhost}>
            {t('edit')}
          </Link>
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
        </span>
      )}
      {cl.address && <span className="basis-full text-xs text-muted-foreground">{cl.address}</span>}
    </li>
  );

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('pageTitle')} />
      <ErrorBanner message={error} />

      {/* ADR-0070 — Clocking Location Management. Deliberately a SEPARATE register from the holiday-calendar
          locations below (see ADR-0070 §1). f9afd1ce — ONE tenant-level block, not one per company: a
          clocking location is created once and available to every company. rev 2 — FIRST on the page (see
          the file header), rows are read-only, and Add / Edit open the page of its own. */}
      <div className="pt-2">
        <PageHeader title={t('clockingHeading')} description={t('clockingDescription')} />
      </div>

      {/* `saved=1` is what the page's Save returns with; a refusal never lands here. */}
      {!error && saved ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('saved')}
        </p>
      ) : null}

      <Card className="overflow-hidden">
        {/* SectionHeader has no actions slot, so the section title and the Add button share one flex header
            row in the header's own classes; a company-scoped admin sees the title alone. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-sm font-medium">
          <span>
            {t('clockingSharedTitle')}
            <span className="ml-2 text-muted-foreground">({clockingLocations.length})</span>
          </span>
          {groupAdmin && (
            <Link href={CLOCKING_NEW_PAGE} className={btnPrimary}>
              {t('addClocking')}
            </Link>
          )}
        </div>

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
                  {/* r272 (0e8cf366) — THE COMPANY NAME IS GONE FROM THIS HEADING. A clocking site has had
                      no company since migration 0459; what it optionally links to is a `location`, which
                      IS company-scoped, and printing that company here made the whole register read as
                      company configuration. That reading is the premise of the reporter's redesign
                      request — they asked us to remove a dependency that exists only in this heading.
                      The location's own code and name stay: those identify the group. */}
                  <span>
                    {g.code} · {g.name}
                  </span>
                  <span className="rounded-full bg-background px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                    {g.archived ? t('statusArchived') : t('statusActive')}
                  </span>
                </div>
                {g.rows.length === 0 ? (
                  /* EMPTY STATE (spec section E, state 3): the location exists but nobody has dropped a
                     gate under it, so nobody can clock in at THIS site however it is assigned. The way
                     OUT of the empty state sits inside it — for a group admin, the link opens the new
                     page with this location already picked (a GET; nothing is written). A company admin
                     has no page to open, so they get the sentence alone. */
                  <p className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                    {t('groupNoPoints')}
                    {groupAdmin && (
                      /* btnGhost's tokens at this row's xs scale — the mockup draws a small bordered
                         button here, and h-9 would double the height of the row. */
                      <Link
                        href={`${CLOCKING_NEW_PAGE}?addPoint=${g.id}`}
                        className="inline-flex h-7 items-center rounded-md border border-input px-2 text-xs font-medium transition duration-150 ease-snappy hover:bg-accent hover:text-accent-foreground"
                      >
                        {t('addPointCta')}
                      </Link>
                    )}
                  </p>
                ) : (
                  <ul>{g.rows.map(pointRow)}</ul>
                )}
              </div>
            ))}

            {/* Linked to a location this caller cannot see: `location` is admin-only-read per company,
                this register is tenant-wide. Rendered as its own group so a company admin never reads a
                sister company's site as "unlinked". */}
            {linkedOutOfScope.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-dashed border-border">
                <div className="bg-muted px-3 py-2 text-sm font-medium">{t('linkedOutOfScopeGroupTitle')}</div>
                <ul>{linkedOutOfScope.map(pointRow)}</ul>
              </div>
            )}

            {/* f9afd1ce — the link is OPTIONAL now, so this group is a normal home, not a legacy net. */}
            {unlinked.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-dashed border-border">
                <div className="bg-muted px-3 py-2 text-sm font-medium">{t('unlinkedGroupTitle')}</div>
                <ul>{unlinked.map(pointRow)}</ul>
              </div>
            )}
          </div>
        )}
      </Card>
      <p className="px-1 text-xs text-muted-foreground">{t('clockingNote')}</p>
      <p className="px-1 text-xs text-muted-foreground">{t('radiusNote')}</p>

      {/* The per-company holiday-calendar `location` register — unchanged, below the clocking register
          since r267 (see the file header). Its description moved down with it. */}
      <p className="px-1 pt-4 text-sm text-muted-foreground">{t('pageDescription')}</p>

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
                                {calendarOptionLabel(cal.id, cal.name)}
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
                      {/* 0e276da0 — beside the picker, for the calendar this location is attached to
                          RIGHT NOW: the days its staff would work. A warning, never a block. */}
                      {calendarWarnings.get(l.id)}
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
                        {calendarOptionLabel(cal.id, cal.name)}
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
    </div>
  );
}
