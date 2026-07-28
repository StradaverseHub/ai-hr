import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { getAttendanceRule } from '@/core/attendance-rule';
import { RuleForm } from '../rule-form';

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
  return <RuleForm rule={rule} error={error} />;
}
