import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { NEW_GROUP, SCHEDULE_PANEL_ANCHOR, groupEditorPath } from '../../schedule-panel';

// 88e94371 — Add a new Schedule Group. 6d091cc0 (r301): the form (../rule-form.tsx, unchanged) opens as a panel
// on Attendance › Schedule › General, so this address redirects to that panel. requireAdmin() first: the route
// stays registered in lib/permissions.ts and a non-administrator is refused here.
export default async function NewAttendanceRulePage() {
  await requireAdmin();
  redirect(`${groupEditorPath(NEW_GROUP)}#${SCHEDULE_PANEL_ANCHOR}`);
}
