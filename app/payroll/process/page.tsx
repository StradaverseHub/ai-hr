import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { PageHeader, ErrorBanner } from '@/components/ui';
import { batchDetail, listBatches } from '@/core/payroll';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listPayrollConfigs } from '@/core/payroll-config';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { PayrollTabs } from '@/components/payroll-tabs';
import { Wizard, type ResumeBatch } from './wizard';
import type { CycleOption } from './steps/step-period';

/** Map a run_type back to the wizard's cycle code. Advance/Mid-Month off-cycle presets are persisted as
 *  run_type='off_cycle' with a remarks label, so a resumed off-cycle draft re-enters as 'off_cycle' (the
 *  base preset) — the remarks label is preserved on the batch and carried through unchanged. */
function cycleFromRunType(runType: string): ResumeBatch['cycle'] {
  switch (runType) {
    case 'bonus':
      return 'bonus';
    case 'off_cycle':
      return 'off_cycle';
    case 'adjustment':
      return 'adjustment';
    default:
      return 'regular';
  }
}

/**
 * Payroll Process wizard shell (3a) — loads companies + masters + per-company payroll config + existing
 * runs, then hands off to the client wizard. The employee payload for Step 2 is fetched by the client once
 * a company is chosen (listEmployeesForPayrollRun via a server action), not eagerly here.
 */
export default async function PayrollProcessPage({ searchParams }: { searchParams: Promise<{ error?: string; resume?: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.process');
  const { error, resume } = await searchParams;
  const multiCycle = process.env.MULTI_CYCLE_PAYROLL_ENABLED === 'true';
  const thisMonth = new Date().toISOString().slice(0, 7);

  // Resume a DRAFT batch (the "who's in this run" step, formerly bypassed for drafts). Fetch under the
  // scoped-admin session — RLS returns nothing for a batch outside this admin's scope (wrong tenant/company).
  let resumeBatch: ResumeBatch | undefined;
  let resumeError: string | undefined;
  if (resume) {
    const data = await batchDetail(s, resume);
    if (!data) {
      // Not found OR not authorised for this admin's scope — show an explicit error, NOT a blank Step 1
      // (a silent fresh wizard reads as "my draft vanished"). Access-control edge case, per plan §3b.
      resumeError = t('draftNotFoundOrNoAccess');
    } else if (data.batch.status !== 'draft') {
      // A processed/closed batch resolved: /payroll/[batchId] is a legitimate direct read-only view.
      redirect(`/payroll/${resume}`);
    } else {
      const scope = (data.batch.scope ?? null) as { departmentIds?: string[]; employmentIds?: string[] } | null;
      resumeBatch = {
        id: data.batch.id,
        companyId: data.batch.companyId,
        payPeriod: data.batch.payPeriod,
        cycle: cycleFromRunType(data.batch.runType),
        paymentDate: data.batch.batchDate ?? '',
        remarks: data.batch.remarks ?? '',
        scope,
      };
    }
  }

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

  // ADR-0069: the "Payroll Cycle" dropdown now reads its options from the per-company payroll_cycle
  // catalog (active only) instead of a hardcoded list. Fetch per scoped company and build a map the
  // client filters by the selected company. The multiCycle flag still gates non-regular visibility in
  // step-period.tsx (an admin can pre-configure custom cycles on a flag-off company without risk).
  const cycleLists = await Promise.all(scopeIds.map((id) => listPayrollCycles(s, id, { activeOnly: true })));
  const cyclesByCompany: Record<string, CycleOption[]> = {};
  scopeIds.forEach((id, i) => {
    cyclesByCompany[id] = cycleLists[i].map((c) => ({ id: c.id, name: c.name, runType: c.runType, remarks: c.remarks, description: c.description }));
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <PayrollTabs active="batches" />
      <ErrorBanner message={error} />
      {resumeError ? (
        <ErrorBanner message={resumeError} />
      ) : (
        <Wizard
          // 3653d14b: the company MULTI-select is bounded to the admin's ACTIVE scope (scopeIds) — the same
          // set the per-company masters + cycle catalogs are loaded for. "All my companies" therefore means
          // "all companies I'm scoped to", and the server re-resolves it against allowedCompanies as a
          // backstop so the run can never widen beyond the admin's grants.
          companies={companies.filter((c) => scopeIds.includes(c.id)).map((c) => ({ id: c.id, name: c.name }))}
          departments={departments.map((d) => ({ id: d.id, name: d.name, companyId: d.companyId, businessUnitId: d.businessUnitId }))}
          businessUnits={businessUnits.map((b) => ({ id: b.id, name: b.name, companyId: b.companyId }))}
          positions={positions.map((p) => ({ id: p.id, name: p.title, companyId: p.companyId }))}
          costCenters={costCenters.map((c) => ({ id: c.id, name: c.name, companyId: c.companyId }))}
          jobGrades={jobGrades.map((g) => ({ id: g.id, name: g.name }))}
          payDayByCompany={payDayByCompany}
          existingRuns={allBatches.map((b) => ({ id: b.id, companyId: b.companyId, payPeriod: b.payPeriod, runType: b.runType, status: b.status, company: b.company }))}
          cyclesByCompany={cyclesByCompany}
          thisMonth={thisMonth}
          multiCycle={multiCycle}
          resumeBatch={resumeBatch}
        />
      )}
    </div>
  );
}
