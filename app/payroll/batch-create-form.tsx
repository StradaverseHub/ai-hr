'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { createBatchAction } from './actions';

type Company = { id: string; name: string };
type Dept = { id: string; name: string; companyId: string };
type Employee = { employmentId: string; name: string; companyId: string; department: string | null };

/**
 * Create-batch form (ADR-0035 1E, #23) with optional department + individual-employee subset
 * selection. Both pickers follow the selected company; the kernel unions selected departments'
 * current assignees with any named individuals (deduped). Leaving everything unchecked ⇒ the whole
 * company (today's behaviour).
 *
 * Deferred (v1): a search / typeahead in the employee picker. v1 tenants are small, and the live
 * selected-count + Select all / Clear make "only selected included" verifiable without it.
 */
export function BatchCreateForm({
  companies,
  departments,
  employees,
  thisMonth,
}: {
  companies: Company[];
  departments: Dept[];
  employees: Employee[];
  thisMonth: string;
}) {
  const t = useTranslations('payroll.list');
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const depts = departments.filter((d) => d.companyId === companyId);
  const emps = useMemo(() => employees.filter((e) => e.companyId === companyId), [employees, companyId]);

  // Live selected count + Select all / Clear, scoped to the current company's filtered list. Driven
  // off the actual checkbox DOM (the same inputs that submit) so the count can't drift from the form.
  const empWrapRef = useRef<HTMLDivElement>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const recount = () => {
    const boxes = empWrapRef.current?.querySelectorAll<HTMLInputElement>('input[name="employmentIds"]');
    setSelectedCount(boxes ? Array.from(boxes).filter((b) => b.checked).length : 0);
  };
  const setAll = (checked: boolean) => {
    const boxes = empWrapRef.current?.querySelectorAll<HTMLInputElement>('input[name="employmentIds"]');
    boxes?.forEach((b) => {
      b.checked = checked;
    });
    recount();
  };

  return (
    <form action={createBatchAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4">
      <Field label={t('company')}>
        <select
          name="companyId"
          required
          value={companyId}
          onChange={(e) => {
            setCompanyId(e.target.value);
            setSelectedCount(0); // the picker remounts (key={companyId}) → all checkboxes reset
          }}
          className={inputCls}
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('payPeriod')}>
        <input name="payPeriod" required placeholder="2026-05" defaultValue={thisMonth} pattern="[0-9]{4}-(0[1-9]|1[0-2])" title="YYYY-MM" className={inputCls} />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" data-tour="payroll-create">
          {t('createBatch')}
        </Button>
      </div>

      {depts.length > 0 && (
        <div className="sm:col-span-4">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('scopeLabel')}</div>
          {/* key by company so checkboxes reset when the company changes */}
          <div key={companyId} className="flex flex-wrap gap-x-4 gap-y-1.5">
            {depts.map((d) => (
              <label key={d.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="departmentIds" value={d.id} className="size-4 rounded" />
                {d.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="sm:col-span-4">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t('scopeEmployeesLabel')}</span>
          {emps.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground">{t('scopeEmployeesSelected', { n: selectedCount })}</span>
              <button type="button" onClick={() => setAll(true)} className="text-xs font-medium text-primary hover:underline">
                {t('scopeEmployeesSelectAll')}
              </button>
              <button type="button" onClick={() => setAll(false)} className="text-xs font-medium text-primary hover:underline">
                {t('scopeEmployeesClear')}
              </button>
            </>
          )}
        </div>
        {emps.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('scopeEmployeesEmpty')}</p>
        ) : (
          // key by company so checkboxes (and the selection) reset when the company changes; an
          // unmounted input doesn't submit, so cross-company ids can't leak through the picker.
          <div key={companyId} ref={empWrapRef} className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
            {emps.map((e) => (
              <label key={e.employmentId} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="employmentIds" value={e.employmentId} onChange={recount} className="size-4 rounded" />
                {e.name}
              </label>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-xs text-muted-foreground">{t('scopeHint')}</p>
      </div>
    </form>
  );
}
