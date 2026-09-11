import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listLocations } from '@/core/location';
import { listClockingLocations } from '@/packs/attendance/service';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { ClockingLocationForm } from '../clocking-form';
import { UUID_RE, clockingRowHref, readTypedClockingValues, type ClockingFormValues } from '../form-fields';

/**
 * f9afd1ce rev 2 (r267) — EDIT one clocking location, on a page of its own. Opened by a row's "Edit" on
 * the list. Two sections in the reporter's order (../clocking-form.tsx); Save returns to the list landed
 * on this row, highlighted; Cancel and Back return there with nothing saved; a refusal lands back here
 * with the reason and everything typed.
 *
 * `[id]` IS AN UNTRUSTED URL SEGMENT AND `clocking_location.id` IS A UUID COLUMN. Its shape is checked
 * BEFORE any query (junk reaching `eq(clockingLocation.id, …)` makes Postgres throw "invalid input syntax
 * for type uuid" — the r263 verifier's 500). Junk and an unknown id are both notFound(), the shift
 * library's [shiftId] idiom: there is no record to show.
 *
 * THE SAME READ THE LIST USES, narrowed to this id — never a second reader that could disagree with the
 * list about the link, the "Used by" companies or the archive state. Archived sites are editable from
 * here too (the list shows them, with Restore on the row).
 *
 * requireAdmin(), like the list; registered on the same `locations` screen column. A company-scoped
 * admin gets the record READ-ONLY plus the note the list gives them — write authority is the group
 * administrator's (core assertGroupAdmin + RLS app.is_group_admin()).
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

  const site = (await listClockingLocations(s, { includeArchived: true })).find((cl) => cl.id === rawId);
  if (!site) notFound();

  const groupAdmin = isGroupAdmin(s);
  const listHref = clockingRowHref(site.id);
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  if (!groupAdmin) {
    const facts: [string, string][] = [
      [t('name'), site.name],
      [t('reportLabel'), site.reportLabel ?? '—'],
      [t('address'), site.address ?? '—'],
      [t('clockingLocationLinkOptional'), site.locationCode ? `${site.locationCode} · ${site.locationName ?? ''}` : t('clockingLocationNone')],
      [t('remarks'), site.remarks ?? '—'],
      [t('coordinates'), `${site.lat}, ${site.lng}`],
      [t('radiusMetresLabel'), site.radiusM != null ? t('radiusMetres', { radius: site.radiusM }) : '—'],
    ];
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('editClockingTitle')} description={site.name} back={{ href: listHref, label: t('backToLocations') }} />
        <Card>
          <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">{t('sharedManagedByGroupAdmin')}</p>
          <dl className="grid gap-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                <dd className="mt-1">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    );
  }

  const linkableLocations = await listLocations(s, [], {});
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
  };
  const values: ClockingFormValues = { ...onFile, ...readTypedClockingValues(sp) };

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('editClockingTitle')} description={site.name} back={{ href: listHref, label: t('backToLocations') }} />
      <ClockingLocationForm
        mode="edit"
        clockingLocationId={site.id}
        values={values}
        linkableLocations={linkableLocations.map((l) => ({ id: l.id, code: l.code, name: l.name, companyName: l.companyName }))}
        linkNotOffered={linkNotOffered}
        error={error}
        cancelHref={listHref}
      />
    </div>
  );
}
