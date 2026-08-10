import Link from 'next/link';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  listCompanies,
  listDepartments,
  listEmployeesPage,
  myEmployment,
  plannedAbsences,
  reportingLinesFor,
} from '@/core/read';
import {
  deriveEmploymentStatus,
  EMPLOYMENT_STATUSES,
  type EmploymentStatus,
} from '@/core/employment-status';
import { todayInKualaLumpur } from '@/core/leave';
import { Avatar, Button, Card, EmployeeCode, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { PlannedAbsences } from '@/components/planned-absences';
import { LeaveInquiryNav } from '@/components/leave/leave-inquiry-nav';
import { inquiryPageWindow } from '@/lib/leave-inquiry';
import { requestLeaveCancellationAction, adminCancelLeaveAction, cancelOwnLeaveAction } from '@/app/leave/actions';
import { resolveCalendarFetchWindow, resolveViewPreference } from '@/lib/leave-calendar-range';
import { CALENDAR_FOCUS_PARAM, parseCalendarFocus } from '@/lib/calendar-focus';

/**
 * Team Leave Tracker (feedback a00c4f64) — the Leave Calendar's own screen, and since 388e53c2 the HR
 * administrator's way in to the three leave-inquiry sections.
 *
 * ── The calendar (a00c4f64) ──────────────────────────────────────────────────────────────────────────
 * The calendar used to be the dashboard's one FIXED full-width row, which meant a manager checking who is
 * off had to open the Dashboard and scroll past everything else, and the calendar shared a page with cards
 * each person can rearrange or switch off. This page is that same calendar, RELOCATED: the reporter asked
 * for a move, so nothing about leave calculation, approval or the calendar's own behaviour changed. The
 * dashboard side of the move is app/page.tsx (block gone), lib/dashboard-layout.ts (unpinned, out of the
 * catalogue) and migration 0404 (the tenants' dashboard_card_config rows deleted).
 *
 * The calendar reads below are app/page.tsx's calendar reads MOVED, not rewritten — same scope resolution,
 * same window resolution, same person-scoped `plannedAbsences` projection, same three server actions passed
 * to the same client island. Anything that differs between the two would be a behaviour change the reporter
 * did not ask for.
 *
 * NOT MANAGER-GATED, and that is the whole reason the nav row carries no `managerUp` flag: every employee
 * saw this calendar on their dashboard, so a manager-only screen would be a silent removal of access from
 * plain staff. Staff see their own leave (the My/Team switch only appears with direct reports, exactly as
 * on the dashboard); managers additionally get the Team view. `scopedSession` + RLS do the real fencing.
 *
 * ── The HR-admin inquiry surface (feedback 388e53c2) ─────────────────────────────────────────────────
 * The three inquiry sections — Employee Details, Employee Balances, Employee Leave Record — already existed
 * and already moved between each other through the left-side rail. Only their ENTRY POINT was wrong: the
 * first of the three lived on `/leave`, so the sidebar kept "My Leave" lit while an HR administrator read
 * somebody else's leave record. The reporter drew a box round that rail and an arrow to this row.
 *
 * So the Employee Details listing is LIFTED here verbatim (its picker, search, Filter, six columns, width,
 * numbered pager and `?emp=` threading are unchanged) and `/leave` goes back to meaning your own leave.
 * Employee Balances and Employee Leave Record KEEP THEIR ADDRESSES — saved links and export links already
 * in circulation stay valid; only the way in changed.
 *
 * AN IN-PAGE ROLE BRANCH, NOT A ROUTE SPLIT, and the branch is an EARLY RETURN so it suppresses the READS
 * as well as the markup (the `ess = !admin` pattern app/leave/page.tsx uses for the mirror-image case): an
 * administrator's page load never pays for `plannedAbsences`, and everybody else's never pays for the
 * employee listing. Everyone who is NOT an HR administrator keeps this calendar exactly as it was — the row
 * stays ungated, the route stays `scopedSession`, and the manager dashboard card and the "View Calendar"
 * deep link from a team member's profile still land on the calendar for the managers who follow them.
 */

// Employee Details listing page size — the reporter asked for exactly ten employees per page (650b6eb8).
const EMPLOYEE_PAGE = 10;

export default async function TeamLeaveTrackerPage({
  searchParams,
}: {
  searchParams: Promise<{
    // The calendar's own params (a00c4f64 / 8c739dda / 726ac8c2).
    abs?: string;
    view?: string;
    cal?: string;
    focus?: string;
    // The Employee Details listing's params, lifted with it from /leave (650b6eb8). They keep their `ed`
    // prefix CHARACTER FOR CHARACTER: renaming them would break every admin link already saved.
    emp?: string | string[];
    edQ?: string;
    edPage?: string;
    edCompany?: string | string[];
    edDept?: string | string[];
    edStatus?: string | string[];
  }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const admin = isAdmin(s);
  // R5 Build #2 (Fix B): MYT "today", so the derived employment status below and the calendar's
  // cancellation cut-off both read the same day near KL midnight that the service does.
  const today = todayInKualaLumpur();

  // ── HR-admin leave inquiry · Employee Details (feedback 650b6eb8, relocated by 388e53c2) ────────────
  // The tab an HR admin lands on: who am I looking up. Picking a row hands the employment id to Employee
  // Balances, which is the screen that actually answers the leave question — this listing does no leave
  // reads of its own.
  if (admin) {
    const tLeave = await getTranslations('leave');
    const tInq = await getTranslations('leave.inquiry');
    // Employee Details (650b6eb8) reuses the People vocabulary rather than minting a second one: the same
    // column heading and, for the badge, the ONE shared Employee Status vocabulary 9cbf5e0d consolidated on.
    const tPeople = await getTranslations('people.list');
    const tStatus = await getTranslations('people.employeeStatus');

    const arr = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
    // `emp` names the employee under inquiry — the `?emp=` carrier the left-side rail threads between the
    // three tabs so switching tab keeps the employee you are looking at.
    const empIds = arr(sp.emp);
    const edQ = sp.edQ?.trim() || undefined;
    const edPage = Math.max(0, Number(sp.edPage) || 0);
    const edCompany = arr(sp.edCompany);
    const edDept = arr(sp.edDept);
    // Whitelisted against the derived buckets, so an unknown value narrows to nothing rather than reaching SQL.
    const edStatus = arr(sp.edStatus).filter((v): v is EmploymentStatus =>
      (EMPLOYMENT_STATUSES as readonly string[]).includes(v),
    );
    const hasEmployeeChips = edCompany.length + edDept.length + edStatus.length > 0;
    const hasEmployeeFilters = !!edQ || hasEmployeeChips;
    // One value only: "which employee am I looking at" is only meaningful when exactly one is named.
    const inquiryEmploymentId = empIds.length === 1 ? empIds[0] : undefined;

    const [companies, departments, employeeList] = await Promise.all([
      listCompanies(s),
      listDepartments(s, { companyIds: scopeIds }),
      // The same access-scoped People read /personnel uses, ordered company A→Z then name A→Z and paged
      // ten at a time. Terminated staff are NOT excluded — their leave position is exactly what HR looks
      // up after someone leaves (20c699f8 made the same call, and employee-balances/page.tsx keeps it).
      listEmployeesPage(s, {
        companyIds: scopeIds,
        q: edQ,
        filterCompanyIds: edCompany,
        departmentIds: edDept,
        employmentStatuses: edStatus,
        sort: 'company',
        limit: EMPLOYEE_PAGE,
        offset: edPage * EMPLOYEE_PAGE,
      }),
    ]);

    const employeePageCount = Math.ceil(employeeList.total / EMPLOYEE_PAGE);
    // Every link this listing generates carries its own narrowings. 388e53c2 repointed the base path from
    // /leave to /leave/tracker; miss one of these and Search or Filter silently leaves the screen.
    const withEmployeeParams = (p: URLSearchParams, opts: { keepPage?: boolean } = {}) => {
      if (edQ) p.set('edQ', edQ);
      for (const id of edCompany) p.append('edCompany', id);
      for (const id of edDept) p.append('edDept', id);
      for (const st of edStatus) p.append('edStatus', st);
      if (opts.keepPage !== false && edPage > 0) p.set('edPage', String(edPage));
      return p;
    };
    const edPageHref = (n: number) => {
      const p = withEmployeeParams(new URLSearchParams(), { keepPage: false });
      if (n > 0) p.set('edPage', String(n));
      const q = p.toString();
      return q ? `/leave/tracker?${q}` : '/leave/tracker';
    };
    // Opening an employee goes straight to Employee Balances (650b6eb8 §v) — the listing is a picker, not
    // a destination, so there is no per-employee page here to land on first. UNCHANGED ADDRESS by design.
    const employeeHref = (employmentId: string) => `/leave/employee-balances?emp=${employmentId}`;
    const employeeFilterFields: FilterField[] = [
      {
        kind: 'multi',
        name: 'edCompany',
        label: tLeave('filters.company'),
        ariaLabel: tLeave('filters.company'),
        options: companies.map((c) => ({ value: c.id, label: c.name })),
        removeAriaLabel: tLeave('filters.removeFilter', { label: tLeave('filters.company') }),
      },
      {
        kind: 'multi',
        name: 'edDept',
        label: tLeave('filters.department'),
        ariaLabel: tLeave('filters.department'),
        options: departments.map((d) => ({ value: d.id, label: d.name })),
        removeAriaLabel: tLeave('filters.removeFilter', { label: tLeave('filters.department') }),
      },
      {
        // The DERIVED Employee Status buckets and the shared people.employeeStatus vocabulary (9cbf5e0d) —
        // never the legacy stored assignment.status, whose retired values must not reappear on a new screen.
        kind: 'multi',
        name: 'edStatus',
        label: tPeople('colStatus'),
        ariaLabel: tPeople('colStatus'),
        options: EMPLOYMENT_STATUSES.map((v) => ({ value: v, label: tStatus(v) })),
        removeAriaLabel: tLeave('filters.removeFilter', { label: tPeople('colStatus') }),
      },
    ];
    const employeeFilterValues = { edCompany, edDept, edStatus };
    const employeeFilterLabels = {
      filter: tLeave('filters.filter'),
      apply: tLeave('filters.apply'),
      clearAll: tLeave('filters.clearAll'),
      activeCount: tLeave('filters.activeCount', {
        count: [edCompany, edDept, edStatus].filter((v) => v.length > 0).length,
      }),
      selectAll: tLeave('filters.selectAll'),
      deselectAll: tLeave('filters.deselectAll'),
    };
    const employeeHiddenParams: [string, string][] = [...(edQ ? ([['edQ', edQ]] as [string, string][]) : [])];

    return (
      // 026e16b9: the same container cap Employee Balances and Employee Leave Record carry, so the three
      // tabs of one screen do not read as three different screens. The calendar branch below keeps its own
      // narrower cap — a month grid does not want a 100rem line length.
      <div className="mx-auto max-w-[100rem] space-y-6">
        <PageHeader title={tInq('employeeDetails')} description={tInq('detailsDescription')} />
        <div className="flex flex-col gap-4 sm:flex-row">
          <LeaveInquiryNav active="details" employmentId={inquiryEmploymentId} />
          <div className="min-w-0 flex-1 space-y-6">
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-4 py-3">
                <div className="text-sm font-medium">
                  {tInq('employeeDetails')}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {tLeave('filters.showingOf', { shown: employeeList.rows.length, total: employeeList.total })}
                  </span>
                </div>
                {/* Search + Filter for this listing. The panel is a SIBLING of the search form, not a
                    child: it renders its own <form>, and nesting one inside another is invalid HTML the
                    parser silently unpicks (test/filter-panel-not-nested.test.ts walks the whole tree). */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <form method="get" action="/leave/tracker" className="flex flex-wrap items-center gap-1.5">
                    {employeeHiddenParams
                      .filter(([k]) => k !== 'edQ')
                      .map(([k, v], i) => (
                        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
                      ))}
                    <input
                      name="edQ"
                      defaultValue={edQ ?? ''}
                      placeholder={tInq('detailsSearchPlaceholder')}
                      aria-label={tInq('detailsSearchPlaceholder')}
                      className={`${inputCls} w-56`}
                    />
                    <Button type="submit" size="sm" variant="secondary">
                      {tLeave('filters.search')}
                    </Button>
                  </form>
                  <FilterPanel
                    action="/leave/tracker"
                    fields={employeeFilterFields}
                    values={employeeFilterValues}
                    labels={employeeFilterLabels}
                    hidden={employeeHiddenParams}
                  />
                </div>
              </div>
              {hasEmployeeChips && (
                <div className="border-b border-border px-4 py-2">
                  <FilterChips
                    action="/leave/tracker"
                    fields={employeeFilterFields}
                    values={employeeFilterValues}
                    labels={employeeFilterLabels}
                    hidden={employeeHiddenParams}
                  />
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  {/* 026e16b9: no `tracking-wide` here — the extra letter-spacing widened every heading
                      and was measurably part of the inquiry tables' horizontal overflow. */}
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">{tLeave('filters.employeeId')}</th>
                      <th className="px-3 py-2 font-medium">{tInq('colEmployeeName')}</th>
                      <th className="px-3 py-2 font-medium">{tLeave('filters.company')}</th>
                      <th className="px-3 py-2 font-medium">{tLeave('filters.department')}</th>
                      <th className="px-3 py-2 font-medium">{tInq('colPosition')}</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">{tPeople('colStatus')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {employeeList.rows.map((e) => (
                      <tr
                        key={e.employmentId}
                        // The employee the other two tabs are showing, when you have arrived back here from one.
                        aria-current={e.employmentId === inquiryEmploymentId ? 'true' : undefined}
                        className={e.employmentId === inquiryEmploymentId ? 'bg-muted/60' : 'hover:bg-muted/40'}
                      >
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <EmployeeCode code={e.employeeCode} />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={e.name} className="size-7 text-[10px]" />
                            <Link
                              href={employeeHref(e.employmentId)}
                              aria-label={tInq('openBalances', { name: e.name })}
                              className="font-medium text-foreground hover:text-primary"
                            >
                              {e.name}
                            </Link>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">{e.company}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">{e.department ?? '—'}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">{e.position ?? '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          {(() => {
                            // The DERIVED status (9cbf5e0d), as of the page's MYT today — same badge and same
                            // vocabulary as Personnel, so the two screens cannot tell different stories.
                            const st = deriveEmploymentStatus(e, today);
                            return <StatusBadge status={st} label={tStatus(st)} />;
                          })()}
                        </td>
                      </tr>
                    ))}
                    {employeeList.rows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                          {hasEmployeeFilters ? tInq('noEmployeesFiltered') : tInq('noEmployees')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {/* Numbered page navigation — "1 2 3 Next >" (650b6eb8 §ii). Ellipses stand in for the pages a
                  long list would otherwise print in full; the window helper is unit-tested. */}
              {employeePageCount > 1 && (
                <nav
                  aria-label={tInq('employeeDetails')}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm"
                >
                  {edPage > 0 ? (
                    <Link href={edPageHref(edPage - 1)} className="text-primary hover:underline">
                      {tInq('pagePrev')}
                    </Link>
                  ) : (
                    <span />
                  )}
                  <span className="flex flex-wrap items-center gap-1">
                    {inquiryPageWindow(edPage, employeePageCount).map((n, i) =>
                      n == null ? (
                        <span key={`gap-${i}`} aria-hidden className="px-1 text-muted-foreground">
                          …
                        </span>
                      ) : (
                        <Link
                          key={n}
                          href={edPageHref(n)}
                          aria-label={tInq('pageAria', { page: n + 1 })}
                          aria-current={n === edPage ? 'page' : undefined}
                          className={`rounded-md px-2 py-1 text-xs tabular-nums ${
                            n === edPage
                              ? 'bg-primary font-semibold text-primary-foreground'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                        >
                          {n + 1}
                        </Link>
                      ),
                    )}
                  </span>
                  {edPage + 1 < employeePageCount ? (
                    <Link href={edPageHref(edPage + 1)} className="text-primary hover:underline">
                      {tInq('pageNext')}
                    </Link>
                  ) : (
                    <span />
                  )}
                </nav>
              )}
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // ── The Leave Calendar — every employee and every manager, exactly as before (a00c4f64) ─────────────
  const t = await getTranslations('leaveTracker');

  // Calendar window (item 8c739dda → ee55f5fe → ed76f6b0): ?abs=YYYY-MM-DD (from the timeline nav / date
  // picker) anchors the window; ?cal=month — falling back to the session cookie the range switch writes —
  // picks the initial view. The READ always fetches the month-covering superset window so the client's
  // Week/Month toggle is a purely client-side re-slice — zero network.
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayIso = new Date(todayMs).toISOString().slice(0, 10);
  const absParam = sp.abs && /^\d{4}-\d{2}-\d{2}$/.test(sp.abs) ? sp.abs : null;
  const calView = resolveViewPreference({
    param: sp.cal,
    cookie: (await cookies()).get('leave_calendar_view')?.value,
  });
  const { from: absFrom, to: absTo } = resolveCalendarFetchWindow({
    view: calView,
    anchorIso: absParam,
    todayIso,
  });
  // My/Team view switch (item 8c739dda): default "my" (own leave only); "team" widens to the viewer's
  // reporting team. The switch only renders when the viewer actually has direct reports (resolved below).
  const absView = sp.view === 'team' ? 'team' : 'my';
  // item 726ac8c2: ?focus=<personId> — the employee a manager deep-linked to from the Leave Summary on
  // their Personnel profile. Validated (uuid shape) before it reaches the client.
  const absFocusPersonId = parseCalendarFocus(sp[CALENDAR_FOCUS_PARAM]);

  const me = await myEmployment(s);
  const managerRole = (s.roles ?? []).includes('manager');
  const reportingLines = me ? await reportingLinesFor(s, me.employmentId) : null;
  // eae550e9 step 1: the read is scoped to these PEOPLE, the superset both My and Team render. Keyed by
  // PERSON id so a concurrent second employment merges into one row. An EMPTY array (viewer with no
  // person) deliberately matches NOTHING in the read — never the company.
  const teamPersonIds = [
    ...new Set<string>([
      ...(s.personId ? [s.personId] : []),
      ...(reportingLines?.reports ?? []).map((r) => r.personId),
    ]),
  ];
  const hasDirectReports = (reportingLines?.reports.length ?? 0) > 0;

  // Partial Leave Cancellation from the calendar (ADR-0065): pass MYT "today" so each approved row's
  // cancellable candidate dates match the Leave page / service cut-off exactly (strictly-after-MYT).
  const absences = await plannedAbsences(s, scopeIds, { from: absFrom, to: absTo }, today, {
    personIds: teamPersonIds,
  });

  // eae550e9 step 3: "team" is every fetched row and "my" is the viewer's own person row — a pure
  // in-memory filter the CLIENT panel owns (toggling does zero network).
  const showAbsViewSwitch = hasDirectReports;
  const effectiveAbsView = showAbsViewSwitch ? absView : 'my';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <PlannedAbsences
        rows={absences}
        todayIso={todayIso}
        anchorIso={absParam}
        initialCalView={calView}
        showViewSwitch={showAbsViewSwitch}
        initialView={effectiveAbsView}
        // Partial Leave Cancellation from the calendar (ADR-0065): the viewer gates "own leave only"; the action
        // is the SAME one the Leave page posts (redirects to /leave?toast=cancellationRequested + revalidates).
        viewerPersonId={s.personId}
        cancelAction={requestLeaveCancellationAction}
        // HR Admin Leave Cancellation on behalf (feedback 22e68ff0): admins get an immediate cancel
        // affordance on other employees' pills; same action the Leave page posts. 388e53c2 did NOT remove
        // that capability — an administrator reaches this branch on no path, and the affordance's two
        // surviving homes are Employee Leave Record and this grid for the managers who still see it.
        viewerIsAdmin={admin}
        adminCancelAction={adminCancelLeaveAction}
        // Edit/cancel-by-status (item c9a19e34): the viewer self-withdraws their own PENDING leave directly
        // from the calendar; the SAME action the Leave page posts (re-asserts subject-only + pending).
        selfCancelAction={cancelOwnLeaveAction}
        // 8cb7b089: pills awaiting this viewer's decision deep-link to /approvals. Scope note (recorded, not
        // accidental): the calendar's Team view is the viewer's own person + direct reports (teamPersonIds
        // above) while /approvals scopes by the viewer's decision reach — for a manager these line up
        // (their reports' requests), and an admin sees everything on both sides.
        viewerCanApprove={admin || managerRole}
        focusPersonId={absFocusPersonId}
      />
    </div>
  );
}
