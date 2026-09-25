import Link from 'next/link';
import { btnGhost } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import type { listClockingLocations } from '@/packs/attendance/service';
import {
  archiveClockingLocationAction,
  restoreClockingLocationAction,
  deleteClockingLocationAction,
} from '../actions';
import { clockingEditPage } from './clocking/form-fields';

export type ClockingRow = Awaited<ReturnType<typeof listClockingLocations>>[number];

/**
 * 639bf4a5 rev 2 (r338) — THE CLOCKING POINTS A LOCATION CARRIES, rendered beside the location itself.
 *
 * These rows used to live on the register (app/admin/work-locations/page.tsx), grouped under the site
 * they link to. The register is a COMPANY LISTING now, so the rows moved ONTO the location's own
 * screens — read-only on ./[id], with their controls on ./[id]/edit — which is the reporter's fourth
 * point: "the clocking points a location carries move with it, so a site and its points stay maintained
 * in one place". The same component renders the points that link to NO location, on ./clocking.
 *
 * NOTHING ABOUT A POINT CHANGED. Same facts, same controls, same single editor (./clocking/[id]) and
 * the same service behind them (`packs/attendance/service`, the published facade — never
 * core/clocking-location, which is the drift ratchet's rule and is untouched by this round's menu move).
 *
 * WRITE AUTHORITY IS THE GROUP ADMINISTRATOR'S (core assertGroupAdmin + RLS app.is_group_admin()), which
 * is why `manage` is passed rather than assumed: a company-scoped admin gets the same facts and a View,
 * and the note that says who maintains them. "Used by" and the assigned count are derived from
 * employee_clocking_location, whose RLS is can_see_employment — so a company admin's figures cover only
 * the companies THEY manage, and the captions say exactly that rather than a SECURITY DEFINER read
 * widening what they may see about other companies' staff.
 *
 * `locationId` IS POSTED BESIDE THE ID ON EVERY CONTROL, and it is what sends the operator back to this
 * screen afterwards (./location-fields.ts `clockingPointBase`). It is an ID, shape-checked, never a
 * posted URL — the same rule test/clocking-location-page.test.ts holds the save path to.
 */
export function ClockingPointRows({
  t,
  rows,
  manage,
  focus,
  locationId,
}: {
  t: (key: string, values?: Record<string, string | number>) => string;
  rows: ClockingRow[];
  /** true for a group admin on the Edit screen: Edit / Archive / Restore / Delete. Otherwise a View. */
  manage: boolean;
  focus?: string;
  /** The location these rows hang off, or '' for the points that hang off none. */
  locationId: string;
}) {
  return (
    <ul>
      {rows.map((cl) => (
        <li
          key={cl.id}
          id={`row-${cl.id}`}
          className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-3 text-sm ${cl.archivedAt ? 'opacity-60' : ''} ${cl.id === focus ? 'bg-muted/50' : ''}`}
        >
          <span className="min-w-[10rem] font-medium">{cl.name}</span>
          {/* f9afd1ce rev 2 — the Attendance report's short name, when set. The list keeps printing the name. */}
          {cl.reportLabel && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              <span className="uppercase tracking-wide">{t('reportLabel')}</span> {cl.reportLabel}
            </span>
          )}
          <span className="text-muted-foreground">
            <span className="text-xs uppercase tracking-wide">{t('coordinates')}</span> {cl.lat}, {cl.lng}
          </span>
          <span className="text-muted-foreground">
            <span className="text-xs uppercase tracking-wide">{t('radius')}</span>{' '}
            {cl.radiusM != null ? t('radiusMetres', { radius: cl.radiusM }) : '—'}
          </span>
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="text-xs uppercase tracking-wide">{manage ? t('usedBy') : t('usedByManaged')}</span>
            {cl.usedByCompanies.length === 0 ? (
              <span className="text-xs text-muted-foreground">—</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {cl.usedByCompanies.map((name) => (
                  <span key={name} className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {name}
                  </span>
                ))}
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {manage
              ? t('assignedCount', { count: cl.assignedCount })
              : t('assignedCountManaged', { count: cl.assignedCount })}
          </span>
          {/* r272 (0e8cf366) — STATUS IS ALWAYS STATED. An archived row carried a badge and a live one
              carried nothing, so "Active" was conveyed only by the ABSENCE of a badge. */}
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              cl.archivedAt ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'
            }`}
          >
            {cl.archivedAt ? t('statusArchived') : t('statusActive')}
          </span>
          {!manage && (
            <span className="ml-auto flex items-center gap-2">
              {/* r272 — A WAY IN FOR A COMPANY ADMIN: the detail page renders them a read-only fact list,
                  and before r272 nothing linked to it, so the only readers who could open a point were
                  the ones allowed to change it. */}
              <Link href={clockingEditPage(cl.id)} className={btnGhost}>
                {t('view')}
              </Link>
            </span>
          )}
          {manage && (
            <span className="ml-auto flex items-center gap-2">
              {/* Edit opens the page of its own; nothing on this row is typed into. */}
              <Link href={clockingEditPage(cl.id)} className={btnGhost}>
                {t('edit')}
              </Link>
              {cl.archivedAt ? (
                <form action={restoreClockingLocationAction}>
                  <input type="hidden" name="clockingLocationId" value={cl.id} />
                  <input type="hidden" name="locationId" value={locationId} />
                  <button className={btnGhost}>{t('restore')}</button>
                </form>
              ) : (
                <form action={archiveClockingLocationAction}>
                  <input type="hidden" name="clockingLocationId" value={cl.id} />
                  <input type="hidden" name="locationId" value={locationId} />
                  <button className={btnGhost}>{t('archive')}</button>
                </form>
              )}
              <form action={deleteClockingLocationAction}>
                <input type="hidden" name="clockingLocationId" value={cl.id} />
                <input type="hidden" name="locationId" value={locationId} />
                <ConfirmSubmit
                  title={t('deleteConfirmTitle')}
                  description={t('deleteConfirmDescription', { name: cl.name })}
                  confirmLabel={t('delete')}
                  size="sm"
                  variant="ghost"
                >
                  {t('delete')}
                </ConfirmSubmit>
              </form>
            </span>
          )}
          {cl.address && <span className="basis-full text-xs text-muted-foreground">{cl.address}</span>}
        </li>
      ))}
    </ul>
  );
}
