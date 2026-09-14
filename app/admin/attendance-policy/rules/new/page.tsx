import { requireAdmin } from '@/lib/authz';
import { listAttendanceRules } from '@/core/attendance-rule';
import { listShiftsForTenant } from '@/core/roster';
import { RuleForm } from '../rule-form';
import { ruleShiftChoices } from '../shift-choices';

// 88e94371 — Add a new "Lateness, Early Out & Overtime Settings" rule. Admin-only; the rule is tenant-wide
// (6da67ab7 — there is no company to pick) and reaches employees through the shifts that select it. Route
// registered in lib/permissions.ts.
export default async function NewAttendanceRulePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const { error } = await searchParams;
  // 870b79e2 — a brand-new group can be given its shifts in the same save; nothing is ticked yet, and each
  // row says which group the shift is leaving if it is taken.
  const [shifts, rules] = await Promise.all([listShiftsForTenant(s), listAttendanceRules(s)]);
  return <RuleForm rule={null} shifts={ruleShiftChoices(shifts, rules, null)} error={error} />;
}
