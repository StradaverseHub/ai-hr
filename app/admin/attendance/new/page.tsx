import { requireAdmin } from '@/lib/authz';
import { listAttendanceRules } from '@/core/attendance-rule';
import { ShiftForm } from '../shift-form';

// af7a8eb4 — Add a new shift template. Admin-only; the template is tenant-global (R33 f21d6eee — there is
// no company to pick) and reaches employees through their profile's fixed shift or Roster Management.
// Mirrors /admin/attendance-policy/rules/new. Route registered in lib/permissions.ts.
//
// The static "new" segment out-ranks the sibling dynamic "[shiftId]" in Next's segment ranking — the same
// shape /admin/holidays/groups/new + groups/[id] already ships.
export default async function NewShiftPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const { error } = await searchParams;
  // Inactive rules are hidden on a NEW shift: there is no stored ruleId that could already point at one.
  const ruleOptions = (await listAttendanceRules(s)).filter((r) => r.status === 'active');
  return <ShiftForm shift={null} otWindows={[]} ruleOptions={ruleOptions} error={error} />;
}
