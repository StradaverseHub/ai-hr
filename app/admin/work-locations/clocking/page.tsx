import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listClockingLocations } from '@/packs/attendance/service';
import { Card, PageHeader, btnPrimary, pageWideCls } from '@/components/ui';
import { ClockingPointRows } from '../clocking-points';
import { CLOCKING_NEW_PAGE, LOCATIONS_LIST, UUID_RE } from '../location-fields';

/**
 * 639bf4a5 rev 2 (r338) — THE CLOCKING POINTS THAT HANG OFF NO LOCATION.
 *
 * ⚠️ THIS SCREEN EXISTS BECAUSE THE REGISTER STOPPED BEING ONE. Until this round every clocking point
 * in the tenant rendered on /admin/work-locations, grouped under the location it links to, with two
 * extra groups for the ones that link to NOTHING and the ones that link to a location this caller's RLS
 * cannot see. r338 turns that page into a COMPANY LISTING with no rows of its own, and moves each
 * location's points onto the location's own screens. Those two groups have no location to move onto —
 * the link has been OPTIONAL since f9afd1ce (migration 0459) — so without this screen they would simply
 * have disappeared from the product: still in the database, still enforcing geofences for whoever is
 * assigned to them, and unreachable from any page. The listing links here with a count when there are
 * any, and says nothing when there are none.
 *
 * TWO GROUPS, DECIDED PER ROW, exactly as the register decided them:
 *   • `locationId` null → "Not linked to a location". A normal home since the link became optional.
 *   • `locationId` set but the location came back null → linked to a location this caller cannot see
 *     (another company's, for a company-scoped admin). Its OWN group, so it is never mistaken for
 *     "unlinked" and never silently re-homed by a Save.
 *
 * requireAdmin(), like every screen in this family, and registered on the SAME `locations` screen column
 * in lib/permissions.ts — no new grant, no new permission identity. WRITE authority for a point is the
 * group administrator's (core assertGroupAdmin + RLS app.is_group_admin()); a company-scoped admin gets
 * the facts, a View and the note.
 *
 * Read through the pack's published facade (`packs/attendance/service`), never core/clocking-location —
 * the drift ratchet's rule, which this round leaves exactly where r336 ratcheted it to.
 */
export default async function UnlinkedClockingPointsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const sp = await searchParams;
  const focus = typeof sp.focus === 'string' && UUID_RE.test(sp.focus) ? sp.focus : undefined;
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  const groupAdmin = isGroupAdmin(s);
  const all = await listClockingLocations(s, { includeArchived: true });
  const unlinked = all.filter((cl) => !cl.locationId);
  const outOfScope = all.filter((cl) => cl.locationId && cl.locationCode == null);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('offRegisterTitle')}
        description={t('offRegisterDescription')}
        back={{ href: LOCATIONS_LIST, label: t('backToLocations') }}
        actions={
          groupAdmin ? (
            <Link href={CLOCKING_NEW_PAGE} className={btnPrimary}>
              {t('addClocking')}
            </Link>
          ) : undefined
        }
      />

      {!error && saved ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('saved')}
        </p>
      ) : null}

      {!groupAdmin && (
        <p className="px-1 text-xs text-muted-foreground">{t('sharedManagedByGroupAdmin')}</p>
      )}

      {unlinked.length === 0 && outOfScope.length === 0 && (
        <Card>
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('noSharedSites')}</p>
        </Card>
      )}

      {unlinked.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            {t('unlinkedGroupTitle')}
            <span className="ml-2 text-muted-foreground">({unlinked.length})</span>
          </div>
          <ClockingPointRows t={t} rows={unlinked} manage={groupAdmin} focus={focus} locationId="" />
        </Card>
      )}

      {outOfScope.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            {t('linkedOutOfScopeGroupTitle')}
            <span className="ml-2 text-muted-foreground">({outOfScope.length})</span>
          </div>
          <ClockingPointRows t={t} rows={outOfScope} manage={groupAdmin} focus={focus} locationId="" />
        </Card>
      )}

      <p className="px-1 text-xs text-muted-foreground">{t('clockingNote')}</p>
      <p className="px-1 text-xs text-muted-foreground">{t('radiusNote')}</p>
    </div>
  );
}
