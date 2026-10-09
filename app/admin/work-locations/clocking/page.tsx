import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listClockingLocations } from '@/packs/attendance/service';
import { listLocations, listUnmappedBranches } from '@/core/location';
import {
  Card,
  ErrorBanner,
  PageHeader,
  btnGhost,
  btnPrimary,
  inputCls,
  pageWideCls,
} from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { SectionCard, noteCls, typeHelpCls, typeLabelCls } from '@/components/ui/section-card';
import { StackedBody, StackedHead, StackedRow, StackedTable, StackedTd, StackedTh } from '@/components/ui/stacked-table';
import { StatusWord } from '@/components/ui/status-word';
import { withWorkLocationsFrom } from '@/lib/return-to';
import { archiveClockingLocationAction, restoreClockingLocationAction } from '../../actions';
import { CLOCKING_LIST, CLOCKING_NEW_PAGE, UUID_RE, clockingEditPage, clockingViewPage } from './form-fields';
import { LOCATION_NEW_PAGE, locationEditPage, locationViewPage } from '../location-fields';

/**
 * r428 (83c0d3c8 contest) — ATTENDANCE › LOCATIONS, REBUILT COMPANY-FIRST.
 *
 * The reporter contested r423's clocking list: every company and every location detail on one screen,
 * under a COMPANIES column that is one chip per company — unreadable once an organisation has more than a
 * couple, and the shape does not scale. Their ask (and the second half of the same contest): fold the
 * separate "Work Locations" menu row into this one, so Locations is the single place for both kinds.
 *
 * TWO STEPS, ONE ROUTE (ADR-0070 note — browsing is company-first now; CREATING stays location-first, the
 * r423 behaviour, untouched: "+ New Clocking Location" still opens one form and ticks the companies
 * allowed to use it, exactly as before).
 *   STEP 1 — no `?company=`, or one that names nothing this caller can see: the COMPANY LIST. One line per
 *     company — Company · Clocking Locations (count, inactive split) · Work Locations (count, archived
 *     split) · View Locations — plus, for a group administrator only, "Not open to any company" when a
 *     clocking location has lost every company it was open to (clocking_location_company can empty out
 *     when the last company on a shared location is deleted; the location itself is never deleted with
 *     it, so it must stay findable). A search box matches a company's own name or any location name it can
 *     see — in memory, over what step 1 already loaded; nothing about who may READ moves out of the query.
 *   STEP 2 — `?company=<id>` (validated against `listCompanies(s, { adminOnly: true })`, a COMPARISON never
 *     a query, exactly the r423 rule) or the literal `?company=none` (group administrators only — the same
 *     orphan locations, requested directly): the company's own two sections, Clocking locations (today's
 *     table, minus the Company filter the company itself now IS, and minus the chip list — replaced by a
 *     short "Shared With" column) and Work locations (today's `/admin/work-locations` listing, scoped to
 *     one company — no more `rowSpan`, because there is only one company in view: STATUS IS A REAL COLUMN
 *     per row now, not a derived company-level word, which is why `statusLegend` retires with it).
 *
 * WHO SEES WHAT is unchanged — decided in the query, not here. A group administrator sees every company
 * and every count; a company administrator sees only the companies they administer, the counts for those
 * companies, and on "Shared With" only the OTHER administered companies by NAME, never a count that would
 * imply knowledge of a company they cannot see (plan point 13). Write authority is untouched: only a group
 * administrator creates, edits or deactivates a clocking location; a work location is company master data,
 * requireAdmin + RLS `app.is_admin_for(company_id)`, same as it always was.
 *
 * NOTHING ABOUT DATA, PERMISSIONS OR CLOCKING MOVES. Every read below still goes through the pack's
 * published facade (`packs/attendance/service`) for clocking, and `core/location` directly for the work
 * spine — the same two sources r423 and r338 read, in the same files that have always owned the ratchet
 * claim.
 */
