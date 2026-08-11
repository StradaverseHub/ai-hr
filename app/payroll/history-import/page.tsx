import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies, listDepartments } from '@/core/read';
import { listImportCodes } from '@/core/payroll-history-import';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { PageHeader } from '@/components/ui';
import { HistoryImport } from './history-import';

export default async function PayrollHistoryImportPage() {
  const t = await getTranslations('payroll.historyImport');
  const s = await requireAdmin();
  const [companies, departments] = await Promise.all([listCompanies(s), listDepartments(s)]);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  // Default to the active scope if it's a single company; otherwise the company with the most
  // departments — i.e. the operating entity people are actually paid in, not a holding shell.
  const deptCount = new Map<string, number>();
  for (const d of departments) deptCount.set(d.companyId, (deptCount.get(d.companyId) ?? 0) + 1);
  const operating = [...companies].sort(
    (a, b) => (deptCount.get(b.id) ?? 0) - (deptCount.get(a.id) ?? 0),
  )[0];
  const defaultCompanyId =
    scopeIds.length === 1 ? scopeIds[0] : (operating?.id ?? companies[0]?.id ?? '');

  // 4157a498 — the DOE codes the file may use and the cycle codes it may name, read from the SAME
  // sources the validator resolves against so the template's Codes sheet and the on-screen reference can
  // never disagree with what actually validates. Plain serialisable data across the RSC boundary: the
  // client component receives arrays, never a function.
  const codes = companies.length ? await listImportCodes(s) : [];
  const cyclesByCompany: Record<string, { name: string; code: string | null }[]> = {};
  for (const c of companies) {
    const cycles = await listPayrollCycles(s, c.id, { activeOnly: true });
    cyclesByCompany[c.id] = cycles.map((cy) => ({ name: cy.name, code: cy.code }));
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Feedback 8bf6dfa1: entry point relocated to the Transactions hub — back follows it. */}
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
      />
      {companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        <HistoryImport
          companies={companies.map((c) => ({ id: c.id, name: c.name, companyLabel: c.companyLabel }))}
          defaultCompanyId={defaultCompanyId}
          codes={codes}
          cyclesByCompany={cyclesByCompany}
        />
      )}
    </div>
  );
}
