import { organisationChoiceLabels } from '@/lib/organisation-choice-label';
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
import { resolveProbationMonths } from '@/core/org';
import { getHiringDefaults } from '@/core/hiring-defaults';
import { getEmployeeDraft } from '@/core/employee-draft';
// r393 (685d2380 step 2) — the Payroll Policy picker offers what the Personnel record's offers: the DRAFT
// COMPANY'S active policies, read through the Payroll pack's facade, and only where Payroll is switched on.
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { listAssignablePolicies } from '@/packs/payroll/service';
// Recruitment slice 3 — "Start new hire": the short create form pre-filled ON THE SERVER from an application.
import { hireHandoffPrefill, RecruitmentError, type HirePrefill } from '@/packs/recruitment/service';
// Item a72610af — the Employment tab's three defaults are SEEDED INTO the draft here, on the server,
// against the draft as loaded. See the function's own header for why a display-only fallback was the bug.
import { withEmploymentDefaults } from '@/lib/employee-draft-schema';
// 35b7af0a group 8 — the nationality catalog the shared identity group offers on BOTH screens.
// Board 2c1b2fba — every profile catalog the continue form needs comes from ONE read (all categories,
// active only, the draft company), exactly as the activated record reads its own.
import { listAllProfileOptions } from '@/core/profile-options';
// Board 2c1b2fba — the ready pay item catalogue (Payroll pack facade, never core/pay-components directly)
// and whether the draft already holds a photo (kept beside the draft, never inside its JSON).
import { listPayComponents } from '@/packs/payroll/service';
import { hasEmployeeDraftPhoto } from '@/core/employee-draft-photo';
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
  // `tab` is the SAME parameter the activated record takes (app/admin/personnel/[employmentId]/page.tsx):
  // the shared tab shell writes it on every switch, and the screen it names is the one that must open on a
  // reload or a shared link. Declared here so the draft honours it instead of only writing it.
  searchParams: Promise<{ draft?: string; error?: string; tab?: string; fromApplication?: string }>;
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
    // Recruitment hand-off: the URL names only the application. Company, name and email are read here from the
    // application after the recruitment service re-checks that this administrator may start the hire.
    let hire: HirePrefill | null = null;
    let hireRefused = false;
    if (sp.fromApplication && isModuleEnabledOrFalse(session, 'recruitment')) {
      try {
        hire = await hireHandoffPrefill(session, sp.fromApplication);
        if (!companies.some((c) => c.id === hire!.companyId)) { hire = null; hireRefused = true; }
      } catch (e) {
        if (!(e instanceof RecruitmentError)) throw e;
        hireRefused = true;
      }
    }
    const rt = hire || hireRefused ? await getTranslations('recruitment.hire') : null;
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
        {hire && rt && (
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">{rt('prefillNote', { name: hire.fullName, job: hire.jobTitle })}</div>
        )}
        {hireRefused && rt && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">{rt('prefillRefused')}</div>
        )}
        <CreateEmployeeForm
          companies={companies.map((c) => ({ id: c.id, label: c.name }))}
          employeeIdRules={employeeIdRules}
          initial={hire ? { companyId: hire.companyId, fullName: hire.fullName, primaryEmail: hire.email } : undefined}
          recruitmentApplicationId={hire?.applicationId}
        />
      </div>
    );
  }

  const draftCompanyId = draft.companyId;
  const [
    departments,
    positions,
    costCenters,
    businessUnits,
    grades,
    managerCandidates,
    catalogs,
    hasPhoto,
  ] = await Promise.all([
    listDepartments(session),
    listPositions(session, { companyIds: scopeIds }),
    listCostCenters(session, { companyIds: scopeIds }),
    listBusinessUnits(session, { companyIds: scopeIds }),
    listJobGrades(session,{companyId:scopeIds.length===1?scopeIds[0]:null}),
    listManagerCandidates(session, { companyIds: scopeIds }),
    // Board 2c1b2fba — ONE catalog read for every dropdown on the continue form, active options only and
    // judged for THE DRAFT'S COMPANY (the company Activate validates against), the way the activated record
    // reads its own (`listAllProfileOptions(s, { activeOnly: true, companyId })`). It replaces the seven
    // per-kind reads that were here (nationality, dependentRelationship, country, state, salutation,
    // religion, race) and serves the categories this item added: the eight organisation labels, the
    // emergency-contact relationship and the qualification level. 35b7af0a / 759dfc7d / da7463b4 / a72610af
    // all asked for "active only, as the record reads it" — still true. An empty dependentRelationship
    // catalog is not an error: the Family tab falls back to the five built-ins, exactly as the record does.
    listAllProfileOptions(session, { activeOnly: true, companyId: draftCompanyId ?? null }),
    hasEmployeeDraftPhoto(session, draft.id),
  ]);
  const choices = (rows: { value: string; label: string }[]) => rows.map((o) => ({ value: o.value, label: o.label }));
  const nationalities = catalogs.nationality;

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

  // The full-time probation default for THIS draft's company — the hiring-defaults probation length
  // (core/hiring-defaults.ts, `company.probation_months`; NULL → 3 via `resolveProbationMonths`). Since
  // r392 (685d2380 step 1) it seeds the Probation PERIOD rather than an end date: the Employment tab works
  // the end out from the period (`draftProvisionalEndOn`), the same function Activate uses.
  // One company, not all nine (item 06f0cb8f): the company is fixed for the life of a draft, so the map
  // the wizard used to carry could only ever be read at one key.
  const probationMonths = draftCompanyId
    ? resolveProbationMonths((await getHiringDefaults(session, draftCompanyId))?.probationMonths)
    : 3;

  // r393 (685d2380 step 2) — PAYROLL SWITCHED ON for this draft's company decides whether the Payroll tab
  // shows the policy picker at all (the record's own `payrollOn` rule, asked about the draft's company), and
  // the picker offers the SAME list the record's does: `listAssignablePolicies` for that company — active
  // policies only — with blank meaning the Monthly default. `completeEmployeeDraft` asks the same question
  // and ignores a stored policy when the answer is no, so what is hidden here is also not applied.
  const payrollOn = draftCompanyId ? isModuleEnabledOrFalse(session, 'payroll', draftCompanyId) : false;
  // Board 2c1b2fba — the Pay items section's catalogue: READY components for the draft company only, read
  // only where Payroll is on (the record's `payComponentsCard` rule — off, or an empty catalogue, hides the
  // section). Both reads are for the one draft company, side by side; nothing here loops.
  const [policyRows, componentRows] =
    payrollOn && draftCompanyId
      ? await Promise.all([
          listAssignablePolicies(session, draftCompanyId),
          listPayComponents(session, { readyOnly: true, companyId: draftCompanyId }),
        ])
      : ([[], []] as [
          Awaited<ReturnType<typeof listAssignablePolicies>>,
          Awaited<ReturnType<typeof listPayComponents>>,
        ]);
  const payrollPolicies = policyRows.map((p) => ({ id: p.id, name: p.name }));
  const payComponents = componentRows.map((c) => ({ id: c.id, code: c.code, name: c.name }));

  // Board 2c1b2fba — the continue form uses the activated record's full width (its page wraps in
  // `max-w-[100rem]`); the four-field Create form above stays narrow.
  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
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
        key={draft.id}
        today={today}
        draftId={draft.id}
        reservedEmployeeCode={draft.reservedEmployeeCode}
        initialData={withEmploymentDefaults(draft.data, { hiredOn: today, probationMonths })}
        initialStep={draft.currentStep}
        initialTab={sp.tab}
        companies={companies.map((c) => ({ id: c.id, label: c.name }))}
        businessUnits={organisationChoiceLabels(businessUnits).map((b) => ({
          id: b.id,
          label: b.displayLabel,
          companies: buCsv.get(b.id) ?? b.companyId,
        }))}
        departments={organisationChoiceLabels(departments).map((d) => ({
          id: d.id,
          label: d.displayLabel,
          companies: deptCsv.get(d.id) ?? d.companyId,
          businessUnitId: d.businessUnitId ?? '',
          buCompanies: d.businessUnitId ? (buCsv.get(d.businessUnitId) ?? '') : '',
        }))}
        positions={organisationChoiceLabels(positions).map((p) => ({ id: p.id, label: p.displayLabel, companies: posCsv.get(p.id) ?? p.companyId }))}
        costCenters={organisationChoiceLabels(costCenters).map((c) => ({
          id: c.id,
          label: c.displayLabel,
          companies: ccCsv.get(c.id) ?? c.companyId,
        }))}
        grades={organisationChoiceLabels(grades).map((g) => ({ id: g.id, label: g.displayLabel }))}
        // r392 — CODE then name ("EMP-0008 – John Tan"), the label the Personnel record's Direct Superior
        // Combobox uses, so typing an Employee ID or part of a name narrows the list the same way on both.
        // The candidate set itself is unchanged: `listManagerCandidates(session, { companyIds: scopeIds })`.
        managers={managerCandidates.map((m) => ({
          id: m.employmentId,
          label: m.employeeCode ? `${m.employeeCode} – ${m.name}` : m.name,
        }))}
        nationalityOptions={choices(nationalities)}
        // PLAIN DATA across the boundary, trimmed to what the dropdowns render: this screen is a client
        // component and a catalog row's sort order and active flag would be columns in the browser bundle
        // that nothing on the page reads.
        profileOptions={{
          salutation: choices(catalogs.salutation),
          religion: choices(catalogs.religion),
          race: choices(catalogs.race),
        }}
        relationshipOptions={choices(catalogs.dependentRelationship)}
        countryOptions={choices(catalogs.country)}
        stateOptions={choices(catalogs.state)}
        // Board 2c1b2fba — the record's own catalogs for the eight organisation labels, the emergency-contact
        // relationship and the qualification level. Plain value/label data, like every catalog above.
        orgLabelOptions={{
          division: choices(catalogs.division),
          branch: choices(catalogs.branch),
          region: choices(catalogs.region),
          line: choices(catalogs.line),
          section: choices(catalogs.section),
          team: choices(catalogs.team),
          base: choices(catalogs.base),
          category: choices(catalogs.category),
        }}
        emergencyRelationshipOptions={choices(catalogs.relationship)}
        qualificationLevelOptions={choices(catalogs.qualificationLevel)}
        payrollOn={payrollOn}
        payrollPolicies={payrollPolicies}
        payComponents={payComponents}
        hasPhoto={hasPhoto}
      />
    </div>
  );
}

/**
 * `withProbationDefault` USED TO LIVE HERE and is now `withEmploymentDefaults` in
 * lib/employee-draft-schema.ts — item a72610af. It was already doing the right thing for the provisional
 * end date (seeding it INTO the data, on the server, against the draft as loaded) while the employment
 * type and the hire date beside it were only ever DISPLAYED. That asymmetry is the defect: it is why a
 * stuck draft on production carries a probation-derived end date and no employment type at all.
 *
 * It moved rather than grew a second half here because the ORDER of the three seeds is load-bearing (the
 * end date is derived from the type), and because a rule the wizard's own controls have to agree with
 * belongs in the module both screens already share.
 */
