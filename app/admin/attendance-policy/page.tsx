import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { SCHEDULE, SCHEDULE_GROUPS_ANCHOR } from './schedule-panel';

/**
 * 6d091cc0 (r301) — Schedule Groups moved onto Attendance › Schedule › General. This address redirects there.
 *
 * The list this page rendered (88e94371, ad52212d round 2) is now the Schedule Group card on the General tab,
 * and its Add / Edit form opens as a panel on that page. Nothing was copied or reset; see
 * ./schedule-group-card.tsx.
 *
 * WHY A GUARDED STUB AND NOT A DELETED ROUTE. `requireAdmin()` first, THEN the redirect, so:
 *   · the route stays registered under `attendancePolicyConfig` in lib/permissions.ts — a screenKey is a
 *     permission identity, and test/function-access.test.ts only counts a page.tsx that calls a guard;
 *   · a non-administrator following an old bookmark is refused here, not told where the setting now lives;
 *   · the module gate (./layout.tsx, `moduleLayout('attendance')`) still applies to the segment;
 *   · bookmarks and the old links in other people's notes land on the card they meant.
 *
 * The fragment rides the Location header of the 307; a browser applies it to the destination. Verified on a dev
 * server render (round report).
 */
export default async function AttendancePolicyPage() {
  await requireAdmin();
  redirect(`${SCHEDULE}#${SCHEDULE_GROUPS_ANCHOR}`);
}
