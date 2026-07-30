import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import {
  listCompanies,
  listDepartments,
  listJobGrades,
  listManagerCandidates,
} from '@/core/read';
import { listPositions, listCostCenters, listBusinessUnits } from '@/core/admin';
import { computeProvisionalEndOn, resolveProbationMonths } from '@/core/org';
import { getHiringDefaults } from '@/core/hiring-defaults';
import { getEmployeeDraft, listEmployeeDrafts } from '@/core/employee-draft';
import { labelIdsForCompany } from '@/core/system-labels';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { PageHeader } from '@/components/ui';
import { EmployeeWizard } from './wizard';

/**
 * Create New Employee — a dedicated, step-by-step screen (item 6d671f44).
 *
 * The reporter's requirement is literal: "The current employee list screen shall not be used for data
 * entry." So this is its own route, and the Personnel list keeps only the button that opens it.
 *
 * Everything the wizard needs is loaded ONCE here and handed down: a step-by-step form that fetched a
 * catalog per step would make going back a network round trip, and HR moves back and forth constantly.
 * The `data-companies` CSV stamps are the SAME resolver output the old inline hire form used
 * (`labelIdsForCompany`, origin ∪ shared-in ∪ global, flag-gated) — the cascade rule moved screens, it
 * did not get reimplemented, and `hireOptionVisible` remains its one definition.
 */
export default async function CreateEmployeePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; error?: string }>;
}) {
  await requireAdmin();
  const t = await getTranslations('people.wizard');
  const { s: session, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const today = todayInKualaLumpur();

  const [companies, departments, positions, costCenters, businessUnits, grades, managerCandidates, drafts] =
    await Promise.all([
      listCompanies(session),
      listDepartments(session),
      listPositions(session, { companyIds: scopeIds }),
      listCostCenters(session, { companyIds: scopeIds }),
      listBusinessUnits(session, { companyIds: scopeIds }),
      listJobGrades(session),
      listManagerCandidates(session, { companyIds: scopeIds }),
      listEmployeeDrafts(session),
    ]);

  const draft = sp.draft ? await getEmployeeDraft(session, sp.draft) : null;

  // Same inversion the Personnel page performs: resolver answers per company → Map(labelId → CSV).
  const labelCompanyCsv = async (kind: string): Promise<Map<string, string>> => {
    const perCompany = await Promise.all(
      companies.map(async (c) => ({ companyId: c.id, ids: await labelIdsForCompany(session, kind, c.id) })),
    );
    const byLabel = new Map<string, string[]>();
    for (const { companyId, ids } of perCompany) {
      for (const id of ids) {
        const arr = byLabel.get(id);
        if (arr) arr.push(companyId);
        else byLabel.set(id, [companyId]);
      }
    }
    return new Map(Array.from(byLabel, ([id, cos]) => [id, cos.sort().join(',')] as const));
  };
  const [buCsv, deptCsv, posCsv, ccCsv] = await Promise.all([
    labelCompanyCsv('business_unit'),
    labelCompanyCsv('department'),
    labelCompanyCsv('position'),
    labelCompanyCsv('cost_center'),
  ]);

  // The full-time probation default, per company, so the Employment step can fill the provisional end
  // date the moment a company is chosen — the same figure `hireAction` computes server-side, which
  // remains the authority (r79a / 4fb8b75a step 3: it comes from HIRING defaults, not payroll config).
  const probationDefaults: Record<string, string> = {};
  for (const c of companies) {
    const months = resolveProbationMonths((await getHiringDefaults(session, c.id))?.probationMonths);
    probationDefaults[c.id] = computeProvisionalEndOn(today, 'full_time', months) ?? today;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/admin/personnel', label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
      />
      {sp.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {sp.error}
        </div>
      )}
      <EmployeeWizard
        today={today}
        draftId={draft?.id ?? null}
        initialData={draft?.data ?? {}}
        initialStep={draft?.currentStep ?? 1}
        drafts={drafts.map((d) => ({
          id: d.id,
          label: d.label,
          companyName: d.companyName,
          currentStep: d.currentStep,
          createdByName: d.createdByName,
          updatedAt: d.updatedAt.toISOString(),
          missingCount: d.missing.length,
        }))}
        companies={companies.map((c) => ({ id: c.id, label: c.name }))}
        businessUnits={businessUnits.map((b) => ({
          id: b.id,
          label: `${b.code} — ${b.name}`,
          companies: buCsv.get(b.id) ?? b.companyId,
        }))}
        departments={departments.map((d) => ({
          id: d.id,
          label: d.name,
          companies: deptCsv.get(d.id) ?? d.companyId,
          businessUnitId: d.businessUnitId ?? '',
          buCompanies: d.businessUnitId ? (buCsv.get(d.businessUnitId) ?? '') : '',
        }))}
        positions={positions.map((p) => ({ id: p.id, label: p.title, companies: posCsv.get(p.id) ?? p.companyId }))}
        costCenters={costCenters.map((c) => ({
          id: c.id,
          label: `${c.code} — ${c.name}`,
          companies: ccCsv.get(c.id) ?? c.companyId,
        }))}
        grades={grades.map((g) => ({ id: g.id, label: g.name }))}
        managers={managerCandidates.map((m) => ({
          id: m.employmentId,
          label: m.employeeCode ? `${m.name} (${m.employeeCode})` : m.name,
        }))}
        probationDefaults={probationDefaults}
      />
    </div>
  );
}
