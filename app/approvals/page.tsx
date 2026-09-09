import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listLeaveRequests, listPendingLeaveCancellations, leaveRequestDateBreakdown } from '@/core/read';
// 1e9145d4 adds dayTypesForPairs to this EXISTING direct import. app/approvals/page.tsx is already an
// audited kernel-contract entry on the attendance pack's drift allowlist (the approvals inbox is
// cross-module substrate awaiting an approvals contract, ADR-0080 open decision 6) — this widens no
// allowlist and copies no new pattern.
import { dayTypesForPairs, listAttendanceCorrections } from '@/core/attendance';
import { listTravelRequests } from '@/core/travel-request';
import { listProfileChangeRequests } from '@/core/profile';
// r260 stage two (9583deac) — the shared approve/reject control whose Reject cannot be submitted
// without a reason, and the declaration that names each proposed field the way both screens name it.
import { ProfileChangeDecide } from '@/components/profile-change-decide';
import {
  PROFILE_REQUEST_OPTION_NAMESPACE,
  formatProposedValue,
  requestableField,
} from '@/lib/profile-requestable-fields';
import { listPendingClaims } from '@/core/claims';
import { listResignationRequests } from '@/core/offboarding';
import { listReviews, pendingManagerReviewsFor } from '@/core/employment-review';
// 5ff7daff — the approver's queue for employee replacement-leave claims, reached through the leave-pack
// facade (a core/ file may not import a pack implementation; this page reads the facade like every other
// leave surface does). The service and its decide half have existed since 296fc027 with NO caller: the
// section below is the caller they were missing, and the reason production held zero credits.
import { listPendingReplacementLeaveRequests } from '@/packs/leave/service';
import { decideReplacementLeaveRequestAction } from '@/app/leave/actions';
import { myEmployment } from '@/core/read';
import { Button, Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import {
  approveClaimAction,
  approveCorrectionAction,
  approveTravelAction,
  approveProfileChangeAction,
  decideLeaveCancellationAction,
  decideResignationAction,
  submitManagerEvaluationAction,
} from './actions';
import { ReviewDecideForm } from './review-decide-form';
import { LeaveDateBreakdown } from './leave-date-breakdown';
import { LeaveDecideControls } from './leave-decide-controls';
// 33bf1a2d: the leave-request table cells shared with My Leave → Requests (app/leave/page.tsx), so the two
// tables can no longer drift apart the way they had before this round.
import {
  LeaveAttachmentCell,
  LeaveDaysCell,
  LeaveEmployeeCell,
  LeaveTypeCell,
} from '@/components/leave/leave-request-cells';
import { durationLabel } from '@/lib/leave-duration';
import { ApprovalsSortControl } from './sort-control';
import { AttentionOnArrival } from './attention-on-arrival';
import { CategoryPanel } from './category-panel';
import { parseApprovalSort, sortApprovalRows, type ApprovalSort } from '@/lib/approvals-sort';
import {
  correctionsRowFilter,
  parseApprovalCategory,
  sectionVisible,
  type ApprovalSection,
} from '@/lib/approvals-categories';
import { decidedStatusCounts } from '@/core/approvals-summary';
import { APPROVAL_SECTION_ID, approvalRowDomId } from '@/lib/approvals-focus';
import {
  BulkSelectionProvider,
  BulkSelectAllToggle,
  BulkSectionSelectAll,
  BulkRowCheckbox,
} from './bulk-selection';
import { isOvertimeCorrection, type BulkRow, type BulkCategory } from '@/lib/approvals-bulk';
// fef49b9a — the SHARED paid/unpaid derivation. The manager's list and the employee's own history must
// not each do their own subtraction; that is how two screens come to disagree about one request.
import { leaveDisplaySplit } from '@/lib/leave-split';
import { listLeaveTypes } from '@/core/read';

/** Category-panel return params (2dec6406): every decide form carries the current category + sort so the
 *  action's redirect lands back on the SAME filtered view (success and error paths alike). */
type NavParams = { category: string; sort: string };

function NavFields({ nav }: { nav: NavParams }) {
  return (
    <>
      <input type="hidden" name="category" value={nav.category} />
      <input type="hidden" name="sort" value={nav.sort} />
    </>
  );
}

function DecideButtons({
  action,
  id,
  disabled,
  labels,
  nav,
}: {
  action: (fd: FormData) => void | Promise<void>;
  id: string;
  disabled?: boolean;
  labels: { yourRequest: string; approve: string; reject: string };
  nav: NavParams;
}) {
  if (disabled) {
    return <span className="text-xs text-muted-foreground">{labels.yourRequest}</span>;
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="approved" />
        <NavFields nav={nav} />
        <Button type="submit" size="sm">
          {labels.approve}
        </Button>
      </form>
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="rejected" />
        <NavFields nav={nav} />
        <Button type="submit" size="sm" variant="outline">
          {labels.reject}
        </Button>
      </form>
    </div>
  );
}

/** One inbox for everything awaiting a decision: leave, attendance corrections and (admin-only)
 *  profile changes. The decide authz lives in the services — this page only assembles the
 *  queues; RLS already trims each list to what the viewer may see. */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sort?: string; category?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const admin = isAdmin(s);
  const manager = (s.roles ?? []).includes('manager');
  if (!admin && !manager) redirect('/');
  const { error, sort: sortParam, category: categoryParam } = await searchParams;
  // Approvals sort (09cda965): display-only ordering, read from ?sort= so it survives reload + bulk
  // selection. Default (latest-first) matches every loader's existing desc(createdAt).
  const sort = parseApprovalSort(sortParam);
  // Category panel (2dec6406): the selected approval area. Unknown values AND admin-only categories for a
  // non-admin viewer coerce to 'all' (the full inbox — today's page, unchanged).
  const category = parseApprovalCategory(categoryParam, { admin });
  const t = await getTranslations('approvals');
  const tLeave = await getTranslations('leave'); // Emergency Leave (0106) — group label for EL child rows
  // r260 — Personnel Management's own field labels, so a proposed profile change is named in the
  // approver's queue exactly as the employee reads it on their record and HR reads it on the card.
  const tPeople = await getTranslations('people.detail');
  // r260 — the option WORDS behind a proposed select (gender, marital status, PCB category) live in the
  // namespace the employee picked them in. Resolved through the SHARED renderer so this queue and My
  // Profile cannot end up describing one request two ways.
  const tMeOptions = await getTranslations(PROFILE_REQUEST_OPTION_NAMESPACE);
  // fef49b9a — the tenant's own name for unpaid leave, resolved once for the whole page rather than per
  // row. Undefined when the tenant has no UNPAID type; leaveDisplaySplit then uses the translated label.
  const unpaidTypeName = (await listLeaveTypes(s)).find((lt) => lt.code === 'UNPAID')?.name;
  const decideLabels = {
    yourRequest: t('yourRequest'),
    approve: t('approve'),
    reject: t('reject'),
  };
  // Partial Leave Approval (0131): leave reject now requires a reason — its own label set for the textarea.
  const leaveDecideLabels = {
    approve: t('approve'),
    reject: t('reject'),
    rejectReason: t('rejectReasonPlaceholder'),
  };
  // Approvals sort (09cda965): the four option labels for the top-right Sort dropdown.
  const sortLabels = {
    sortBy: t('sortBy'),
    latest: t('sortLatest'),
    oldest: t('sortOldest'),
    name_asc: t('sortNameAsc'),
    name_desc: t('sortNameDesc'),
  } satisfies { sortBy: string } & Record<ApprovalSort, string>;

  const [leave, leaveCancellations, replacementRequests, corrections, travel, profileChanges, claims, resignations] = await Promise.all([
    // 8cb7b089 pre-fix: cap the 200-row limit over PENDING rows only. Without the status filter, a pending
    // request older than the 200 most recent rows of ANY status silently never reached this inbox — quietly
    // incomplete before, actively misleading once calendar pills deep-link straight to this section.
    listLeaveRequests(s, scopeIds, 200, { status: 'pending' }),
    listPendingLeaveCancellations(s, scopeIds),
    // 5ff7daff: same reporting-line scope as every other queue on this page; RLS trims it further.
    listPendingReplacementLeaveRequests(s, { companyIds: scopeIds }),
    listAttendanceCorrections(s, { companyIds: scopeIds, status: 'pending' }),
    // ADR-0069 Travel Request: same inbox, same decide flow.
    listTravelRequests(s, { companyIds: scopeIds, status: 'pending' }),
    admin ? listProfileChangeRequests(s, { companyIds: scopeIds, status: 'pending' }) : Promise.resolve([]),
    listPendingClaims(s),
    admin ? listResignationRequests(s, { status: 'pending' }) : Promise.resolve([]),
  ]);
  // 1e9145d4 — the kind of day each OVERTIME row is asking for, so a rest-day or public-holiday plan is
  // impossible to miss while saying no is still cheap. Resolved through scheduleFor (the same resolver the
  // clocking path uses), and ONLY for overtime rows: a clock-time correction is about punches, not about
  // what the day is worth. This is also the reason the item does NOT add escalation above four hours —
  // overtime has no second approval level, so the answer is to put the fact in front of the one approver.
  const otDayTypes = await dayTypesForPairs(
    s,
    corrections
      .filter(isOvertimeCorrection)
      .map((c) => ({ employmentId: c.employmentId, date: c.attendanceDate })),
  );
  // "Long plan": four hours or more. That is the threshold the rejected auto-escalation rule named, kept
  // as a MARKER rather than a gate — the plan's explicit decision.
  const LONG_PLAN_MINUTES = 4 * 60;

  // Employment-review queues (0110): the manager stage (assigned to the caller's own employment, even
  // without the `manager` platform role) + the HR stage (admin-only).
  const tReview = await getTranslations('review');
  const me = s.personId ? await myEmployment(s) : null;
  const [managerReviews, hrReviews] = await Promise.all([
    me?.employmentId ? pendingManagerReviewsFor(s, me.employmentId) : Promise.resolve([]),
    admin ? listReviews(s, { status: 'pending_hr' }) : Promise.resolve([]),
  ]);

  const pendingLeave = leave.filter((r) => r.status === 'pending');
  // ADR-0068 §6: eagerly fetch the per-date breakdown for each visible PENDING leave row. A non-empty result
  // means this is a per-date-approval request → render the per-date decision modal trigger instead of the
  // whole-request approve/reject. An empty result → the ordinary single control. RLS scopes each breakdown
  // to the viewer.
  const breakdowns = new Map(
    await Promise.all(
      pendingLeave.map(async (r) => [r.id, await leaveRequestDateBreakdown(s, r.id)] as const),
    ),
  );
  // Partial Leave Approval — single-request model (ADR-0068): the per-date expander's label set.
  const locale = await getLocale();
  const dateBreakdownLabels = {
    viewDateBreakdown: t('viewDateBreakdown'),
    dateBreakdown: t('dateBreakdown'),
    dateColumn: t('date'),
    dayColumn: t('dayColumn'),
    daysColumn: t('daysColumn'),
    decisionColumn: t('decisionColumn'),
    reasonColumn: t('reasonColumn'),
    approve: t('approve'),
    reject: t('reject'),
    rejectReason: t('rejectReasonPlaceholder'),
    submitDecisions: t('submitDecisions'),
    statusPending: t('dateStatus.pending'),
    statusApproved: t('dateStatus.approved'),
    statusRejected: t('dateStatus.rejected'),
    employeeRemark: t('employeeRemark'),
    closeDialog: t('closeDialog'),
  };
  const mine = (personId: string | null) => s.personId != null && personId === s.personId;
  // Partial Leave Cancellation (ADR-0065): exclude the viewer's OWN cancellation requests (self-approval ban).
  const pendingCancellations = leaveCancellations.filter((c) => !mine(c.personId));
  // 2B-1: a request may sit at a manager step or an HR step. A manager step is decidable by the
  // viewer the list already scoped to (manager/admin); an HR step only by an admin.
  // 6fadb036: a manager step reads "Manager review"; every other kind (HR, HR Manager, Payroll, Dept/BU
  // Head, Custom Role) is an admin/role-authority step and reads under the generic HR-review stage label.
  const stageLabel = (kind: string | null) =>
    kind === 'direct_manager' ? t('stageManager') : t('stageHr');
  // ADR-0069: travel can be self-filed, so self-exclude the viewer's own from the actionable count.
  const pendingTravel = travel.filter((tr) => !mine(tr.personId));
  const rm = (n: number) => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;

  // Category panel (2dec6406) — ONE population per category, taken from the SAME in-memory lists the
  // sections render (no SQL pending count anywhere), so panel badge = Pending card = section heading by
  // construction. Attendance vs Overtime is a ROW split of the one corrections list via the shared
  // isOvertimeCorrection predicate.
  const pendingCounts = {
    leave: pendingLeave.length,
    leaveCancellation: pendingCancellations.length,
    replacementLeave: replacementRequests.length,
    attendance: corrections.filter((c) => !isOvertimeCorrection(c)).length,
    overtime: corrections.filter(isOvertimeCorrection).length,
    claim: claims.length,
    travel: pendingTravel.length,
    profileChanges: profileChanges.length,
    resignations: resignations.length,
    managerReviews: managerReviews.length,
    hrReviews: hrReviews.length,
  };
  // The All badge / unfiltered header total — now INCLUDING the two review queues, so header, All badge
  // and the All Pending card are one number.
  const allPending = Object.values(pendingCounts).reduce((a, b) => a + b, 0);

  // Which sections render under the selected category; the corrections section additionally row-filters.
  const visible = (section: ApprovalSection) => sectionVisible(category, section);
  const rowFilter = correctionsRowFilter(category);

  // The three DECIDED buckets for the summary cards (approved / rejected / cancelled). Pending never comes
  // from SQL — it is the sum of the visible sections' in-memory counts below. null → the card shows a dash
  // (categories without that state, and both review queues which decide confirm/extend instead).
  const decided = await decidedStatusCounts(s, scopeIds, category);

  // Approvals sort (09cda965): order EACH per-type section's already-loaded rows in the render layer
  // (no loader ORDER BY rewrite). Sort is stable + keyed on request id, so counts/permissions/visible
  // rows are unchanged and a re-sort preserves the (bulk-approval) selection keyed by id. Each section
  // names its own createdAt / display-name fields.
  const sortedLeave = sortApprovalRows(pendingLeave, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.appliedOn });
  const sortedCancellations = sortApprovalRows(pendingCancellations, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.createdAt });
  const sortedReplacement = sortApprovalRows(replacementRequests, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.createdAt.toISOString() });
  const sortedClaims = sortApprovalRows(claims, sort, { id: (r) => r.id, name: (r) => r.claimantName, createdAt: (r) => r.createdAt });
  const sortedCorrections = sortApprovalRows(corrections, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.createdAt });
  const sortedTravel = sortApprovalRows(pendingTravel, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.createdAt });
  const sortedProfileChanges = sortApprovalRows(profileChanges, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.createdAt });
  const sortedResignations = sortApprovalRows(resignations, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.createdAt });
  const sortedManagerReviews = sortApprovalRows(managerReviews, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.createdAt });
  const sortedHrReviews = sortApprovalRows(hrReviews, sort, { id: (r) => r.id, name: (r) => r.employee, createdAt: (r) => r.createdAt });

  // Category panel (2dec6406): the corrections section is ONE shared Card, so attendance vs overtime is a
  // ROW-level filter of its already-sorted rows. Its SectionHeader count reads the filtered array so the
  // heading always equals the panel badge.
  const visibleCorrections = sortedCorrections.filter(rowFilter);

  // The header total = the sum of the VISIBLE sections' counts (the current view's pending workload). On
  // the unfiltered view this equals allPending — header, All badge and All Pending card are one number.
  const total =
    (visible('leave') ? pendingLeave.length : 0) +
    (visible('leaveCancellation') ? pendingCancellations.length : 0) +
    (visible('replacementLeave') ? replacementRequests.length : 0) +
    (visible('claims') ? claims.length : 0) +
    (visible('corrections') ? visibleCorrections.length : 0) +
    (visible('travel') ? pendingTravel.length : 0) +
    (visible('profileChanges') ? profileChanges.length : 0) +
    (visible('resignations') ? resignations.length : 0) +
    (visible('managerReviews') ? managerReviews.length : 0) +
    (visible('hrReviews') ? hrReviews.length : 0);

  // Return params every decide form posts back, so the redirect keeps the selected category + sort.
  const nav: NavParams = { category: category === 'all' ? '' : category, sort: sortParam ?? '' };

  // Bulk approval (fb99474b): which pending rows are BULK-selectable. Exactly the rows that today show a
  // single one-click approve/reject — i.e. NOT the viewer's own request, NOT a leave step gated to an
  // admin the viewer isn't, and NOT a per-date leave request (that one needs the per-date modal). Reviews,
  // profile changes and resignations are out of v1 scope (richer per-item decide flows) — no checkbox. Every
  // id here is re-checked server-side through assertCanDecide, so this is the UI filter, not the guard.
  // 2dec6406: rows come from the VISIBLE, row-FILTERED sections only — BulkSectionSelectAll keys off the
  // provider rows by type, so a filtered select-all can never touch hidden rows of the other sub-type.
  const leaveBulkActionable = (r: (typeof sortedLeave)[number]) =>
    !mine(r.personId) &&
    !(r.currentStepKind && r.currentStepKind !== 'direct_manager' && !admin) &&
    (breakdowns.get(r.id)?.length ?? 0) === 0;
  const bulkRows: BulkRow[] = [
    ...(visible('leave')
      ? sortedLeave.filter(leaveBulkActionable).map((r) => ({ id: r.id, type: 'leave' as const, category: 'leave' as const }))
      : []),
    ...(visible('leaveCancellation')
      ? sortedCancellations.map((c) => ({ id: c.id, type: 'leaveCancellation' as const, category: 'leaveCancellation' as const }))
      : []),
    ...(visible('claims')
      ? sortedClaims.filter((c) => !mine(c.personId)).map((c) => ({ id: c.id, type: 'claim' as const, category: 'claim' as const }))
      : []),
    ...(visible('corrections')
      ? visibleCorrections
          .filter((c) => !mine(c.personId))
          .map((c) => ({
            id: c.id,
            type: 'attendance' as const,
            category: (isOvertimeCorrection(c) ? 'overtime' : 'attendance') as BulkCategory,
          }))
      : []),
    ...(visible('travel')
      ? sortedTravel.map((tr) => ({ id: tr.id, type: 'travel' as const, category: 'travel' as const }))
      : []),
  ];

  // Summary card (2dec6406): dash for buckets the selected category does not have.
  const bucket = (n: number | null) => (n == null ? '—' : n);
  const summaryCards: { key: string; label: string; value: number | string }[] = [
    { key: 'pending', label: t('summaryPending'), value: total },
    { key: 'approved', label: t('summaryApproved'), value: bucket(decided.approved) },
    { key: 'rejected', label: t('summaryRejected'), value: bucket(decided.rejected) },
    { key: 'cancelled', label: t('summaryCancelled'), value: bucket(decided.cancelled) },
  ];

  return (
    <BulkSelectionProvider rows={bulkRows} sort={sortParam ?? ''} category={nav.category}>
    <div className={`mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row lg:items-start${bulkRows.length > 0 ? ' pb-24' : ''}`}>
      {/* 2dec6406: internal approval-task panel — INSIDE the page, between the main sidebar and the content.
          Sticky + independently scrollable on lg; below lg the same markup stacks above the content. */}
      <aside className="w-full shrink-0 lg:sticky lg:top-0 lg:max-h-screen lg:w-60 lg:overflow-y-auto">
        <CategoryPanel category={category} sort={sortParam} counts={pendingCounts} allCount={allPending} admin={admin} />
      </aside>
    <div className="min-w-0 flex-1 space-y-6">
      {/* 8cb7b089: on arrival at /approvals#approvals-leave(-cancellation) — the calendar pill deep-links —
          scroll to, focus, and briefly highlight the target section. Renders nothing itself. */}
      <AttentionOnArrival />
      <div data-tour="approvals-intro">
        <PageHeader
          title={t('title')}
          description={total === 0 ? t('emptyDescription') : t('pendingDescription', { total })}
          // Header actions row (09cda965): Sort dropdown sits top-right. The bulk-approval item (fb99474b)
          // drops its global "Select all" toggle INTO this same flex row, to the LEFT of the sort control.
          actions={
            <div className="flex items-center gap-3" data-approvals-header-actions>
              <BulkSelectAllToggle />
              <ApprovalsSortControl value={sort} labels={sortLabels} />
            </div>
          }
        />
      </div>
      <ErrorBanner message={error} />

      {/* 2dec6406: the four summary cards — Pending from the same in-memory lists as the badges/headings;
          Approved / Rejected / Cancelled from decidedStatusCounts, updating with the selected category. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {summaryCards.map((c) => (
          <Card key={c.key} className="p-5">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{c.value}</div>
          </Card>
        ))}
      </div>

      {/* 8cb7b089: stable section id (from the shared APPROVAL_SECTION_ID constant — the calendar pill href
          is built from the same source), scroll-mt for the floating shell, tabIndex so the arrival island
          can move focus here. data-tour stays — it drives the onboarding tour. */}
      {visible('leave') && (
      <Card
        id={APPROVAL_SECTION_ID.leave}
        tabIndex={-1}
        className="scroll-mt-24 overflow-hidden"
        data-tour="approvals-leave"
      >
        <SectionHeader title={t('leaveRequests')} count={pendingLeave.length} />
        {pendingLeave.length > 0 && (
          // R23: quick path to the team's planned absences, so an approver can check for clashes.
          <div className="flex justify-end border-b border-border px-4 py-1.5">
            <Link href="/leave" className="text-xs text-primary underline-offset-2 hover:underline">
              {t('teamCalendar')}
            </Link>
          </div>
        )}
        {pendingLeave.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingLeave')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-4 py-2">
                  <BulkSectionSelectAll type="leave" />
                </th>
                <th className="px-4 py-2 font-medium">{t('code')}</th>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('type')}</th>
                <th className="px-4 py-2 font-medium">{t('dates')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('days')}</th>
                {/* 33bf1a2d: Attachment — whether the employee filed a supporting document, so the approver
                    can open it without first drilling into the request. */}
                <th className="px-4 py-2 font-medium">{t('attachment')}</th>
                <th className="px-4 py-2 text-right font-medium" data-tour="approvals-decide">
                  {t('action')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedLeave.map((r) => (
                // a34eedde: stable per-row DOM id so the arrival island can flash the exact request
                // a calendar pill deep-linked to (hash `approvals-leave--<id>`).
                <tr key={r.id} id={approvalRowDomId(r.id)}>
                  <td className="px-4 py-2.5">{leaveBulkActionable(r) && <BulkRowCheckbox id={r.id} type="leave" />}</td>
                  <td className="px-4 py-2.5">
                    <EmployeeCode code={r.employeeCode} />
                  </td>
                  {/* 33bf1a2d: the SHARED employee cell (avatar + name), same as My Leave → Requests. The
                      /personnel link is Approval Items' own — an approver checking history — and stays. */}
                  <td className="px-4 py-2.5">
                    <LeaveEmployeeCell
                      name={r.employee}
                      href={`/personnel/${r.employmentId}`}
                      linkTitle={t('viewHistory')}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {/* 33bf1a2d: the SHARED leave-type chip. Emergency Leave (0106) — EL children are
                        ordinary ANNUAL/UNPAID requests sharing a parent_group_id; the tag rides on the
                        shared cell so both surfaces show the two halves as one EL. */}
                    <LeaveTypeCell
                      typeCode={r.typeCode}
                      typeName={r.leaveType}
                      groupLabel={r.parentGroupId ? tLeave('emergency.groupLabel') : null}
                    >
                      {/* Phase-B #13 (ADR-0062): the EA s.37 paid-allowance decision for a maternity request.
                          FALSE ⇒ the allowance was withheld → the 98-day leave is granted UNPAID (with a reason);
                          TRUE ⇒ paid; NULL on a maternity row ⇒ inputs unconfirmed → defaulted to paid.
                          Approver-only context, so it rides as a child rather than forking the shared cell. */}
                      {r.typeCode === 'MATERNITY' && (
                        <div className="mt-0.5 text-xs">
                          {r.allowanceEligible === false ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              {tLeave('maternity.allowanceWithheld', {
                                reason: tLeave(`maternity.reason.${r.maternityReason ?? 'qualifying_service'}`),
                              })}
                            </span>
                          ) : r.allowanceEligible === true ? (
                            <span className="text-muted-foreground">{tLeave('maternity.allowancePaid')}</span>
                          ) : (
                            <span className="text-muted-foreground">{tLeave('maternity.allowanceUnconfirmed')}</span>
                          )}
                        </div>
                      )}
                      {r.stepCount > 0 && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {stageLabel(r.currentStepKind)} ·{' '}
                          {t('stepOfN', { n: (r.currentStepIndex ?? 0) + 1, total: r.stepCount })}
                        </div>
                      )}
                    </LeaveTypeCell>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {r.startDate} → {r.endDate}
                    {/* R17 600be8ac ask #1: surface the applicant's own words so the approver's summary shows
                        WHY the leave was requested, not just the dates. Prefer the mandatory remark, else reason. */}
                    {(r.employeeRemark || r.reason) && (
                      <div className="mt-0.5 max-w-[16rem] whitespace-normal text-xs text-muted-foreground/80">
                        <span className="font-medium text-foreground/60">{t('employeeRemark')}:</span>{' '}
                        {r.employeeRemark || r.reason}
                      </div>
                    )}
                  </td>
                  {/* 33bf1a2d: the SHARED days cell — day count + the ADR-0048 duration label (which the
                      approver did NOT get before: a half-day request read as a bare "0.5") + the 0129
                      hourly window.
                      r80 follow-up: the applicant's remaining-balance sub-line (R23 2F-3, "13.5d left")
                      is GONE at the reporter's request — the Days column shows just the days. The balance
                      itself is untouched: it is still on the row's projection, still on the employee's
                      /personnel record one click away via the name link, and no calculation moved. */}
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    <LeaveDaysCell
                      days={r.days}
                      durationSuffix={durationLabel(tLeave, r.durationType, r.hours)}
                      durationType={r.durationType}
                      fromTime={r.fromTime}
                      toTime={r.toTime}
                      // fef49b9a — so a manager sees what they are approving BEFORE opening it. It stays
                      // ONE request with one approve action; only the day breakdown is shown.
                      splitRows={leaveDisplaySplit({
                        leaveTypeName: r.leaveType,
                        days: r.days,
                        unpaidDays: r.unpaidDays,
                        unpaidTypeName,
                        unpaidFallbackLabel: tLeave('unpaidPortionLabel'),
                      })}
                    />
                  </td>
                  {/* 33bf1a2d: Attachment. `hasDocument` is already part of the shared leave-request
                      projection in core/read.ts, so this column adds NO query and no per-row fetch. */}
                  <td className="px-4 py-2.5">
                    <LeaveAttachmentCell
                      href={r.hasDocument ? `/me/leave/attachment/${r.id}?inline=1` : null}
                      label={t('viewDocument')}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    {mine(r.personId) ? (
                      <span className="flex justify-end text-xs text-muted-foreground">{decideLabels.yourRequest}</span>
                    ) : r.currentStepKind && r.currentStepKind !== 'direct_manager' && !admin ? (
                      // 6fadb036: any non-manager step (HR / HR Manager / Payroll / Dept-BU Head / Custom Role)
                      // is an admin/role-authority gate — a plain manager viewer sees the stage, not buttons.
                      <span className="flex justify-end text-xs text-muted-foreground">{stageLabel(r.currentStepKind)}</span>
                    ) : (breakdowns.get(r.id)?.length ?? 0) > 0 ? (
                      // Partial Leave Approval — single-request model (ADR-0068): this request has per-date
                      // sub-rows → an explicit "Review dates" action (d6429eb4 renamed the LABEL only; the
                      // key `viewDateBreakdown` and the flow are untouched) opens the per-date decision
                      // MODAL (R18 7e532d23 — reporter's expected UX; one inbox row, one batch submit).
                      <div className="flex justify-end">
                        <LeaveDateBreakdown
                          requestId={r.id}
                          dates={breakdowns.get(r.id)!}
                          locale={locale}
                          remark={r.employeeRemark || r.reason}
                          labels={dateBreakdownLabels}
                          nav={nav}
                        />
                      </div>
                    ) : (
                      // Ordinary request (no per-date rows): one approve/reject control (reject requires a reason).
                      <LeaveDecideControls id={r.id} labels={leaveDecideLabels} nav={nav} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      )}

      {/* Partial Leave Cancellation (ADR-0065): pending employee requests to give back a subset of approved
          leave dates. Each card shows the ORIGINAL dates, the date(s) to cancel (highlighted), the remaining
          dates, days, and reason, with Approve/Reject. Self-requests are excluded above (self-approval ban). */}
      {visible('leaveCancellation') && (
      <Card id={APPROVAL_SECTION_ID.leaveCancellation} tabIndex={-1} className="scroll-mt-24 overflow-hidden">
        <SectionHeader title={t('leaveCancellationTitle')} count={pendingCancellations.length} />
        {pendingCancellations.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingCancellations')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-4 py-2">
                  <BulkSectionSelectAll type="leaveCancellation" />
                </th>
                <th className="px-4 py-2 font-medium">{t('code')}</th>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('type')}</th>
                <th className="px-4 py-2 font-medium">{t('originalDates')}</th>
                <th className="px-4 py-2 font-medium">{t('datesToCancel')}</th>
                <th className="px-4 py-2 font-medium">{t('remainingDates')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('days')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedCancellations.map((c) => (
                // a34eedde: same per-row DOM id convention for cancellation rows (hash
                // `approvals-leave-cancellation--<cancellationId>`).
                <tr key={c.id} id={approvalRowDomId(c.id)}>
                  <td className="px-4 py-2.5">
                    <BulkRowCheckbox id={c.id} type="leaveCancellation" />
                  </td>
                  <td className="px-4 py-2.5">
                    <EmployeeCode code={c.employeeCode} />
                  </td>
                  {/* 33bf1a2d (r80 follow-up): the leave-CANCELLATION queue was left on the pre-r77 look —
                      a bare bold name and plain type text — while the leave-request table directly above it
                      had been restyled. Both queues now render the SAME shared cells, so the two tables on
                      this one screen match and can no longer drift apart. */}
                  <td className="px-4 py-2.5">
                    <LeaveEmployeeCell
                      name={c.employee}
                      href={`/personnel/${c.employmentId}`}
                      linkTitle={t('viewHistory')}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {/* A cancellation row carries no parent_group_id, so no Emergency Leave (0106) tag —
                        the chip + icon are the same palette (styleFor) as every other leave surface. */}
                    <LeaveTypeCell typeCode={c.typeCode} typeName={c.leaveType} />
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {c.originalStart} → {c.originalEnd}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {c.cancelDates.map((d) => (
                        <span
                          key={d}
                          className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                    {c.reason && <div className="mt-1 text-xs text-muted-foreground">{c.reason}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                    {c.remainingDates.length > 0 ? c.remainingDates.join(', ') : '—'}
                  </td>
                  {/* The SHARED days cell. A cancellation has no duration type / hourly window of its own
                      (it gives back whole dates off an approved request), so it renders the day count and
                      nothing else — the same as every other Days column on this screen. */}
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    <LeaveDaysCell days={c.requestedDays} />
                  </td>
                  <td className="px-4 py-2.5">
                    <DecideButtons action={decideLeaveCancellationAction} id={c.id} labels={decideLabels} nav={nav} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      )}

      {/* 5ff7daff — REPLACEMENT LEAVE REQUESTS. The queue that did not exist: `decideReplacementLeaveRequest`
          shipped in 296fc027 with no caller anywhere, so an employee's claim was submitted and then sat
          unseen, and not one credit was ever minted in production. This section is that caller.

          It sits in the Leave group beside the other two leave queues because that is where an approver
          looks, and it is deliberately NOT bulk-selectable: every other bulk kind is a single fact to accept
          or refuse, while a replacement claim is a LIST OF WORKED DATES whose whole point is that they are
          checked line by line. Approving here mints one credit per worked date with the expiry counted from
          this decision — see core/replacement-request.ts. */}
      {visible('replacementLeave') && (
      <Card className="overflow-hidden">
        <SectionHeader title={t('replacementLeaveTitle')} count={replacementRequests.length} />
        {replacementRequests.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingReplacement')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('code')}</th>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('replacementDatesWorked')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('days')}</th>
                <th className="px-4 py-2 font-medium">{t('reason')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedReplacement.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5">
                    <EmployeeCode code={r.employeeCode} />
                  </td>
                  <td className="px-4 py-2.5">
                    <LeaveEmployeeCell
                      name={r.employee}
                      href={`/personnel/${r.employmentId}`}
                      linkTitle={t('viewHistory')}
                    />
                  </td>
                  {/* Every worked date, with its own figure — the reporter asked to see the claim line by
                      line, and a manager approving time already worked has to be able to check each one. */}
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      {r.dates.map((d) => (
                        <span key={d.workedDate} className="tabular-nums text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">{d.workedDate}</span>
                          {d.fromTime && d.toTime ? ` · ${d.fromTime.slice(0, 5)} → ${d.toTime.slice(0, 5)}` : ''}
                          {' · '}
                          {r.unit === 'hour'
                            ? `${(d.hours ?? 0).toFixed(2)} ${tLeave('breakdown.replacement.unitHour')}`
                            : `${(d.days ?? 0).toFixed(2)} ${tLeave('breakdown.replacement.unitDay')}`}
                        </span>
                      ))}
                    </div>
                  </td>
                  {/* The banked figure is ALWAYS days — an Hour request is converted over the standard day by
                      the service — so the hour total rides alongside rather than replacing it. */}
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    <div className="font-medium">{r.totalDays.toFixed(2)}</div>
                    {r.unit === 'hour' && (
                      <div className="text-xs text-muted-foreground">
                        {r.totalHours.toFixed(2)} {tLeave('breakdown.replacement.unitHour')}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.reason ?? '\u2014'}</td>
                  <td className="px-4 py-2.5">
                    {mine(r.personId) ? (
                      <span className="flex justify-end text-xs text-muted-foreground">{decideLabels.yourRequest}</span>
                    ) : (
                      // Posts to decideReplacementLeaveRequestAction — the action that had no caller. It takes
                      // `requestId` (not the `id` DecideButtons posts), and `returnTo` is read BY VALUE so the
                      // decision lands back on this filtered inbox rather than on My Leave (AGENTS.md rule 17).
                      <div className="flex items-center justify-end gap-2">
                        <form action={decideReplacementLeaveRequestAction}>
                          <input type="hidden" name="requestId" value={r.id} />
                          <input type="hidden" name="decision" value="approved" />
                          <input type="hidden" name="returnTo" value="approvals" />
                          <NavFields nav={nav} />
                          <Button type="submit" size="sm">
                            {decideLabels.approve}
                          </Button>
                        </form>
                        <form action={decideReplacementLeaveRequestAction}>
                          <input type="hidden" name="requestId" value={r.id} />
                          <input type="hidden" name="decision" value="rejected" />
                          <input type="hidden" name="returnTo" value="approvals" />
                          <NavFields nav={nav} />
                          <Button type="submit" size="sm" variant="outline">
                            {decideLabels.reject}
                          </Button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      )}

      {visible('claims') && (
      <Card className="overflow-hidden">
        <SectionHeader title={t('claims')} count={claims.length} />
        {claims.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingClaims')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-4 py-2">
                  <BulkSectionSelectAll type="claim" />
                </th>
                <th className="px-4 py-2 font-medium">{t('code')}</th>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('type')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('amount')}</th>
                <th className="px-4 py-2 font-medium">{t('dates')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedClaims.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5">{!mine(c.personId) && <BulkRowCheckbox id={c.id} type="claim" />}</td>
                  <td className="px-4 py-2.5">
                    <EmployeeCode code={c.employeeCode} />
                  </td>
                  <td className="px-4 py-2.5 font-medium">{c.claimantName}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {c.typeName}
                    {c.attachments.map((a) => (
                      <a key={a.id} href={`/claims/attachment/${a.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="ml-2 text-xs text-primary underline-offset-2 hover:underline">
                        ↗ {t('receipt')}
                      </a>
                    ))}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(c.amount)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{c.incurredOn}</td>
                  <td className="px-4 py-2.5">
                    <DecideButtons action={approveClaimAction} id={c.id} disabled={mine(c.personId)} labels={decideLabels} nav={nav} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      )}

      {/* 2dec6406: ONE shared section for clock-time corrections AND overtime — the attendance / overtime
          panel entries row-filter it (visibleCorrections), and the heading count reads the filtered array
          so heading = badge. */}
      {visible('corrections') && (
      <Card className="overflow-hidden" data-tour="approvals-corrections">
        <SectionHeader title={t('attendanceCorrections')} count={visibleCorrections.length} />
        {visibleCorrections.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingCorrections')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-4 py-2">
                  <BulkSectionSelectAll type="attendance" />
                </th>
                <th className="px-4 py-2 font-medium">{t('code')}</th>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('date')}</th>
                <th className="px-4 py-2 font-medium">{t('proposed')}</th>
                <th className="px-4 py-2 font-medium">{t('reason')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleCorrections.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5">{!mine(c.personId) && <BulkRowCheckbox id={c.id} type="attendance" />}</td>
                  <td className="px-4 py-2.5">
                    <EmployeeCode code={c.employeeCode} />
                  </td>
                  <td className="px-4 py-2.5 font-medium">{c.employee}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{c.attendanceDate}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {c.proposedCheckIn
                      ? `${c.proposedCheckIn.slice(0, 5)}${c.proposedCheckOut ? ` → ${c.proposedCheckOut.slice(0, 5)}` : ''}`
                      : ''}
                    {c.requestedOtMinutes != null
                      ? `${c.proposedCheckIn ? ' · ' : ''}${t('otHoursLabel')} ${(c.requestedOtMinutes / 60).toFixed(1)}h`
                      : ''}
                    {/* 1e9145d4 — the two facts an overtime approver must not have to work out for
                        themselves. An ordinary working day gets no chip: a marker on everything marks
                        nothing. No new section, no new column — this rides in the Proposed cell that
                        already carries the hours. */}
                    {c.requestedOtMinutes != null && (
                      <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
                        {otDayTypes.get(`${c.employmentId}|${c.attendanceDate}`) === 'rest_day' && (
                          <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                            {t('otDayRestDay')}
                          </span>
                        )}
                        {otDayTypes.get(`${c.employmentId}|${c.attendanceDate}`) === 'holiday' && (
                          <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-400">
                            {t('otDayHoliday')}
                          </span>
                        )}
                        {c.requestedOtMinutes >= LONG_PLAN_MINUTES && (
                          <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-400">
                            {t('otLongPlan')}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.reason ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <DecideButtons
                      action={approveCorrectionAction}
                      id={c.id}
                      disabled={mine(c.personId)}
                      labels={decideLabels}
                      nav={nav}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      )}

      {/* ADR-0069 Travel Requests */}
      {visible('travel') && (
      <Card className="overflow-hidden" data-tour="approvals-travel">
        <SectionHeader title={t('travelRequests')} count={pendingTravel.length} />
        {pendingTravel.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingTravel')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-4 py-2">
                  <BulkSectionSelectAll type="travel" />
                </th>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('dates')}</th>
                <th className="px-4 py-2 font-medium">{t('reason')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedTravel.map((tr) => (
                <tr key={tr.id}>
                  <td className="px-4 py-2.5">
                    <BulkRowCheckbox id={tr.id} type="travel" />
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    {/* Employee ID left-of-name (feedback 38668d9b) */}
                    <EmployeeCode code={tr.employeeCode} className="mr-1.5" />
                    {tr.employee}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {tr.travelFrom} → {tr.travelTo}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{tr.remarks}</td>
                  <td className="px-4 py-2.5">
                    <DecideButtons
                      action={approveTravelAction}
                      id={tr.id}
                      disabled={mine(tr.personId)}
                      labels={decideLabels}
                      nav={nav}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      )}

      {admin && visible('profileChanges') && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('profileChanges')} count={profileChanges.length} />
          {profileChanges.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingChanges')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {sortedProfileChanges.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {/* Employee ID left-of-name (feedback 38668d9b) */}
                      {r.employeeCode && <EmployeeCode code={r.employeeCode} className="mr-1.5" />}
                      {r.employee}
                    </div>
                    {/* r260 stage two — each proposed field named by the SAME people.detail catalogue
                        key the employee reads it under on their own record and HR reads it under on the
                        Personnel card (lib/profile-requestable-fields.ts). It used to print the raw
                        jsonb key: "bankAccountNo → 5566778899". With the widened field set that would
                        have been twenty-four raw keys an approver had to translate in their head, and
                        every select among them would have read as its stored code. */}
                    {/* ONE FIELD PER LINE, for the same reason /admin/personnel is: the option labels
                        an employee picks from contain ' · ' themselves ("2 · Married, spouse not
                        working"), so joining the pairs with it made one field read as two. */}
                    <div className="text-xs text-muted-foreground">
                      {Object.entries((r.proposed ?? {}) as Record<string, unknown>).map(([k, v]) => {
                        const f = requestableField(k);
                        // mask: false — the approver is checking the proposed account number against a
                        // bank letter; the EMPLOYEE's own screen is the one that masks it.
                        const line = f
                          ? `${tPeople(f.labelKey)} → ${formatProposedValue(f, v, tMeOptions, { mask: false })}`
                          : `${k} → ${v}`;
                        return <div key={k}>{line}</div>;
                      })}
                    </div>
                  </div>
                  <ProfileChangeDecide
                    action={approveProfileChangeAction}
                    requestId={r.id}
                    idFieldName="id"
                    disabled={mine(r.personId)}
                    labels={{ ...decideLabels, reasonPlaceholder: t('rejectReasonPlaceholder') }}
                    hidden={<NavFields nav={nav} />}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {admin && visible('resignations') && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('resignations')} count={resignations.length} />
          {resignations.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingResignations')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('code')}</th>
                  <th className="px-4 py-2 font-medium">{t('employee')}</th>
                  <th className="px-4 py-2 font-medium">{t('lastWorkingDay')}</th>
                  <th className="px-4 py-2 font-medium">{t('reason')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedResignations.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5">
                      <EmployeeCode code={r.employeeCode} />
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      <Link
                        href={`/personnel/${r.employmentId}`}
                        className="underline-offset-2 hover:text-primary hover:underline"
                        title={t('viewHistory')}
                      >
                        {r.employee}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.lastWorkingDay}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {r.reason ?? '—'}
                      {/* #42cff598: one "View document" link per attached supporting document (RLS-scoped). */}
                      {r.documents.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          {r.documents.map((d) => (
                            <a
                              key={d.id}
                              href={`/me/resignation/attachment/${d.id}?inline=1`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-primary underline-offset-2 hover:underline"
                              title={d.fileName}
                            >
                              {t('viewDocument')}
                            </a>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <DecideButtons
                        action={decideResignationAction}
                        id={r.id}
                        disabled={mine(r.personId)}
                        labels={decideLabels}
                        nav={nav}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* Employment review — manager stage (0110). Visible to the assigned Direct Manager (even without
          the `manager` platform role) and to admins. */}
      {visible('managerReviews') && (
      <Card className="overflow-hidden">
        <SectionHeader title={tReview('managerStage')} count={managerReviews.length} />
        {managerReviews.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{tReview('noManagerReviews')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {sortedManagerReviews.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center">
                    {/* Employee ID left-of-name (feedback 38668d9b) */}
                    {r.employeeCode && <EmployeeCode code={r.employeeCode} className="mr-1.5" />}
                    <Link href={`/personnel/${r.employmentId}`} className="font-medium underline-offset-2 hover:text-primary hover:underline">
                      {r.employee}
                    </Link>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tReview(`reviewType.${r.reviewType}` as 'reviewType.probation')} · {tReview('dueDate')} {r.dueDate}
                  </span>
                </div>
                <form action={submitManagerEvaluationAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="id" value={r.id} />
                  <NavFields nav={nav} />
                  <label className="text-xs text-muted-foreground">
                    {tReview('recommendation.label')}
                    <select name="recommendation" required className={`${inputCls} mt-1`}>
                      <option value="recommend_confirm">{tReview('recommendation.recommend_confirm')}</option>
                      <option value="recommend_extend">{tReview('recommendation.recommend_extend')}</option>
                      <option value="recommend_terminate">{tReview('recommendation.recommend_terminate')}</option>
                    </select>
                  </label>
                  <input name="comments" placeholder={tReview('managerComments')} className={`${inputCls} flex-1`} />
                  <Button type="submit" size="sm">
                    {tReview('submitEvaluation')}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
      )}

      {/* Employment review — HR decision stage (0110, admin-only). */}
      {admin && visible('hrReviews') && (
        <Card className="overflow-hidden">
          <SectionHeader title={tReview('hrStage')} count={hrReviews.length} />
          {hrReviews.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-muted-foreground">{tReview('noHrReviews')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {sortedHrReviews.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="flex items-center">
                      {/* Employee ID left-of-name (feedback 38668d9b) */}
                      {r.employeeCode && <EmployeeCode code={r.employeeCode} className="mr-1.5" />}
                      <Link href={`/personnel/${r.employmentId}`} className="font-medium underline-offset-2 hover:text-primary hover:underline">
                        {r.employee}
                      </Link>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {tReview(`reviewType.${r.reviewType}` as 'reviewType.probation')}
                    </span>
                  </div>
                  {r.managerRecommendation && (
                    <div className="mb-2 text-xs text-muted-foreground">
                      {tReview('recommendation.label')}: {tReview(`recommendation.${r.managerRecommendation}` as 'recommendation.recommend_confirm')}
                      {r.managerComments ? ` · ${r.managerComments}` : ''}
                    </div>
                  )}
                  {/* R4 Build #4: progressive-disclosure HR-decision form — selecting Confirm / Extend /
                      Terminate reveals only that decision's fields. Advisory (records decision + letter). */}
                  <ReviewDecideForm reviewId={r.id} nav={nav} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
    </div>
    </BulkSelectionProvider>
  );
}
