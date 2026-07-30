import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies, listDepartments } from '@/core/read';
import { listCostCenters, listPositions } from '@/core/admin';
import { PageHeader } from '@/components/ui';
import { EmployeeImport } from './employee-import';

export default async function ImportPage() {
  const t = await getTranslations('people.import');
  const s = await requireAdmin();
  // d8471481 — the Excel template's Reference sheet is generated from these LIVE catalogs, the same
  // ones core/import's analyze() validates a row against. Reading them here (rather than
  // hand-maintaining a second list) is what makes "the value in the template is a value the importer
  // accepts" true by construction. Unscoped on purpose: a file may now span several companies.
  const [companies, departments, positions, costCenters] = await Promise.all([
    listCompanies(s),
    listDepartments(s),
    listPositions(s),
    listCostCenters(s),
  ]);
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
        back={{ href: '/admin/personnel', label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
      />
      {companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        <EmployeeImport
          companies={companies.map((c) => ({ id: c.id, name: c.name }))}
          defaultCompanyId={defaultCompanyId}
          reference={{
            // Sorted + de-duplicated: a shared label (62de487d) resolves for several companies and
            // would otherwise appear once per company in the reference list.
            departments: uniqSorted(departments.map((d) => d.name)),
            positions: uniqSorted(positions.map((p) => p.title)),
            costCenters: uniqSorted(costCenters.map((c) => c.code ?? c.name ?? '')),
          }}
        />
      )}
    </div>
  );
}

function uniqSorted(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim() !== ''))].sort((a, b) =>
    a.localeCompare(b),
  );
}
