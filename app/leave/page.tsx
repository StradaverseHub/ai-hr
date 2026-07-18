import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  leaveBalances,
  leaveEntitlementBreakdown,
  leaveRequestsFor,
  myEmployment,
  listCompanies,
  listDepartments,
  listEmployees,
  listLeaveTypes,
  listLeaveRequests,
  listLeaveRequestsPage,
  listLeaveApprovers,
  reportingLinesFor,
} from '@/core/read';
import { listBusinessUnits } from '@/core/admin';
import { listLocations } from '@/core/location';
import { todayInKualaLumpur } from '@/core/leave';
import { Avatar, Button, Card, PageHeader, inputCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { styleFor } from '@/components/planned-absences';
import { CancelDatesDialog } from '@/components/leave/cancel-dates-dialog';
import { AdminCancelLeaveDialog } from '@/components/leave/admin-cancel-leave-dialog';
import { EditLeaveDialog } from '@/components/leave/edit-leave-dialog';
import { CancelLeaveDialog } from '@/components/leave/cancel-leave-dialog';
import { RequestLeaveDialog } from '@/components/leave/request-leave-dialog';
import { LeaveBalanceTable } from '@/components/leave/leave-balance-table';
import { EntitlementBreakdown } from '@/components/leave/EntitlementBreakdown';
import { deriveSummaryBalance } from '@/components/leave/entitlement-panel-config';
// deriveBalanceRow lives in a SERVER-SAFE module (no 'use client'), so this RSC can call it at render
// time — importing it from the client table would trip the RSC boundary guard (b7d84266). R37 e5a158d3.
import { deriveBalanceRow } from '@/components/leave/leave-balance-row';
import { durationLabel } from '@/lib/leave-duration';
import {
  requestLeaveAction,
  requestLeaveCancellationAction,
  adminCancelLeaveAction,
  editLeaveAction,
  cancelOwnLeaveAction,
  previewLeaveDeductionAction,
} from './actions';

const REQ_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};

// Admin search/filter/sort page size — mirrors /personnel (feedback 0773bda9).
const PAGE = 25;
const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
// Approval Information — "Pending with" stages (feedback 0773bda9). The approval chain stores a ROLE
// (approver_kind), not a named person, so this filter narrows by the stage a pending request awaits.
const PENDING_STAGES = ['direct_manager', 'hr_admin'] as const;

