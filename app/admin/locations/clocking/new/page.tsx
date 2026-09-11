import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listLocations } from '@/core/location';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { ClockingLocationForm } from '../clocking-form';
import { LOCATIONS_LIST, readTypedClockingValues, type ClockingFormValues } from '../form-fields';

/**
 * f9afd1ce rev 2 (r267) — NEW clocking location, on a page of its own. Opened by the list's "Add clocking
 * location" button and by an empty group's "Add a clocking point" link (`?addPoint=<locationId>`, which
 * only PRE-PICKS the holiday-calendar link — a GET; nothing is written). Two sections in the reporter's
 * order (../clocking-form.tsx); Save returns to the list landed on the new row, Cancel returns to the
 * list with nothing saved, and a refusal lands back here with the reason and everything typed.
 *
 * requireAdmin(), like the list: the route is registered on the SAME `locations` screen column in
 * lib/permissions.ts (no new grant). WRITE authority is the group administrator's (core assertGroupAdmin
 * + RLS app.is_group_admin()), so a company-scoped admin who opens this address gets the same one-line
 * note the list gives them and no form — the list never links them here.
 */
export default async function NewClockingLocationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const sp = await searchParams;
  const groupAdmin = isGroupAdmin(s);
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  if (!groupAdmin) {
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('newClockingTitle')} back={{ href: LOCATIONS_LIST, label: t('backToLocations') }} />
        <Card>
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('sharedManagedByGroupAdmin')}</p>
        </Card>
      </div>
    );
  }

  // The location picker: every LIVE location the caller can see, any company (a group admin's RLS on
  // `location` reaches every company). `?addPoint=` is an untrusted url value: it is honoured only when
  // it names one of these options — a comparison, never a query.
  const linkableLocations = await listLocations(s, [], {});
  const addPoint = typeof sp.addPoint === 'string' && linkableLocations.some((l) => l.id === sp.addPoint) ? sp.addPoint : '';

  // WHAT WAS TYPED, echoed by a refused save (app/admin/actions.ts), wins over the blank page — the link
  // included, even when the operator cleared it: a cleared link must not come back pre-picked.
  const values: ClockingFormValues = {
    name: '',
    reportLabel: '',
    address: '',
    locationId: addPoint,
    remarks: '',
    lat: '',
    lng: '',
    radiusM: '',
    ...readTypedClockingValues(sp),
  };

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('newClockingTitle')}
        description={t('clockingDescription')}
        back={{ href: LOCATIONS_LIST, label: t('backToLocations') }}
      />
      <ClockingLocationForm
        mode="new"
        values={values}
        linkableLocations={linkableLocations.map((l) => ({ id: l.id, code: l.code, name: l.name, companyName: l.companyName }))}
        error={error}
        cancelHref={LOCATIONS_LIST}
      />
    </div>
  );
}
