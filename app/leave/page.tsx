import Link from 'next/link';
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  leaveBalances,
  leaveEntitlementBreakdown,
  leaveRequestDateBreakdown,
  leaveRequestsFor,
  myEmployment,
  listCompanies,
  listDepartments,
  listEmployees,
  listEmployeesPage,
  listLeaveTypes,
  listLeaveRequests,
  reportingLinesFor,
  replacementLeaveLedger,
} from '@/core/read';
import {
  deriveEmploymentStatus,
  EMPLOYMENT_STATUSES,
  type EmploymentStatus,
} from '@/core/employment-status';
import { todayInKualaLumpur } from '@/core/leave';
import { essViewHasAnyVisibleRow, isReplacementLeaveCode } from '@/core/ess-view';
import { Avatar, Button, Card, EmployeeCode, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
// Employee Details (feedback 650b6eb8): the left-side inquiry nav wave 1 built for the two screens this
// listing feeds, plus the numbered-pager window helper that lives beside the other inquiry selection rules.
import { LeaveInquiryNav } from '@/components/leave/leave-inquiry-nav';
import { inquiryPageWindow } from '@/lib/leave-inquiry';
// 33bf1a2d: the leave-request table cells this table used to spell out inline, now SHARED with the
// Approval Items leave table (app/approvals/page.tsx) so the two can no longer drift apart.
import { LeaveDaysCell, LeaveEmployeeCell, LeaveTypeCell } from '@/components/leave/leave-request-cells';
import { CancelDatesDialog } from '@/components/leave/cancel-dates-dialog';
import { EditLeaveDialog } from '@/components/leave/edit-leave-dialog';
import { CancelLeaveDialog } from '@/components/leave/cancel-leave-dialog';
import { RequestLeaveDialog } from '@/components/leave/request-leave-dialog';
// 296fc027 — the employee replacement-leave request: the button beside "+ Request Leave", the availability
// read that decides whether to offer it, and the action it posts to.
import { ReplacementLeaveRequestDialog } from '@/components/leave/replacement-leave-request-dialog';
import { replacementRequestAvailability } from '@/packs/leave/service';
import { LeaveBalanceTable } from '@/components/leave/leave-balance-table';
import { EntitlementBreakdown } from '@/components/leave/EntitlementBreakdown';
// My Absence merge (a7cbd895): the /me Leave tab's primary summary cards + per-request extras now live here.
import { LeaveCards, type LeaveCardEntry } from '@/components/leave/leave-cards';
import { LeaveDateOutcome } from '@/components/leave/leave-date-outcome';
// Compact card history + slide-out detail panel for the self-service view (feedback 657962ec).
import { LeaveHistoryCards, type LeaveHistoryEntry } from '@/components/leave/leave-history-cards';
// Restored old-Leave-page layout (feedback 56a0deb9): collapsible balance card + secondary-type groups.
import { CollapsibleCardSection } from '@/components/collapsible-card-section';
import { SecondaryLeaveGroups } from '@/components/leave/secondary-leave-groups';
import { PRIMARY_CODES, SECONDARY_GROUPS, resolveSecondaryGroup } from '@/lib/leave-groups';
// deriveBalanceRow lives in a SERVER-SAFE module (no 'use client'), so this RSC can call it at render
// time — importing it from the client table would trip the RSC boundary guard (b7d84266). R37 e5a158d3.
import { deriveBalanceRow } from '@/components/leave/leave-balance-row';
import { durationLabel } from '@/lib/leave-duration';
// fef49b9a — ONE derivation of the paid/unpaid breakdown, shared with the other three surfaces.
import { leaveDisplaySplit } from '@/lib/leave-split';
import { LEAVE_STATUS_PILL, LEAVE_STATUS_PILL_DEFAULT } from '@/lib/leave-status';
import {
  requestLeaveAction,
  submitReplacementLeaveRequestAction,
  requestLeaveCancellationAction,
  adminCancelLeaveAction,
  editLeaveAction,
  cancelOwnLeaveAction,
  previewLeaveDeductionAction,
  leaveApplySummaryAction,
} from './actions';

// fe3eb141 — the pill palette moved to lib/leave-status.ts so Employee Leave Records, which now shows
// the same Status column, cannot drift from this table. `partial` is display-only (an approved request
// with ≥1 rejected date, a7cbd895 / /me R17 600be8ac); the DB status stays 'approved'.
const REQ_STATUS = LEAVE_STATUS_PILL;

// Employee Details listing page size — the reporter asked for exactly ten employees per page (650b6eb8).
const EMPLOYEE_PAGE = 10;
// afd0a87c — LEAVE_STATUSES / LEAVE_DURATIONS / PENDING_STAGES were the whitelists for the retired
// request table's status, Days-column and "Pending with" filters. They narrowed a tampered query value to
// nothing before it could reach SQL; with no filter left to tamper with, they have no subject. The same
// vocabularies still live where the reads use them (core/read.ts listLeaveRequestsPage, ADR-0048).

// Restored old-Leave-page layout (feedback 56a0deb9): the collapsible Current Balance section persists its
// open/closed choice in this cookie (SSR-read via cookies(), mirroring GRADES_OPEN_COOKIE on the leave
// entitlements page). Cookie absent ⇒ CLOSED — the reporter wants the balance details collapsed by default.
const BALANCE_OPEN_COOKIE = 'leave_balance_open';

// Equal-height columns for the self-service breakdown + history pairing (feedback 657962ec): both columns
// share this lg+ height cap and scroll WITHIN themselves, so neither stretches the row taller than the
// other — they stay exactly side by side. On mobile the cards stack at natural height (no cap).
const COLUMN_CAP = 'lg:max-h-[42rem]';

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
    // afd0a87c — the org-wide request table's query contract (q / page / size / company / bu / dept / loc /
    // duration / type / status / from / to / appliedFrom / appliedTo / approvedBy / pendingWith / sort /
    // dir) is GONE with the table. Declaring params nothing reads would advertise a filter that silently
    // does nothing. A saved admin link carrying them still lands on this page — Next ignores unknown
    // search params — it simply arrives unfiltered, which is disclosed in the approved plan.
    //
    // `emp` SURVIVES on its own: it names the employee under inquiry, is threaded between the inquiry tabs
    // by the left-side nav, and never belonged to the retired table.
    emp?: string | string[];
    // R37 e5a158d3: as-at date for the (relocated) detailed leave-balance table's entitlement breakdown.
    asOf?: string;
    // Employee Details listing (feedback 650b6eb8). Its own search / page / narrowings, prefixed `ed`:
    // this page carries TWO independently filtered listings and the unprefixed q/page/company/dept/status
    // already belong to the leave-request table below. Renaming those instead would break every saved
    // admin link and every export URL already in circulation.
    edQ?: string;
    edPage?: string;
    edCompany?: string | string[];
    edDept?: string | string[];
    edStatus?: string | string[];
  }>;
}) {
  const { s: session, scopeIds } = await scopedSession();
  const t = await getTranslations('leave');
  // R37 e5a158d3: the relocated detailed balance table reuses the `me` namespace's as-at-form + table labels.
  const tMe = await getTranslations('me');
  // Employee Details (650b6eb8) reuses the People vocabulary rather than minting a second one: the same
  // column heading and, for the badge, the ONE shared Employee Status vocabulary 9cbf5e0d consolidated on.
  const tPeople = await getTranslations('people.list');
  const tStatus = await getTranslations('people.employeeStatus');
  const tInq = await getTranslations('leave.inquiry');
  const admin = isAdmin(session);
  // R5 Build #2 (Fix B): MYT "today" so the "hasn't started yet" cut-off matches the service (Malaysia time),
  // not a UTC clock that would allow/block a day near KL midnight. The default-date on the apply form uses it too.
  const today = todayInKualaLumpur();
  const sp = await searchParams;
  // Feedback 56a0deb9 — collapsible balance section. SSR-read the persisted choice (cookie absent ⇒ closed,
  // the reporter's default) so the first paint is already correct — no closed-then-restored flash.
  const cookieStore = await cookies();
  const balanceOpen = cookieStore.get(BALANCE_OPEN_COOKIE)?.value === '1';

  // Partial Leave Cancellation (ADR-0065 / R5 Build #2): the candidate dates for a row's Cancel-dates pop-up are
  // the row's REAL working dates (roster + holiday aware, resolved server-side in core/read.ts) that are
  // strictly after today (MYT). This replaces the old Mon–Fri heuristic that could offer a holiday the service
  // rejects or hide a working Saturday. The service still re-validates every posted date authoritatively.
  const cancellableCandidates = (workingDates: string[] | undefined): string[] =>
    (workingDates ?? []).filter((d) => d > today);

  // ── Advanced Search & Filter params (admin only; feedback 0773bda9) ──────────────────────────────────
  const arr = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  // afd0a87c — the org-wide request table's search/sort/eleven filters are gone with it. `emp` STAYS: it
  // names the employee under inquiry (inquiryEmploymentId below), which the left-side nav threads between
  // tabs and which never depended on the retired table.
  const empIds = arr(sp.emp);
  // ── Employee Details params (admin only; feedback 650b6eb8) ─────────────────────────────────────────
  const edQ = sp.edQ?.trim() || undefined;
  const edPage = Math.max(0, Number(sp.edPage) || 0);
  const edCompany = arr(sp.edCompany);
  const edDept = arr(sp.edDept);
  // Whitelisted against the derived buckets, so an unknown value narrows to nothing rather than reaching SQL.
  const edStatus = arr(sp.edStatus).filter((s): s is EmploymentStatus =>
    (EMPLOYMENT_STATUSES as readonly string[]).includes(s),
  );
  const hasEmployeeChips = edCompany.length + edDept.length + edStatus.length > 0;
  const hasEmployeeFilters = admin && (!!edQ || hasEmployeeChips);
  // The employee currently under inquiry, threaded through the left nav so switching tab keeps them. One
  // value only: `emp` doubles as the request table's multi-select employee filter, and "which employee am
  // I looking at" is only meaningful when exactly one is named.
  const inquiryEmploymentId = empIds.length === 1 ? empIds[0] : undefined;

  const locale = await getLocale();
  const [employees, leaveTypes, me] = await Promise.all([
    listEmployees(session, scopeIds),
    // Employee apply-popup enhancement: pass the viewer's locale so listLeaveTypes localizes `name` through
    // pickName. Without it the list is always English, which also makes an alphabetical sort meaningless
    // outside English. Admin master screens deliberately keep passing no locale (they edit the English name).
    listLeaveTypes(session, { locale }),
    // R37 e5a158d3: the balance view is now the viewer's OWN detailed table (was an all-employee pivot).
    myEmployment(session),
  ]);
  // Sort ONCE, at the source: all four consumers on this page map off this array (the request-leave dialog
  // options, the two edit-leave dialog lists, and the admin filter-chip options), so one sort makes them
  // agree instead of one popup being ordered and another not. NOT pushed into core/read.ts listLeaveTypes —
  // the admin master listing has its own ordering.
  leaveTypes.sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }));
  // fef49b9a — the tenant's OWN name for unpaid leave, so the breakdown says what their catalogue says.
  // Matched on the UNPAID code, which is the same lookup core/leave.ts already uses for the Emergency
  // decomposition (core/leave.ts:3480). The approved plan asked for the leave-type ROLE marker instead,
  // but LeaveTypeRoleValue has no `unpaid` member — noted rather than silently diverging. Undefined when
  // the tenant has no such type, in which case leaveDisplaySplit falls back to a translated label.
  const unpaidTypeName = leaveTypes.find((lt) => lt.code === 'UNPAID')?.name;
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
    // Balance Deduction Source (cdf9ca48): lets the form drop Emergency Leave's decomposition-specific
    // controls once EL has been pointed at another type's balance — see LeaveTypeOption.borrowsBalance.
    borrowsBalance: lt.balanceSourceTypeId != null,
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
  // Feedback 8ec63139: the ESS half of this page (My Balances, the Requests section, Request Leave) is gone
  // for an HR admin — this route is their employee-inquiry landing page, and their own leave duplicated the
  // Approval Items surface. `ess` is the single gate: it suppresses the READS as well as the markup, so an
  // admin page load no longer pays for balances/breakdowns nobody renders. Nothing about leave application,
  // approval or balance calculation changes — only who is shown their own figures here.
  const ess = !admin;
  // 296fc027 · may this employee ask for replacement leave? THREE questions in one read: the chargeable
  // add-on, the per-company employee-request switch, and this employee's own eligibility as of today. Only
  // asked on the ESS path — an admin viewing this route sees the employee-inquiry surface, not their own.
  //
  // THIS IS NOT THE ENFORCEMENT. `submitReplacementLeaveRequest` re-derives all three server-side; this
  // read exists so the button is not offered where the submission would be refused. Hiding it is the
  // courtesy, refusing the POST is the control.
  const replacementRequest = ess && me ? await replacementRequestAvailability(session, me.employmentId, today) : { allowed: false };
  const breakdownAsOf = sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : today;
  const selfBalances = ess && me ? await leaveBalances(session, me.employmentId, locale) : [];
  const selfRequests = ess && me ? await leaveRequestsFor(session, me.employmentId, locale) : [];
  const selfBreakdowns = me
    ? await Promise.all(
        selfBalances.map((b) => leaveEntitlementBreakdown(session, me.employmentId, b.leaveTypeId, breakdownAsOf, locale)),
      )
    : [];
  const breakdownByType = new Map(selfBreakdowns.filter((x) => x != null).map((x) => [x!.leaveTypeId, x!]));
  // leaveBalances already dropped visible_to_employee=false types; still filter the default-hidden placement
  // (mirrors /me detailedBalances). Presentation only — no calc change.
  const detailedBalances = selfBalances.filter((b) => b.placement !== 'hidden');

  // ── "My Leave" primary summary cards (My Absence merge · a7cbd895) ───────────────────────────────────
  // The clickable colour-coded PRIMARY-type cards that headed the /me Leave tab (6d78f373) now open the
  // merged page, so the at-a-glance summary employees know moved with the tab. Same source (selfBalances +
  // breakdownByType), same ESS gating (deriveBalanceRow / essViewHasAnyVisibleRow) — presentation only.
  // Secondary types render again as their own grouped section (feedback 56a0deb9 reversed the R54 call to
  // skip them): the reporter wants the old /me arrangement back, and with the detailed balance table now
  // COLLAPSED by default the double-listing that motivated the skip is no longer prominent.
  type SelfBalance = (typeof selfBalances)[number];
  const buildCardPanel = (b: SelfBalance) => {
    const bd = breakdownByType.get(b.leaveTypeId);
    // 1f6fd6d8: the `entitlementCalcBreakdown` toggle named a section that no longer exists. The honest
    // form of the question the three call sites were really asking is essViewHasAnyVisibleRow — a side-sheet
    // whose every line HR has hidden is an empty panel, and an empty panel should not be offered.
    if (!essViewHasAnyVisibleRow(b.essView) || !bd) return null;
    return {
      data: bd,
      summary: { available: b.available },
      // §5 Upcoming Approved Leave removed from the panel (feedback 11876072) — no upcoming list is built.
      visual: { color: b.color, icon: b.icon, code: b.code },
      asOf: breakdownAsOf,
    };
  };
  // ── Replacement Leave: the per-credit register behind the card (feedback 00307068) ──────────────────
  //
  // Replacement Leave is not a yearly allowance — it is a stack of separately earned credits, each with its
  // own approval and its own expiry — so its card opens a TABLE of those credits rather than the nine-line
  // Leave Balance Summary every other type gets. `replacementLeaveLedger` has held exactly that data since
  // 0113 and, until now, had no UI caller at all; this is the entry point it was missing.
  //
  // ONE EXTRA READ, AND ONLY WHEN IT IS RENDERED. Loaded only when the employee actually has a visible
  // REPLACEMENT card (ESS surface + a primary-placed type whose code is REPLACEMENT), so an admin page load
  // and every tenant without the module pay nothing for it. Nothing else on this page changes shape.
  const replacementBalance = ess ? selfBalances.find((b) => b.placement === 'primary' && isReplacementLeaveCode(b.code)) : undefined;
  const replacementLedger = replacementBalance && me ? await replacementLeaveLedger(session, me.employmentId) : null;

  const primaryCards: LeaveCardEntry[] = selfBalances
    .filter((b) => b.placement === 'primary')
    .map((b) => ({
      leaveTypeId: b.leaveTypeId,
      leaveType: b.leaveType,
      color: b.color,
      icon: b.icon,
      code: b.code,
      // ESS-gated remaining figure (null when Available is HR-hidden ⇒ the card renders "—").
      remaining: deriveBalanceRow(b, breakdownByType.get(b.leaveTypeId) ?? null).available,
      panel: buildCardPanel(b),
      // The credit table's envelope — plain serialisable data only (no Date objects, no closures), because
      // this RSC hands it straight to a client component. The column explanations come from the SAME
      // breakdown read every other card uses; for a REPLACEMENT type core/read resolves them over the five
      // column keys instead of the nine summary keys, so heading and wording are always keyed alike.
      replacement:
        replacementLedger && isReplacementLeaveCode(b.code)
          ? {
              rows: replacementLedger.rows,
              leaveUnit: replacementLedger.leaveUnit,
              explanations: breakdownByType.get(b.leaveTypeId)?.formulaExplanations ?? {},
            }
          : null,
    }));
  // Canonical PRIMARY_CODES order first (Annual, Medical, Hospitalisation, Emergency, Replacement), then
  // any other HR-promoted primaries alphabetically — same reading order the /me tab had.
  const primaryRank = (code: string | null) => {
    const i = code ? (PRIMARY_CODES as readonly string[]).indexOf(code.toUpperCase()) : -1;
    return i === -1 ? PRIMARY_CODES.length : i;
  };
  primaryCards.sort((a, b) => primaryRank(a.code) - primaryRank(b.code) || a.leaveType.localeCompare(b.leaveType));

  // ── "Other leave" secondary-type groups (restored · feedback 56a0deb9) ───────────────────────────────
  // The pre-R54 grouped panels the /me Leave tab carried (6d78f373): SECONDARY-placement types bucketed
  // into Family & Personal / Education / Other via lib/leave-groups, each row keeping its View Breakdown
  // side-sheet link. Same source as the detailed table (selfBalances + breakdownByType) — no data change;
  // empty groups are omitted, and an all-primary catalog omits the whole section (as on the old page).
  const secondaryGroups = SECONDARY_GROUPS.map((group) => ({
    group,
    types: selfBalances.filter((b) => b.placement === 'secondary' && resolveSecondaryGroup(b.code) === group),
  })).filter((g) => g.types.length > 0);

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
    employeeList,
  } = admin
    ? await (async () => {
        // afd0a87c — the org-wide leave register is GONE, so this branch no longer reads it. rows/total
        // are returned empty because the non-admin branch below still needs them (the self-service card
        // and selfHistory read the same destructure). businessUnits / locations / approvers were option
        // sources for the retired filter panel and have no other consumer on this page; companies and
        // departments STAY because employeeFilterFields consumes them for the Employee Details listing.
        const [companies, departments, employeeList] = await Promise.all([
          listCompanies(session),
          listDepartments(session, { companyIds: scopeIds }),
          // Employee Details (650b6eb8): the same access-scoped People read /personnel uses, ordered
          // company A→Z then name A→Z and paged ten at a time. Terminated staff are NOT excluded — their
          // leave position is exactly what HR looks up after someone leaves (20c699f8 made the same call).
          listEmployeesPage(session, {
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
        return { rows: [], total: 0, companies, businessUnits: [], departments, locations: [], approvers: [], employeeList };
      })()
    : await (async () => {
        const requests = await listLeaveRequests(session, scopeIds);
        const mine = requests.filter((r) => session.personId != null && r.personId === session.personId);
        return {
          rows: mine,
          total: mine.length,
          companies: [],
          businessUnits: [],
          departments: [],
          locations: [],
          approvers: [],
          employeeList: { rows: [], total: 0 },
        };
      })();

  // Self-service history ordering (feedback 657962ec): cards render newest first BY LEAVE START DATE —
  // explicit here (the read returns createdAt-desc, i.e. most recently APPLIED first, which is not the
  // same thing). Admin history keeps its own sortable columns and is untouched.
  const selfHistory = admin ? [] : [...history].sort((a, b) => b.startDate.localeCompare(a.startDate));

  // Per-date outcome rows for the viewer's OWN recent requests (My Absence merge · a7cbd895): the same
  // 5-most-recent window the /me Leave tab resolved (R17 600be8ac ask #6), so the employee still sees the
  // date-by-date approved/rejected breakdown after the tab moved here — now inside the detail panel
  // (657962ec). The window follows the card order (5 newest by start date). Admin history is untouched
  // (approvers already get per-date detail on /approvals). RLS self-branch admits the subject to their rows.
  const dateBreakdownEntries: (readonly [string, Awaited<ReturnType<typeof leaveRequestDateBreakdown>>])[] =
    admin
      ? []
      : await Promise.all(
          selfHistory.slice(0, 5).map(async (r) => [r.id, await leaveRequestDateBreakdown(session, r.id)] as const),
        );
  const requestDateBreakdowns = new Map(dateBreakdownEntries);

  // ── Self-service history cards (feedback 657962ec) ───────────────────────────────────────────────────
  // Each of the viewer's OWN records becomes a plain, pre-translated entry for the LeaveHistoryCards client
  // island: the card shows type / dates / duration / status only, while the slide-out detail panel carries
  // the session, stage, per-date outcomes, document link and the SAME action dialogs the old list rendered
  // inline — same gates (item c9a19e34 edit/cancel-by-status, ADR-0065 cancel-dates), same server actions,
  // services still re-assert subject/status authoritatively. Presentation-only: no data or permission change.
  const historyEntries: LeaveHistoryEntry[] = selfHistory.map((r) => {
    // "Partially approved" display badge (R17 600be8ac ask #4): display-derived; DB status stays 'approved'.
    const isPartial = r.status === 'approved' && r.hasRejectedDates;
    const dateRows = requestDateBreakdowns.get(r.id) ?? [];
    // Session labelling: half-day/hourly rows get the ADR-0048 duration label (hourly shows its stored
    // hours + 0129 time window, slice-guarded for the Postgres seconds); full-day rows read "Full day".
    const sessionSuffix = durationLabel(t, r.durationType, r.hours);
    const hourlyWindow =
      r.durationType === 'hourly' && r.fromTime && r.toTime
        ? ` (${r.fromTime.slice(0, 5)}–${r.toTime.slice(0, 5)})`
        : '';
    // Edit/cancel-by-status (item c9a19e34) + Cancel-dates (R5 Build #2): the same gates the old inline
    // list applied — every row here is the viewer's OWN (see the `mine` filter above).
    const actions =
      r.status === 'pending' &&
      r.parentGroupId == null &&
      r.typeCode !== 'EMERGENCY' &&
      r.typeCode !== 'REPLACEMENT' ? (
        <>
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
        </>
      ) : r.status === 'approved' &&
        r.durationType === 'full_day' &&
        (r.parentGroupId == null || r.isCancellationSplit) &&
        !r.pendingCancellationId ? (
        <CancelDatesDialog
          leaveRequestId={r.id}
          candidateDates={cancellableCandidates(r.workingDates)}
          submitAction={requestLeaveCancellationAction}
        />
      ) : null;
    return {
      id: r.id,
      leaveType: r.leaveType,
      // Emergency Leave (0106): tag the ANNUAL/UNPAID children of one EL submission as one Emergency Leave.
      groupLabel: r.parentGroupId ? t('emergency.groupLabel') : null,
      startDate: r.startDate,
      endDate: r.endDate,
      days: Number(r.days),
      // fef49b9a — the paid/unpaid breakdown, derived ONCE by lib/leave-split.ts and pre-translated here
      // because LeaveHistoryCards is a client island that translates nothing. `unpaidTypeName` comes from
      // the tenant's OWN unpaid leave type (resolved above) rather than a hardcoded string, so a tenant
      // that renamed it sees its own name; the fallback is a translated label.
      splitRows: (() => {
        const rows = leaveDisplaySplit({
          leaveTypeName: r.leaveType,
          days: r.days,
          unpaidDays: r.unpaidDays,
          unpaidTypeName,
          unpaidFallbackLabel: t('unpaidPortionLabel'),
        });
        return rows.length > 1 ? rows : null;
      })(),
      sessionSuffix,
      sessionLabel: `${sessionSuffix ?? t('duration.full_day')}${hourlyWindow}`,
      statusKey: isPartial ? 'partial' : r.status,
      statusLabel: isPartial ? tMe('leaveStatus.partiallyApproved') : t(`status.${r.status}`),
      stageLabel:
        r.status === 'pending' && r.stepCount > 0
          ? r.currentStepKind === 'direct_manager'
            ? tMe('stageManager')
            : tMe('stageHr')
          : null,
      // WHO it is sitting with (feedback 567333b7), alongside the stage line that already said WHAT the
      // stage is. Populated only for a direct-manager step — see the projection in core/read.ts on why the
      // role-based kinds deliberately keep their label instead of naming or enumerating people.
      approverName: r.status === 'pending' ? (r.currentApproverName ?? null) : null,
      approverPersonId: r.status === 'pending' ? (r.currentApproverPersonId ?? null) : null,
      // Partial Leave Cancellation (ADR-0065): a pending give-back request shows a pill in the panel.
      cancelPendingLabel: r.pendingCancellationId ? t('cancelPendingBadge') : null,
      documentHref: r.hasDocument ? `/me/leave/attachment/${r.id}?inline=1` : null,
      documentLabel: r.hasDocument ? tMe('viewDocument') : null,
      actions,
      dateOutcome:
        dateRows.length > 0 ? (
          <LeaveDateOutcome
            dates={dateRows}
            locale={locale}
            labels={{
              title: tMe('dateBreakdown.title'),
              approved: tMe('dateBreakdown.approved'),
              rejected: tMe('dateBreakdown.rejected'),
              pending: tMe('dateBreakdown.pending'),
              reason: tMe('dateBreakdown.reason'),
            }}
          />
        ) : null,
    };
  });

  // ── Filter panel + query-string helpers (admin only; feedback 0773bda9) ──────────────────────────────
  // The active filter set WITHOUT sort/dir/page — the base for every generated link and the search-form's
  // hidden inputs. Multi params (type/status) are appended so all selected values survive.
  // The Employee Details listing's own state (feedback 650b6eb8), carried by every link the REQUEST table
  // generates so searching, paging or re-sorting the requests below never disturbs the employee list above
  // it. `keepPage: false` is for the employee listing's OWN controls: changing an employee filter is the one
  // thing that should send that listing back to page one, exactly as the request table treats `page`.
  const withEmployeeParams = (p: URLSearchParams, opts: { keepPage?: boolean } = {}) => {
    if (edQ) p.set('edQ', edQ);
    for (const id of edCompany) p.append('edCompany', id);
    for (const id of edDept) p.append('edDept', id);
    for (const st of edStatus) p.append('edStatus', st);
    if (opts.keepPage !== false && edPage > 0) p.set('edPage', String(edPage));
    return p;
  };
  // Sort links reset to the first page (drop `page`); toggle asc/desc when re-clicking the active column.
  // The chosen rows-per-page survives, like every other narrowing on this screen (fc776376).
  // fc776376 — the shared pager builds its own links through this, because /leave's address carries
  // REPEATED params (the multi-select filters) that a flat key/value builder would flatten.

  // ── Employee Details listing (feedback 650b6eb8) ─────────────────────────────────────────────────────
  // The tab an HR admin lands on: who am I looking up. Picking a row hands the employment id to Employee
  // Balances, which is the screen that actually answers the leave question — this listing does no leave
  // reads of its own. Its links carry the request table's state for the same reason that table's carry
  // this one's: one page, two listings, neither may silently reset the other.
  const employeePageCount = Math.ceil(employeeList.total / EMPLOYEE_PAGE);
  const edPageHref = (n: number) => {
    // afd0a87c — was withEmployeeParams(withSort(filterParams())): it carried the request table's search,
    // sort and eleven filters so paging the employee list never reset the requests below. There is no
    // request table any more, so it carries only this listing's own state.
    const p = withEmployeeParams(new URLSearchParams(), { keepPage: false });
    if (n > 0) p.set('edPage', String(n));
    const s = p.toString();
    return s ? `/leave?${s}` : '/leave';
  };
  // Opening an employee goes straight to Employee Balances (650b6eb8 §v) — the listing is a picker, not a
  // destination, so there is no per-employee page here to land on first.
  const employeeHref = (employmentId: string) => `/leave/employee-balances?emp=${employmentId}`;
  const employeeFilterFields: FilterField[] = [
    {
      kind: 'multi',
      name: 'edCompany',
      label: t('filters.company'),
      ariaLabel: t('filters.company'),
      options: companies.map((c) => ({ value: c.id, label: c.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.company') }),
    },
    {
      kind: 'multi',
      name: 'edDept',
      label: t('filters.department'),
      ariaLabel: t('filters.department'),
      options: departments.map((d) => ({ value: d.id, label: d.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.department') }),
    },
    {
      // The DERIVED Employee Status buckets and the shared people.employeeStatus vocabulary (9cbf5e0d) —
      // never the legacy stored assignment.status, whose retired values must not reappear on a new screen.
      kind: 'multi',
      name: 'edStatus',
      label: tPeople('colStatus'),
      ariaLabel: tPeople('colStatus'),
      options: EMPLOYMENT_STATUSES.map((s) => ({ value: s, label: tStatus(s) })),
      removeAriaLabel: t('filters.removeFilter', { label: tPeople('colStatus') }),
    },
  ];
  const employeeFilterValues = { edCompany, edDept, edStatus };
  const employeeFilterLabels = {
    filter: t('filters.filter'),
    apply: t('filters.apply'),
    clearAll: t('filters.clearAll'),
    activeCount: t('filters.activeCount', {
      count: [edCompany, edDept, edStatus].filter((v) => v.length > 0).length,
    }),
    selectAll: t('filters.selectAll'),
    deselectAll: t('filters.deselectAll'),
  };
  // afd0a87c — this carried the retired request table's params so one listing could not clear the other.
  // With a single listing on the page, only its own search term needs preserving.
  const employeeHiddenParams: [string, string][] = [...(edQ ? ([['edQ', edQ]] as [string, string][]) : [])];


  // The "Other leave" breakdown Card (restored · feedback 56a0deb9): the pre-R54 grouped panels, rebuilt
  // from the SAME derivations that feed the detailed balance table (deriveBalanceRow remaining + ESS-gated
  // EntitlementBreakdown side-sheet sharing the ?asOf= reload). Null when no secondary types exist — the
  // section is omitted exactly as on the old /me page. Rendered in BOTH branches below: beside the history
  // for the personal view (with the shared equal-height column cap · 657962ec), full-width above the table
  // for admins (no cap).
  const secondaryBreakdownCard = (className = '') =>
    secondaryGroups.length > 0 ? (
      <Card className={`p-5 ${className}`.trim()}>
        <SecondaryLeaveGroups
          heading={tMe('otherLeaveHeading')}
          groups={secondaryGroups.map(({ group, types }) => ({
            group,
            label: tMe(`leaveGroups.${group}`),
            types: types.map((b) => {
              const bd = breakdownByType.get(b.leaveTypeId);
              const showBreakdown = essViewHasAnyVisibleRow(b.essView);
              return {
                leaveTypeId: b.leaveTypeId,
                leaveType: b.leaveType,
                color: b.color,
                icon: b.icon,
                code: b.code,
                remaining: deriveBalanceRow(b, bd ?? null).available,
                breakdown:
                  showBreakdown && bd ? (
                    <EntitlementBreakdown
                      data={bd}
                      summary={{ available: b.available }}
                      visual={{ color: b.color, icon: b.icon, code: b.code }}
                      asOf={breakdownAsOf}
                      action="/leave"
                      applyEssConfig
                    />
                  ) : undefined,
              };
            }),
          }))}
        />
      </Card>
    ) : null;

  return (
    // Layout (feedback 026e16b9): the container cap goes to 100rem so this page — whose Employee Details
    // listing is one of the three inquiry tabs — uses the width a wide monitor actually has, and matches
    // Employee Balances and Employee Leave Record rather than being 6xl where they are wider. Presentation
    // only; nothing about the data, filters or pagination changes.
    <div className="mx-auto max-w-[100rem] space-y-6">
      {/* The submission success toast (45c781e2) is NOT raised here any more — feedback 29710798. This page
          mounted its own listener for `?toast=leaveSubmitted` while the globally-mounted ToastFromQuery
          (app/layout.tsx) answered the same param, so one submission produced two pop-ups. requestLeaveAction
          now redirects with the already-localised sentence, which the global listener alone renders. */}
      <div data-tour="leave-intro">
        <PageHeader
          // a7cbd895: the page is the "My Absence" first-level destination now — title follows the nav rename.
          title={t('myAbsenceTitle')}
          description={t('description')}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {/* Request Leave (feedback 48e69709): primary "+" trigger opening the apply form in a modal.
                  Feedback 8ec63139 narrowed it to the SELF-SERVICE viewer — on the HR-admin landing page it
                  was one of the three own-leave affordances the reporter asked to remove. The action, the
                  form and the on-behalf-of employee selector are untouched; only this trigger's audience
                  changed. Managers keep it (they are not `admin`), so applying on behalf of a report still
                  works from here. */}
              {ess && (
                <RequestLeaveDialog
                  types={requestLeaveTypeOptions}
                  startDefault={today}
                  employeeOptions={canApplyOnBehalf ? requestLeaveEmployeeOptions : undefined}
                  submitAction={requestLeaveAction}
                  previewAction={previewLeaveDeductionAction}
                  summaryAction={leaveApplySummaryAction}
                />
              )}
              {/* 296fc027 · "+ Replacement Leave Request", BESIDE "+ Request Leave" and deliberately not
                  inside it. Request Leave asks to TAKE time; this asks to be CREDITED for time already
                  worked. They sit together because that is where an employee looks, and they are separate
                  because they are opposites underneath — different table, different service, a credit
                  rather than a debit (migration 0381 explains why reusing `leave_request` would corrupt
                  the balance check, the calendar and payroll at once).

                  Rendered only when the server says this employee may submit. With the switch off, or the
                  employee outside the eligibility criteria, there is no button — and the action refuses
                  the POST anyway. */}
              {ess && replacementRequest.allowed && (
                <ReplacementLeaveRequestDialog
                  types={requestLeaveTypeOptions}
                  submitAction={submitReplacementLeaveRequestAction}
                  today={today}
                  requiresFirstScheduleConsent={replacementRequest.requiresFirstScheduleConsent}
                />
              )}
            </div>
          }
        />
      </div>

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

      {/* "My Leave" primary summary cards — ported from the /me Leave tab (My Absence merge · a7cbd895).
          Clicking a card opens THAT type's details in the right-side slide-out panel, exactly as on /me.
          The `me-leave` tour anchor moves with the cards so the My Profile walkthrough still lands on them
          (its step now routes here — see lib/module-tours.json). Empty ⇒ row omitted (e.g. not linked). */}
      {ess && primaryCards.length > 0 && (
        <Card className="p-5" data-tour="me-leave">
          <LeaveCards entries={primaryCards} />
        </Card>
      )}

      {/* Detailed leave-balance table — relocated from the /me Leave tab (R37 e5a158d3). Single balance
          view (replaced the old all-employee pivot): the viewer's OWN dense Workday-style table with a
          per-type EntitlementBreakdown side-sheet and ONE shared as-at-date GET form. Same source
          (leaveBalances + leaveEntitlementBreakdown) + same deriveBalanceRow gating as /me, so figures,
          breakdowns, calculations and visibility are unchanged. Feedback 56a0deb9: the section folds
          behind its header (CollapsibleCardSection — CLOSED by default, cookie-persisted per browser) so
          the page opens tidy; the data-tour anchor stays on the Card, whose summary bar remains visible
          when closed, so the leave-balance tour step keeps a target either way. Feedback 8ec63139: the whole
          section is self-service only — an HR admin's own balances do not belong on their inquiry page. */}
      {ess && (
      <Card className="overflow-hidden" data-tour="leave-balance">
        <CollapsibleCardSection
          title={t('myBalancesTitle')}
          subtitle={t('balancesSubtitle')}
          toggleLabel={t('balancesToggle')}
          cookieKey={BALANCE_OPEN_COOKIE}
          defaultOpen={balanceOpen}
        >
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
                // deriveBalanceRow applies the ESS available/taken gating; the breakdown side-sheet is offered only
                // when HR has left at least one Leave Summary line visible (1f6fd6d8) — else the expander never mounts.
                const showBreakdown = essViewHasAnyVisibleRow(b.essView);
                const bd = breakdownByType.get(b.leaveTypeId);
                return {
                  ...deriveBalanceRow(b, bd ?? null),
                  detail:
                    showBreakdown && bd ? (
                      <EntitlementBreakdown
                        data={bd}
                        summary={{ available: b.available }}
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
        </CollapsibleCardSection>
      </Card>
      )}

      {/* Self-service view — compact card history (feedback 657962ec, replacing the 56a0deb9 list): the
          "Other leave" breakdown beside the leave history, each in its own column on wide screens,
          stacking on small ones. Each history record is now a clean card (type, dates, duration, status)
          whose full detail + actions open in a slide-out panel — see LeaveHistoryCards. Both columns share
          the COLUMN_CAP height on lg+ and scroll within themselves so they stay exactly side by side.
          Rows, actions, gates and data are all unchanged. */}
      {!admin && (
        <div className={`grid grid-cols-1 gap-6 ${secondaryGroups.length > 0 ? 'lg:grid-cols-2' : ''}`}>
          {secondaryBreakdownCard(`${COLUMN_CAP} lg:overflow-y-auto`)}
          <Card className={`flex flex-col overflow-hidden ${COLUMN_CAP}`} data-tour="leave-requests">
            <div className="shrink-0 border-b border-border px-4 py-3 text-sm font-medium">
              {t('historyCount', { count: total })}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {historyEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('requestsEmpty')}</p>
              ) : (
                <LeaveHistoryCards entries={historyEntries} locale={locale} />
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Feedback 8ec63139: the HR admin's own full-width "Other leave" breakdown card (56a0deb9) is gone —
          it was the third face of My Balances on a page that is now about employees, not the viewer. The
          self-service pairing above is untouched. */}
      {/* ── HR-admin leave inquiry (feedback 650b6eb8) ────────────────────────────────────────────────
          The landing tab: an employee listing you search, narrow and page through, whose rows open the
          Employee Balances screen. The left-side nav is wave 1's (20c699f8 / 953be4b0) — this is the
          "details" destination it was already pointing at.

          afd0a87c — THE ORG-WIDE LEAVE-REQUEST TABLE IS GONE, and this comment is kept as the record of
          why it survived twice before. It was held in 8ec63139 (the reporter had just asked for a filter on
          every one of its columns) and again in r80 (reported as a duplicate of Approval Items, which it was
          not). The reporter has now asked plainly for the removal itself, with no relocation, and said they
          will redesign Employee Leave Record separately.

          TWO CAPABILITIES GO WITH IT AND HAVE NO OTHER HOME, both disclosed in the approved plan and
          accepted: the org-wide register over every status with its eleven filters, and an HR admin editing
          their OWN pending application (withdraw-and-reapply is the workaround). Its filtered CSV/Excel
          export route is deleted in the same change rather than left unreachable.

          WHAT DOES NOT GO, contrary to what test/leave-records-cancel.test.ts used to assert: withdrawing
          and giving back dates on your own leave still work from the dashboard calendar —
          components/planned-absences.tsx gates those on personId === viewerPersonId with no admin
          exclusion. AdminCancelLeaveDialog over someone else's leave lives on Employee Leave Record and on
          the calendar. */}
      {admin && (
      <div className="flex flex-col gap-4 sm:flex-row">
        <LeaveInquiryNav active="details" employmentId={inquiryEmploymentId} />
        <div className="min-w-0 flex-1 space-y-6">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-4 py-3">
              <div className="text-sm font-medium">
                {tInq('employeeDetails')}
                <span className="ml-2 font-normal text-muted-foreground">
                  {t('filters.showingOf', { shown: employeeList.rows.length, total: employeeList.total })}
                </span>
              </div>
              {/* Search + Filter for THIS listing. The hidden inputs carry the leave-request table's own
                  state so narrowing employees never blanks the table below (and vice versa). The panel is a
                  SIBLING of the search form, not a child: it renders its own <form>, and nesting one inside
                  another is invalid HTML the parser silently unpicks. */}
              <div className="flex flex-wrap items-center gap-1.5">
                <form method="get" action="/leave" className="flex flex-wrap items-center gap-1.5">
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
                    {t('filters.search')}
                  </Button>
                </form>
                <FilterPanel
                  action="/leave"
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
                  action="/leave"
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
                    <th className="whitespace-nowrap px-3 py-2 font-medium">{t('filters.employeeId')}</th>
                    <th className="px-3 py-2 font-medium">{tInq('colEmployeeName')}</th>
                    <th className="px-3 py-2 font-medium">{t('filters.company')}</th>
                    <th className="px-3 py-2 font-medium">{t('filters.department')}</th>
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
      )}
    </div>
  );
}