// Self-service Leave page (consultant feedback #8/#10): Balance + History + Apply only. Team
// availability lives on the Dashboard (the "Planned absences" timeline); approvals live in the
// Approvals inbox. So this page no longer carries the team-availability calendar, the status-filter
// chips, or inline approve/reject — keeping the employee/manager view focused on their own leave.
export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    // Partial Leave Cancellation (ADR-0065): success toast after a cancellation request is submitted.
    toast?: string;
    // Phase-B #15: non-blocking holiday-completeness warning surfaced after a request was created.
    warnHoliday?: string;
    loaded?: string;
    state?: string;
    year?: string;
    // Advanced Search & Filter (feedback 0773bda9) — admin-only. `state` above is already taken by the
    // holiday warning, so the org filters below use distinct keys. type/status repeat for multi-select.
    q?: string;
    page?: string;
    company?: string;
    bu?: string;
    dept?: string;
    loc?: string;
    type?: string | string[];
    status?: string | string[];
    from?: string;
    to?: string;
    appliedFrom?: string;
    appliedTo?: string;
    // Approval Information (feedback 0773bda9): approvedBy = final decider employment id; pendingWith =
    // the stage a pending request currently awaits (direct_manager | hr_admin).
    approvedBy?: string;
    pendingWith?: string;
    sort?: string;
    dir?: string;
    // R37 e5a158d3: as-at date for the (relocated) detailed leave-balance table's entitlement breakdown.
    asOf?: string;
  }>;
}) {
  const { s: session, scopeIds } = await scopedSession();
  const t = await getTranslations('leave');
  // R37 e5a158d3: the relocated detailed balance table reuses the `me` namespace's as-at-form + table labels.
  const tMe = await getTranslations('me');
  const admin = isAdmin(session);
  // R5 Build #2 (Fix B): MYT "today" so the "hasn't started yet" cut-off matches the service (Malaysia time),
  // not a UTC clock that would allow/block a day near KL midnight. The default-date on the apply form uses it too.
  const today = todayInKualaLumpur();
  const sp = await searchParams;

  // Partial Leave Cancellation (ADR-0065 / R5 Build #2): the candidate dates for a row's Cancel-dates pop-up are
  // the row's REAL working dates (roster + holiday aware, resolved server-side in core/read.ts) that are
  // strictly after today (MYT). This replaces the old Mon–Fri heuristic that could offer a holiday the service
  // rejects or hide a working Saturday. The service still re-validates every posted date authoritatively.
  const cancellableCandidates = (workingDates: string[] | undefined): string[] =>
    (workingDates ?? []).filter((d) => d > today);

  // ── Advanced Search & Filter params (admin only; feedback 0773bda9) ──────────────────────────────────
  const arr = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const q = sp.q?.trim() || undefined;
  const page = Math.max(0, Number(sp.page) || 0);
  const company = sp.company || undefined;
  const bu = sp.bu || undefined;
  const dept = sp.dept || undefined;
  const loc = sp.loc || undefined;
  const typeIds = arr(sp.type);
  const statuses = arr(sp.status).filter((s) => (LEAVE_STATUSES as readonly string[]).includes(s));
  const from = sp.from || undefined;
  const to = sp.to || undefined;
  const appliedFrom = sp.appliedFrom || undefined;
  const appliedTo = sp.appliedTo || undefined;
  const approvedBy = sp.approvedBy || undefined;
  const pendingWith =
    sp.pendingWith && (PENDING_STAGES as readonly string[]).includes(sp.pendingWith) ? sp.pendingWith : undefined;
  const sort = sp.sort || undefined;
  const dir: 'asc' | 'desc' = sp.dir === 'asc' ? 'asc' : 'desc';
  const hasFilters =
    admin &&
    !!(
      q ||
      company ||
      bu ||
      dept ||
      loc ||
      typeIds.length ||
      statuses.length ||
      from ||
      to ||
      appliedFrom ||
      appliedTo ||
      approvedBy ||
      pendingWith
    );

  const locale = await getLocale();
  const [employees, leaveTypes, me] = await Promise.all([
    listEmployees(session, scopeIds),
    listLeaveTypes(session),
    // R37 e5a158d3: the balance view is now the viewer's OWN detailed table (was an all-employee pivot).
    myEmployment(session),
  ]);
  const active = employees.filter((e) => !e.terminatedOn);

  // Request Leave (feedback 48e69709): the apply form moved from a collapsed Card at the page bottom into a
  // modal launched from a "+" primary button in the PageHeader. These are the exact props the form used to
  // compute inline — mapped here in the RSC (t() runs server-side) and handed to the client dialog.
  const requestLeaveTypeOptions = leaveTypes.map((lt) => ({
    id: lt.id,
    // Supporting-document config: suffix a "· document required" badge so the applicant knows a file is
    // expected before submitting (mirrors /me). NOT leave.documentRequired — that key is a full error
    // sentence; this badge has its own leave.documentRequiredBadge key.
    label: lt.requiresDocument ? `${lt.name} · ${t('documentRequiredBadge')}` : lt.name,
    durations: lt.durations ?? null,
    code: lt.code,
    // Feedback 9d8cf621: HR-authored apply-time notice for this leave type (shown under the select).
    applyNotice: (lt.customMessages as Record<string, string> | null)?.applyNotice ?? null,
  }));
  const requestLeaveEmployeeOptions = active.map((e) => ({ id: e.employmentId, name: e.name }));
  // Employee selector visibility (item 69088c13): only an on-behalf-of applicant (an HR admin or a line
  // manager with direct reports) needs to pick WHO the leave is for. A plain self-service employee applies
  // for themselves, so the selector is hidden and the submit binds to their own employment server-side.
  const canApplyOnBehalf =
    admin || (!!me && (await reportingLinesFor(session, me.employmentId)).reports.length > 0);

  // ── Detailed leave-balance table (relocated from /me · R37 e5a158d3) ─────────────────────────────────
  // The self-service balance view is the same dense Workday-style table the /me Leave tab used to carry:
  // per-type rows via deriveBalanceRow + a per-row EntitlementBreakdown side-sheet + ONE shared as-at-date
  // GET form. Scoped to the viewer via the per-employment leaveBalances (NOT the all-employee pivot), so
  // permissions/calculations are unchanged and identical to what /me showed. An invalid/empty ?asOf= ⇒ today.
  const breakdownAsOf = sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : today;
  const selfBalances = me ? await leaveBalances(session, me.employmentId, locale) : [];
  const selfRequests = me ? await leaveRequestsFor(session, me.employmentId, locale) : [];
  const selfBreakdowns = me
    ? await Promise.all(
        selfBalances.map((b) => leaveEntitlementBreakdown(session, me.employmentId, b.leaveTypeId, breakdownAsOf, locale)),
      )
    : [];
  const breakdownByType = new Map(selfBreakdowns.filter((x) => x != null).map((x) => [x!.leaveTypeId, x!]));
  // leaveBalances already dropped visible_to_employee=false types; still filter the default-hidden placement
  // (mirrors /me detailedBalances). Presentation only — no calc change.
  const detailedBalances = selfBalances.filter((b) => b.placement !== 'hidden');

  // History: admins get the paginated, filterable, sortable read (over any population size); a
  // manager/employee keeps the untouched self-service view (their OWN requests, capped list). Option
  // sources for the filter panel are loaded only on the admin path.
  const {
    rows: history,
    total,
    companies,
    businessUnits,
    departments,
    locations,
    approvers,
  } = admin
    ? await (async () => {
        const [pageData, companies, businessUnits, departments, locations, approvers] = await Promise.all([
          listLeaveRequestsPage(session, {
            companyIds: scopeIds,
            q,
            companyId: company,
            businessUnitId: bu,
            departmentId: dept,
            locationId: loc,
            leaveTypeIds: typeIds.length ? typeIds : undefined,
            statuses: statuses.length ? statuses : undefined,
            from,
            to,
            appliedFrom,
            appliedTo,
            approvedBy,
            pendingWith,
            sort,
            dir,
            limit: PAGE,
            offset: page * PAGE,
          }),
          listCompanies(session),
          listBusinessUnits(session, { companyIds: scopeIds }),
          listDepartments(session, { companyIds: scopeIds }),
          listLocations(session, scopeIds),
          listLeaveApprovers(session, scopeIds),
        ]);
        return { rows: pageData.rows, total: pageData.total, companies, businessUnits, departments, locations, approvers };
      })()
    : await (async () => {
        const requests = await listLeaveRequests(session, scopeIds);
        const mine = requests.filter((r) => session.personId != null && r.personId === session.personId);
        return { rows: mine, total: mine.length, companies: [], businessUnits: [], departments: [], locations: [], approvers: [] };
      })();

  // ── Filter panel + query-string helpers (admin only; feedback 0773bda9) ──────────────────────────────
  // The active filter set WITHOUT sort/dir/page — the base for every generated link and the search-form's
  // hidden inputs. Multi params (type/status) are appended so all selected values survive.
  const filterParams = () => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (company) p.set('company', company);
    if (bu) p.set('bu', bu);
    if (dept) p.set('dept', dept);
    if (loc) p.set('loc', loc);
    for (const id of typeIds) p.append('type', id);
    for (const st of statuses) p.append('status', st);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (appliedFrom) p.set('appliedFrom', appliedFrom);
    if (appliedTo) p.set('appliedTo', appliedTo);
    if (approvedBy) p.set('approvedBy', approvedBy);
    if (pendingWith) p.set('pendingWith', pendingWith);
    return p;
  };
  const withSort = (p: URLSearchParams) => {
    if (sort) p.set('sort', sort);
    if (sp.dir) p.set('dir', dir);
    return p;
  };
  // Sort links reset to the first page (drop `page`); toggle asc/desc when re-clicking the active column.
  const sortHref = (key: string) => {
    const p = filterParams();
    p.set('sort', key);
    p.set('dir', sort === key && dir === 'asc' ? 'desc' : 'asc');
    return `/leave?${p.toString()}`;
  };
  const pageHref = (n: number) => {
    const p = withSort(filterParams());
    if (n > 0) p.set('page', String(n));
    const s = p.toString();
    return s ? `/leave?${s}` : '/leave';
  };
  const exportHref = (format: 'csv' | 'xlsx') => {
    const p = withSort(filterParams());
    p.set('format', format);
    return `/leave/export?${p.toString()}`;
  };
  const hasNext = admin && (page + 1) * PAGE < total;

  const filterFields: FilterField[] = [
    {
      kind: 'search',
      name: 'q',
      label: t('filters.search'),
      placeholder: t('filters.searchPlaceholder'),
      ariaLabel: t('filters.searchAria'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.search') }),
    },
    {
      kind: 'select',
      name: 'company',
      label: t('filters.company'),
      ariaLabel: t('filters.company'),
      allLabel: t('filters.allCompanies'),
      options: companies.map((c) => ({ value: c.id, label: c.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.company') }),
    },
    {
      kind: 'select',
      name: 'bu',
      label: t('filters.businessUnit'),
      ariaLabel: t('filters.businessUnit'),
      allLabel: t('filters.allBusinessUnits'),
      options: businessUnits.map((b) => ({ value: b.id, label: b.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.businessUnit') }),
    },
    {
      kind: 'select',
      name: 'dept',
      label: t('filters.department'),
      ariaLabel: t('filters.department'),
      allLabel: t('filters.allDepartments'),
      options: departments.map((d) => ({ value: d.id, label: d.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.department') }),
    },
    {
      kind: 'select',
      name: 'loc',
      label: t('filters.location'),
      ariaLabel: t('filters.location'),
      allLabel: t('filters.allLocations'),
      options: locations.map((l) => ({ value: l.id, label: l.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.location') }),
    },
    {
      kind: 'multi',
      name: 'type',
      label: t('filters.leaveType'),
      ariaLabel: t('filters.leaveType'),
      options: leaveTypes.map((lt) => ({ value: lt.id, label: lt.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.leaveType') }),
    },
    {
      kind: 'multi',
      name: 'status',
      label: t('filters.statusLabel'),
      ariaLabel: t('filters.statusLabel'),
      options: LEAVE_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.statusLabel') }),
    },
    {
      kind: 'date',
      name: 'from',
      label: t('filters.dateFrom'),
      ariaLabel: t('filters.dateFrom'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.dateFrom') }),
    },
    {
      kind: 'date',
      name: 'to',
      label: t('filters.dateTo'),
      ariaLabel: t('filters.dateTo'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.dateTo') }),
    },
    {
      kind: 'date',
      name: 'appliedFrom',
      label: t('filters.appliedFrom'),
      ariaLabel: t('filters.appliedFrom'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.appliedFrom') }),
    },
    {
      kind: 'date',
      name: 'appliedTo',
      label: t('filters.appliedTo'),
      ariaLabel: t('filters.appliedTo'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.appliedTo') }),
    },
    // Approval Information (feedback 0773bda9). "Pending with" = the stage a pending request awaits (the
    // chain stores a ROLE, not a named person, so this is a two-value stage picker). "Approved by" = the
    // stored final decider (a named person), sourced from requests that have actually been decided.
    {
      kind: 'select',
      name: 'pendingWith',
      label: t('filters.pendingWith'),
      ariaLabel: t('filters.pendingWith'),
      allLabel: t('filters.anyStage'),
      options: PENDING_STAGES.map((s) => ({ value: s, label: t(`filters.stage.${s}`) })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.pendingWith') }),
    },
    {
      kind: 'select',
      name: 'approvedBy',
      label: t('filters.approvedBy'),
      ariaLabel: t('filters.approvedBy'),
      allLabel: t('filters.anyApprover'),
      options: approvers.map((a) => ({ value: a.id, label: a.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.approvedBy') }),
    },
  ];
  const filterValues: Record<string, string | string[] | undefined> = {
    q,
    company,
    bu,
    dept,
    loc,
    type: typeIds,
    status: statuses,
    from,
    to,
    appliedFrom,
    appliedTo,
    pendingWith,
    approvedBy,
  };
  const activeFilterCount =
    [q, company, bu, dept, loc, from, to, appliedFrom, appliedTo, approvedBy, pendingWith].filter(Boolean).length +
    (typeIds.length ? 1 : 0) +
    (statuses.length ? 1 : 0);
  const filterLabels = {
    filter: t('filters.filter'),
    apply: t('filters.apply'),
    clearAll: t('filters.clearAll'),
    activeCount: t('filters.activeCount', { count: activeFilterCount }),
  };
  // Hidden inputs so the top search box preserves every other active filter + sort when submitted.
  const searchHiddenParams = [...withSort(filterParams())].filter(([k]) => k !== 'q');

  // Sortable column header (admin): a Link that toggles ?sort=&dir= with an aria-sort hint on the <th>.
  const sortableTh = (key: string, label: string, extra = '') => {
    const activeSort = sort === key;
    return (
      <th
        className={`px-4 py-2 font-medium ${extra}`}
        aria-sort={activeSort ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <Link
          href={sortHref(key)}
          aria-label={t('filters.sortAria', { column: label })}
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          {label}
          <span aria-hidden className="text-[10px]">
            {activeSort ? (dir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </Link>
      </th>
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div data-tour="leave-intro">
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {admin && (
                <>
                {/* Global search bar (reporter: at the top of the page). GET form; hidden inputs carry the
                    other active filters + sort so searching never drops them. */}
                <form method="get" action="/leave" className="flex items-center gap-1.5">
                  {searchHiddenParams.map(([k, v], i) => (
                    <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
                  ))}
                  <input
                    name="q"
                    defaultValue={q ?? ''}
                    placeholder={t('filters.searchPlaceholder')}
                    aria-label={t('filters.searchAria')}
                    className={`${inputCls} w-56`}
                  />
                  <Button type="submit" size="sm" variant="secondary">
                    {t('filters.search')}
                  </Button>
                </form>
                <FilterPanel action="/leave" fields={filterFields} values={filterValues} labels={filterLabels} />
                {/* Export the filtered set (reporter: Excel + CSV). Plain links → admin-gated route. */}
                <div className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs">
                  <span className="text-muted-foreground">{t('filters.export')}:</span>
                  <Link href={exportHref('csv')} className="font-medium text-primary hover:underline">
                    {t('filters.exportCsv')}
                  </Link>
                  <span className="text-muted-foreground">·</span>
                  <Link href={exportHref('xlsx')} className="font-medium text-primary hover:underline">
                    {t('filters.exportExcel')}
                  </Link>
                </div>
                </>
              )}
              {/* Request Leave (feedback 48e69709): primary "+" trigger for EVERY viewer (employees too, not
                  just admins) — opens the apply form in a modal. Replaces the old bottom inline Card. */}
              <RequestLeaveDialog
                types={requestLeaveTypeOptions}
                startDefault={today}
                employeeOptions={canApplyOnBehalf ? requestLeaveEmployeeOptions : undefined}
                submitAction={requestLeaveAction}
                previewAction={previewLeaveDeductionAction}
              />
            </div>
          }
        />
      </div>

      {admin && <FilterChips action="/leave" fields={filterFields} values={filterValues} labels={filterLabels} />}

      {sp.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {sp.error}
        </div>
      )}

      {sp.toast === 'cancellationRequested' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('cancelRequestedToast')}
        </div>
      )}

      {/* HR Admin Leave Cancellation (feedback 22e68ff0): success banner after an on-behalf cancellation. */}
      {sp.toast === 'adminCancelled' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('adminCancelledToast')}
        </div>
      )}

      {sp.warnHoliday && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          {t('errors.holidaysIncomplete', {
            loaded: sp.loaded ?? '0',
            state: sp.state || '—',
            year: sp.year ?? '',
          })}
        </div>
      )}

      {/* Detailed leave-balance table — relocated from the /me Leave tab (R37 e5a158d3). Single balance
          view (replaced the old all-employee pivot): the viewer's OWN dense Workday-style table with a
          per-type EntitlementBreakdown side-sheet and ONE shared as-at-date GET form. Same source
          (leaveBalances + leaveEntitlementBreakdown) + same deriveBalanceRow gating as /me, so figures,
          breakdowns, calculations and visibility are unchanged. */}
      <Card className="overflow-hidden" data-tour="leave-balance">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          {t('myBalancesTitle')}
          <span className="ml-2 font-normal text-muted-foreground">{t('balancesSubtitle')}</span>
        </div>
        {me == null || detailedBalances.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('balancesEmpty')}</div>
        ) : (
          <div className="space-y-3 p-4">
            {/* ONE shared as-at date GET form driving every row's breakdown (mirrors /me). Invalid/empty ⇒ today. */}
            <form method="GET" action="/leave" className="flex flex-wrap items-end gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {tMe('leaveBalanceTable.asAtDate')}
                <input
                  type="date"
                  name="asOf"
                  defaultValue={breakdownAsOf}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                />
              </label>
              <button
                type="submit"
                className="rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted dark:hover:bg-muted/40"
              >
                {tMe('leaveBalanceTable.apply')}
              </button>
            </form>
            <LeaveBalanceTable
              rows={detailedBalances.map((b) => {
                // deriveBalanceRow applies the ESS available/taken/overutilized gating; the Entitlement
                // Calculation Breakdown side-sheet is its own ESS toggle — off ⇒ the expander doesn't mount.
                const showBreakdown = b.essView.entitlementCalcBreakdown !== false;
                const bd = breakdownByType.get(b.leaveTypeId);
                return {
                  ...deriveBalanceRow(b, bd ?? null),
                  detail:
                    showBreakdown && bd ? (
                      <EntitlementBreakdown
                        data={bd}
                        summary={{ available: b.available, taken: b.taken, pending: b.pending, ytdEntitled: b.accrued, balance: deriveSummaryBalance(b.available, b.taken, bd) }}
                        upcoming={selfRequests
                          .filter((r) => r.status === 'approved' && r.startDate > today && r.leaveType === b.leaveType)
                          .map((r) => ({ startDate: r.startDate, endDate: r.endDate, days: Number(r.days), durationType: r.durationType }))}
                        visual={{ color: b.color, icon: b.icon, code: b.code }}
                        asOf={breakdownAsOf}
                        action="/leave"
                        applyEssConfig
                      />
                    ) : undefined,
                };
              })}
            />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden" data-tour="leave-requests">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          {admin ? t('requestsTitle') : t('myRequestsTitle')}
          <span className="ml-2 font-normal text-muted-foreground">
            {hasFilters
              ? t('filters.showingOf', { shown: history.length, total })
              : t('requestsCountTotal', { count: total })}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {admin ? (
                  <>
                    {sortableTh('name', t('colEmployee'))}
                    {sortableTh('applied', t('colApplied'))}
                    <th className="px-4 py-2 font-medium">{t('colType')}</th>
                    {/* Leave Start & End are both sortable per the reporter's list — one Dates column, two toggles. */}
                    <th className="px-4 py-2 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <Link href={sortHref('start')} className="hover:text-foreground" aria-label={t('filters.sortAria', { column: t('filters.dateFrom') })}>
                          {t('colDates')}
                          <span aria-hidden className="ml-0.5 text-[10px]">{sort === 'start' ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                        </Link>
                        <Link href={sortHref('end')} className="text-[10px] font-normal normal-case text-muted-foreground hover:text-foreground" aria-label={t('filters.sortAria', { column: t('filters.dateTo') })}>
                          ({t('filters.dateTo')}{sort === 'end' ? (dir === 'asc' ? ' ▲' : ' ▼') : ''})
                        </Link>
                      </span>
                    </th>
                    <th className="px-4 py-2 text-right font-medium">{t('colDays')}</th>
                    {sortableTh('status', t('colStatus'))}
                    <th className="px-4 py-2 font-medium">{t('colAction')}</th>
                  </>
                ) : (
                  <>
                    <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                    <th className="px-4 py-2 font-medium">{t('colApplied')}</th>
                    <th className="px-4 py-2 font-medium">{t('colType')}</th>
                    <th className="px-4 py-2 font-medium">{t('colDates')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('colDays')}</th>
                    <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                    <th className="px-4 py-2 font-medium">{t('colAction')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.map((r) => {
                const { chip, Icon } = styleFor(r.typeCode);
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={r.employee} className="size-7 text-[10px]" />
                        <span className="font-medium">{r.employee}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r.appliedOn ? new Date(r.appliedOn).toISOString().slice(0, 10) : '—'}
                      {/* Short leave reference (feedback 0773bda9): the searchable #-prefix of the record id,
                          shown to admins so the global search's reference match is discoverable. */}
                      {admin && (
                        <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                          #{r.id.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${chip}`}>
                        <Icon className="size-3" />
                        {r.leaveType.replace(/\s*leave$/i, '')}
                      </span>
                      {/* Emergency Leave (0106): an EL submission is decomposed into ANNUAL + UNPAID child
                          rows sharing a parent_group_id; tag each child so the two halves read as one EL. */}
                      {r.parentGroupId && (
                        <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t('emergency.groupLabel')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r.startDate} → {r.endDate}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {Number(r.days)}
                      {durationLabel(t, r.durationType, r.hours) && (
                        <span className="ml-1 text-[10px] font-medium uppercase text-muted-foreground">
                          {durationLabel(t, r.durationType, r.hours)}
                        </span>
                      )}
                      {/* Hourly-leave time window (0129): the actual window on hourly rows, slice-guarded for
                          the Postgres seconds, gated so non-hourly rows never render a stray time. */}
                      {r.durationType === 'hourly' && r.fromTime && r.toTime && (
                        <span className="ml-1 text-[10px] font-medium text-muted-foreground">
                          {r.fromTime.slice(0, 5)}–{r.toTime.slice(0, 5)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${REQ_STATUS[r.status] ?? 'bg-muted text-muted-foreground'}`}>
                        {t(`status.${r.status}`)}
                      </span>
                      {/* Partial Leave Cancellation (ADR-0065): a pending give-back request shows a pill. */}
                      {r.pendingCancellationId && (
                        <span className="ml-1.5 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                          {t('cancelPendingBadge')}
                        </span>
                      )}
                      {/* Approval Information (feedback 0773bda9): decided rows show the final decider; a
                          still-pending row shows the stage it awaits. Admin history only. */}
                      {admin && r.decidedByName && (
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">
                          {t('filters.decidedByLine', { name: r.decidedByName })}
                        </span>
                      )}
                      {admin && r.status === 'pending' && r.currentStepKind && (
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">
                          {t('filters.pendingWithLine', {
                            stage:
                              r.currentStepKind === 'direct_manager' || r.currentStepKind === 'hr_admin'
                                ? t(`filters.stage.${r.currentStepKind}`)
                                : r.currentStepKind,
                          })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {(() => {
                        // Discoverable Cancel-dates affordance (R5 Build #2). Shown as a labelled BUTTON on the
                        // viewer's OWN approved, full-day, NON-EL row with no pending cancellation. Ordinary
                        // requests (parentGroupId null) AND survivors of a prior cancellation split
                        // (isCancellationSplit — so the employee can give back MORE days later) qualify; genuine
                        // EL / per-date children never do. Admins viewing others' rows never see it (subject-only,
                        // matching the service's subject assertion). The pop-up lists the real cancellable
                        // working dates (holiday-aware, strictly after MYT today); when none remain the button
                        // renders disabled with a reason rather than a silent dash.
                        const isOwn = session.personId != null && r.personId === session.personId;
                        // HR Admin Leave Cancellation on behalf of an employee (feedback 22e68ff0). An admin
                        // viewing SOMEONE ELSE's pending/approved leave gets an immediate "Cancel leave" button
                        // (no approval workflow). An approved REPLACEMENT (TOIL) leave is excluded — its register
                        // consume has no ledger inverse (matches the service gate). The self-ban mirrors the
                        // service: the admin's OWN leave falls through to the normal employee give-back flow.
                        if (
                          admin &&
                          !isOwn &&
                          (r.status === 'pending' || r.status === 'approved') &&
                          !(r.status === 'approved' && r.typeCode === 'REPLACEMENT')
                        ) {
                          return (
                            <AdminCancelLeaveDialog
                              leaveRequestId={r.id}
                              back="/leave"
                              submitAction={adminCancelLeaveAction}
                            />
                          );
                        }
                        // Edit/cancel-by-status (item c9a19e34): the viewer's OWN PENDING plain (non-EL/
                        // non-REPLACEMENT) row gets Edit + immediate self-Cancel. The service re-asserts
                        // subject-only + status='pending' authoritatively.
                        if (
                          isOwn &&
                          r.status === 'pending' &&
                          r.parentGroupId == null &&
                          r.typeCode !== 'EMERGENCY' &&
                          r.typeCode !== 'REPLACEMENT'
                        ) {
                          return (
                            <div className="flex flex-wrap gap-2">
                              <EditLeaveDialog
                                leaveRequestId={r.id}
                                types={leaveTypes.map((lt) => ({
                                  id: lt.id,
                                  label: lt.name,
                                  durations: lt.durations ?? null,
                                  code: lt.code,
                                }))}
                                current={{
                                  leaveTypeId: r.leaveTypeId,
                                  durationType: (r.durationType ?? 'full_day') as
                                    | 'full_day'
                                    | 'half_day_am'
                                    | 'half_day_pm'
                                    | 'hourly',
                                  startDate: r.startDate,
                                  endDate: r.endDate,
                                  fromTime: r.fromTime,
                                  toTime: r.toTime,
                                  reason: r.reason,
                                  employeeRemark: r.employeeRemark,
                                }}
                                submitAction={editLeaveAction}
                              />
                              <CancelLeaveDialog leaveRequestId={r.id} submitAction={cancelOwnLeaveAction} />
                            </div>
                          );
                        }
                        const cancellableShape =
                          r.status === 'approved' &&
                          r.durationType === 'full_day' &&
                          (r.parentGroupId == null || r.isCancellationSplit);
                        const eligible = isOwn && cancellableShape && !r.pendingCancellationId;
                        if (!eligible) return <span className="text-muted-foreground">—</span>;
                        return (
                          <CancelDatesDialog
                            leaveRequestId={r.id}
                            candidateDates={cancellableCandidates(r.workingDates)}
                            submitAction={requestLeaveCancellationAction}
                          />
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
              {history.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    {hasFilters ? t('filters.emptyFiltered') : t('requestsEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {admin && (page > 0 || hasNext) && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            {page > 0 ? (
              <Link href={pageHref(page - 1)} className="text-primary hover:underline">
                {t('filters.newer')}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted-foreground">
              {t('filters.rangeOf', {
                from: total === 0 ? 0 : page * PAGE + 1,
                to: Math.min((page + 1) * PAGE, total),
                total,
              })}
            </span>
            {hasNext ? (
              <Link href={pageHref(page + 1)} className="text-primary hover:underline">
                {t('filters.older')}
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
