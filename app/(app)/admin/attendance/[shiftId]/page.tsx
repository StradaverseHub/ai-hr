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
  //
  // aec53564 — …AND the tenant's Standard rule, whatever its status. Blank on this dropdown means "the
  // Standard rule", and core/attendance-rule.ts `resolveRuleTx` resolves it WITHOUT looking at `status`, so
  // a deactivated Standard still decides this shift. Since 07ebd04d that rule may state a working week, and
  // the form has to read the same row the write will: filtering it out here would grey the day row on the
  // server's answer and not on the screen's, and the two would disagree about one POST.
  const allRules = await listAttendanceRules(s);
  const ruleOptions = allRules.filter((r) => r.status === 'active' || r.id === shift.ruleId || r.isDefault);

  return <ShiftForm shift={shift} otWindows={otWindows} ruleOptions={ruleOptions} error={error} />;
}
