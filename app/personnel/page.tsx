import Link from 'next/link';
import { CurrentLedger } from '@/components/current-ledger';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployeesPage } from '@/core/read';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { Avatar, Card, EmployeeCode, PageHeader, StatusBadge } from '@/components/ui';
import { employmentPhotoIds } from '@/core/person-photo';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Read-only staff directory (People→Personnel split). Every employee can browse colleagues by
 * name / department / company / work contact — no pay, statutory, or personal data, and no admin
 * affordances (hire form, profile-change queue, CSV import, compensation). Those live behind
 * /admin/personnel. RLS still scopes every read to what this viewer is allowed to see.
 */
export default async function PersonnelPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string;
    size?: string;
    company?: string;
    dept?: string;
    status?: string;
    type?: string;
  }>;
}) {
  const t = await getTranslations('people.list');
  // Employee Status sync (5afcda91): the directory shows the SAME system-derived Employee Status as
  // /admin/personnel — deriveEmploymentStatus over the lifecycle dates, never the legacy stored
  // assignment.status (whose obsolete values must never render anywhere).
  const tStatus = await getTranslations('people.employeeStatus');
  const today = todayInKualaLumpur();
  const { s: session, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const { q, company, dept, status, type } = sp;
  const pq = parsePageQuery(sp);
  const statusFilter = status === 'active' || status === 'terminated' ? status : undefined;
  const hasFilters = !!(q || company || dept || status || type);
  const [{ rows: employees, total }, companies, departments] = await Promise.all([
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
  ]);
  // 597c810a — the SAME avatar in the same place as /admin/personnel, so the two listings cannot look
  // like one of them is faulty. ONE bulk RLS-scoped existence read for this page's rows (never an <img>
  // per row: 89 persons, 2 photos on production means 87 pointless 404s), taken AFTER the page's rows are
  // known. Photo visibility is unchanged and is RLS's decision, not this page's — a person whose name this
  // viewer can see but whose photo they cannot is simply absent from the Map and keeps their initials.
  const photoIds = await employmentPhotoIds(
    session,
    employees.map((e) => e.employmentId),
  );
  const pgState = pageState(pq, total, employees.length);
  const EMPLOYMENT_TYPES = [
    { value: 'full_time', labelKey: 'employmentFullTime' },
    { value: 'part_time', labelKey: 'employmentPartTime' },
    { value: 'contract', labelKey: 'employmentContract' },
    { value: 'intern', labelKey: 'employmentIntern' },
  ] as const;

  // Consolidated filter panel (feedback 3542ed4a): same GET params (?q=&company=&dept=&status=&type=),
  // same query path — only the presentation moved from an inline row into a top-right panel + chips.
  // All strings resolved here so the client island stays free of dynamic t() keys.
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
        // R81 — same as /admin/personnel: lifecycle VALUES unchanged, label speaks the new vocabulary.
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

  const pager = <Pager basePath="/personnel" params={{ q, company, dept, status, type }} state={pgState} />;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{t('employeeCount', { count: total })}</span>
            <FilterPanel action="/personnel" fields={filterFields} values={filterValues} labels={filterLabels} />
          </div>
        }
      />

      <FilterChips action="/personnel" fields={filterFields} values={filterValues} labels={filterLabels} />

      <CurrentLedger footer={pager} label={t('title')}
        records={employees.map((e) => ({
          key: e.employmentId, title: e.name, subtitle: e.department ?? e.company,
          reference: e.employeeCode ?? '—', status: tStatus(deriveEmploymentStatus(e, today)),
          href: `/personnel/${e.employmentId}`, actions: null,
          fields: [
            { label: t('colDepartment'), value: e.department },
            { label: t('colCompany'), value: e.company },
            { label: t('colStatus'), value: tStatus(deriveEmploymentStatus(e, today)) },
            { label: t('colHired'), value: e.hiredOn },
            { label: t('colEmail'), value: e.email },
          ],
        }))}>
      <Card className="overflow-hidden">
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
                    <Avatar
                      name={e.name}
                      src={photoIds.has(e.employmentId) ? `/personnel/photo/${photoIds.get(e.employmentId)}` : undefined}
                    />
                    <div className="min-w-0">
                      <Link
                        href={`/personnel/${e.employmentId}`}
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
                  {q ? t('emptySearch', { q }) : hasFilters ? t('emptyFiltered') : t('emptyNoEmployees')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {pager}
      </Card>
      </CurrentLedger>

    </div>
  );
}
