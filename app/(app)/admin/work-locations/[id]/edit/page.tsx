import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listLocations } from '@/core/location';
import { listProfileOptions } from '@/core/profile-options';
import { Card, PageHeader, btnGhost, pageWideCls } from '@/components/ui';
import { workLocationsReturnTo } from '@/lib/return-to';
import { archiveLocationAction, restoreLocationAction } from '../../../actions';
import { LocationForm } from '../../location-form';
import { UUID_RE, readTypedLocationValues, type LocationFormValues } from '../../location-fields';

/**
 * 639bf4a5 rev 2 (r338) — EDIT one work location, on a screen of its own.
 *
 * r423 (83c0d3c8) — the clocking points r338 put on this screen ("a site and its points stay maintained in
 * one place") are GONE from it, with their "Add a clocking point" link: every clocking location is listed
 * and maintained on Attendance › Locations (../../clocking/page.tsx) now, opened to companies rather than
 * hung off one company's work location.
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
 * The LOCATION is company master data: requireAdmin here, RLS `app.is_admin_for(company_id)` underneath.
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
  const backHref = workLocationsReturnTo(sp.from);

  const companies = await listCompanies(s, { adminOnly: true });
  const locations = await listLocations(s, companies.map((c) => c.id), { includeArchived: true });
  const site = locations.find((l) => l.id === rawId);
  if (!site) notFound();

  const branchOptions = await listProfileOptions(s, 'branch', { activeOnly: true });

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
        back={{ href: backHref, label: t('backToWorkLocations') }}
      />

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

    </div>
  );
}
