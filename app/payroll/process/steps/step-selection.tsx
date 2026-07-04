'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EmployeeCode, Field, inputCls } from '@/components/ui';
import { materializeToggle } from '../selection-logic';

export type Master = { id: string; name: string; companyId: string };

// Client-safe mirror of core/read.ts's PayrollRunEmployeeRow (NOT imported directly — core/read.ts pulls
// in db/client, which is server-only and would break the client/server RSC boundary for this component).
export type PayrollRunEmployeeRow = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  companyId: string;
  departmentId: string | null;
  businessUnitId: string | null;
  positionId: string | null;
  gradeId: string | null;
  costCenterId: string | null;
  employmentType: string | null;
  status: string | null;
  hiredOn: string;
  terminatedOn: string | null;
  hasCurrentCompensation: boolean;
};

/** Step 2 (3d) — filter bar (AND-combined) + individual picker with select-all/clear + live headcount.
 *  Filters narrow the PREVIEW list; the resolved explicit id set is what's submitted (plan's scope rule:
 *  any filter use or manual deselect ⇒ explicit snapshot; nothing touched ⇒ no scope = whole company). */
export function StepSelection({
  employees,
  loading,
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
  const [businessUnitId, setBusinessUnitId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [gradeId, setGradeId] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [status, setStatus] = useState('');

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
          (!status || e.status === status),
      ),
    [employees, businessUnitId, departmentId, positionId, gradeId, employmentType, costCenterId, status],
  );

  const anyFilterActive = !!(businessUnitId || departmentId || positionId || gradeId || employmentType || costCenterId || status);

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
  const statuses = [...new Set(employees.map((e) => e.status).filter((v): v is string => !!v))];

  const headcount = anyFilterActive || filtersTouched ? filtered.filter((e) => selected.has(e.employmentId)).length : employees.length;

  return (
    <div className="space-y-4">
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
              <option key={v} value={v}>{v}</option>
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
                {e.terminatedOn && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">({t('leaverTag')})</span>
                )}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
