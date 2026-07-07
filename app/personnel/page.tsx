import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployeesPage } from '@/core/read';
import { Avatar, Card, EmployeeCode, PageHeader, StatusBadge } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';

const PAGE = 25;

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
    company?: string;
    dept?: string;
    status?: string;
    type?: string;
  }>;
}) {
  const t = await getTranslations('people.list');
  const { s: session, scopeIds } = await scopedSession();
  const { q, page: pageParam, company, dept, status, type } = await searchParams;
  const page = Math.max(0, Number(pageParam) || 0);
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
      limit: PAGE,
      offset: page * PAGE,
    }),
    listCompanies(session),
    listDepartments(session),
  ]);
  const hasNext = (page + 1) * PAGE < total;
  const qs = (over: Record<string, string | number | undefined>) => {
    const merged: Record<string, string | number | undefined> = { q, company, dept, status, type, page: pageParam, ...over };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, String(v));
    const s = sp.toString();
    return s ? `/personnel?${s}` : '/personnel';
  };
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
                    <Avatar name={e.name} />
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
                  <StatusBadge status={e.terminatedOn ? 'terminated' : e.status} />
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
        {(page > 0 || hasNext) && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            {page > 0 ? (
              <Link href={qs({ page: page - 1 || undefined })} className="text-primary hover:underline">
                {t('newer')}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted-foreground">
              {t('rangeOf', {
                from: page * PAGE + 1,
                to: Math.min((page + 1) * PAGE, total),
                total,
              })}
            </span>
            {hasNext ? (
              <Link href={qs({ page: page + 1 })} className="text-primary hover:underline">
                {t('older')}
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
