import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies, listDepartments } from '@/core/read';
import { PageHeader } from '@/components/ui';
import { EmployeeImport } from './employee-import';

export default async function ImportPage() {
  const s = await requireAdmin();
  const [companies, departments] = await Promise.all([listCompanies(s), listDepartments(s)]);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  // Default to the active scope if it's a single company; otherwise the company with the most
  // departments — i.e. the operating entity people are actually hired into, not a holding shell.
  const deptCount = new Map<string, number>();
  for (const d of departments) deptCount.set(d.companyId, (deptCount.get(d.companyId) ?? 0) + 1);
  const operating = [...companies].sort(
    (a, b) => (deptCount.get(b.id) ?? 0) - (deptCount.get(a.id) ?? 0),
  )[0];
  const defaultCompanyId =
    scopeIds.length === 1 ? scopeIds[0] : (operating?.id ?? companies[0]?.id ?? '');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/people', label: 'People' }}
        title="Import employees"
        description="Bulk-load employees, statutory profiles and pay from a CSV. Validate first, then import."
      />
      {companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">Create a company before importing employees.</p>
      ) : (
        <EmployeeImport
          companies={companies.map((c) => ({ id: c.id, name: c.name }))}
          defaultCompanyId={defaultCompanyId}
        />
      )}
    </div>
  );
}
