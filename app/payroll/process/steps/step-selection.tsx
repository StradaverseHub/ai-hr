'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EmployeeCode, Field, inputCls } from '@/components/ui';
import { materializeToggle } from '../selection-logic';
import { EMPLOYMENT_STATUSES } from '@/core/employment-status';
// 7076f8af — the SAME partial-ID/partial-name rule the Personnel switcher and the two payroll report
// screens use (lib/employee-search.ts), as a predicate rather than a ranked jump list, so "emp0008" finds
// "EMP-0008" here for the same reason it does there. Dependency-free, so a client island may import it.
import { matchesEmployeeSearch } from '@/lib/employee-search';

/** A label option for the Step-2 filter dropdowns. `isGlobal` is the "All Companies" criteria: a global
 *  label belongs to every company of the tenant, so the wizard's company narrowing unions it in
 *  (f1bbc572) rather than testing the origin company alone. */
export type Master = { id: string; name: string; companyId: string; isGlobal: boolean };

// Client-safe mirror of core/read.ts's PayrollRunEmployeeRow (NOT imported directly — core/read.ts pulls
// in db/client, which is server-only and would break the client/server RSC boundary for this component).
export type PayrollRunEmployeeRow = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  departmentId: string | null;
  businessUnitId: string | null;
  positionId: string | null;
  gradeId: string | null;
  costCenterId: string | null;
  employmentType: string | null;
  /** R81: a derived Employee Status bucket (EmploymentStatus), never a stored column value. */
  status: string | null;
  hiredOn: string;
  terminatedOn: string | null;
  hasCurrentCompensation: boolean;
  /** 7076f8af — the employee's assigned Payroll Policy name; null for most employments today. */
  payrollPolicyName: string | null;
};

/** Step 2 (3d) — filter bar (AND-combined) + individual picker with select-all/clear + live headcount.
 *  Filters narrow the PREVIEW list; the resolved explicit id set is what's submitted (plan's scope rule:
 *  any filter use or manual deselect ⇒ explicit snapshot; nothing touched ⇒ no scope = whole company). */
