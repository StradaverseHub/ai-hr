import { requireAdmin } from '@/lib/authz';
import { RuleForm } from '../rule-form';

// 88e94371 — Add a new "Lateness, Early Out & Overtime Settings" rule. Admin-only; the rule is tenant-wide
// (6da67ab7 — there is no company to pick) and reaches employees through the shifts that select it. Route
// registered in lib/permissions.ts.
export default async function NewAttendanceRulePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAdmin();
  const { error } = await searchParams;
  return <RuleForm rule={null} error={error} />;
}
