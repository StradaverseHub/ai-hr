import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import {legacyWorkScheduleRedirect,type LegacyScheduleFeedback} from '@/lib/legacy-schedule-redirect';

/** Retired Work Schedule address. Keep its own admin guard and segment module gate, then
 * carry bounded feedback to the canonical Work Schedule settings page. Fragments are
 * client-side only, so this server alias retains its established default card anchor.
 */
export default async function AttendanceSchedulePage({searchParams}:{searchParams?:Promise<LegacyScheduleFeedback>} = {}) {
  await requireAdmin();
  redirect(legacyWorkScheduleRedirect(await searchParams));
}
