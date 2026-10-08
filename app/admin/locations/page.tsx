import { requireAdmin } from '@/lib/authz';
import { CLOCKING_LIST } from '../work-locations/clocking/form-fields';
import { forward } from './redirect-stub';

/**
 * r423 (83c0d3c8) — RE-POINTED at Attendance › Locations, the CLOCKING location list
 * (`/admin/work-locations/clocking`). This address was the clocking-site admin before r336, so an old
 * bookmark meant clocking locations; the work location listing it forwarded to since r336 has its own menu
 * row ("Work Locations") now.
 *
 * 639bf4a5 (r336) — REDIRECT STUB. The work-site register lives at `/admin/work-locations` now, under
 * Organization, named "Physical Work Location".
 *
 * WHY A GUARDED STUB AND NOT A DELETED ROUTE (the 6d091cc0 precedent, app/admin/attendance-policy):
 *   · `requireAdmin()` runs FIRST, so a non-administrator following an old bookmark is refused here
 *     rather than told where the screen went;
 *   · the route therefore stays counted by test/function-access.test.ts and stays registered on the
 *     `locations` screen column in lib/permissions.ts — a screenKey is a permission identity, and
 *     dropping the route would silently revoke grants that name it;
 *   · a stale bookmark lands on the screen it meant instead of a 404.
 *
 * THIS IS ALSO THE "LINK FROM ATTENDANCE" THE APPROVED PLAN PROMISED. The plan said the clocking points
 * move with the site "with a link from Attendance so the old route still finds them". A second MENU ROW
 * under Attendance would put one screen in two places — the very thing the same paragraph argues
 * against, and it would re-enter the address into MODULE_OF_HREF (components/sidebar.tsx), gating the
 * organization's own work-site register behind the billable attendance module. The old ROUTE is the
 * link, and it is pinned by test/work-location-organization-relocation.test.ts.
 */
export default async function LocationsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  forward(await searchParams, CLOCKING_LIST);
}
