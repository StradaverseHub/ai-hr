import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { scheduleGroupNewPath } from '../../schedule-panel';

// 88e94371 — Add a new Schedule Group. 6d091cc0 (r301): the form (../rule-form.tsx, unchanged) opened as a
// panel on Attendance › Schedule › General. 665de026 (r331): the reporter contested that shape, so Add is a
// page of its own again — /admin/attendance/schedule/new, titled "Add Schedule" — and this address redirects
// there. requireAdmin() first: the route stays registered in lib/permissions.ts under `attendancePolicyConfig`
// (a screenKey is a permission identity) and a non-administrator is refused here rather than told where the
// screen went.
export default async function NewAttendanceRulePage() {
  await requireAdmin();
  redirect(scheduleGroupNewPath());
}