export function StepSelection({
  employees,
  loading,
  multiCompany = false,
  businessUnits,
  departments,
  positions,
  jobGrades,
  costCenters,
  selected,
  onSelectedChange,
  filtersTouched,
  onFiltersTouchedChange,
}: {
  employees: PayrollRunEmployeeRow[];
  loading: boolean;
  /** 3653d14b: when the run spans more than one company, show a Company column so the admin can tell whose
   *  employees they are picking. Single-company runs omit the column (no visual change from before). */
  multiCompany?: boolean;
  businessUnits: Master[];
  departments: (Master & { businessUnitId: string | null })[];
  positions: Master[];
  jobGrades: { id: string; name: string }[];
  costCenters: Master[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  filtersTouched: boolean;
  onFiltersTouchedChange: (v: boolean) => void;
}) {
  const t = useTranslations('payroll.process');
  // A SECOND namespace in this file (R81). The shared Employee Status labels live under
  // `people.employeeStatus` and are reused verbatim by Personnel, the dashboard, leave and analytics —
  // duplicating six strings into `payroll.process` would be the drift this item exists to remove. NOTE:
  // scripts/i18n-check.mjs check C skips any file using more than one namespace, so the six keys × six
  // locales behind tStatus are verified by hand and by test/employment-status-state-machine.test.ts,
  // which asserts every locale carries every bucket.
  const tStatus = useTranslations('people.employeeStatus');
  const [businessUnitId, setBusinessUnitId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [gradeId, setGradeId] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [status, setStatus] = useState('');
  // 7076f8af — free-text search over Employee ID and name. It is an EIGHTH FILTER, not a separate mode:
  // AND-combined with the seven dropdowns below, marked through the same markFilterTouch, and toggling a
  // row while it is active goes through the same materializeToggle. That is what stops a search from
  // clobbering an edited selection — typing narrows what you SEE, never who is in the run.
  const [search, setSearch] = useState('');

  const filtered = useMemo(
    () =>
      employees.filter(
        (e) =>
          (!businessUnitId || e.businessUnitId === businessUnitId) &&
          (!departmentId || e.departmentId === departmentId) &&
          (!positionId || e.positionId === positionId) &&
          (!gradeId || e.gradeId === gradeId) &&
          (!employmentType || e.employmentType === employmentType) &&
          (!costCenterId || e.costCenterId === costCenterId) &&
          (!status || e.status === status) &&
          matchesEmployeeSearch(e, search),
      ),
    [employees, businessUnitId, departmentId, positionId, gradeId, employmentType, costCenterId, status, search],
  );

  const anyFilterActive = !!(
    businessUnitId ||
    departmentId ||
    positionId ||
    gradeId ||
    employmentType ||
    costCenterId ||
    status ||
    search.trim()
  );

  // A status filter that would exclude a mid-period leaver — visible warning per plan §"missing-edges".
  const excludedLeavers = useMemo(
    () => (status ? employees.filter((e) => e.terminatedOn && e.status !== status) : []),
    [employees, status],
  );
  const compLess = useMemo(() => employees.filter((e) => !e.hasCurrentCompensation), [employees]);

  const markFilterTouch = () => {
    // A filter narrows the PREVIEW list only — it must NOT clobber an already-edited `selected` set (plan §3d):
    // if the admin has deselected someone and then touches a filter, that manual deselection must survive
    // (the resulting scope stays "everyone minus that one", not "reset to the whole filtered view"). So this
    // deliberately only marks the selection as touched; it does not rewrite `selected`.
    if (!filtersTouched) onFiltersTouchedChange(true);
  };

  const toggle = (id: string) => {
    // Bug fix (plan §3d): when the selection has NOT yet been materialised (whole-company default, nothing
    // touched, no filter active), every visible row renders CHECKED via the `!filtersTouched && !anyFilterActive`
    // fallback — but `selected` is still empty. Toggling one row off `selected` (an empty set) would produce a
    // SINGLETON {id}, i.e. "only that one selected" instead of "everyone except that one". materializeToggle
    // seeds from the currently-checked visible rows FIRST on that first touch, then applies the toggle. After
    // materialisation (filtersTouched or a filter active — incl. resume mode, which seeds from the persisted
    // scope) it is the plain add/delete against `selected`. Same pure fn the unit test asserts.
    const next = materializeToggle(
      id,
      selected,
      filtered.map((e) => e.employmentId),
      filtersTouched,
      anyFilterActive,
    );
    onSelectedChange(next);
    if (!filtersTouched) onFiltersTouchedChange(true);
  };
  const selectAll = () => {
    onSelectedChange(new Set(filtered.map((e) => e.employmentId)));
    onFiltersTouchedChange(true);
  };
  const clearAll = () => {
    onSelectedChange(new Set());
    onFiltersTouchedChange(true);
  };

  const employmentTypes = [...new Set(employees.map((e) => e.employmentType).filter((v): v is string => !!v))];
  // R81 (9cbf5e0d): the Status filter's options are the DERIVED Employee Status buckets present in this
  // run's population, listed in the resolver's canonical order rather than in row order — so the dropdown
  // reads the same, in the same sequence, as the Personnel filter. Intersecting with EMPLOYMENT_STATUSES
  // also means a value the deriver cannot produce can never appear here.
  const present = new Set(employees.map((e) => e.status).filter((v): v is string => !!v));
  const statuses = EMPLOYMENT_STATUSES.filter((v) => present.has(v));

  const headcount = anyFilterActive || filtersTouched ? filtered.filter((e) => selected.has(e.employmentId)).length : employees.length;

  return (
    <div className="space-y-4">
      {/* The search box sits ABOVE the seven dropdowns because it is the affordance the reporter asked
          for by name ("search box for employee ID or name") and the one people reach for first. */}
      <Field label={t('searchLabel')}>
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            markFilterTouch();
          }}
          placeholder={t('searchPlaceholder')}
          className={inputCls}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t('filterBusinessUnit')}>
          <select value={businessUnitId} onChange={(e) => { setBusinessUnitId(e.target.value); markFilterTouch(); }} className={inputCls}>
            <option value="">{t('filterAll')}</option>
            {businessUnits.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('filterDepartment')}>
          <select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); markFilterTouch(); }} className={inputCls}>
            <option value="">{t('filterAll')}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('filterPosition')}>
          <select value={positionId} onChange={(e) => { setPositionId(e.target.value); markFilterTouch(); }} className={inputCls}>
            <option value="">{t('filterAll')}</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('filterJobGrade')}>
          <select value={gradeId} onChange={(e) => { setGradeId(e.target.value); markFilterTouch(); }} className={inputCls}>
            <option value="">{t('filterAll')}</option>
            {jobGrades.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('filterEmploymentType')}>
          <select value={employmentType} onChange={(e) => { setEmploymentType(e.target.value); markFilterTouch(); }} className={inputCls}>
            <option value="">{t('filterAll')}</option>
            {employmentTypes.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label={t('filterCostCentre')}>
          <select value={costCenterId} onChange={(e) => { setCostCenterId(e.target.value); markFilterTouch(); }} className={inputCls}>
            <option value="">{t('filterAll')}</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('filterStatus')}>
          <select value={status} onChange={(e) => { setStatus(e.target.value); markFilterTouch(); }} className={inputCls}>
            <option value="">{t('filterAll')}</option>
            {statuses.map((v) => (
              <option key={v} value={v}>{tStatus(v)}</option>
            ))}
          </select>
        </Field>
      </div>

      {excludedLeavers.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          {t('leaverFilterWarning', { n: excludedLeavers.length })}
        </div>
      )}
      {compLess.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t('compLessWarning', { n: compLess.length })}
        </div>
      )}

      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t('employeesLabel')}</span>
          <span className="text-xs text-muted-foreground">{t('headcount', { n: headcount })}</span>
          <button type="button" onClick={selectAll} className="text-xs font-medium text-primary hover:underline">
            {t('selectAll')}
          </button>
          <button type="button" onClick={clearAll} className="text-xs font-medium text-primary hover:underline">
            {t('clearAll')}
          </button>
        </div>
        {loading ? (
          <p className="text-xs text-muted-foreground">{t('loadingEmployees')}</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noEmployees')}</p>
        ) : (
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto rounded-lg border border-border p-2">
            {/* 7076f8af — the Payroll Policy column's heading. It names what the right-hand value in every
                row below is, so a row reading "—" is legible as "none assigned" rather than as a gap. */}
            <div className="flex items-center gap-1.5 border-b border-border pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="size-4" aria-hidden="true" />
              <span>{t('employeesLabel')}</span>
              <span className="ml-auto">{t('payrollPolicyColumn')}</span>
            </div>
            {filtered.map((e) => (
              <label key={e.employmentId} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(e.employmentId) || (!filtersTouched && !anyFilterActive)}
                  onChange={() => toggle(e.employmentId)}
                  className="size-4 rounded"
                />
                <EmployeeCode code={e.employeeCode} />
                {e.name}
                {multiCompany && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{e.company}</span>
                )}
                {e.terminatedOn && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">({t('leaverTag')})</span>
                )}
                {/* An em dash, never an empty cell: two of forty employments carry a policy today, so blank
                    would be the majority state and would read as "failed to load" rather than "none". */}
                <span
                  className="ml-auto shrink-0 text-xs text-muted-foreground"
                  title={e.payrollPolicyName ?? t('payrollPolicyNone')}
                >
                  {e.payrollPolicyName ?? '—'}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
