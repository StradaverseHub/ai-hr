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
import { getEmployeeDraft } from '@/core/employee-draft';
import type { EmployeeDraftData } from '@/lib/employee-draft-schema';
// 35b7af0a group 8 — the nationality catalog the shared identity group offers on BOTH screens.
import { listProfileOptions } from '@/core/profile-options';
import { listConfigs, resolveEmployeeIdRule } from '@/core/employee-id-config';
import { labelIdsForCompany } from '@/core/system-labels';
import type { EmployeeIdRule } from '@/lib/employee-id-mode';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { PageHeader } from '@/components/ui';
import { CreateEmployeeForm } from './create-form';
import { EmployeeWizard } from './wizard';

/**
 * Create New Employee — a dedicated screen (item 6d671f44, reshaped by 06f0cb8f).
 *
 * The reporter's requirement is literal: "The current employee list screen shall not be used for data
 * entry." So this is its own route, and the Personnel list keeps only the button that opens it.
 *
 * ONE ROUTE, TWO FORMS (item 06f0cb8f): without `?draft=` this is the SHORT create form — four fields,
 * then the record exists and its Employee ID is held. With `?draft=<id>` it is the continue form, the
 * rest of the details, ending at Activate. It is deliberately one route and not two: the Create form's
 * only outcome is to land on the continue form, `lib/permissions.ts` already registers this address, and
 * splitting it would put a second guarded page in the way of the same two clicks.
 *
 * THE CATALOGS ARE ONLY LOADED FOR THE CONTINUE FORM. The Create form needs companies and the Employee
 * ID rules and nothing else; departments, positions, cost centres, grades, managers, nationalities and
 * the per-company probation defaults are eight reads the four-field screen would never use. Everything
 * the continue form needs is still loaded ONCE — a step-by-step form that fetched a catalog per step
 * would make going back a network round trip, and HR moves back and forth constantly.
 *
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

  // The draft first: it decides which of the two forms this route is, and therefore what has to be read.
  const draft = sp.draft ? await getEmployeeDraft(session, sp.draft) : null;

  const [companies, idConfigs] = await Promise.all([listCompanies(session), listConfigs(session, scopeIds)]);

  // Item bd271009 — which Employee ID Auto Running Number Setup applies to each company, resolved ONCE
  // here from a single read rather than a query per company as the select is used. What crosses the
  // boundary is PLAIN DATA (booleans, strings, numbers, and a pre-formatted sample code): both forms are
  // client components, and a formatter or a translator closure passed here would throw at render and take
  // the whole page down — the r123 fault test/server-client-boundary.test.ts exists to catch.
  const employeeIdRules: Record<string, EmployeeIdRule> = {};
  for (const c of companies) employeeIdRules[c.id] = resolveEmployeeIdRule(idConfigs, c.id);

  if (!draft) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          back={{ href: '/admin/personnel', label: t('backLabel') }}
          title={t('title')}
          description={t('createDescription')}
        />
        {sp.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
            {sp.error}
          </div>
        )}
        <CreateEmployeeForm
          companies={companies.map((c) => ({ id: c.id, label: c.name }))}
          employeeIdRules={employeeIdRules}
        />
      </div>
    );
  }

  const [departments, positions, costCenters, businessUnits, grades, managerCandidates, nationalities] =
    await Promise.all([
      listDepartments(session),
      listPositions(session, { companyIds: scopeIds }),
      listCostCenters(session, { companyIds: scopeIds }),
      listBusinessUnits(session, { companyIds: scopeIds }),
      listJobGrades(session),
      listManagerCandidates(session, { companyIds: scopeIds }),
      // 35b7af0a group 8 — active options only, exactly as the Personnel profile card reads them, so a
      // nationality HR can pick here is one core/org.ts's catalog validation will accept on a later edit.
      listProfileOptions(session, 'nationality', { activeOnly: true }),
    ]);

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

  // The full-time probation default for THIS draft's company, so the Employment step opens with the
  // provisional end date already filled — the same figure `hireAction` computes server-side, which
  // remains the authority (r79a / 4fb8b75a step 3: it comes from HIRING defaults, not payroll config).
  // One company, not all nine (item 06f0cb8f): the company is fixed for the life of a draft, so the map
  // the wizard used to carry could only ever be read at one key.
  const draftCompanyId = draft.companyId;
  const probationMonths = draftCompanyId
    ? resolveProbationMonths((await getHiringDefaults(session, draftCompanyId))?.probationMonths)
    : 3;
  const probationDefault = computeProvisionalEndOn(today, 'full_time', probationMonths) ?? today;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/admin/personnel', label: t('backLabel') }}
        title={t('continueTitle')}
        description={t('description')}
      />
      {sp.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {sp.error}
        </div>
      )}
      <EmployeeWizard
        today={today}
        draftId={draft.id}
        reservedEmployeeCode={draft.reservedEmployeeCode}
        initialData={withProbationDefault(draft.data, probationDefault)}
        initialStep={draft.currentStep}
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
        nationalityOptions={nationalities.map((o) => ({ value: o.value, label: o.label }))}
      />
    </div>
  );
}

/**
 * Seed the provisional end date the FIRST time the Employment step is opened, and only then.
 *
 * It used to be filled by the company picker's change handler, which no longer exists on this form — the
 * company is fixed at Create. Applied here rather than in the wizard so it happens once, on the server,
 * against the draft as loaded: a client-side effect would re-apply the default every render and fight
 * anyone who deliberately cleared the field.
 */
function withProbationDefault(data: EmployeeDraftData, provisionalEndOn: string): EmployeeDraftData {
  const e = data.employment ?? {};
  if (e.provisionalEndOn !== undefined) return data;
  if ((e.employmentType ?? 'full_time') !== 'full_time') return data;
  return { ...data, employment: { ...e, provisionalEndOn } };
}
