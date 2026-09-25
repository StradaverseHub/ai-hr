import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listProfileOptions } from '@/core/profile-options';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { workLocationsReturnTo } from '@/lib/return-to';
import { BLANK_LOCATION, LocationForm } from '../location-form';
import { readTypedLocationValues, type LocationFormValues } from '../location-fields';

/**
 * 639bf4a5 rev 2 (r338) — ADD a work location, on a screen of its own.
 *
 * Opened by the "Add" link on the company listing, which is on EVERY company's block — including the
 * ones that already have a location, because production has companies with two and the old per-company
 * create strip is gone. Save returns to the listing landed on the new row; Cancel and Back return to
 * the listing with nothing saved; a refusal lands back HERE with the reason and everything typed.
 *
 * ⚠️ `?companyId=` IS AN UNTRUSTED URL VALUE AND IT IS THE SCREEN'S SUBJECT. It is honoured only when it
 * names one of the companies `listCompanies(s, { adminOnly: true })` returned — a COMPARISON, never a
 * query — so a forged id cannot open a create form for a company this admin does not administer, and
 * cannot be echoed back into a hidden field either. Anything else is notFound(): there is no company to
 * add a location for. RLS would refuse the write regardless (`app.is_admin_for(company_id)`); this is
 * the screen agreeing with the database rather than offering a form the database will reject.
 *
 * requireAdmin(), like the listing: registered on the SAME `locations` screen column in
 * lib/permissions.ts, so no new grant and no new permission identity.
 *
 * NO CLOCKING POINTS HERE, and the page says so rather than showing an empty box: a clocking point links
 * to a location that EXISTS, so there is nothing to link to until this one is saved. The location's Edit
 * screen is where its points are maintained.
 */
export default async function NewLocationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const backHref = workLocationsReturnTo(sp.from);

  const companies = await listCompanies(s, { adminOnly: true });
  const wanted = typeof sp.companyId === 'string' ? sp.companyId : '';
  const company = companies.find((c) => c.id === wanted);
  if (!company) notFound();

  const branchOptions = await listProfileOptions(s, 'branch', { activeOnly: true });

  // WHAT WAS TYPED, echoed by a refused save (app/admin/actions.ts), wins over the blank form — a
  // cleared Branch included, so a link the operator removed does not come back pre-picked.
  const values: LocationFormValues = { ...BLANK_LOCATION, ...readTypedLocationValues(sp) };

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('newLocationTitle')}
        description={company.name}
        back={{ href: backHref, label: t('backToLocations') }}
      />
      <LocationForm
        t={t}
        mode="new"
        companyId={company.id}
        values={values}
        branchOptions={branchOptions}
        error={error}
        cancelHref={backHref}
        returnTo={backHref}
      />
      <Card>
        <p className="px-4 py-4 text-sm text-muted-foreground">{t('clockingPointsAfterSave')}</p>
      </Card>
    </div>
  );
}