export default async function ClockingLocationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
  const groupAdmin = isGroupAdmin(s);

  const companies = (await listCompanies(s, { adminOnly: true }))
    .map((c) => ({ id: c.id, name: c.companyLabel ?? c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // r428 — `?company=` is honoured ONLY when it names a company this caller administers (a comparison,
  // never a query — the r423 rule, carried over), or is the literal `'none'` for a group administrator.
  // Anything else — absent, foreign, or garbage — falls back to step 1, the company list.
  const rawCompany = one('company');
  const companyParam: string | undefined =
    rawCompany === 'none' && groupAdmin ? 'none' : companies.some((c) => c.id === rawCompany) ? rawCompany : undefined;

  // Called directly and awaited, NOT instantiated as JSX (`<CompanyView .../>`): an async function
  // component rendered as JSX only resolves under a Suspense boundary, which `renderToStaticMarkup`
  // (test/clocking-location-page.test.ts, test/work-location-organization-relocation.test.ts) cannot
  // satisfy synchronously — the same reason ClockingLocationForm stays a plain sync function.
  if (companyParam) {
    return await CompanyView({ s, t, groupAdmin, companies, companyId: companyParam, one });
  }
  return await CompanyList({ s, t, groupAdmin, companies, one });
}

/** ────────────────────────────────── STEP 1 — THE COMPANY LIST ────────────────────────────────── */

async function CompanyList({
  s,
  t,
  groupAdmin,
  companies,
  one,
}: {
  s: Awaited<ReturnType<typeof requireAdmin>>;
  t: (key: string, values?: Record<string, string | number>) => string;
  groupAdmin: boolean;
  companies: { id: string; name: string }[];
  one: (k: string) => string;
}) {
  const q = one('q').slice(0, 200).trim();
  const qLower = q.toLowerCase();
  // A save with no company context (the top-level "+ New Clocking Location" button, or an edit reached
  // with no `?company=`) lands HERE rather than on a company's own row — there is none to highlight on a
  // company list, but the operator must still be told the save happened rather than seeing nothing at
  // all. `focus` is read and dropped: no row on this screen carries that id.
  const error = one('error') || undefined;
  const saved = one('saved') || undefined;
  const toast = one('toast') || undefined;

  // Every clocking location this caller can see (status 'all': the count on screen must include the
  // inactive ones, split out, not hide them). One query; grouped below per company AND used to find the
  // orphans — valid ONLY for a group admin, whose `companies` arrays carry every true member (no RLS
  // narrowing); a company admin's `companies` arrays can never come back empty (the base query already
  // requires at least one administered company to exist), so this branch is never reached for one.
  const clockingRows = await listClockingLocations(s, { status: 'all' });
  const workRows = await listLocations(s, companies.map((c) => c.id), { includeArchived: true });

  const clockingByCompany = new Map<string, { total: number; inactive: number }>();
  for (const row of clockingRows) {
    for (const c of row.companies) {
      const agg = clockingByCompany.get(c.id) ?? { total: 0, inactive: 0 };
      agg.total += 1;
      if (row.archivedAt) agg.inactive += 1;
      clockingByCompany.set(c.id, agg);
    }
  }
  const workByCompany = new Map<string, { total: number; archived: number }>();
  for (const row of workRows) {
    const agg = workByCompany.get(row.companyId) ?? { total: 0, archived: 0 };
    agg.total += 1;
    if (row.archivedAt) agg.archived += 1;
    workByCompany.set(row.companyId, agg);
  }
  const orphanRows = groupAdmin ? clockingRows.filter((r) => r.companies.length === 0) : [];

  const matches = (haystack: string) => haystack.toLowerCase().includes(qLower);
  const companyMatches = (companyId: string, companyName: string): boolean => {
    if (!q) return true;
    if (matches(companyName)) return true;
    if (clockingRows.some((r) => r.companies.some((c) => c.id === companyId) && matches(r.name))) return true;
    if (workRows.some((r) => r.companyId === companyId && matches(r.name))) return true;
    return false;
  };
  const visibleCompanies = companies.filter((c) => companyMatches(c.id, c.name));
  const orphanVisible = orphanRows.length > 0 && (!q || orphanRows.some((r) => matches(r.name)) || matches(t('orphanCompanyName')));

  const clockingTotal = clockingRows.length;
  const workTotal = workRows.length;

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('pageTitle')}
        description={t('companyListDescription')}
        actions={
          groupAdmin ? (
            <Link href={CLOCKING_NEW_PAGE} className={btnPrimary}>
              {t('newClockingCta')}
            </Link>
          ) : undefined
        }
      />
      <ErrorBanner message={error} />
      {!error && saved ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {toast ?? t('saved')}
        </p>
      ) : null}

      <SectionCard index={1} title={t('findCompanySection')}>
        <form method="get" action={CLOCKING_LIST} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={typeLabelCls}>{t('searchLabel')}</span>
            <input type="search" name="q" defaultValue={q} placeholder={t('companySearchPlaceholder')} className={inputCls} />
          </label>
          <button className={btnGhost}>{t('applyFilters')}</button>
        </form>
      </SectionCard>

      <SectionCard index={2} title={t('companiesSection')} aside={t('companiesCount', { count: companies.length })}>
        {visibleCompanies.length === 0 && !orphanVisible ? (
          <p className={`px-1 py-6 ${typeHelpCls}`}>{t('noMatches')}</p>
        ) : (
          <StackedTable label={t('companiesSection')}>
            <StackedHead>
              <StackedTh>{t('colCompany')}</StackedTh>
              <StackedTh>{t('colClockingLocations')}</StackedTh>
              <StackedTh>{t('colWorkLocations')}</StackedTh>
              <StackedTh className="text-right">{t('colAction')}</StackedTh>
            </StackedHead>
            <StackedBody>
              {visibleCompanies.map((c) => {
                const clocking = clockingByCompany.get(c.id) ?? { total: 0, inactive: 0 };
                const work = workByCompany.get(c.id) ?? { total: 0, archived: 0 };
                return (
                  <StackedRow key={c.id} className="align-top">
                    <StackedTd label={t('colCompany')} role="title">
                      {c.name}
                    </StackedTd>
                    <StackedTd label={t('colClockingLocations')}>
                      {clocking.total === 0 ? (
                        <span className="text-muted-foreground">{t('noneYet')}</span>
                      ) : (
                        <>
                          <span>{t('locationsCountLabel', { count: clocking.total })}</span>
                          {clocking.inactive > 0 && (
                            <span className={`block ${typeHelpCls}`}>{t('inactiveCountNote', { count: clocking.inactive })}</span>
                          )}
                        </>
                      )}
                    </StackedTd>
                    <StackedTd label={t('colWorkLocations')}>
                      {work.total === 0 ? (
                        <span className="text-muted-foreground">{t('noneYet')}</span>
                      ) : (
                        <>
                          <span>{t('locationsCountLabel', { count: work.total })}</span>
                          {work.archived > 0 && (
                            <span className={`block ${typeHelpCls}`}>{t('archivedCountNote', { count: work.archived })}</span>
                          )}
                        </>
                      )}
                    </StackedTd>
                    <StackedTd label={t('colAction')} role="full" hideLabel className="@max-3xl:mt-2">
                      <Link href={`${CLOCKING_LIST}?company=${c.id}`} className="text-primary hover:underline">
                        {t('viewLocationsCta')}
                      </Link>
                    </StackedTd>
                  </StackedRow>
                );
              })}
              {orphanVisible && (
                <StackedRow id="company-none" className="align-top">
                  <StackedTd label={t('colCompany')} role="title">
                    {t('orphanCompanyName')}
                    <span className={`block font-normal ${typeHelpCls}`}>{t('orphanRowNote')}</span>
                  </StackedTd>
                  <StackedTd label={t('colClockingLocations')}>{t('locationsCountLabel', { count: orphanRows.length })}</StackedTd>
                  <StackedTd label={t('colWorkLocations')}>
                    <span className="text-muted-foreground">—</span>
                  </StackedTd>
                  <StackedTd label={t('colAction')} role="full" hideLabel className="@max-3xl:mt-2">
                    <Link href={`${CLOCKING_LIST}?company=none`} className="text-primary hover:underline">
                      {t('viewLocationsCta')}
                    </Link>
                  </StackedTd>
                </StackedRow>
              )}
            </StackedBody>
          </StackedTable>
        )}
        <div className={`mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2 ${typeHelpCls}`}>
          <span>{t('locationsTotalSummary', { clockingTotal, workTotal })}</span>
          <span>{t('sharedCountNote')}</span>
        </div>
      </SectionCard>

      <p className={noteCls}>{t('companyListNote')}</p>
    </div>
  );
}

