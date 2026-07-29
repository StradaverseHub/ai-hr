import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import {
  listCompanies,
  listDepartments,
  listEmployeesPage,
  listJobGrades,
  listManagerCandidates,
} from '@/core/read';
import { listPositions, listCostCenters, listBusinessUnits } from '@/core/admin';
import { computeProvisionalEndOn, resolveProbationMonths } from '@/core/org';
import { getHiringDefaults } from '@/core/hiring-defaults';
import { listProfileChangeRequests } from '@/core/profile';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { Avatar, Button, Card, EmployeeCode, Field, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';
import {
  HireFormProvider,
  HireFormButton,
  HireFormPanel,
  HireFormCancelButton,
} from '@/components/hire-employee';
import { HIRE_ORG_FILTER_SCRIPT, hireOptionVisible } from '@/lib/hire-form-filter';
import { labelIdsForCompany } from '@/core/system-labels';
import { decideProfileChangeAction, hireAction } from './actions';

/** Render a pay-affecting change bundle as human-readable "field → value" pairs. */
function describeProposed(
  p: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  const PCB_LABEL: Record<number, string> = {
    1: t('pcbSingle'),
    2: t('pcbMarriedSpouseNotWorking'),
    3: t('pcbMarriedSpouseWorking'),
  };
  const o = (p ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (o.bankName != null) parts.push(`${t('fieldBank')} → ${o.bankName}`);
  if (o.bankAccountNo != null) parts.push(`${t('fieldAccount')} → ${o.bankAccountNo}`);
  if (o.taxCategory != null)
    parts.push(`${t('fieldPcb')} → ${PCB_LABEL[Number(o.taxCategory)] ?? o.taxCategory}`);
  if (o.numChildren != null) parts.push(`${t('fieldChildren')} → ${o.numChildren}`);
  return parts.length ? parts.join(' · ') : t('noChanges');
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    q?: string;
    page?: string;
    size?: string;
    company?: string;
    dept?: string;
    status?: string;
    type?: string;
  }>;
}) {
  await requireAdmin(); // Admin-only management surface (ADR: People→Personnel split). Non-admins redirect home.
  const t = await getTranslations('people.list');
  const tCommon = await getTranslations('common');
  const tStatus = await getTranslations('people.employeeStatus');
  // Employee Status redesign (R43 c26c3ce5): the People list shows the SYSTEM-DERIVED status (from each
  // employee's lifecycle dates + blacklist override), not the legacy stored assignment.status.
  const { s: session, scopeIds } = await scopedSession();
  const today = new Date().toISOString().slice(0, 10);
  const isAdmin = (session.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
  const sp = await searchParams;
  const { error, q, company, dept, status, type } = sp;
  const pq = parsePageQuery(sp);
  const statusFilter = status === 'active' || status === 'terminated' ? status : undefined;
  const hasFilters = !!(q || company || dept || status || type);
  const [
    { rows: employees, total },
    companies,
    departments,
    profileChanges,
    positions,
    costCenters,
    businessUnits,
    grades,
    managerCandidates,
  ] = await Promise.all([
    listEmployeesPage(session, {
      companyIds: scopeIds,
      q,
      companyId: company || undefined,
      departmentId: dept || undefined,
      status: statusFilter,
      employmentType: type || undefined,
      limit: pq.limit,
      offset: pq.offset,
    }),
    listCompanies(session),
    listDepartments(session),
    isAdmin
      ? listProfileChangeRequests(session, { companyIds: scopeIds, status: 'pending' })
      : Promise.resolve([]),
    // Hire-form pickers — admin-gated like the hire form itself.
    isAdmin ? listPositions(session, { companyIds: scopeIds }) : Promise.resolve([]),
    isAdmin ? listCostCenters(session, { companyIds: scopeIds }) : Promise.resolve([]),
    isAdmin ? listBusinessUnits(session, { companyIds: scopeIds }) : Promise.resolve([]),
    isAdmin ? listJobGrades(session) : Promise.resolve([]),
    isAdmin ? listManagerCandidates(session, { companyIds: scopeIds }) : Promise.resolve([]),
  ]);
  // full_time default provisional end for the server-rendered date field default. Uses the company shown
  // first in the hire form's company dropdown (companies[0]) so the default reflects that company's
  // configured probation months (null config → EA default 3).
  const defaultCompanyId = companies[0]?.id;
  const defaultProbationMonths =
    isAdmin && defaultCompanyId
      ? resolveProbationMonths((await getHiringDefaults(session, defaultCompanyId))?.probationMonths)
      : 3;
  const fullTimeProvisionalDefault =
    computeProvisionalEndOn(today, 'full_time', defaultProbationMonths) ?? today;
  // Shared System Labels (feedback 570e3311): the stamp source for the hire form's `data-companies`
  // CSVs. For each hire-picker kind, resolve labelIdsForCompany (the tested SQL resolver — origin ∪
  // shared-in ∪ global, flag-gated; core/system-labels.ts) once per company, then INVERT the answers
  // into Map(labelId → sorted company-id CSV). The resolver stays the single source of truth for the
  // flag semantics — no JS reimplementation here; a label missing from the map (e.g. its origin
  // company is archived out of the companies list) falls back to its origin company id at the stamp.
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
  const [buCompaniesCsv, deptCompaniesCsv, posCompaniesCsv, ccCompaniesCsv] = isAdmin
    ? await Promise.all([
        labelCompanyCsv('business_unit'),
        labelCompanyCsv('department'),
        labelCompanyCsv('position'),
        labelCompanyCsv('cost_center'),
      ])
    : [new Map<string, string>(), new Map<string, string>(), new Map<string, string>(), new Map<string, string>()];
  // Server-rendered initial state of the hire form's org-picker cascade. The company <select> has no
  // placeholder, so the browser auto-selects companies[0]; HIRE_ORG_FILTER_SCRIPT then runs at parse
  // time (before hydration) and stamps hidden/disabled on every option the same hireOptionVisible
  // rule rejects. Rendering that SAME initial state here makes the script's first pass a no-op and
  // keeps server HTML identical to React's output — omit this and every non-companies[0] option
  // hydrates with a mismatch warning. BU dimension: the BU select defaults to '' (None), and '' as
  // selectedBusinessUnit passes every department, so only the company (CSV-membership) rule bites
  // initially — which is why optBuCompanies can stay '' here without diverging from the script.
  const hireInitiallyHidden = (optCompanies: string) =>
    !hireOptionVisible({
      optCompanies,
      optBusinessUnit: null,
      optBuCompanies: '',
      selectedCompany: defaultCompanyId ?? '',
      selectedBusinessUnit: '',
    });
  // Zero-visible-options empty state (feedback d61f0ff2): when the selected company may use NONE of a
  // select's options, the inline script unhides that select's `<id>-empty` message ("No organization
  // labels are configured for the selected company") instead of leaving an unexplained empty dropdown.
  // Server-render the SAME initial state (default company = companies[0]) for hydration parity, exactly
  // like the hidden/disabled option stamps above — the script's parse-time pass must be a no-op.
  const buCsvs = businessUnits.map((bu) => buCompaniesCsv.get(bu.id) ?? bu.companyId);
  const deptCsvs = departments.map((d) => deptCompaniesCsv.get(d.id) ?? d.companyId);
  const posCsvs = positions.map((pos) => posCompaniesCsv.get(pos.id) ?? pos.companyId);
  const ccCsvs = costCenters.map((cc) => ccCompaniesCsv.get(cc.id) ?? cc.companyId);
  const hireInitiallyEmpty = (csvs: string[]) => csvs.every((csv) => hireInitiallyHidden(csv));
  const pgState = pageState(pq, total, employees.length);
  const EMPLOYMENT_TYPES = [
    { value: 'full_time', labelKey: 'employmentFullTime' },
    { value: 'part_time', labelKey: 'employmentPartTime' },
    { value: 'contract', labelKey: 'employmentContract' },
    { value: 'intern', labelKey: 'employmentIntern' },
  ] as const;

  // Consolidated filter panel (feedback 3542ed4a): same GET params (?q=&company=&dept=&status=&type=),
  // same query path — only the presentation moved from an inline row into a top-right panel + chips.
  // All strings resolved here so the client island stays free of dynamic t() keys. The onboarding
  // tour's "people-search" anchor now points at the Filter button (the search input lives inside it).
  const filterFields: FilterField[] = [
    {
      kind: 'search',
      name: 'q',
      label: t('search'),
      placeholder: t('searchPlaceholder'),
      ariaLabel: t('searchAriaLabel'),
      removeAriaLabel: t('removeFilter', { label: t('search') }),
    },
    {
      kind: 'select',
      name: 'company',
      label: t('company'),
      ariaLabel: t('filterCompany'),
      allLabel: t('allCompanies'),
      options: companies.map((c) => ({ value: c.id, label: c.name })),
      removeAriaLabel: t('removeFilter', { label: t('company') }),
    },
    {
      kind: 'select',
      name: 'dept',
      label: t('department'),
      ariaLabel: t('filterDepartment'),
      allLabel: t('allDepartments'),
      options: departments.map((d) => ({ value: d.id, label: d.name })),
      removeAriaLabel: t('removeFilter', { label: t('department') }),
    },
    {
      kind: 'select',
      name: 'status',
      label: t('colStatus'),
      ariaLabel: t('filterStatus'),
      allLabel: t('allStatuses'),
      options: [
        { value: 'active', label: t('statusActive') },
        { value: 'terminated', label: t('statusTerminated') },
      ],
      removeAriaLabel: t('removeFilter', { label: t('colStatus') }),
    },
    {
      kind: 'select',
      name: 'type',
      label: t('employmentType'),
      ariaLabel: t('filterType'),
      allLabel: t('allTypes'),
      options: EMPLOYMENT_TYPES.map((et) => ({ value: et.value, label: t(et.labelKey) })),
      removeAriaLabel: t('removeFilter', { label: t('employmentType') }),
    },
  ];
  const filterValues = { q, company, dept, status, type };
  const activeFilterCount = [q, company, dept, status, type].filter(Boolean).length;
  const filterLabels = {
    filter: t('filter'),
    apply: t('applyFilters'),
    clearAll: t('clearAllFilters'),
    activeCount: t('activeFilters', { count: activeFilterCount }),
  };

  return (
    <HireFormProvider>
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {t('employeeCount', { count: total })}
            </span>
            {isAdmin && (
              <Link
                href="/admin/personnel/import"
                data-tour="people-import"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('importCsv')}
              </Link>
            )}
            {/* r79a (4fb8b75a step 3) — Hiring Defaults: probation months + review reminder cadence, moved
                here from the Payroll Schedule screen, where neither had a payroll reader. */}
            {isAdmin && (
              <Link
                href="/admin/personnel/settings"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('hiringDefaults')}
              </Link>
            )}
            <FilterPanel
              action="/admin/personnel"
              fields={filterFields}
              values={filterValues}
              labels={filterLabels}
              dataTour="people-search"
            />
            {isAdmin && (
              <HireFormButton label={t('createNewEmployee')} dataTour="people-hire" />
            )}
          </div>
        }
      />

      <FilterChips
        action="/admin/personnel"
        fields={filterFields}
        values={filterValues}
        labels={filterLabels}
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {isAdmin && (
        <HireFormPanel>
          <Card>
            <form action={hireAction} className="space-y-6 p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('employeeIdLabel')}>
                  <input
                    name="employeeCode"
                    required
                    maxLength={30}
                    className={inputCls}
                    placeholder={t('employeeIdPlaceholder')}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{t('employeeIdHint')}</p>
                </Field>
                <Field label={t('fullName')}>
                  <input name="fullName" required className={inputCls} placeholder={t('fullNamePlaceholder')} />
                </Field>
                <Field label={t('email')}>
                  <input name="primaryEmail" type="email" required className={inputCls} placeholder={t('emailPlaceholder')} />
                </Field>
              </div>

              <fieldset className="space-y-4">
                <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('orgInfoHeading')}
                </legend>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t('company')}>
                    <select name="companyId" id="hire-company" required className={inputCls}>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('businessUnit')}>
                    <select
                      name="businessUnitId"
                      id="hire-business-unit"
                      defaultValue=""
                      data-hire-bu-select
                      className={inputCls}
                    >
                      <option value="">{t('businessUnitNone')}</option>
                      {businessUnits.map((bu) => {
                        const csv = buCompaniesCsv.get(bu.id) ?? bu.companyId;
                        return (
                          <option
                            key={bu.id}
                            value={bu.id}
                            data-companies={csv}
                            hidden={hireInitiallyHidden(csv)}
                            disabled={hireInitiallyHidden(csv)}
                          >
                            {bu.code} — {bu.name}
                          </option>
                        );
                      })}
                    </select>
                    <p
                      id="hire-business-unit-empty"
                      hidden={!hireInitiallyEmpty(buCsvs)}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {t('orgLabelsEmptyForCompany')}
                    </p>
                  </Field>
                  <Field label={t('department')}>
                    {/* Each department option carries the CSV of companies that may use it (resolver
                        output) and its BU id (empty = unassigned). A tiny inline script narrows this
                        list to the chosen Company's departments and, within that, to the chosen BU's;
                        unassigned (NULL-BU) departments stay visible under every BU choice. The
                        disabled '' placeholder is the self-heal target: switching Company CLEARS a
                        stale pick back to this prompt (required still blocks submit until a real pick). */}
                    <select name="departmentId" id="hire-department" required defaultValue="" className={inputCls}>
                      <option value="" disabled>
                        {t('departmentSelectPrompt')}
                      </option>
                      {departments.map((d) => {
                        const csv = deptCompaniesCsv.get(d.id) ?? d.companyId;
                        return (
                          <option
                            key={d.id}
                            value={d.id}
                            data-companies={csv}
                            data-business-unit={d.businessUnitId ?? ''}
                            data-bu-companies={d.businessUnitId ? (buCompaniesCsv.get(d.businessUnitId) ?? '') : ''}
                            hidden={hireInitiallyHidden(csv)}
                            disabled={hireInitiallyHidden(csv)}
                          >
                            {d.name}
                          </option>
                        );
                      })}
                    </select>
                    <p
                      id="hire-department-empty"
                      hidden={!hireInitiallyEmpty(deptCsvs)}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {t('orgLabelsEmptyForCompany')}
                    </p>
                  </Field>
                  <Field label={t('position')}>
                    <select name="positionId" id="hire-position" className={inputCls}>
                      <option value="">{t('positionNone')}</option>
                      {positions.map((pos) => {
                        const csv = posCompaniesCsv.get(pos.id) ?? pos.companyId;
                        return (
                          <option
                            key={pos.id}
                            value={pos.id}
                            data-companies={csv}
                            hidden={hireInitiallyHidden(csv)}
                            disabled={hireInitiallyHidden(csv)}
                          >
                            {pos.title}
                          </option>
                        );
                      })}
                    </select>
                    <p
                      id="hire-position-empty"
                      hidden={!hireInitiallyEmpty(posCsvs)}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {t('orgLabelsEmptyForCompany')}
                    </p>
                  </Field>
                  <Field label={t('jobGrade')}>
                    <select name="gradeId" className={inputCls}>
                      <option value="">{t('jobGradeNone')}</option>
                      {grades.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('reportingManager')}>
                    <select name="reportingManagerEmploymentId" defaultValue="" className={inputCls}>
                      <option value="">{t('noManager')}</option>
                      {managerCandidates.map((m) => (
                        <option key={m.employmentId} value={m.employmentId}>
                          {m.name}
                          {m.employeeCode ? ` (${m.employeeCode})` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('costCenter')}>
                    <select name="costCenterId" id="hire-cost-center" className={inputCls}>
                      <option value="">{t('costCenterNone')}</option>
                      {costCenters.map((cc) => {
                        const csv = ccCompaniesCsv.get(cc.id) ?? cc.companyId;
                        return (
                          <option
                            key={cc.id}
                            value={cc.id}
                            data-companies={csv}
                            hidden={hireInitiallyHidden(csv)}
                            disabled={hireInitiallyHidden(csv)}
                          >
                            {cc.code} — {cc.name}
                          </option>
                        );
                      })}
                    </select>
                    <p
                      id="hire-cost-center-empty"
                      hidden={!hireInitiallyEmpty(ccCsvs)}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {t('orgLabelsEmptyForCompany')}
                    </p>
                  </Field>
                </div>
              </fieldset>

              <fieldset className="space-y-4">
                <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('employmentInfoHeading')}
                </legend>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t('employmentType')}>
                    <select name="employmentType" defaultValue="full_time" className={inputCls}>
                      <option value="full_time">{t('employmentFullTime')}</option>
                      <option value="part_time">{t('employmentPartTime')}</option>
                      <option value="contract">{t('employmentContract')}</option>
                      <option value="intern">{t('employmentIntern')}</option>
                    </select>
                  </Field>
                  <Field label={t('hireDate')}>
                    <input name="hiredOn" type="date" required defaultValue={today} className={inputCls} />
                  </Field>
                  <Field label={t('provisionalEndDate')}>
                    <input
                      name="provisionalEndOn"
                      type="date"
                      defaultValue={fullTimeProvisionalDefault}
                      className={inputCls}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">{t('provisionalEndHint')}</p>
                  </Field>
                  <Field label={t('hireInitialSalary')}>
                    <input
                      name="initialBasicSalary"
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      className={inputCls}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">{t('hireInitialSalaryHint')}</p>
                  </Field>
                  <Field label={t('salaryColRemarks')}>
                    <input
                      name="initialSalaryRemarks"
                      type="text"
                      placeholder={t('salaryRemarksPlaceholder')}
                      className={inputCls}
                    />
                  </Field>
                </div>
              </fieldset>

              <div className="flex items-center gap-2">
                <Button type="submit">{t('hire')}</Button>
                <HireFormCancelButton label={tCommon('cancel')} />
              </div>
            </form>
            {/* Org-picker cascading filter (no React client island): the chosen Company narrows the
                Business Unit / Department / Position / Cost Centre lists to the labels that company MAY
                use (data-companies CSV — origin ∪ shared-in ∪ global per the System Labels resolver),
                and the chosen Business Unit further narrows Departments (unassigned, empty-BU
                departments stay visible under every BU). Selections that become hidden self-heal to
                the '' placeholder — the Department prompt included, so a company switch CLEARS the
                previous pick instead of silently auto-picking the first visible option. The
                Reporting Manager (cross-company allowed by design, core/org.ts) and Job Grade
                (tenant-wide) selects are deliberately NOT filtered. Pure DOM, server-rendered-safe;
                visibility rule shared with test/hire-form-filter.test.ts via lib/hire-form-filter.ts.
                The server-side CrossCompanyError guard in core/org.ts remains the final backstop.
                The form stays mounted (panel toggles via the `hidden` attribute) so this script
                initialises against the ids at load exactly as it did under the old collapsed panel. */}
            <script dangerouslySetInnerHTML={{ __html: HIRE_ORG_FILTER_SCRIPT }} />
          </Card>
        </HireFormPanel>
      )}

      {isAdmin && profileChanges.length > 0 && (
        <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
          <div className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <h2 className="text-sm font-semibold">{t('profileChangeRequests')}</h2>
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              {t('pendingCount', { count: profileChanges.length })}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {profileChanges.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.employee}</div>
                  <div className="text-xs text-muted-foreground">{describeProposed(r.proposed, t)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <form action={decideProfileChangeAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="approved" />
                    <Button type="submit" size="sm">
                      {t('approve')}
                    </Button>
                  </form>
                  <form action={decideProfileChangeAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="rejected" />
                    <Button type="submit" size="sm" variant="outline">
                      {t('reject')}
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {t('profileChangeHint')}
          </p>
        </Card>
      )}

      <Card className="overflow-hidden" data-tour="people-table">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('colCode')}</th>
              <th className="px-4 py-3 font-medium">{t('colName')}</th>
              <th className="px-4 py-3 font-medium">{t('colDepartment')}</th>
              <th className="px-4 py-3 font-medium">{t('colCompany')}</th>
              <th className="px-4 py-3 font-medium">{t('colStatus')}</th>
              <th className="px-4 py-3 font-medium">{t('colHired')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {employees.map((e) => (
              <tr key={e.employmentId} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <EmployeeCode code={e.employeeCode} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={e.name} />
                    <div className="min-w-0">
                      <Link
                        href={`/admin/personnel/${e.employmentId}?from=personnel`}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {e.name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">{e.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.department ?? '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{e.company}</td>
                <td className="px-4 py-3">
                  {(() => {
                    const st = deriveEmploymentStatus(e, today);
                    return <StatusBadge status={st} label={tStatus(st)} />;
                  })()}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.hiredOn}</td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  {q ? t('emptySearch', { q }) : hasFilters ? t('emptyFiltered') : t('emptyNoEmployeesAdmin')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pager basePath="/admin/personnel" params={{ q, company, dept, status, type }} state={pgState} />
      </Card>

    </div>
    </HireFormProvider>
  );
}
