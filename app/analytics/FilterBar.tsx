'use client';

/**
 * Analytics filter bar — the established People form-GET pattern, kept minimal. A plain
 * <form method="get"> whose selects auto-submit on change (one-line progressive enhancement:
 * requestSubmit on change); date inputs keep an explicit Apply button so a no-JS session still works.
 * No useRouter / router.replace / debounce machinery — submit only fires on a discrete select change,
 * so there are no overlapping per-keystroke re-queries even on a large tenant.
 *
 * One control per underlying column (no business-unit/cost-centre duplication; nationality == citizenship
 * relabelled): company, department, cost-centre, lifecycle-status, employee-status, gender, nationality,
 * location(workState), manager, date-range.
 */
import { useTranslations } from 'next-intl';
// 9cbf5e0d — the Employee Status filter offers the five DERIVED buckets, labelled from the ONE shared
// vocabulary (people.employeeStatus), so the dashboard can never name a status differently from Personnel.
import { EMPLOYMENT_STATUSES } from '@/core/employment-status';
import { EmployeeChoiceField } from '@/components/employee-choice-field';

type Opt = { value: string; label: string };

export type FilterBarProps = {
  from: string;
  to: string;
  values: {
    companyId?: string;
    departmentId?: string;
    costCenterId?: string;
    lifecycleStatus?: string;
    assignmentStatus?: string;
    gender?: string;
    nationality?: string;
    workState?: string;
    managerEmploymentId?: string;
  };
  options: {
    companies: Opt[];
    departments: Opt[];
    costCentres: Opt[];
    locations: Opt[];
  };
  managerSelection: {employmentId:string;name:string}|null;
  preservedParams?:Record<string,string|undefined>;
};

const GENDERS = ['male', 'female', 'undisclosed'];
const NATIONALITIES = ['citizen', 'pr', 'non_citizen'];
const LIFECYCLE = ['active', 'terminated'];

export function FilterBar({ from, to, values, options, managerSelection, preservedParams }: FilterBarProps) {
  const t = useTranslations('analytics');
  // Only the native submit button carries prior report state. Normal GET submissions gain no fields.
  const contextKeys=['companyId','departmentId','costCenterId','lifecycleStatus','assignmentStatus','gender','nationality','workState','from','to','q','year','hirePage','hireSize','termPage','termSize','changePage','changeSize','carryPage','carrySize'];
  const nativeContext=JSON.stringify(Object.fromEntries(contextKeys.filter(key=>typeof preservedParams?.[key]==='string').map(key=>[key,preservedParams![key]])));
  const tStatus = useTranslations('people.employeeStatus');
  const inputCls =
    'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';
  const auto = (e: React.ChangeEvent<HTMLSelectElement>) => e.currentTarget.form?.requestSubmit();

  const Select = ({
    name,
    value,
    allLabel,
    opts,
  }: {
    name: string;
    value: string | undefined;
    allLabel: string;
    opts: Opt[];
  }) => (
    <select name={name} defaultValue={value ?? ''} onChange={auto} className={inputCls}>
      <option value="">{allLabel}</option>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <form method="get" className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
      {/* HTML implicit Enter uses the first submitter; retain the ordinary GET report action. */}
      <button type="submit" tabIndex={-1} aria-hidden="true" className="sr-only">{t('apply')}</button>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('filterCompany')}</span>
        <Select name="companyId" value={values.companyId} allLabel={t('allCompanies')} opts={options.companies} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('filterDepartment')}</span>
        <Select name="departmentId" value={values.departmentId} allLabel={t('allDepartments')} opts={options.departments} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('filterCostCentre')}</span>
        <Select name="costCenterId" value={values.costCenterId} allLabel={t('allCostCentres')} opts={options.costCentres} />
      </label>
      <EmployeeChoiceField key={values.managerEmploymentId??''} name="managerEmploymentId" label={t('filterManager')}
        allLabel={t('allManagers')} selectedId={values.managerEmploymentId} selected={managerSelection} fallbackAction="/analytics/manager-choices" fallbackContext={nativeContext} />
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('filterLifecycleStatus')}</span>
        <Select
          name="lifecycleStatus"
          value={values.lifecycleStatus}
          allLabel={t('allStatuses')}
          opts={LIFECYCLE.map((v) => ({ value: v, label: t(`lifecycle_${v}`) }))}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('chartEmploymentStatus')}</span>
        <Select
          name="assignmentStatus"
          value={values.assignmentStatus}
          allLabel={t('allStatuses')}
          opts={EMPLOYMENT_STATUSES.map((v) => ({ value: v, label: tStatus(v) }))}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('filterGender')}</span>
        <Select
          name="gender"
          value={values.gender}
          allLabel={t('allGenders')}
          opts={GENDERS.map((v) => ({ value: v, label: t(`gender_${v}`) }))}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('filterNationality')}</span>
        <Select
          name="nationality"
          value={values.nationality}
          allLabel={t('allNationalities')}
          opts={NATIONALITIES.map((v) => ({ value: v, label: t(`nationality_${v}`) }))}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('filterLocation')}</span>
        <Select name="workState" value={values.workState} allLabel={t('allLocations')} opts={options.locations} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('from')}</span>
        <input name="from" type="date" defaultValue={from} className={inputCls} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('to')}</span>
        <input name="to" type="date" defaultValue={to} className={inputCls} />
      </label>
      <div className="flex items-end gap-2">
        <button
          type="submit"
          className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('apply')}
        </button>
        <a href="/analytics" className="self-center text-sm text-muted-foreground hover:text-foreground">
          {t('reset')}
        </a>
      </div>
      {/* business-unit is intentionally NOT a control — it maps to the same cost-centre column and is not
          yet modelled (see Out of scope). Nationality is the epfCitizenship proxy relabelled. */}
    </form>
  );
}
