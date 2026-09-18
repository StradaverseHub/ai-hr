import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listCompanies, listDepartments, listEmployeesPage } from '@/core/read';
import { deriveEmploymentStatus } from '@/core/employment-status';
// r307 — the SAME definition of "what is missing" the Record Readiness screen uses
// (core/record-readiness.ts gapsForRecord), indexed per person instead of per gap.
import { employmentIdsWithGaps, gapsForEmployments, GAP_BLOCKS, type ReadinessGapId } from '@/core/record-readiness';
import { NeedsActionCell, type NeedsItem } from './needs-action-cell';
import { Avatar, Card, EmployeeCode, PageHeader, StatusBadge } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * r307 — WHAT IS NEEDED NEXT, for an admin.
 *
 * The directory answered "who works here". For the people who work this screen it now also answers
 * "and what is stopping each of them" — a column naming the first thing missing from the record and
 * what it stops (payroll, payment, a statutory filing), and a panel with the rest of the list and the
 * catalogue's own fix guidance. Before this, what blocks somebody's pay was visible only on
 * /control-tower/readiness, grouped by gap, which answers a different question than the one HR asks
 * while looking at a person.
 *
 * ADMIN ONLY, AND THAT IS AUTHORIZATION RATHER THAN TASTE. A gap is the absence of a bank account or a
 * statutory identifier, which is still a fact about somebody's record: the screen itself is
 * `scopedSession` (every employee browses colleagues), so the column, the chip and the panel are gated
 * on `isAdmin` and the reads behind them are not issued for anybody else. A manager's "what is needed
 * next" is their approval queue, not this; that view is deliberately not built here.
 *
 * THE CHIP FILTERS THE POPULATION, NOT THE PAGE. "Needs action" narrows through the shared employee
 * WHERE (`employmentIds`), so the pager total counts the same set the rows come from. Filtering after
 * paging would have produced a count that was true of nothing.
 *
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
    /** r307 — '1' shows only records with a gap. Admin-only; ignored for anybody else. */
    needs?: string;
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
  // r307 — the admin gate for everything readiness-related on this screen. A non-admin issues none of
  // these reads at all, rather than issuing them and hiding the result.
  const admin = isAdmin(session);
  const gapIds = admin ? await employmentIdsWithGaps(session) : null;
  const needsView = admin && sp.needs === '1';
  const [{ rows: employees, total }, companies, departments] = await Promise.all([
    listEmployeesPage(session, {
      companyIds: scopeIds,
      // The chip narrows the POPULATION: an empty set means "nobody", which employeeListWhere honours
      // as no rows rather than as no filter.
      employmentIds: needsView ? [...(gapIds ?? [])] : undefined,
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
  const pgState = pageState(pq, total, employees.length);
  // Only for the rows actually on this page — a per-person read, not a capped slice of the grouped one.
  const gapsByEmployment = admin
    ? await gapsForEmployments(session, employees.map((e) => e.employmentId))
    : new Map<string, ReadinessGapId[]>();
  // The gap names and their fix guidance come from the Record Readiness catalogue, so the two screens
  // call the same thing by the same name in all six locales.
  const tGap = await getTranslations('controlTower.readinessScreen');
  const CONSEQUENCE: Record<string, { label: string; tone: 'critical' | 'warning' }> = {
    payroll: { label: t('stopsRun'), tone: 'critical' },
    payment: { label: t('stopsPayment'), tone: 'critical' },
    statutory_filing: { label: t('stopsFiling'), tone: 'warning' },
  };
  const itemsFor = (employmentId: string): NeedsItem[] =>
    (gapsByEmployment.get(employmentId) ?? []).map((id) => {
      const blocks = GAP_BLOCKS[id];
      return {
        label: tGap(`gap.${id}`),
        fix: tGap(`gap.${id}Fix`),
        consequence: CONSEQUENCE[blocks]!.label,
        tone: CONSEQUENCE[blocks]!.tone,
      };
    });
  const cellLabels = {
    needed: t('drawerNeeded'),
    blockers: t('drawerBlockers'),
    facts: t('drawerFacts'),
    completeRecord: t('drawerCompleteRecord'),
    close: t('drawerClose'),
    colCode: t('colCode'),
    colCompany: t('colCompany'),
    colDepartment: t('colDepartment'),
    colStatus: t('colStatus'),
    colHired: t('colHired'),
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

      {/* r307 — the population switch. Plain links, so it works with no client JavaScript and every
          view is a URL somebody can bookmark or send to a colleague. The count is the size of the id
          set the "Needs action" view narrows to, so the chip and the pager cannot disagree. */}
      {admin && (
        <div className="flex flex-wrap items-center gap-2">
          {[
            { key: 'needs', label: t('needsActionTab'), href: '/personnel?needs=1', on: needsView, count: gapIds?.size ?? 0 },
            { key: 'all', label: t('everyoneTab'), href: '/personnel', on: !needsView, count: null as number | null },
          ].map((chip) => (
            <Link
              key={chip.key}
              href={chip.href}
              aria-current={chip.on ? 'page' : undefined}
              className={
                chip.on
                  ? 'inline-flex items-center gap-2 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background'
                  : 'inline-flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground'
              }
            >
              {chip.label}
              {chip.count !== null && (
                <span
                  className={`rounded px-1.5 text-[10px] tabular-nums ${
                    chip.on ? 'bg-background/20' : 'bg-foreground/10'
                  }`}
                >
                  {chip.count}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('colCode')}</th>
              <th className="px-4 py-3 font-medium">{t('colName')}</th>
              <th className="px-4 py-3 font-medium">{t('colDepartment')}</th>
              <th className="px-4 py-3 font-medium">{t('colCompany')}</th>
              <th className="px-4 py-3 font-medium">{t('colStatus')}</th>
              {admin && <th className="px-4 py-3 font-medium">{t('colNeeded')}</th>}
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
                  {(() => {
                    const st = deriveEmploymentStatus(e, today);
                    return <StatusBadge status={st} label={tStatus(st)} />;
                  })()}
                </td>
                {admin &&
                  (() => {
                    const items = itemsFor(e.employmentId);
                    const st = deriveEmploymentStatus(e, today);
                    return (
                      <td className="px-4 py-3">
                        {items.length === 0 ? (
                          <span className="text-muted-foreground">{t('needsNothing')}</span>
                        ) : (
                          <NeedsActionCell
                            person={{
                              employmentId: e.employmentId,
                              name: e.name,
                              employeeCode: e.employeeCode,
                              company: e.company,
                              department: e.department,
                              statusLabel: tStatus(st),
                              hiredOn: e.hiredOn,
                              items,
                              moreLabel:
                                items.length > 1 ? t('needsMore', { count: items.length - 1 }) : null,
                            }}
                            labels={cellLabels}
                          />
                        )}
                      </td>
                    );
                  })()}
                <td className="px-4 py-3 text-muted-foreground">{e.hiredOn}</td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={admin ? 7 : 6} className="px-4 py-10 text-center text-muted-foreground">
                  {q ? t('emptySearch', { q }) : hasFilters ? t('emptyFiltered') : t('emptyNoEmployees')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pager
          basePath="/personnel"
          params={{ q, company, dept, status, type, ...(needsView ? { needs: '1' } : {}) }}
          state={pgState}
        />
      </Card>
    </div>
  );
}
