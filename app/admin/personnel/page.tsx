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
  // 06f0cb8f — DRAFT is a status you can filter to, and it selects the draft rows INSTEAD of employees.
  // The two are different tables (see below), so "status = draft" cannot narrow the employment query; it
  // suppresses it. `draftOnly` is that suppression, kept as a named flag rather than buried in a ternary
  // because the pager total below depends on it and a wrong total is a silently broken page.
  const draftOnly = status === 'draft';
  // 6d671f44 — the hire form is no longer on this page, so neither are its pickers. What this screen
  // still needs is the LIST, its filter options, the pending profile-change queue, and the unfinished
  // Create New Employee drafts — which since 06f0cb8f are ROWS IN THE TABLE BELOW rather than a card
  // above it, because the reporter's request is that a Draft appears in the employee list.
  const [{ rows: employeeRows, total: employeeTotal }, companies, departments, profileChanges, allDrafts, allEmployees] = await Promise.all([
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

  // ── Draft rows (item 06f0cb8f) ────────────────────────────────────────────────────────────────────
  // Drafts are PINNED ABOVE the employees on every page, not merged into the sort and not paged. There
  // are a handful of them at most (they exist for days, not years), and the reporter's reason for wanting
  // them in this list is to see who is still outstanding — an outstanding record on page 4 answers
  // nothing. THE PAGER TOTAL STILL COUNTS EMPLOYMENTS ONLY: "40 employees" must keep meaning forty people
  // on the books, and a Draft is a reserved place, not a person.
  //
  // NARROWED IN MEMORY, deliberately. A draft is not an employment — it has no assignment, so no
  // department and no employment type — so the two filters that read those columns (`dept`, `type`) can
  // only ever exclude every draft, and the lifecycle filters (`active` / `terminated`) describe dates a
  // draft does not have. Each of those hides the drafts rather than pretending to match them, and
  // `draft` shows them alone. Company and the search box DO apply, because a draft has both.
  const drafts = allDrafts.filter((d) => {
    // FIRST PAGE ONLY. Pinned rows that repeat above every page of a long list stop reading as "these
    // are outstanding" and start reading as a rendering fault. With the Draft filter on there is only
    // one page, so this costs nothing there.
    if (pq.offset > 0) return false;
    if (dept || type || statusFilter) return false;
    if (company && d.companyId !== company) return false;
    if (q) {
      const needle = q.trim().toLowerCase();
      const hay = `${d.label} ${d.reservedEmployeeCode ?? ''} ${d.companyName ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const employees = draftOnly ? [] : employeeRows;
  const total = draftOnly ? 0 : employeeTotal;
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
        // 06f0cb8f — the reporter asked to be able to pull up exactly who is still outstanding. It is
        // the one option here that is a STORED state rather than a lifecycle query, because it selects
        // from a different table; picking it shows the Draft rows and no employees at all.
        { value: 'draft', label: t('statusDraft') },
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

      {/* 06f0cb8f — the amber "Unfinished new employees" card that used to sit HERE is gone. It was a
          separate panel above the table with no status against it, which is exactly what the reporter
          objected to; drafts are rows in the table below now, carrying their held Employee ID and a
          Draft badge. Everything else 6d671f44 promised is still true: a draft is captured input, absent
          from headcount, from payroll selection and from every report. */}

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
            {/* DRAFTS FIRST (item 06f0cb8f). Same columns as everyone else — the reporter's own example
                table is Employee ID / Employee Name / Company / Status — so a Draft reads as what it is:
                a place in the list with a number held for it. The two columns it genuinely has no answer
                for (Department, Hired) show an em dash rather than being left blank, because a blank cell
                in a table of filled ones reads as a loading fault. The row links to the continue form,
                not to a profile: there is no profile yet. */}
            {drafts.map((d) => (
              <tr key={d.id} className="bg-muted/20 hover:bg-muted/40">
                <td className="px-4 py-3">
                  {d.reservedEmployeeCode ? (
                    <EmployeeCode code={d.reservedEmployeeCode} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={d.label || '?'} />
                    <div className="min-w-0">
                      <Link
                        href={`/admin/personnel/new?draft=${d.id}`}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {d.label || t('draftUntitled')}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">
                        {d.missing.length > 0 ? t('draftMissing', { count: d.missing.length }) : t('draftReady')}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">—</td>
                <td className="px-4 py-3 text-muted-foreground">{d.companyName ?? t('draftNoCompany')}</td>
                <td className="px-4 py-3">
                  <StatusBadge status="draft" label={t('statusDraft')} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">—</td>
              </tr>
            ))}
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
            {/* The empty state counts the DRAFT rows too — "no employees yet" under a table that is
                visibly showing two of them would be the screen contradicting itself. */}
            {employees.length === 0 && drafts.length === 0 && (
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
