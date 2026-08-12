import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { listShiftOtWindows, listShiftsForTenant } from '@/core/roster';
import { listAttendanceRules } from '@/core/attendance-rule';
import { ShiftForm } from '../shift-form';

// af7a8eb4 — Edit one shift template. Admin-only; mirrors /admin/attendance-policy/rules/[ruleId].
// Archived ("deactivated") shifts are editable from here too, which is why the lookup includes them: the
// list's Show deactivated view links straight at this route. Route registered in lib/permissions.ts.
export default async function EditShiftPage({
  params,
  searchParams,
}: {
  params: Promise<{ shiftId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const { shiftId } = await params;
  const { error } = await searchParams;

  const shifts = await listShiftsForTenant(s, { includeArchived: true });
  const shift = shifts.find((sh) => sh.id === shiftId);
  if (!shift) notFound();

  // The edited shift's overtime grid, and the rule dropdown's options. An INACTIVE rule stays offered when
  // this shift already points at it, so opening the form cannot silently re-point the shift at Standard.
  const otWindows = await listShiftOtWindows(s, shift.id);
  const allRules = await listAttendanceRules(s);
  const ruleOptions = allRules.filter((r) => r.status === 'active' || r.id === shift.ruleId);

  return <ShiftForm shift={shift} otWindows={otWindows} ruleOptions={ruleOptions} error={error} />;
}
