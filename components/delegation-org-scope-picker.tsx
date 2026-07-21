'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';

/**
 * R51 (baf56348) — the Delegation Coverage cascade: Company → Business Unit → Department, each list enabled
 * only after the previous choice, each narrowing instantly CLIENT-side (options are props, filtered with
 * useMemo — the step-selection pattern; no per-scope-change server round-trip, no loading states). Blank at
 * a level = everything under the level above; all blank = unrestricted. Submits plain form fields
 * `scopeCompanyId` / `scopeBusinessUnitId` / `scopeDepartmentId` (the server action re-validates the chain).
 * Division is deliberately absent: it is a free-typed note today, not a maintained master.
 */

export type OrgScopeMasters = {
  companies: { id: string; name: string }[];
  businessUnits: { id: string; name: string; companyId: string }[];
  departments: { id: string; name: string; companyId: string; businessUnitId: string | null }[];
};

export type OrgScopeSelection = {
  companyId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
};

/** Does a candidate (with org ids) fall inside the chosen coverage? Blank levels are wildcards. */
export function candidateInScope(
  c: { companyId: string; businessUnitId: string | null; departmentId: string | null },
  scope: OrgScopeSelection,
): boolean {
  if (scope.companyId && c.companyId !== scope.companyId) return false;
  if (scope.businessUnitId && c.businessUnitId !== scope.businessUnitId) return false;
  if (scope.departmentId && c.departmentId !== scope.departmentId) return false;
  return true;
}

export function DelegationOrgScopePicker({
  masters,
  defaultScope,
  onChange,
}: {
  masters: OrgScopeMasters;
  defaultScope?: OrgScopeSelection;
  onChange?: (scope: OrgScopeSelection) => void;
}) {
  const t = useTranslations('delegations');
  const [companyId, setCompanyId] = useState<string>(defaultScope?.companyId ?? '');
  const [businessUnitId, setBusinessUnitId] = useState<string>(defaultScope?.businessUnitId ?? '');
  const [departmentId, setDepartmentId] = useState<string>(defaultScope?.departmentId ?? '');

  const businessUnits = useMemo(
    () => (companyId ? masters.businessUnits.filter((b) => b.companyId === companyId) : []),
    [masters.businessUnits, companyId],
  );
  // A department with no BU link is usable under every BU of its company (hire-form precedent).
  const departments = useMemo(
    () =>
      businessUnitId
        ? masters.departments.filter(
            (d) => d.companyId === companyId && (d.businessUnitId === businessUnitId || d.businessUnitId == null),
          )
        : [],
    [masters.departments, companyId, businessUnitId],
  );

  const emit = (next: OrgScopeSelection) => onChange?.(next);

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-muted-foreground">{t('coverageTitle')}</span>
      <p className="text-xs text-muted-foreground">{t('coverageHint')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('coverageCompany')}</span>
          <select
            name="scopeCompanyId"
            value={companyId}
            onChange={(e) => {
              const v = e.target.value;
              setCompanyId(v);
              setBusinessUnitId('');
              setDepartmentId('');
              emit({ companyId: v || null, businessUnitId: null, departmentId: null });
            }}
            className={inputCls}
          >
            <option value="">{t('coverageAllCompanies')}</option>
            {masters.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('coverageBusinessUnit')}</span>
          <select
            name="scopeBusinessUnitId"
            value={businessUnitId}
            disabled={!companyId}
            onChange={(e) => {
              const v = e.target.value;
              setBusinessUnitId(v);
              setDepartmentId('');
              emit({ companyId: companyId || null, businessUnitId: v || null, departmentId: null });
            }}
            className={inputCls}
          >
            <option value="">{t('coverageAllBusinessUnits')}</option>
            {businessUnits.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('coverageDepartment')}</span>
          <select
            name="scopeDepartmentId"
            value={departmentId}
            disabled={!businessUnitId}
            onChange={(e) => {
              const v = e.target.value;
              setDepartmentId(v);
              emit({ companyId: companyId || null, businessUnitId: businessUnitId || null, departmentId: v || null });
            }}
            className={inputCls}
          >
            <option value="">{t('coverageAllDepartments')}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
