import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { PageHeader, ErrorBanner, pageWideCls } from '@/components/ui';
import { batchDetail, listBatches } from '@/core/payroll';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listPayrollConfigs } from '@/core/payroll-config';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { Wizard, type ResumeBatch } from './wizard';
// 7076f8af — the draft adjustment panel, rendered HERE (on the server) and handed to the client wizard as
// a node. See app/payroll/adjustments-panel.tsx for why the panel moved and why it was not deleted.
import { PayrollAdjustmentsPanel } from '../adjustments-panel';
import type { CycleOption } from './steps/step-period';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
// d75b0c11 — Back returns the Payroll Process list AS IT WAS LEFT. The label + the `payroll.list`
// lookup live in the shared helper so this page keeps exactly ONE next-intl namespace (see
// app/payroll/back.ts, and test/i18n-coverage.test.ts Check C, which only resolves single-namespace files).
import { payrollProcessBack } from '../back';

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
export default async function PayrollProcessPage({
  searchParams,
}: {
  // iPage/iSize page the adjustment panel's input grid on the Review step, using the same prefixed pair
  // the run screen used, so paging it can never be confused with a future listing on this page.
  searchParams: Promise<{ error?: string; resume?: string; from?: string; iPage?: string; iSize?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.process');
  const { error, resume, from, iPage, iSize } = await searchParams;
  // d75b0c11 — the Payroll Process list hands this screen its own filter query as `?from=…` (on the
  // period cell, on Continue and on the New-run button). Whitelisted BY SHAPE inside the helper, never
  // echoed raw. Absent or hostile ⇒ `/payroll`, i.e. byte-identical to the pre-d75b0c11 destination.
  //
  // r253 — THE HREF IS SHARED, THE LABEL IS NOT. d75b0c11 passed the helper's whole return value to
  // PageHeader, which silently changed this screen's Back from "Back" (`payroll.process.back`) to
  // "Payroll" (`payroll.list.title`) — a user-visible string nobody asked to change. The destination is
  // what the item was about; the wording stays this screen's own key.
  const back = { href: (await payrollProcessBack(from)).href, label: t('back') };
  // Carried into the wizard so the TERMINAL screen of the run flow (`/payroll/process/result`) receives
  // it too — its Back has read `?from=` since 9066bd6c but nothing has ever supplied one.
  const carryFrom = back.href === '/payroll' ? undefined : back.href;
  const multiCycle = isModuleEnabledOrFalse(s, 'multi_cycle_payroll');
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

  // Organization Module (361e3b15): each company's SAVED default cycle name, so the wizard's Step-1 pre-select
  // for the single/primary company loads the stored default (matched by name against the active options) —
  // making the saved default load-bearing, not decorative. Falls back gracefully when the name is inactive.
  const defaultCycleByCompany: Record<string, string> = {};
  for (const c of companies) if (scopeIds.includes(c.id)) defaultCycleByCompany[c.id] = c.defaultPayrollCycle;

  return (
    <div className={pageWideCls}>
      {/* e440991b point 1 — this was the one screen in the product with no way back. Every other
          multi-step screen passes `back`; the wizard's own in-step Back button only walks between
          steps, so from step 1 the only exit was the browser control. Points at the run listing this
          wizard is entered from — d75b0c11 makes that the listing AS IT WAS LEFT rather than a bare
          /payroll, which is the same destination whenever no filter selection was carried in. */}
      <PageHeader title={t('title')} description={t('subtitle')} back={back} />
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
          defaultCycleByCompany={defaultCycleByCompany}
          thisMonth={thisMonth}
          multiCycle={multiCycle}
          resumeBatch={resumeBatch}
          from={carryFrom}
          adjustmentsPanel={
            resumeBatch ? (
              /* r253 — THE PANEL RETURNS TO THIS SCREEN WITH THE SELECTION STILL ON IT. `returnTo` was
                 hardcoded without `from`, so pressing any consolidation bridge (Prefill overtime,
                 Transfer allowances, saving one employee's row…) redirected to a wizard URL with no
                 selection: this screen's Back collapsed to `/payroll` and running the payroll from
                 there landed on a Result screen with nothing to carry either. `adjustmentReturnTo`
                 keeps a whitelisted path's query verbatim, so the encoded value survives the round
                 trip; the pager gets it too, since paging the input grid is the same navigation. */
              <PayrollAdjustmentsPanel
                batchId={resumeBatch.id}
                returnTo={`/payroll/process?resume=${resumeBatch.id}${
                  carryFrom ? `&from=${encodeURIComponent(carryFrom)}` : ''
                }`}
                pager={{
                  basePath: '/payroll/process',
                  params: { resume: resumeBatch.id, ...(carryFrom ? { from: carryFrom } : {}) },
                  page: iPage,
                  size: iSize,
                }}
              />
            ) : null
          }
        />
      )}
    </div>
  );
}