/** ────────────────────────────── STEP 2 — ONE COMPANY'S OWN VIEW ────────────────────────────── */

async function CompanyView({
  s,
  t,
  groupAdmin,
  companies,
  companyId,
  one,
}: {
  s: Awaited<ReturnType<typeof requireAdmin>>;
  t: (key: string, values?: Record<string, string | number>) => string;
  groupAdmin: boolean;
  companies: { id: string; name: string }[];
  companyId: string;
  one: (k: string) => string;
}) {
  const companyName = companyId === 'none' ? t('orphanCompanyName') : companies.find((c) => c.id === companyId)!.name;
  const focus = UUID_RE.test(one('focus')) ? one('focus') : undefined;
  const saved = one('saved') || undefined;
  const error = one('error') || undefined;
  const toast = one('toast') || undefined;
  const q = one('q').slice(0, 200);
  const status = (['active', 'inactive'] as const).find((v) => v === one('status')) ?? 'all';

  const clockingRows = await listClockingLocations(s, { status, q, companyId });
  const clockingActive = clockingRows.filter((r) => !r.archivedAt).length;

  const isOrphan = companyId === 'none';
  const workRows = isOrphan ? [] : await listLocations(s, [companyId], { includeArchived: true });
  const workArchived = workRows.filter((l) => l.archivedAt).length;
  const unmappedBranches = isOrphan ? [] : await listUnmappedBranches(s, [companyId]);
  // Both kinds of save land here now, each with its own confirmation sentence (and, for a work location,
  // its own key — `locationSaved`, from the former standalone listing). `focus` says which record it
  // was, against the two lists this render already loaded — never a third query to find out.
  const savedWork = saved && focus != null && workRows.some((l) => l.id === focus);

  /** This screen as the operator is standing on it, so every way out of a work-location screen can come
   *  back to exactly here — the r338 `here`/`withFrom` idiom, ported from the former standalone listing. */
  const here = (() => {
    const params = new URLSearchParams();
    params.set('company', companyId);
    if (q) params.set('q', q);
    if (status !== 'all') params.set('status', status);
    if (saved) params.set('saved', saved);
    if (focus) params.set('focus', focus);
    return `${CLOCKING_LIST}?${params.toString()}`;
  })();
  const withFrom = (dest: string) => withWorkLocationsFrom(dest, here);

  const sharedWith = (rowCompanies: { id: string; name: string }[]): string => {
    const others = rowCompanies.filter((c) => c.id !== companyId);
    if (others.length === 0) return t('notShared');
    return groupAdmin ? t('otherCompaniesCount', { count: others.length }) : others.map((c) => c.name).join(', ');
  };

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={companyName}
        description={isOrphan ? undefined : t('companyViewDescription')}
        back={{ href: CLOCKING_LIST, label: t('backToAllCompanies') }}
        actions={
          groupAdmin ? (
            <Link href={`${CLOCKING_NEW_PAGE}${isOrphan ? '' : `?company=${companyId}`}`} className={btnPrimary}>
              {t('newClockingCta')}
            </Link>
          ) : undefined
        }
      />
      <ErrorBanner message={error} />
      {!error && saved ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {toast ?? (savedWork ? t('locationSaved') : t('saved'))}
        </p>
      ) : null}

      <SectionCard index={1} title={t('clockingLocationsSection')} description={t('clockingSectionDescription')}>
        {!groupAdmin && <p className={`mb-3 ${typeHelpCls}`}>{t('companyAdminReadOnly')}</p>}

        <form method="get" action={CLOCKING_LIST} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <input type="hidden" name="company" value={companyId} />
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={typeLabelCls}>{t('searchLabel')}</span>
            <input type="search" name="q" defaultValue={q} placeholder={t('searchPlaceholder')} className={inputCls} />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={typeLabelCls}>{t('colStatus')}</span>
            <select name="status" defaultValue={status} className={inputCls}>
              <option value="all">{t('statusAll')}</option>
              <option value="active">{t('statusActive')}</option>
              <option value="inactive">{t('statusInactive')}</option>
            </select>
          </label>
          <button className={btnGhost}>{t('applyFilters')}</button>
        </form>

        {clockingRows.length === 0 ? (
          <p className={typeHelpCls}>{q || status !== 'all' ? t('noMatches') : t('noSharedSites')}</p>
        ) : (
          <StackedTable label={t('clockingLocationsSection')}>
            <StackedHead>
              <StackedTh>{t('locationName')}</StackedTh>
              <StackedTh>{t('address')}</StackedTh>
              <StackedTh>{t('colState')}</StackedTh>
              <StackedTh>{t('gpsCoordinates')}</StackedTh>
              <StackedTh>{t('geofencingRadius')}</StackedTh>
              <StackedTh>{t('colSharedWith')}</StackedTh>
              <StackedTh>{t('colStatus')}</StackedTh>
              <StackedTh className="text-right">{t('colActions')}</StackedTh>
            </StackedHead>
            <StackedBody>
              {clockingRows.map((cl) => {
                const viewHref = `${clockingViewPage(cl.id)}${isOrphan ? '' : `?company=${companyId}`}`;
                const editHref = `${clockingEditPage(cl.id)}${isOrphan ? '' : `?company=${companyId}`}`;
                return (
                  <StackedRow key={cl.id} id={`row-${cl.id}`} className={cl.id === focus ? 'bg-muted/50' : ''}>
                    <StackedTd label={t('locationName')} role="title">
                      {cl.name}
                      {cl.reportLabel ? <span className={`block font-normal ${typeHelpCls}`}>{cl.reportLabel}</span> : null}
                    </StackedTd>
                    <StackedTd label={t('address')} className="text-muted-foreground">
                      {cl.address ?? '—'}
                    </StackedTd>
                    <StackedTd label={t('colState')}>{cl.state ?? '—'}</StackedTd>
                    <StackedTd label={t('gpsCoordinates')} className="tabular-nums">
                      {cl.lat}, {cl.lng}
                    </StackedTd>
                    <StackedTd label={t('geofencingRadius')} className="tabular-nums">
                      {cl.radiusM != null ? t('radiusMetres', { radius: cl.radiusM }) : '—'}
                    </StackedTd>
                    <StackedTd label={t('colSharedWith')}>{sharedWith(cl.companies)}</StackedTd>
                    <StackedTd label={t('colStatus')} role="aside" hideLabel>
                      <StatusWord
                        tone={cl.archivedAt ? 'mid' : 'ink'}
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${cl.archivedAt ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}
                      >
                        {cl.archivedAt ? t('statusInactive') : t('statusActive')}
                      </StatusWord>
                    </StackedTd>
                    <StackedTd label={t('colActions')} role="full" hideLabel>
                      <span className="inline-flex flex-wrap items-center justify-end gap-2 @max-3xl:justify-start">
                        <Link href={viewHref} className="text-primary hover:underline">
                          {t('view')}
                        </Link>
                        {groupAdmin && (
                          <>
                            <span className="text-muted-foreground">|</span>
                            <Link href={editHref} className="text-primary hover:underline">
                              {t('edit')}
                            </Link>
                            <span className="text-muted-foreground">|</span>
                            {cl.archivedAt ? (
                              <form action={restoreClockingLocationAction}>
                                <input type="hidden" name="clockingLocationId" value={cl.id} />
                                {!isOrphan && <input type="hidden" name="returnCompany" value={companyId} />}
                                <button className="text-primary hover:underline">{t('activate')}</button>
                              </form>
                            ) : (
                              <form action={archiveClockingLocationAction}>
                                <input type="hidden" name="clockingLocationId" value={cl.id} />
                                {!isOrphan && <input type="hidden" name="returnCompany" value={companyId} />}
                                <ConfirmSubmit
                                  title={t('deactivateConfirmTitle')}
                                  description={t('deactivateConfirmDescription', { name: cl.name, count: cl.assignedCount })}
                                  confirmLabel={t('deactivate')}
                                  size="sm"
                                  variant="ghost"
                                >
                                  {t('deactivate')}
                                </ConfirmSubmit>
                              </form>
                            )}
                          </>
                        )}
                      </span>
                    </StackedTd>
                  </StackedRow>
                );
              })}
            </StackedBody>
          </StackedTable>
        )}
        <div className={`mt-3 flex flex-wrap justify-between gap-2 ${typeHelpCls}`}>
          <span>{t('clockingSummary', { total: clockingRows.length, active: clockingActive })}</span>
          <span>{t('inactiveNote')}</span>
        </div>
        <p className={`mt-1 ${typeHelpCls}`}>{t('sharedWithNote')}</p>
      </SectionCard>

      {!isOrphan && (
        <SectionCard
          index={2}
          title={t('workLocationsSection')}
          description={t('workLocationsSectionDescription')}
          aside={
            <Link href={withFrom(`${LOCATION_NEW_PAGE}?companyId=${companyId}`)} className={btnGhost}>
              {t('addWorkLocationCta')}
            </Link>
          }
        >
          {workRows.length === 0 ? (
            <p className={typeHelpCls}>{t('noWorkLocationsYet')}</p>
          ) : (
            <StackedTable label={t('workLocationsSection')}>
              <StackedHead>
                <StackedTh>{t('code')}</StackedTh>
                <StackedTh>{t('name')}</StackedTh>
                <StackedTh>{t('branch')}</StackedTh>
                <StackedTh>{t('colStatus')}</StackedTh>
                <StackedTh className="text-right">{t('colActions')}</StackedTh>
              </StackedHead>
              <StackedBody>
                {workRows.map((l) => (
                  <StackedRow key={l.id} id={`row-${l.id}`} className={l.id === focus ? 'bg-muted/50' : ''}>
                    <StackedTd label={t('code')}>{l.code}</StackedTd>
                    <StackedTd label={t('name')} role="title">
                      {l.name}
                    </StackedTd>
                    <StackedTd label={t('branch')} className="text-muted-foreground">
                      {l.branch ?? t('branchNone')}
                    </StackedTd>
                    <StackedTd label={t('colStatus')} role="aside" hideLabel>
                      <StatusWord
                        tone={l.archivedAt ? 'mid' : 'ink'}
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${l.archivedAt ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}
                      >
                        {l.archivedAt ? t('statusArchived') : t('statusActive')}
                      </StatusWord>
                    </StackedTd>
                    <StackedTd label={t('colActions')} role="full" hideLabel>
                      <span className="inline-flex items-center justify-end gap-2 @max-3xl:justify-start">
                        <Link href={withFrom(locationViewPage(l.id))} className="text-primary hover:underline">
                          {t('view')}
                        </Link>
                        <span className="text-muted-foreground">|</span>
                        <Link href={withFrom(locationEditPage(l.id))} className="text-primary hover:underline">
                          {t('edit')}
                        </Link>
                      </span>
                    </StackedTd>
                  </StackedRow>
                ))}
              </StackedBody>
            </StackedTable>
          )}
          <div className={`mt-3 flex flex-wrap justify-between gap-2 ${typeHelpCls}`}>
            <span>{t('workLocationsSummary', { total: workRows.length, archived: workArchived })}</span>
            <span>{t('restoreArchivedNote')}</span>
          </div>
        </SectionCard>
      )}

      {!isOrphan && unmappedBranches.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">{t('unmappedBranchesHeading')}</div>
          <ul className="divide-y divide-border">
            {unmappedBranches.map((u) => (
              <li key={u.branch} className="px-4 py-3 text-sm text-muted-foreground">
                {t('unmappedBranchRow', { branch: u.branch, count: u.headcount })}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
