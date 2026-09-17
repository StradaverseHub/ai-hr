import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { SCHEDULE_PANEL_ANCHOR, groupEditorPath } from '../../schedule-panel';

// 88e94371 — Edit one Schedule Group. 6d091cc0 (r301): the form (../rule-form.tsx, unchanged) opens as a panel on
// Attendance › Schedule › General, so this address redirects to that panel. requireAdmin() first: the route stays
// registered in lib/permissions.ts and a non-administrator is refused here. An id that is not a group this viewer
// can see opens no panel there (read by value), where it used to 404 here.
export default async function EditAttendanceRulePage({ params }: { params: Promise<{ ruleId: string }> }) {
  await requireAdmin();
  const { ruleId } = await params;
  redirect(`${groupEditorPath(ruleId)}#${SCHEDULE_PANEL_ANCHOR}`);
}
