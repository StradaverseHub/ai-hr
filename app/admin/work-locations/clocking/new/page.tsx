import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listLocations } from '@/core/location';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { ClockingLocationForm } from '../clocking-form';
import { clockingFormOptions } from '../form-data';
import { CLOCKING_LIST, UUID_RE, readTypedClockingValues, readTypedCompanyIds, type ClockingFormValues } from '../form-fields';

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
 *
 * r428 (83c0d3c8 contest) — opened from the LIST's company view now ("+ New Clocking Location" inside a
 * company starts with that company ticked), as well as from the top-level company list (no `?company=`,
 * nothing pre-ticked, same as before). `?company=` is untrusted and is honoured only when it names one of
 * `clockingFormOptions(s).companies` — a COMPARISON against the real option set, never a query — so a
 * forged id cannot pre-tick, nor be echoed into `returnCompany`, a company this admin cannot open a
 * location to. It wins only when nothing was already TYPED (a refusal's echo takes precedence), and it is
 * carried through as `returnCompany` so Save, Cancel and Back land back on that company's own view.
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
        <AttendanceSettingsNavigation />
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

  // r428 — re-validated against the real option set, never trusted from the url alone.
  const rawCompany = typeof sp.company === 'string' ? sp.company : '';
  const returnCompany = UUID_RE.test(rawCompany) && companies.some((c) => c.id === rawCompany) ? rawCompany : undefined;
  const backHref = returnCompany ? `${CLOCKING_LIST}?company=${returnCompany}` : CLOCKING_LIST;

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
  // r428 — `?company=` prefills the one tick only when nothing was already typed (a refusal's own echo,
  // including an explicitly EMPTY one, always wins).
  const companyIds = readTypedCompanyIds(sp) ?? (returnCompany ? [returnCompany] : []);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('newClockingTitle')}
        description={t('clockingDescription')}
        back={{ href: backHref, label: t('backToLocations') }}
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
        cancelHref={backHref}
        returnCompany={returnCompany}
      />
    </div>
  );
}
