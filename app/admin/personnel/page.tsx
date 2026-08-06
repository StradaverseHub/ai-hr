import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployees, listEmployeesPage } from '@/core/read';
import { listProfileChangeRequests } from '@/core/profile';
import { listEmployeeDrafts } from '@/core/employee-draft';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { Avatar, Button, Card, EmployeeCode, PageHeader, StatusBadge } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';
import { decideProfileChangeAction } from './actions';
// c002b3c3 — "Search Employee": jump straight to a profile without a round trip through this list.
import { EmployeeSwitcher } from './employee-switcher';

import { todayInKualaLumpur } from '@/lib/hr-date';

/** Render a pay-affecting change bundle as human-readable "field → value" pairs. */
function describeProposed(
  p: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  const PCB_LABEL: Record<number, string> = {
    1: t('pcbSingle'),
    2: t('pcbMarriedSpouseNotWorking'),
    3: t('pcbMarriedSpouseWorking'),
  };
  const o = (p ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (o.bankName != null) parts.push(`${t('fieldBank')} → ${o.bankName}`);
  if (o.bankAccountNo != null) parts.push(`${t('fieldAccount')} → ${o.bankAccountNo}`);
  if (o.taxCategory != null)
    parts.push(`${t('fieldPcb')} → ${PCB_LABEL[Number(o.taxCategory)] ?? o.taxCategory}`);
  if (o.numChildren != null) parts.push(`${t('fieldChildren')} → ${o.numChildren}`);
  return parts.length ? parts.join(' · ') : t('noChanges');
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    q?: string;
    page?: string;
    size?: string;
    company?: string;
    dept?: string;
    status?: string;
    type?: string;
  }>;
}) {
  await requireAdmin(); // Admin-only management surface (ADR: People→Personnel split). Non-admins redirect home.
  const t = await getTranslations('people.list');
  const tCommon = await getTranslations('common');
  const tStatus = await getTranslations('people.employeeStatus');
  // Employee Status redesign (R43 c26c3ce5): the People list shows the SYSTEM-DERIVED status (from each
  // employee's lifecycle dates + blacklist override), not the legacy stored assignment.status.
  const { s: session, scopeIds } = await scopedSession();
  const today = todayInKualaLumpur();
  const isAdmin = (session.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
  const sp = await searchParams;
  const { error, q, company, dept, status, type } = sp;
  const pq = parsePageQuery(sp);
  const statusFilter = status === 'active' || status === 'terminated' ? status : undefined;
  const hasFilters = !!(q || company || dept || status || type);
  // 6d671f44 — the hire form is no longer on this page, so neither are its pickers. What this screen
  // still needs is the LIST, its filter options, the pending profile-change queue, and the count of
  // unfinished Create New Employee drafts (a draft is not an employee and never appears in the table
  // below; it is surfaced here only because this is where somebody would come looking for it).
  const [{ rows: employees, total }, companies, departments, profileChanges, drafts, allEmployees] = await Promise.all([
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
    isAdmin
      ? listProfileChangeRequests(session, { companyIds: scopeIds, status: 'pending' })
      : Promise.resolve([]),
    isAdmin ? listEmployeeDrafts(session) : Promise.resolve([]),
    // c002b3c3 — the switcher needs the WHOLE reachable set, not the page being displayed: searching for
    // someone on page 7 of the list is the entire point. `listEmployees` is the same scoped read the
    // profile route already uses for its own pickers, narrowed here by the active company context
    // (`scopeIds`) so the box searches exactly what this screen is showing. It can only ever be NARROWER
    // than RLS — the profile route re-resolves whatever is picked and 404s on anything out of scope.
    listEmployees(session, scopeIds),
  ]);
  const pgState = pageState(pq, total, employees.length);
  const EMPLOYMENT_TYPES = [
    { value: 'full_time', labelKey: 'employmentFullTime' },
    { value: 'part_time', labelKey: 'employmentPartTime' },
    { value: 'contract', labelKey: 'employmentContract' },
    { value: 'intern', labelKey: 'employmentIntern' },
  ] as const;

  // Consolidated filter panel (feedback 3542ed4a): same GET params (?q=&company=&dept=&status=&type=),
  // same query path — only the presentation moved from an inline row into a top-right panel + chips.
  // All strings resolved here so the client island stays free of dynamic t() keys. The onboarding
  // tour's "people-search" anchor now points at the Filter button (the search input lives inside it).
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
        // R81 (9cbf5e0d): the VALUES are the lifecycle query params this filter has always used
        // (employment.terminated_on set or not) and are unchanged — this narrows the list, it does not
        // display a status. Only the LABELS moved onto the reporter's vocabulary, so the filter and the
        // Status badge in the same table stop using two different words ("Terminated" / "Resigned") for
        // one state. Retiring Terminated as a word means retiring it here too.
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
    // c002b3c3 — the Personnel module goes FULL WIDTH. `max-w-[100rem]` is not a new number: it is the
    // container this codebase already settled on for wide screens (payroll, the transaction screens, the
    // leave inquiries), chosen there after measuring — capped rather than full-bleed, because an
    // uncapped table on an ultrawide display is unreadable in the other direction. Reusing that exact
    // value is the point: the listing and the profile must not become a third and fourth width.
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        title={t('title')}
        actions={
          // `flex-wrap` (c002b3c3): this row gained a search box, and PageHeader holds its actions
          // group `shrink-0` — without wrapping, a narrow window would scroll the PAGE sideways rather
          // than stacking the controls, which is the one thing a full-width change must not introduce.
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="text-sm text-muted-foreground">
              {t('employeeCount', { count: total })}
            </span>
            {isAdmin && (
              <Link
                href="/admin/personnel/import"
                data-tour="people-import"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('importCsv')}
              </Link>
            )}
            {/* 7b5f18c3 — the Hiring Defaults button that used to sit here is GONE. It is a system setup,
                not a daily HR action, and nobody looks for one in the top-right corner of the employee
                list; it now lives at System Settings → Hiring Defaults. The old address still redirects
                there, so a bookmark of the removed button's destination still lands somewhere real. */}
            {/* c002b3c3 — Search Employee, beside the Filter button. It is NOT a second copy of the
                filter's `q` box and does not narrow this table: it JUMPS to a profile. Both controls
                are here because they answer different questions — "show me these people" and "take me
                to this person" — and the second one previously had no answer at all. */}
            <EmployeeSwitcher
              employees={allEmployees.map((e) => ({
                employmentId: e.employmentId,
                name: e.name,
                employeeCode: e.employeeCode,
                company: e.company,
                department: e.department,
              }))}
            />
            <FilterPanel
              action="/admin/personnel"
              fields={filterFields}
              values={filterValues}
              labels={filterLabels}
              dataTour="people-search"
            />
            {/* 6d671f44 — Create New Employee is now its own step-by-step screen with Save as Draft.
                The reporter's requirement is literal: "The current employee list screen shall not be
                used for data entry", so this is a LINK, and the inline form that used to expand below
                the header is gone. The tour anchor moves with the button, exactly as it did in
                5c9b73f2 when the entry point last relocated. */}
            {isAdmin && (
              <Link
                href="/admin/personnel/new"
                data-tour="people-hire"
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {t('createNewEmployee')}
              </Link>
            )}
          </div>
        }
      />

      <FilterChips
        action="/admin/personnel"
        fields={filterFields}
        values={filterValues}
        labels={filterLabels}
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Unfinished drafts (6d671f44). A draft is captured input, not an employee: it is absent from
          the table below, from headcount, from payroll selection and from every report, and it holds no
          Employee ID. It is listed here because this is where somebody would come back to finish one. */}
      {isAdmin && drafts.length > 0 && (
        <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
          <div className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <h2 className="text-sm font-semibold">{t('draftsHeading')}</h2>
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              {t('draftsCount', { count: drafts.length })}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {drafts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{d.label || t('draftUntitled')}</div>
                  <div className="text-xs text-muted-foreground">
                    {d.companyName ?? t('draftNoCompany')}
                    {' · '}
                    {d.missing.length > 0
                      ? t('draftMissing', { count: d.missing.length })
                      : t('draftReady')}
                  </div>
                </div>
                <Link
                  href={`/admin/personnel/new?draft=${d.id}`}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
                >
                  {t('draftContinue')}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {isAdmin && profileChanges.length > 0 && (
        <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
          <div className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <h2 className="text-sm font-semibold">{t('profileChangeRequests')}</h2>
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              {t('pendingCount', { count: profileChanges.length })}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {profileChanges.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.employee}</div>
                  <div className="text-xs text-muted-foreground">{describeProposed(r.proposed, t)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <form action={decideProfileChangeAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="approved" />
                    <Button type="submit" size="sm">
                      {t('approve')}
                    </Button>
                  </form>
                  <form action={decideProfileChangeAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="rejected" />
                    <Button type="submit" size="sm" variant="outline">
                      {t('reject')}
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {t('profileChangeHint')}
          </p>
        </Card>
      )}

      <Card className="overflow-hidden" data-tour="people-table">
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
                        href={`/admin/personnel/${e.employmentId}?from=personnel`}
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
                  {q ? t('emptySearch', { q }) : hasFilters ? t('emptyFiltered') : t('emptyNoEmployeesAdmin')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pager basePath="/admin/personnel" params={{ q, company, dept, status, type }} state={pgState} />
      </Card>

    </div>
  );
}
