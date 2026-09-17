import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { SCHEDULE, WORK_SCHEDULE_OVERTIME_ANCHOR } from '../schedule-panel';

/**
 * 6d091cc0 (r301) — "Company work schedule & overtime rates" moved onto Attendance › Schedule › General. This
 * address redirects there.
 *
 * What this page still owned after r287 — backup-shift coverage, the tenant overtime rates and the registered
 * clocking devices with Revoke — is the Work Schedule & Overtime Rates card now (../work-schedule-overtime-card.tsx),
 * and each company's working week is a row of Company Policy Settings with its editor in a panel. Same reads,
 * same writers; nothing was copied or reset.
 *
 * A guarded stub for the same reasons as ../page.tsx: `requireAdmin()` keeps the route registered (a screenKey is a
 * permission identity), refuses a non-administrator before revealing anything, and keeps the module gate on the
 * segment; the redirect keeps bookmarks working.
 */
export default async function AttendanceSchedulePage() {
  await requireAdmin();
  redirect(`${SCHEDULE}#${WORK_SCHEDULE_OVERTIME_ANCHOR}`);
}
