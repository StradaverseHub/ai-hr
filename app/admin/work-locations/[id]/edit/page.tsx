import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listLocations } from '@/core/location';
import { listProfileOptions } from '@/core/profile-options';
import { listClockingLocations } from '@/packs/attendance/service';
import { Card, PageHeader, btnGhost, pageWideCls } from '@/components/ui';
import { workLocationsReturnTo } from '@/lib/return-to';
import { archiveLocationAction, restoreLocationAction } from '../../../actions';
import { ClockingPointRows } from '../../clocking-points';
import { LocationForm } from '../../location-form';
import {
  CLOCKING_NEW_PAGE_FOR,
  UUID_RE,
  readTypedLocationValues,
  type LocationFormValues,
} from '../../location-fields';

/**
 * 639bf4a5 rev 2 (r338) — EDIT one work location, on a screen of its own, WITH THE CLOCKING POINTS IT
 * CARRIES. This is the reporter's fourth point built literally: "the clocking points a location carries
 * move with it onto that dedicated screen, so a site and its points stay maintained in one place".
 *
 * Opened by the "Edit" link on the company listing (and from the View screen beside it). Save returns to
 * the listing landed on this row, highlighted; Cancel and Back return there with nothing saved; a
 * refusal lands back HERE with the reason and everything typed (../../location-fields.ts).
 *
 * ⚠️ `[id]` IS SHAPE-CHECKED BEFORE ANY QUERY, and the location is looked for among the companies
 * `listCompanies(s, { adminOnly: true })` returned — so a location outside this admin's scope is
 * notFound() rather than opened for editing. Same boundary as the listing and the View screen.
 *
 * ARCHIVE / RESTORE LIVE HERE, not on the listing: the listing renders no form at all, and archiving is
 * a property of one location rather than of the company block it sits in. The listing still SHOWS an
 * archived location (struck through, with its badge), so nothing is hidden by the move.
 *
 * TWO DIFFERENT AUTHORITIES ON ONE SCREEN, and they are not collapsed. The LOCATION is company master
 * data: requireAdmin here, RLS `app.is_admin_for(company_id)` underneath. A CLOCKING POINT is a shared
 * tenant-level record whose writes are the GROUP administrator's (core assertGroupAdmin + RLS
 * app.is_group_admin()). So a company-scoped admin edits the location and reads its points, with the
 * one-line note the register always gave them — exactly as before this round, on a different screen.
 */
export default async function EditLocationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const { id: rawId } = await params;
  const sp = await searchParams;
  if (!UUID_RE.test(rawId)) notFound();

  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;
  const focus = typeof sp.focus === 'string' && UUID_RE.test(sp.focus) ? sp.focus : undefined;
  const backHref = workLocationsReturnTo(sp.from);

  const companies = await listCompanies(s, { adminOnly: true });
  const locations = await listLocations(s, companies.map((c) => c.id), { includeArchived: true });
  const site = locations.find((l) => l.id === rawId);
  if (!site) notFound();

  const groupAdmin = isGroupAdmin(s);
  const branchOptions = await listProfileOptions(s, 'branch', { activeOnly: true });
  const points = (await listClockingLocations(s, { includeArchived: true })).filter(
    (cl) => cl.locationId === site.id,
  );

  // WHAT IS ON FILE, as the form's raw strings — then WHAT WAS TYPED when a refusal echoed it, which wins.
  const onFile: LocationFormValues = {
    code: site.code,
    name: site.name,
    country: site.country,
    branch: site.branch ?? '',
  };
  const values: LocationFormValues = { ...onFile, ...readTypedLocationValues(sp) };

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('editLocationTitle')}
        description={`${site.companyName} · ${site.code} · ${site.name}`}
        back={{ href: backHref, label: t('backToLocations') }}
      />

      {/* A clocking-point save lands back here with `saved=1&focus=<pointId>`; the location's own Save
          lands on the LISTING, so this note is about the point, never about the site. */}
      {!error && saved ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('saved')}
        </p>
      ) : null}

      <LocationForm
        t={t}
        mode="edit"
        locationId={site.id}
        values={values}
        branchOptions={branchOptions}
        error={error}
        cancelHref={backHref}
        returnTo={backHref}
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {site.archivedAt ? t('archivedNote') : t('headcountLabel', { count: site.headcount })}
          </span>
          {site.archivedAt ? (
            <form action={restoreLocationAction}>
              <input type="hidden" name="locationId" value={site.id} />
              <input type="hidden" name="returnTo" value={backHref} />
              <button className={btnGhost}>{t('restore')}</button>
            </form>
          ) : (
            <form action={archiveLocationAction}>
              <input type="hidden" name="locationId" value={site.id} />
              <input type="hidden" name="returnTo" value={backHref} />
              <button className={btnGhost}>{t('archive')}</button>
            </form>
          )}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-sm font-medium">
          <span>
            {t('clockingPointsHeading')}
            <span className="ml-2 text-muted-foreground">({points.length})</span>
          </span>
          {groupAdmin && (
            <Link href={CLOCKING_NEW_PAGE_FOR(site.id)} className={btnGhost}>
              {t('addPointCta')}
            </Link>
          )}
        </div>
        {!groupAdmin && (
          <p className="border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            {t('sharedManagedByGroupAdmin')}
          </p>
        )}
        {points.length === 0 ? (
          /* The empty state (spec section E, state 3): the location exists but nobody has dropped a gate
             under it, so nobody can clock in at THIS site however it is assigned. The way OUT of the
             empty state sits inside it, for a group admin; a company admin gets the sentence alone. */
          <p className="px-4 py-3 text-xs text-muted-foreground">{t('groupNoPoints')}</p>
        ) : (
          <ClockingPointRows t={t} rows={points} manage={groupAdmin} focus={focus} locationId={site.id} />
        )}
      </Card>
      <p className="px-1 text-xs text-muted-foreground">{t('clockingNote')}</p>
      <p className="px-1 text-xs text-muted-foreground">{t('radiusNote')}</p>
    </div>
  );
}
