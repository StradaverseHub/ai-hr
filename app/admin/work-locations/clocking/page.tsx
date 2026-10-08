import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listClockingLocations } from '@/packs/attendance/service';
import {
  Card,
  ErrorBanner,
  PageHeader,
  btnGhost,
  btnPrimary,
  inputCls,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { cn } from '@/lib/utils';
import { archiveClockingLocationAction, restoreClockingLocationAction } from '../../actions';
import { CLOCKING_LIST, CLOCKING_NEW_PAGE, UUID_RE, clockingEditPage, clockingViewPage } from './form-fields';

/**
 * r423 (83c0d3c8) — ATTENDANCE › LOCATIONS: THE LIST OF CLOCKING LOCATIONS.
 *
 * Until r423 Attendance › Locations was the company-based WORK location listing, and clocking locations sat
 * inside each work location's own screen, plus this address for the ones attached to none. The reporter
 * asked for location-first setup: create the place, then tick the companies allowed to use it. So this
 * address (registered on the `locations` screen column since r338, no new grant) became the list, and the
 * work location listing moved to its own menu row, "Work Locations" (../page.tsx), otherwise unchanged.
 *
 * COLUMNS, the plan's: Location Name · Address · State · GPS Coordinates · Geofencing Radius · Companies ·
 * Status · Actions (View, Edit, Deactivate — or Activate for an inactive one). Filters: a search box (name
 * or address), Company, and Status (All / Active / Inactive). The filters are a GET form: they change the
 * address, never a record.
 *
 * WHO SEES WHAT — decided in the query (core listClockingLocations), not here. A group administrator sees
 * every location and every company on it, and gets New / Edit / Deactivate. A company administrator sees,
 * READ-ONLY, only the locations open to companies they administer, and on each only those company names
 * (app.is_admin_for in SQL; clocking_location_company's RLS says the same underneath). The Company filter
 * offers the companies the caller administers, by the same rule.
 *
 * DEACTIVATE ASKS FIRST and says how many employees are assigned (an inactive location cannot be chosen for
 * anyone and does not accept clocking). Activate does not ask: nothing is lost by it.
 *
 * Read through the pack's published facade (`packs/attendance/service`), never core/clocking-location —
 * the drift ratchet's rule.
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
  const focus = UUID_RE.test(one('focus')) ? one('focus') : undefined;
  const saved = one('saved') || undefined;
  const error = one('error') || undefined;
  const q = one('q').slice(0, 200);
  const status = (['active', 'inactive'] as const).find((v) => v === one('status')) ?? 'all';

  const groupAdmin = isGroupAdmin(s);
  const companies = (await listCompanies(s, { adminOnly: true }))
    .map((c) => ({ id: c.id, name: c.companyLabel ?? c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // `?company=` is honoured only when it names a company this caller administers — a comparison, never a query.
  const companyId = companies.some((c) => c.id === one('company')) ? one('company') : '';

  const rows = await listClockingLocations(s, { status, q, companyId: companyId || undefined });
  const activeCount = rows.filter((r) => !r.archivedAt).length;

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('pageTitle')}
        description={t('clockingListDescription')}
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
          {t('saved')}
        </p>
      ) : null}
      {!groupAdmin && <p className="px-1 text-xs text-muted-foreground">{t('companyAdminReadOnly')}</p>}

      {/* The filters: a GET form, so the list is linkable and Back returns to what was filtered. */}
      <form method="get" action={CLOCKING_LIST} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_14rem_10rem_auto] sm:items-end">
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t('searchLabel')}</span>
          <input type="search" name="q" defaultValue={q} placeholder={t('searchPlaceholder')} className={inputCls} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t('colCompany')}</span>
          <select name="company" defaultValue={companyId} className={inputCls}>
            <option value="">{t('allCompanies')}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t('colStatus')}</span>
          <select name="status" defaultValue={status} className={inputCls}>
            <option value="all">{t('statusAll')}</option>
            <option value="active">{t('statusActive')}</option>
            <option value="inactive">{t('statusInactive')}</option>
          </select>
        </label>
        <button className={btnGhost}>{t('applyFilters')}</button>
      </form>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{q || companyId || status !== 'all' ? t('noMatches') : t('noSharedSites')}</p>
        ) : (
          <div className={cn(tableWrapCls, 'rounded-none border-0')}>
            <table className="w-full min-w-[56rem] text-sm">
              <thead className={cn(theadCls, 'border-b border-border bg-transparent')}>
                <tr>
                  <th className={thCls}>{t('locationName')}</th>
                  <th className={thCls}>{t('address')}</th>
                  <th className={thCls}>{t('colState')}</th>
                  <th className={thCls}>{t('gpsCoordinates')}</th>
                  <th className={thCls}>{t('geofencingRadius')}</th>
                  <th className={thCls}>{t('colCompanies')}</th>
                  <th className={thCls}>{t('colStatus')}</th>
                  <th className={cn(thCls, 'text-right')}>{t('colActions')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {rows.map((cl) => (
                  <tr
                    key={cl.id}
                    id={`row-${cl.id}`}
                    className={cn('align-top', cl.archivedAt && 'text-muted-foreground', cl.id === focus && 'bg-muted/50')}
                  >
                    <td className="px-3 py-2 font-medium">
                      {cl.name}
                      {cl.reportLabel ? <span className="block text-xs font-normal text-muted-foreground">{cl.reportLabel}</span> : null}
                    </td>
                    <td className="max-w-[16rem] px-3 py-2 text-muted-foreground">{cl.address ?? '—'}</td>
                    <td className="px-3 py-2">{cl.state ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {cl.lat}, {cl.lng}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{cl.radiusM != null ? t('radiusMetres', { radius: cl.radiusM }) : '—'}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-col items-start gap-1">
                        {cl.companies.map((c) => (
                          <span key={c.id} className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-xs">
                            {c.name}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold',
                          cl.archivedAt ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
                        )}
                      >
                        {cl.archivedAt ? t('statusInactive') : t('statusActive')}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="inline-flex flex-wrap items-center justify-end gap-2">
                        <Link href={clockingViewPage(cl.id)} className="text-primary hover:underline">
                          {t('view')}
                        </Link>
                        {groupAdmin && (
                          <>
                            <span className="text-muted-foreground">|</span>
                            <Link href={clockingEditPage(cl.id)} className="text-primary hover:underline">
                              {t('edit')}
                            </Link>
                            <span className="text-muted-foreground">|</span>
                            {cl.archivedAt ? (
                              <form action={restoreClockingLocationAction}>
                                <input type="hidden" name="clockingLocationId" value={cl.id} />
                                <button className="text-primary hover:underline">{t('activate')}</button>
                              </form>
                            ) : (
                              <form action={archiveClockingLocationAction}>
                                <input type="hidden" name="clockingLocationId" value={cl.id} />
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span>{t('clockingSummary', { total: rows.length, active: activeCount })}</span>
        <span>{t('inactiveNote')}</span>
      </div>
      <p className="px-1 text-xs text-muted-foreground">{t('radiusNote')}</p>
    </div>
  );
}
