import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { getAttendanceRule, listAttendanceRules } from '@/core/attendance-rule';
import { listShiftsForTenant } from '@/core/roster';
import { RuleForm } from '../rule-form';
import { ruleShiftChoices } from '../shift-choices';

// 88e94371 — Edit an existing rule. Standard (is_default) rules are editable here (name locked). The route
// is registered in lib/permissions.ts.
export default async function EditAttendanceRulePage({
  params,
  searchParams,
}: {
  params: Promise<{ ruleId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const { ruleId } = await params;
  const { error } = await searchParams;
  const rule = await getAttendanceRule(s, ruleId);
  if (!rule) notFound();
  // 870b79e2 — the "Shifts allowed" editor. Non-archived shifts only (an archived shift is not assignable
  // anywhere else either), read through the SAME listShiftsForTenant the shift library and the Schedule
  // screen use, so three surfaces cannot disagree about which shifts exist or in what order.
  const [shifts, rules] = await Promise.all([listShiftsForTenant(s), listAttendanceRules(s)]);
  return <RuleForm rule={rule} shifts={ruleShiftChoices(shifts, rules, rule.id)} error={error} />;
}
