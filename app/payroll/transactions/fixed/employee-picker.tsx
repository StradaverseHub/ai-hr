'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { EmployeeName, Field, inputCls } from '@/components/ui';

/** A Fixed-Transaction employee row — the fields the Step-1 search/filter panel needs. `status` is the
 *  derived employment status ('active' when not terminated, else 'ended') computed on the server. */
export type PickerEmployee = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  company: string;
  companyId: string;
  department: string | null;
  departmentId: string | null;
  businessUnit: string | null;
  businessUnitId: string | null;
  status: 'active' | 'ended';
};

/**
 * Fixed Transaction — Step-1 employee picker (feedback ee21508c). Replaces the plain dropdown + "Employee"
 * submit button with a live search + filter panel over the already access-fenced employee list. Filter by
 * Company, Business Unit, Department and Employee Status, then match on Employee ID or name. Selecting a
 * person navigates to ?employmentId=<id> — the server component then renders their transactions immediately
 * (no extra button to click). Purely a navigation/UX layer; the scope-guard on the server is authoritative.
 */
export function EmployeePicker({
  employees,
  selectedId,
}: {
  employees: PickerEmployee[];
  selectedId: string | null;
}) {
  const t = useTranslations('payroll.transactions.fixed');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [query, setQuery] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [businessUnitId, setBusinessUnitId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');

  const companyOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of employees) seen.set(e.companyId, e.company);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [employees]);

  // BU / department options derive from the currently company-scoped set (no extra query).
  const inCompany = useMemo(
    () => (companyId ? employees.filter((e) => e.companyId === companyId) : employees),
    [employees, companyId],
  );
  const businessUnitOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of inCompany) if (e.businessUnitId && e.businessUnit) seen.set(e.businessUnitId, e.businessUnit);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [inCompany]);
  const departmentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of inCompany) if (e.departmentId && e.department) seen.set(e.departmentId, e.department);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [inCompany]);

  const CAP = 25;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = companyId ? employees.filter((e) => e.companyId === companyId) : employees;
    if (businessUnitId) base = base.filter((e) => e.businessUnitId === businessUnitId);
    if (departmentId) base = base.filter((e) => e.departmentId === departmentId);
    if (status) base = base.filter((e) => e.status === status);
    if (q) base = base.filter((e) => e.name.toLowerCase().includes(q) || (e.employeeCode ?? '').toLowerCase().includes(q));
    return base;
  }, [employees, query, companyId, businessUnitId, departmentId, status]);
  const results = useMemo(() => filtered.slice(0, CAP), [filtered]);
  const capped = filtered.length > CAP;

  const select = (id: string) => {
    startTransition(() => router.push(`/payroll/transactions/fixed?employmentId=${encodeURIComponent(id)}`));
  };
  const resetFilters = () => {
    setQuery('');
    setCompanyId('');
    setBusinessUnitId('');
    setDepartmentId('');
    setStatus('');
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('filterCompany')}>
          <select
            value={companyId}
            onChange={(e) => {
              setCompanyId(e.target.value);
              setBusinessUnitId('');
              setDepartmentId('');
            }}
            className={inputCls}
          >
            <option value="">{t('allCompanies')}</option>
            {companyOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('filterBusinessUnit')}>
          <select value={businessUnitId} onChange={(e) => setBusinessUnitId(e.target.value)} className={inputCls}>
            <option value="">{t('allBusinessUnits')}</option>
            {businessUnitOptions.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('filterDepartment')}>
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputCls}>
            <option value="">{t('allDepartments')}</option>
            {departmentOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('filterStatus')}>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
            <option value="">{t('allStatuses')}</option>
            <option value="active">{t('statusActive')}</option>
            <option value="ended">{t('statusEnded')}</option>
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('searchLabel')} className="flex-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className={inputCls}
          />
        </Field>
        <button
          type="button"
          onClick={resetFilters}
          className="h-9 rounded-md border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('reset')}
        </button>
      </div>

      <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {results.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noEmployees')}</p>
        )}
        {results.map((e) => {
          const active = e.employmentId === selectedId;
          return (
            <button
              key={e.employmentId}
              type="button"
              onClick={() => select(e.employmentId)}
              disabled={isPending}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60 ${
                active ? 'bg-primary/10' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <EmployeeName code={e.employeeCode} name={e.name} className="block truncate font-medium text-foreground" />
                <span className="block truncate text-xs text-muted-foreground">
                  {e.company} · {e.businessUnit ?? '—'} · {e.department ?? '—'}
                </span>
              </span>
              {active && <span className="shrink-0 text-xs font-medium text-primary">{t('selectedTag')}</span>}
            </button>
          );
        })}
      </div>
      {capped && <p className="text-xs text-muted-foreground">{t('showingCapped', { cap: CAP, total: filtered.length })}</p>}
    </div>
  );
}
