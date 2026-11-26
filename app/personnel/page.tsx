import { organisationChoiceLabels } from '@/lib/organisation-choice-label';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments } from '@/core/read';
import { Card, PageHeader } from '@/components/ui';
import type { FilterField } from '@/components/filter-panel';
import { currentUiTheme } from '@/lib/ui-theme-server';
import { directoryParams, directoryView } from './directory-view';
import { DirectoryChips, DirectoryHeaderActions, DirectoryListProvider, DirectoryTable } from './directory-list';

/**
 * Read-only staff directory (People→Personnel split). Every employee can browse colleagues by
 * name / department / company / work contact — no pay, statutory, or personal data, and no admin
 * affordances (hire form, profile-change queue, CSV import, compensation). Those live behind
 * /admin/personnel. RLS still scopes every read to what this viewer is allowed to see.
 *
 * ADR 0181 Phase 4 — list-only filters: the list (count, chips, pager, table) is one view rendered by
 * ./directory-view.ts, here on first load and by POST /personnel/list for every later filter, chip, page-size and
 * pager step, so a change refreshes only the list. Keyset paging (no OFFSET) and a total that is exact below 1,000
 * and "1,000+" above. The Employee Status shown is the system-derived one (deriveEmploymentStatus, 5afcda91), the
 * same as /admin/personnel; the legacy stored assignment.status never renders.
 */
export default async function PersonnelPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string;
    size?: string;
    after?: string;
    before?: string;
    last?: string;
    count?: string;
    company?: string;
    dept?: string;
    status?: string;
    type?: string;
  }>;
}) {
  const t = await getTranslations('people.list');
  const { s: session, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const [view, companies, departments, theme] = await Promise.all([
    directoryView(session, scopeIds, directoryParams(sp)),
    listCompanies(session),
    listDepartments(session),
    currentUiTheme(),
  ]);
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
      options: organisationChoiceLabels(departments).map((d) => ({ value: d.id, label: d.displayLabel })),
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
  // The active-filter count string for every possible count (0–5 fields), so the island needs no t().
  const filterLabels = {
    filter: t('filter'),
    apply: t('applyFilters'),
    clearAll: t('clearAllFilters'),
    activeCount: Object.fromEntries(filterFields.map((_, i) => i).concat(filterFields.length).map((n) => [n, t('activeFilters', { count: n })])),
  };

  return (
    <DirectoryListProvider initial={view}>
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('title')} actions={<DirectoryHeaderActions fields={filterFields} labels={filterLabels} />} />

        <DirectoryChips fields={filterFields} labels={filterLabels} />

        <Card className="overflow-hidden">
          <DirectoryTable
            theme={theme}
            columns={{ code: t('colCode'), name: t('colName'), department: t('colDepartment'), company: t('colCompany'), status: t('colStatus'), hired: t('colHired') }}
          />
        </Card>
      </div>
    </DirectoryListProvider>
  );
}
