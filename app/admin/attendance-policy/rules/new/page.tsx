import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { RuleForm } from '../rule-form';

// 88e94371 — Add a new "Lateness, Early Out & Overtime Settings" rule. Admin-only; the rule is owned by the
// company chosen in the form (defaults to the first company in scope). Route registered in lib/permissions.ts.
export default async function NewAttendanceRulePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const { error } = await searchParams;
  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  return <RuleForm rule={null} companies={visible.map((c) => ({ id: c.id, name: c.name }))} error={error} />;
}
