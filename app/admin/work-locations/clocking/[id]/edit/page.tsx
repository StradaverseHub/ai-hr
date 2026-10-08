import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listLocations } from '@/core/location';
import { listClockingLocations } from '@/packs/attendance/service';
import { PageHeader, pageWideCls } from '@/components/ui';
import { ClockingLocationForm } from '../../clocking-form';
import { clockingFormOptions } from '../../form-data';
import {
  UUID_RE,
  clockingFocusHref,
  clockingViewPage,
  readTypedClockingValues,
  readTypedCompanyIds,
  type ClockingFormValues,
} from '../../form-fields';

/**
 * r423 (83c0d3c8) — EDIT one clocking location. The form moved here from `../page.tsx`, which is the
 * read-only View now (the list's View / Edit / Deactivate). Save returns to the list landed on this row;
 * Cancel and Back return there with nothing saved; a refusal lands back HERE with the reason and everything
 * typed, the ticked companies included.
 *
 * `[id]` IS AN UNTRUSTED URL SEGMENT AND `clocking_location.id` IS A UUID COLUMN: shape-checked BEFORE any
 * query; junk and an unknown id are both notFound().
 *
 * THE SAME READ THE LIST USES, narrowed to this id — never a second reader that could disagree with the
 * list about the companies or the status.
 *
 * Writing is the GROUP administrator's (core assertGroupAdmin + RLS app.is_group_admin()). Anyone else who
 * opens this address is sent the read-only View instead: there is no form they could save.
 *
 * r428 (83c0d3c8 contest) — opened from a company's own view now (the list's step 2) as well as from the
 * bare list; `?company=` is untrusted and is honoured only when it NAMES one of THIS location's own
 * `site.companies` — re-validated against the real record, never a query — so Back, Cancel and Save all
 * land on that company's view rather than the bare list, and a forged id cannot claim a company the
 * location is not even open to.
 */
export default async function EditClockingLocationPage({
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

  const site = (await listClockingLocations(s, { status: 'all' })).find((cl) => cl.id === rawId);
  if (!site) notFound();
  if (!isGroupAdmin(s)) redirect(clockingViewPage(site.id));

  // r428 — re-validated against THIS location's own companies, never trusted from the url alone.
  const rawCompany = typeof sp.company === 'string' ? sp.company : '';
  const returnCompany = UUID_RE.test(rawCompany) && site.companies.some((c) => c.id === rawCompany) ? rawCompany : undefined;
  const listHref = clockingFocusHref(site.id, returnCompany);
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const [{ companies, stateOptions }, linkableLocations] = await Promise.all([
    clockingFormOptions(s),
    listLocations(s, [], {}),
  ]);
  const linkNotOffered =
    site.locationId != null && !linkableLocations.some((l) => l.id === site.locationId)
      ? { id: site.locationId, code: site.locationCode, name: site.locationName }
      : null;

  // WHAT IS ON FILE, as the form's raw strings — then WHAT WAS TYPED when a refusal echoed it, which wins.
  const onFile: ClockingFormValues = {
    name: site.name,
    reportLabel: site.reportLabel ?? '',
    address: site.address ?? '',
    locationId: site.locationId ?? '',
    remarks: site.remarks ?? '',
    lat: String(site.lat),
    lng: String(site.lng),
    radiusM: site.radiusM == null ? '' : String(site.radiusM),
    state: site.state ?? '',
    status: site.archivedAt ? 'inactive' : 'active',
  };
  const values: ClockingFormValues = { ...onFile, ...readTypedClockingValues(sp) };
  const companyIds = readTypedCompanyIds(sp) ?? site.companies.map((c) => c.id);

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('editClockingTitle')} description={site.name} back={{ href: listHref, label: t('backToLocations') }} />
      <ClockingLocationForm
        t={t}
        mode="edit"
        clockingLocationId={site.id}
        values={values}
        companyIds={companyIds}
        companies={companies}
        stateOptions={stateOptions}
        linkableLocations={linkableLocations.map((l) => ({ id: l.id, code: l.code, name: l.name, companyName: l.companyName }))}
        linkNotOffered={linkNotOffered}
        assignedCount={site.assignedCount}
        error={error}
        cancelHref={listHref}
        returnCompany={returnCompany}
      />
    </div>
  );
}
