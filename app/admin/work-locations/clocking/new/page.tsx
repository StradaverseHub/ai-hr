import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listLocations } from '@/core/location';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { ClockingLocationForm } from '../clocking-form';
import { clockingFormOptions } from '../form-data';
import { CLOCKING_LIST, readTypedClockingValues, readTypedCompanyIds, type ClockingFormValues } from '../form-fields';

/**
 * f9afd1ce rev 2 (r267) — NEW clocking location, on a page of its own.
 *
 * r423 (83c0d3c8) — opened by the "New Clocking Location" button on Attendance › Locations (../page.tsx);
 * Save, Cancel and Back all return there. The form is in the reporter's order (../clocking-form.tsx): the
 * location, then its GPS point and radius, then the COMPANIES allowed to use it (at least one), then its
 * Status. The r338 "add a point under this work location" entry (`?addPoint=`) is gone with the clocking
 * rows it lived beside: a clocking location is opened to companies now, not filed under a work location.
 *
 * requireAdmin(), registered on the same `locations` screen column in lib/permissions.ts. WRITE authority
 * is the group administrator's (core assertGroupAdmin + RLS app.is_group_admin()), so a company-scoped
 * admin who opens this address gets the one-line note and no form — the list never links them here.
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
        <PageHeader title={t('newClockingTitle')} back={{ href: CLOCKING_LIST, label: t('backToLocations') }} />
        <Card>
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('sharedManagedByGroupAdmin')}</p>
        </Card>
      </div>
    );
  }

  const [{ companies, stateOptions }, linkableLocations] = await Promise.all([
    clockingFormOptions(s),
    listLocations(s, [], {}),
  ]);

  // WHAT WAS TYPED, echoed by a refused save (app/admin/actions.ts), wins over the blank page.
  const values: ClockingFormValues = {
    name: '',
    reportLabel: '',
    address: '',
    locationId: '',
    remarks: '',
    lat: '',
    lng: '',
    radiusM: '',
    state: '',
    status: 'active',
    ...readTypedClockingValues(sp),
  };
  const companyIds = readTypedCompanyIds(sp) ?? [];

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('newClockingTitle')}
        description={t('clockingDescription')}
        back={{ href: CLOCKING_LIST, label: t('backToLocations') }}
      />
      <ClockingLocationForm
        t={t}
        mode="new"
        values={values}
        companyIds={companyIds}
        companies={companies}
        stateOptions={stateOptions}
        linkableLocations={linkableLocations.map((l) => ({ id: l.id, code: l.code, name: l.name, companyName: l.companyName }))}
        error={error}
        cancelHref={CLOCKING_LIST}
      />
    </div>
  );
}
