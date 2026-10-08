import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listClockingLocations } from '@/packs/attendance/service';
import { Card, PageHeader, SectionHeader, btnGhost, pageWideCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { deleteClockingLocationAction } from '../../../actions';
import { UUID_RE, clockingEditPage, clockingFocusHref } from '../form-fields';

/**
 * r423 (83c0d3c8) — VIEW one clocking location, READ-ONLY. The list's "View" opens it; "Edit" (group
 * administrators only) opens ./edit. Until r423 this address WAS the edit form, with a read-only fact list
 * for a company administrator; the form moved to ./edit so View and Edit are two screens, as the list's
 * three actions promise.
 *
 * `[id]` is shape-checked BEFORE any query; junk and an unknown id are notFound(). THE SAME READ THE LIST
 * USES, narrowed to this id: a company administrator therefore finds only a location open to a company
 * they administer, and sees only those companies' names on it (the filter is in the query).
 *
 * DELETE LIVES HERE, for a group administrator: it was a row action on the old register and the plan's
 * list carries View / Edit / Deactivate only. It is refused by the service while any assignment or
 * attendance record references the location, which is said in the confirmation.
 *
 * r428 (83c0d3c8 contest) — opened from a company's own view (the list's step 2) as well as from the bare
 * list; `?company=` is re-validated against THIS location's own `site.companies`, never trusted from the
 * url alone, so Back and the Edit link both land on that company's view rather than the bare list.
 */
export default async function ViewClockingLocationPage({
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
  const groupAdmin = isGroupAdmin(s);
  const rawCompany = typeof sp.company === 'string' ? sp.company : '';
  const returnCompany = UUID_RE.test(rawCompany) && site.companies.some((c) => c.id === rawCompany) ? rawCompany : undefined;
  const listHref = clockingFocusHref(site.id, returnCompany);
  const editHref = `${clockingEditPage(site.id)}${returnCompany ? `?company=${returnCompany}` : ''}`;

  const facts: [string, string][] = [
    [t('locationName'), site.name],
    [t('address'), site.address ?? '—'],
    [t('stateOptional'), site.state ?? '—'],
    [t('gpsCoordinates'), `${site.lat}, ${site.lng}`],
    [t('radiusMetresLabel'), site.radiusM != null ? t('radiusMetres', { radius: site.radiusM }) : '—'],
    [t('colStatus'), site.archivedAt ? t('statusInactive') : t('statusActive')],
    [t('assignedEmployeesLabel'), String(site.assignedCount)],
    [t('reportLabel'), site.reportLabel ?? '—'],
    [t('remarks'), site.remarks ?? '—'],
  ];
  if (site.locationId) {
    facts.push([
      t('clockingLocationLinkOptional'),
      site.locationCode ? `${site.locationCode} · ${site.locationName ?? ''}` : t('clockingLocationNone'),
    ]);
  }

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('viewClockingTitle')}
        description={site.name}
        back={{ href: listHref, label: t('backToLocations') }}
        actions={
          groupAdmin ? (
            <Link href={editHref} className={btnGhost}>
              {t('edit')}
            </Link>
          ) : undefined
        }
      />
      {!groupAdmin && <p className="px-1 text-xs text-muted-foreground">{t('sharedManagedByGroupAdmin')}</p>}

      <Card>
        <SectionHeader title={t('sectionLocation')} />
        <dl className="grid gap-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card>
        <SectionHeader title={t('sectionCompanies')} />
        <div className="flex flex-wrap gap-2 p-4">
          {site.companies.length === 0 ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            site.companies.map((c) => (
              <span key={c.id} className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-sm">
                {c.name}
              </span>
            ))
          )}
        </div>
      </Card>

      {groupAdmin && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
            <span className="text-xs text-muted-foreground">{t('clockingNote')}</span>
            <form action={deleteClockingLocationAction}>
              <input type="hidden" name="clockingLocationId" value={site.id} />
              <ConfirmSubmit
                title={t('deleteConfirmTitle')}
                description={t('deleteConfirmDescription', { name: site.name })}
                confirmLabel={t('delete')}
                size="sm"
                variant="ghost"
              >
                {t('delete')}
              </ConfirmSubmit>
            </form>
          </div>
        </Card>
      )}
    </div>
  );
}
