import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { PageHeader, ErrorBanner } from '@/components/ui';
import { listBatches } from '@/core/payroll';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listPayrollConfigs } from '@/core/payroll-config';
import { PayrollTabs } from '@/components/payroll-tabs';
import { Wizard } from './wizard';

/**
 * Payroll Process wizard shell (3a) — loads companies + masters + per-company payroll config + existing
 * runs, then hands off to the client wizard. The employee payload for Step 2 is fetched by the client once
 * a company is chosen (listEmployeesForPayrollRun via a server action), not eagerly here.
 */
export default async function PayrollProcessPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.process');
  const { error } = await searchParams;
  const multiCycle = process.env.MULTI_CYCLE_PAYROLL_ENABLED === 'true';
  const thisMonth = new Date().toISOString().slice(0, 7);

  const [companies, departments, businessUnits, positions, costCenters, jobGrades, payrollConfigs, allBatches] = await Promise.all([
    listCompanies(s),
    listDepartments(s, { companyIds: scopeIds }),
    listBusinessUnits(s, { companyIds: scopeIds }),
    listPositions(s, { companyIds: scopeIds }),
    listCostCenters(s, { companyIds: scopeIds }),
    listJobGrades(s),
    listPayrollConfigs(s, scopeIds),
    listBatches(s, scopeIds),
  ]);

  const payDayByCompany = Object.fromEntries(payrollConfigs.map((c) => [c.companyId, c.payDay]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <PayrollTabs active="batches" />
      <ErrorBanner message={error} />
      <Wizard
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
        departments={departments.map((d) => ({ id: d.id, name: d.name, companyId: d.companyId, businessUnitId: d.businessUnitId }))}
        businessUnits={businessUnits.map((b) => ({ id: b.id, name: b.name, companyId: b.companyId }))}
        positions={positions.map((p) => ({ id: p.id, name: p.title, companyId: p.companyId }))}
        costCenters={costCenters.map((c) => ({ id: c.id, name: c.name, companyId: c.companyId }))}
        jobGrades={jobGrades.map((g) => ({ id: g.id, name: g.name }))}
        payDayByCompany={payDayByCompany}
        existingRuns={allBatches.map((b) => ({ id: b.id, companyId: b.companyId, payPeriod: b.payPeriod, runType: b.runType, status: b.status, company: b.company }))}
        thisMonth={thisMonth}
        multiCycle={multiCycle}
      />
    </div>
  );
}
