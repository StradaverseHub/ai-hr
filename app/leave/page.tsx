// r397 — the page's reads, started together (app/leave/my-leave-data.ts documents each one and the graph).
import { loadMyLeave } from './my-leave-data';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { viewerEmployment } from '@/lib/viewer';
import {
  leaveRequestDateBreakdown,
  myEmploymentIdsAll,
  listEmployees,
  listLeaveTypes,
  listLeaveRequestsPage,
  // ad965821 — the eligibility-filtered apply source for the viewer's own dropdown. Its multi-employment
  // sibling, and the reporting-lines read that used to decide who got an Employee selector, both left with
  // 5206539f: the selector is a named permission now, not a shape of the org chart.
  listEligibleLeaveTypesFor,
  // r301 (83511d3b) — Cancel Approved Leave: THE button predicate (shared with the Team Leave Tracker) and the
  // Pending Cancellation progress on the viewer's own records.
  employeeCancelOffers,
  pendingCancellationProgress,
} from '@/core/read';
// 5f2e20fb — the SAME filter control the three HR leave screens use, on the employee's own history box.
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
// 5206539f — `leave.apply_on_behalf` is resolved by the SAME function requestLeave's own gate calls
// (canApplyLeaveOnBehalf, asked in ./my-leave-data.ts since r397), so the selector below and the refusal in the
// service can never answer differently.
import { todayInKualaLumpur } from '@/core/leave';
import { isReplacementLeaveType, pickReplacementLeaveType } from '@/core/ess-view';
// r302 (6c9802c9) — My Leave dashboard: the per-leave-year figures, Upcoming Leave, and the names of the people
// who decide the viewer's OWN requests (migration 0472). Every figure is a pick in core/my-leave.ts.
import {
  myUpcomingLeave,
  ownLeaveApprovalTrails,
  ownLeaveCancellations,
  ownLeaveRejections,
} from '@/core/my-leave';
import { MyLeaveDashboard, type MyLeaveDashboardCard } from '@/components/leave/my-leave-dashboard';
import { UpcomingLeave, type UpcomingLeaveRow } from '@/components/leave/upcoming-leave';
import {
  LEAVE_HISTORY_TABS,
  applicationDateOutcomeRows,
  approvalProgress,
  approverKindLabelKey,
  approverLine,
  cancellationLines,
  isPartiallyApproved,
  resolveHistoryTab,
  type HistoryLineDeps,
  type LeaveHistoryTab,
} from '@/lib/my-leave-history';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import { Card, PageHeader } from '@/components/ui';
// 388e53c2 — the Employee Details listing, its left-side rail, its filter panel and the People status
// vocabulary all LEFT this page with the HR-admin inquiry surface. They live on app/leave/tracker/page.tsx
// now, which is the Team Leave Tracker row the reporter asked to enter them from. Nothing was deleted:
// the listing is the same code with its base path repointed. (Naming the moved components literally here
// would defeat the guards that assert none of them survived on this page — prose is not exempt.)
// 33bf1a2d: the leave-request table cells this table used to spell out inline, now SHARED with the
// Approval Items leave table (app/approvals/page.tsx) so the two can no longer drift apart.
import { LeaveDaysCell, LeaveEmployeeCell, LeaveTypeCell } from '@/components/leave/leave-request-cells';
import { CancelDatesDialog } from '@/components/leave/cancel-dates-dialog';
import { EditLeaveDialog } from '@/components/leave/edit-leave-dialog';
import { CancelLeaveDialog } from '@/components/leave/cancel-leave-dialog';
import { RequestLeaveDialog } from '@/components/leave/request-leave-dialog';
// 296fc027 — the employee replacement-leave request: the button beside "+ Request Leave" and the action it posts
// to. The availability read that decides whether to offer it is asked in ./my-leave-data.ts (r397).
import { ReplacementLeaveRequestDialog } from '@/components/leave/replacement-leave-request-dialog';
// r343 — the dialog's body is the single Leave Credit table, and it posts to that table's own action.
// r389 (ba039150) — the dialog is now the ONLY entry point to that form: `/leave/credit` lost its second copy
// and became Leave Credit History. The two actions still live beside it, in ./credit/actions, because the
// Leave Credit actions (submit, the per-date facts, and the history's Cancel) are one module; the submit
// lands back HERE with the confirmation.
import { leaveCreditDayFactsAction, submitLeaveCreditRequestAction } from './credit/actions';
// r219 (7966ee35) — …and, when that availability read says NO, the sentence saying why. The read has always
// carried a discriminated reason; this page rendered the boolean and dropped it, so the reporter spent a
// round changing Leave config settings against a cause that sits above Leave config.
import { ReplacementAvailabilityNotice } from '@/components/leave/replacement-availability-notice';
import { LeaveDateOutcome } from '@/components/leave/leave-date-outcome';
// My Leave History — tabs, one row per request, and the slide-out View panel (657962ec, reshaped by r302).
import { LeaveHistoryCards, type LeaveHistoryEntry } from '@/components/leave/leave-history-cards';
// Shared Leave Group display (feedback 46afcc48): the pooled allowance several leave types draw on, drawn
// as ONE balance, independent of each member type's own placement. r302: a tile in the dashboard grid. Read
// by sharedLeaveGroupBalances in ./my-leave-data.ts (r397).
// r341 (8d3a7bff) — which leave-type card a shared group's ceiling belongs on, decided in one pure place.
import { planSharedGroupCeilings } from '@/lib/shared-leave-pool';
import { durationLabel } from '@/lib/leave-duration';
// 46afcc48 — the shared-group context lines interpolate day figures, and a day figure is printed one way
// in this repo (4a1abc4a). Interpolating a raw Number would print "10" beside the card's "9.00".
import { formatDays } from '@/lib/day-format';
// fef49b9a — ONE derivation of the paid/unpaid breakdown, shared with the other three surfaces.
import { leaveDisplaySplit } from '@/lib/leave-split';
import { LEAVE_STATUS_PILL, LEAVE_STATUS_PILL_DEFAULT } from '@/lib/leave-status';
import {
  requestLeaveAction,
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

// afd0a87c — LEAVE_STATUSES / LEAVE_DURATIONS / PENDING_STAGES were the whitelists for the retired
// request table's status, Days-column and "Pending with" filters. They narrowed a tampered query value to
// nothing before it could reach SQL; with no filter left to tamper with, they have no subject. The same
// vocabularies still live where the reads use them (core/read.ts listLeaveRequestsPage, ADR-0048).

// r302 (6c9802c9) — the "My balances" card (its collapsible section, its leave_balance_open cookie and its
// As-at form), the "Other leave types" card and the two-column grid that paired it with the history are GONE.
// The page is one column now: the Year and Apply Leave, the leave balance dashboard, Upcoming Leave, then My
// Leave History across the full width. The "As at" date is replaced by the Year selector.

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
    // 388e53c2 - `emp` and the `ed*` listing params went to app/leave/tracker/page.tsx WITH the Employee
    // Details listing that read them. Declaring a param nothing on this page reads would advertise a
    // filter that silently does nothing. Their PREFIX is unchanged over there, so every admin link
    // already saved keeps working against its new base path.
    // r302 (6c9802c9) — the LEAVE YEAR the dashboard shows. Not `year`: that name is already the holiday
    // warning banner's (see `warnHoliday` above). Narrowed to an offered year in core/my-leave.ts; anything
    // else is the current year. It replaces R37's `asOf`, which went with the My balances card.
    leaveYear?: string;
    // 2166ef79 — the date the Request Leave dialog OPENS ON. My Attendance offers "request leave instead"
    // on an absent day and sends the employee here with `?apply=1&start=YYYY-MM-DD`, so the absent date is
    // carried across rather than retyped. `apply=1` (a46fe0c0) already opens the dialog; this fills it in.
    // Read here rather than inside the dialog because `startDefault` is already a prop it takes — the
    // alternative was a second dialog, which the plan explicitly rules out.
    start?: string;
    // ── My Leave History filter (5f2e20fb) ────────────────────────────────────────────────────────
    // DELIBERATELY PREFIXED `h`, and this is the whole reason the prefix exists. The retired org-wide
    // register owned bare `from` / `to` / `type` on this very path (see the afd0a87c note above), and
    // admin links carrying them are still saved in people's browsers — reading them here would apply a
    // filter nobody asked for from a link that used to mean something else. `start` is likewise already
    // taken, by the Request Leave deep-link two fields up. `hType` repeats (multi-select tick-list).
    hFrom?: string;
    hTo?: string;
    hType?: string | string[];
    // r302 — the history tab: pending | approved | rejected | cancelled (lib/my-leave-history.ts).
    hTab?: string;
    /**
     * 76dbcaa1 — the leave type a named Apply action asked to open the Request Leave form on.
     *
     * ⚠️ `applyType`, NOT `type`. The retired admin register owned bare `from`/`to`/`type` on THIS path,
     * and test/leave-filter-panel.test.ts keeps them inert so a saved admin link cannot quietly start
     * filtering — or, here, quietly start preselecting a leave type. The prefix is the whole point of
     * that rule and it applies to a new parameter exactly as it applies to an old one.
     */
    apply?: string;
    applyType?: string;
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
  if (!sp.apply && !sp.applyType && ['hTab', 'hType', 'hFrom', 'hTo'].some((key) => key in sp)) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(sp)) for (const one of Array.isArray(value) ? value : value ? [value] : []) query.append(key, one);
    redirect(`/leave/history?${query}`);
  }
  // R37 e5a158d3: the balance view is the viewer's OWN detailed table (was an all-employee pivot). Resolved
  // BEFORE anything else because it is what decides whether this page has a subject at all.
  // r397 — through `viewerEmployment` (lib/viewer.ts), the React `cache()`d seam over THIS SAME read: the root
  // layout's notice slot asks it with the same per-request session object, so one request now pays for the
  // employment lookup once instead of twice. Same function, same argument, same row.
  const me = await viewerEmployment(session);

  // ── The short page (feedback 388e53c2) ───────────────────────────────────────────────────────────────
  // TWO viewers get the heading and one sentence instead of the self-service surface, and NONE of the
  // reads below run for either of them — this is an early return, not a hidden block.
  //
  //   * ANY account not linked to an employee profile. That is a fix, not a removal: every read on this
  //     page is keyed by `me.employmentId`, so an unlinked viewer used to get empty balance cards, an
  //     empty history and a live "+ Request Leave" button that could not possibly work. The sentence is
  //     me.notLinked — the one /me has shown for exactly this condition, in all six languages, since long
  //     before this item. Reused verbatim rather than reworded, so the product says one thing once.
  //
  //   * An HR ADMINISTRATOR. Feedback 8ec63139 already took their own balances, their own history and
  //     Request Leave off this page; 388e53c2 takes the employee lookups off it too, because those are
  //     the Team Leave Tracker row now. What is left is the heading, so an administrator who DOES have an
  //     employment record is pointed at where the lookups went rather than shown a blank page.
  if (me == null || admin) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('myAbsenceTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {me == null ? tMe('notLinked') : t('inquiryMovedToTracker')}
          </p>
        </Card>
      </div>
    );
  }

  // Everything from here down is the SELF-SERVICE page, and `admin` is necessarily false past the return
  // above. The ess and not-admin guards below are 8ec63139's and are deliberately left standing: they are
  // the recorded contract for who sees their own figures here, and this item does not reopen it.
  //
  // NOTE FOR THE NEXT EDITOR: do not quote those guards' JSX literally in a comment on this file. Several
  // tests slice this page at the first occurrence of that opening guard, and a quoted copy above the real
  // one silently inverts the slice — which is how this very comment was first written, and how it failed.
  // Partial Leave Cancellation (ADR-0065 / R5 Build #2): the candidate dates for a row's Cancel-dates pop-up are
  // the row's REAL working dates (roster + holiday aware, resolved server-side in core/read.ts). r301 (83511d3b):
  // WHETHER the button appears and WHICH dates it offers are now decided by core/read.ts employeeCancelOffers —
  // the leave type's own rule (switch, per-date notice), the unpaid-day refusal and the row shape, through the
  // SAME predicate the Team Leave Tracker uses — instead of a "strictly after today" filter here. The service
  // still re-validates every posted date authoritatively.

  const locale = await getLocale();
  // r397 — EVERY READ BELOW IS MADE BY ONE LOADER, app/leave/my-leave-data.ts, which starts the independent ones
  // together instead of one after another. The calls themselves — which function, with which arguments, gated
  // on what — are unchanged and are documented there, read for read, with the dependency graph between them.
  // This page keeps every derivation it always made from their results; it no longer makes the reads.
  const {
    employees,
    leaveTypes,
    eligibleLeaveTypes,
    canApplyOnBehalf,
    replacementRequest,
    leaveCreditOffer,
    dashboard,
    leaveYearAsOf,
    replacementLedger,
    replacementRequests,
    sharedGroupBalances,
    upcoming,
    historyFilterParams,
  } = await loadMyLeave({ session, scopeIds, me, sp, locale, today });
  // Sort ONCE, at the source: every consumer on this page maps off one of these two arrays (the
  // request-leave dialog options, the two edit-leave dialog lists), so one sort makes them agree instead of
  // one popup being ordered and another not. NOT pushed into core/read.ts listLeaveTypes — the admin master
  // listing has its own ordering. r397: the sort is made in the loader, the moment the reads return and before
  // anything consumes them — the same `byName` comparator, so both arrays arrive here already ordered.
  // fef49b9a — the tenant's OWN name for unpaid leave, so the breakdown says what their catalogue says.
  // Matched on the UNPAID code, which is the same lookup core/leave.ts already uses for the Emergency
  // decomposition (core/leave.ts:3480). The approved plan asked for the leave-type ROLE marker instead,
  // but LeaveTypeRoleValue has no `unpaid` member — noted rather than silently diverging. Undefined when
  // the tenant has no such type, in which case leaveDisplaySplit falls back to a translated label.
  const unpaidTypeName = leaveTypes.find((lt) => lt.code === 'UNPAID')?.name;
  const active = employees.filter((e) => !e.terminatedOn);

  // ad965821 — membership test for the Edit box's union below, and the self-service half of the offer set.
  const eligibleTypeIds = new Set(eligibleLeaveTypes.map((lt) => lt.id));
  // Employee selector visibility (item 69088c13; the deciding question REPLACED by 5206539f): only an
  // on-behalf applicant needs to pick WHO the leave is for, and who that is is now A NAMED PERMISSION.
  //
  // WHAT THIS REPLACES, AND WHY BOTH HALVES HAD TO GO. The question used to be
  // a reporting-lines read — "does anyone report to you", counted off the viewer's direct reports. That is
  // not a permission, it is an accident of the org chart; and the list it opened was built from `active`
  // (every employee in the viewer's scope), not from those reports, so a line manager was offered people who
  // did not report to him at all. A line manager now holds nothing by virtue of being one: no selector, and
  // Request Leave files for them. A customer who wants a particular role to file on behalf grants
  // `leave.apply_on_behalf` to it (lib/payroll-permissions.ts), which needs no deploy.
  //
  // THIS READ IS THE COURTESY, NOT THE CONTROL. core/leave.ts requestLeave resolves the SAME permission
  // through the SAME function and throws LeaveOnBehalfNotAllowedError for any subject the caller may not act
  // for, so a hand-crafted post is refused whatever this screen chose to render.
  //
  // Company-scoped: an override row may be granted for one company of a group, so the viewer's OWN company
  // (off the already-loaded employee list — `me` does not carry the id) is what this question is asked in.
  // r397: asked by the loader as `canApplyLeaveOnBehalf(session, myCompanyId)`, myCompanyId being
  // `active.find((e) => e.employmentId === me.employmentId)?.companyId ?? null` over the same employee list.
  // WHO a holder may pick: everyone in their scope, with THE VIEWER LEADING THE LIST. That ordering is the
  // one ad965821 rule that survives — LeaveDurationFields defaults employmentId to the first option, so
  // without it a holder opening Request Leave would be applying for whoever `listEmployees` returned first
  // before touching anything.
  //
  // 5206539f — the per-subject narrowing that used to sit here is DELETED, not adapted: the extra read
  // that resolved an eligible-type map for every selectable employment, the filter that dropped anyone
  // with an empty eligible set, and the fallback that added the viewer back when that filter had removed
  // them. Every line of it existed to make a LINE MANAGER's list of reports behave, and there is no such
  // list any more. What is left is one subject on the self-service path — the viewer — whose own eligible
  // set is `eligibleLeaveTypes` and can never be empty while the trigger below renders.
  const requestLeaveEmployeeOptions = [
    ...active.filter((e) => e.employmentId === me.employmentId),
    ...active.filter((e) => e.employmentId !== me.employmentId),
  ].map((e) => ({ id: e.employmentId, name: e.name }));

  // Request Leave (feedback 48e69709): the apply form moved from a collapsed Card at the page bottom into a
  // modal launched from a "+" primary button in the PageHeader. These are the exact props the form used to
  // compute inline — mapped here in the RSC (t() runs server-side) and handed to the client dialog.
  //
  // ad965821 — MAPPED OFF THE ELIGIBLE SET, not the catalogue. A male employee has no Maternity row here at
  // all; an unmarried one has no Paternity row. Nothing on the screen indicates a row was removed, which is
  // the reporter's explicit ask: a hint that a leave type exists is the thing they said must not happen.
  //
  // 5206539f — AND THAT SET IS THE VIEWER'S OWN AGAIN. ad965821 rev 2 widened this to the UNION of every
  // subject a line manager could pick, because LeaveDurationFields intersects `types` with the selected
  // subject's set and a viewer-only array made the on-behalf offer eligible(manager) ∩ eligible(report).
  // With the manager's selector gone, the self-service path has exactly one subject — the viewer — so the
  // union and the intersection both collapse to `eligibleLeaveTypes`, which is what this maps.
  //
  // WHAT A PERMISSION HOLDER GETS, STATED SO IT IS NOT REDISCOVERED AS A BUG: they are offered THEIR OWN
  // eligible types for whoever they pick, and requestLeave still runs assertEligible against the SUBJECT, so
  // a type the subject does not qualify for is refused rather than filed. Widening the offer per selected
  // subject is the deleted machinery above; if a customer grants this key and needs it back, that is a
  // deliberate re-build with its own ticket, not something to leave standing "just in case".
  //
  // THE SAME LIMIT IS WRITTEN WHERE THE KEY IS DECLARED (lib/payroll-permissions.ts), because that is where
  // an operator decides to grant it — and it bites ONLY once a non-admin role holds it: hr_admin and
  // super_admin, the two default holders, never reach this dialog at all — the trigger is gated on `ess`,
  // which is `!admin` (defined below, rendered further down still).
  const requestLeaveTypeOptions = eligibleLeaveTypes.map((lt) => ({
    id: lt.id,
    // 5570c6a2 — AN OPTION IS THE LEAVE TYPE'S NAME AND NOTHING ELSE.
    //
    // This used to append "· document required" (leave.documentRequiredBadge) for a type carrying
    // requiresDocument. Sitting inside the option it read as part of the type's NAME ("Caregiver Leave -
    // document required"), it made the list harder to scan, and it put an internal HR setting in front of
    // the employee. The rule used to cover BOTH employee dropdowns — this array and the Leave Credit
    // request's own list just below. (Until ad965821 rev 2 it was literally one array; rev 2 split them,
    // and they differed in WHICH ROWS they carried, never in what an option is.)
    //
    // 2a237f5f — THIS IS THE ONLY EMPLOYEE LEAVE-TYPE DROPDOWN LEFT. The Leave Credit request no longer has
    // one: its leave type is always Replacement Leave and is now a fixed field. So the rule has one place
    // to hold rather than two, and the badge cannot come back through the other door because there is no
    // other door.
    //
    // NOTHING ABOUT ENFORCEMENT MOVES. core/leave.ts still refuses a submission whose required document is
    // missing, app/me/actions.ts still raises that sentence (leave.documentRequired / documentRequiredAfter —
    // NOT this key, they are different strings), the general "required for some leave types" hint under the
    // attach-a-file box still stands, and HR still sets and sees the requirement on the admin leave-type
    // screen. leave.documentRequiredBadge stays in all six catalogs: nothing checks for unused keys, parity
    // is what is checked, and deleting one string from six files is churn that buys nothing.
    label: lt.name,
    durations: lt.durations ?? null,
    code: lt.code,
    // Feedback 9d8cf621: HR-authored apply-time notice for this leave type (shown under the select).
    applyNotice: (lt.customMessages as Record<string, string> | null)?.applyNotice ?? null,
    // Balance Deduction Source (cdf9ca48): lets the form drop Emergency Leave's decomposition-specific
    // controls once EL has been pointed at another type's balance — see LeaveTypeOption.borrowsBalance.
    borrowsBalance: lt.balanceSourceTypeId != null,
  }));
  // ── The Leave Credit request's leave type (2a237f5f) ──────────────────────────────────────────────────
  //
  // THERE IS NO LIST. This was `replacementLeaveTypeOptions` — every type the employee was eligible for,
  // mapped into a <select> in the Leave Credit request dialog (ad965821 rev 2 had narrowed WHICH rows it
  // carried, never how many). A Leave Credit is always Replacement Leave, and the choice was already dead
  // on arrival: core/toil.ts credits `ensureReplacementLeaveType(tenant)` whatever the employee picked,
  // and the reversal path reads the ledger row's own type. The form was collecting an answer the engine
  // discards — the same defect class as the Shift form's working days (aec53564, r331).
  //
  // RESOLVED OFF THE FULL LIVE CATALOGUE, NOT `eligibleLeaveTypes`, and that is the whole point of reading
  // it here. The engine's target is a TENANT's replacement type (`ensureReplacementLeaveType(tx, tenantId)`
  // — tenant-scoped, non-archived), so anything narrower would let this screen name one type while the
  // credit landed on another. `leaveTypes` is `listLeaveTypes(session, { locale, includeArchived: false })`:
  // the same scope, the same archived filter, and localized, so the box reads the tenant's OWN name for
  // their type rather than a translated constant.
  //
  // `pickReplacementLeaveType` is the in-memory twin of core/toil.ts `findReplacementLeaveTypeIdTx` — role
  // first, the seeded `REPLACEMENT` code as the fallback for an unclassified row, ties broken role-first.
  // Matching on the code alone would miss production's own type, which is coded `RL` under
  // `role = 'replacement'` (5ff7daff). ⚠️ NOT `ensureReplacementLeaveType`: that one INSERTS a leave type
  // on a miss, and creating a leave type as a side effect of drawing a page is not acceptable. Null here
  // means the tenant has no Replacement Leave type, and the trigger below renders nothing.
  const replacementLeaveType = pickReplacementLeaveType(leaveTypes);

  // ── The leave balance dashboard (r302 · 6c9802c9) ─────────────────────────────────────────────────────
  // Feedback 8ec63139: the ESS half of this page is self-service only; `ess` is the single gate and it suppresses
  // the READS as well as the markup. (An administrator never gets here — the short page returns above.)
  const ess = !admin;
  // 296fc027 · may this employee ask for replacement leave? THREE questions in one read: the chargeable
  // add-on, the per-company employee-request switch, and this employee's own eligibility as of today. Only
  // asked on the ESS path — an admin viewing this route sees the employee-inquiry surface, not their own.
  //
  // THIS IS NOT THE ENFORCEMENT. `submitReplacementLeaveRequest` re-derives all three server-side; this
  // read exists so the button is not offered where the submission would be refused. Hiding it is the
  // courtesy, refusing the POST is the control.
  // r397: read by the loader — replacementRequestAvailability(session, me.employmentId, today). `ess` is necessarily
  // true past the short-page return, which is the only path that reaches the loader.
  // ⚠️ r358 70294f7a — THE TIERS NO LONGER DEPEND ON THE SWITCH, AND THAT IS THE ITEM. This read
  // `extendedHoursOfferForEmployment`, which returns null when the company has not switched extended
  // hours on — false on EVERY company — and the table read that null as "no tier ladder exists" and
  // blocked every row that claimed a window. Since the owner's answer makes every day type claim one,
  // keeping it would have switched Leave Credit off for every company. `leaveCreditOfferForEmployment`
  // returns the ladder and the switch as two separate facts; the switch now governs only whether an
  // ORDINARY working day may earn a credit.
  // r397: read by the loader, and still only when `replacementRequest.allowed` — null otherwise.
  // r219 — WHO IS SHOWN THE REASON, and why it is not simply everyone whose read said no.
  //
  // A tenant that has never had a Replacement Leave type in its catalogue has nothing to explain: the
  // request option was never on offer, and a banner saying "not part of this plan" on every employee's
  // leave page would be an answer to a question nobody asked. Scoped to tenants whose catalogue HAS one,
  // read off the unfiltered `leaveTypes` above rather than the eligible/visible subsets — the notice must
  // survive the very configuration it is explaining, and BY ROLE with the seeded code as the fallback
  // (`isReplacementLeaveType`), because production's own replacement type is coded `RL` (5ff7daff).
  //
  // 2a237f5f — DERIVED FROM THE RESOLVED TYPE rather than asked a second time. It was
  // `leaveTypes.some(isReplacementLeaveType)`, which is the same question the resolver above already
  // answered over the same rows; two expressions of one fact is how the two drift apart. The predicate is
  // unchanged — `pickReplacementLeaveType` filters on `isReplacementLeaveType` — so which tenants see this
  // notice is exactly what it was.
  const tenantHasReplacementLeave = replacementLeaveType != null;

  // r302 — EVERY FIGURE ON THE DASHBOARD, PER LEAVE YEAR, from core/my-leave.ts: a pick off
  // leaveEntitlementBreakdown for the chosen year's cycle, and — for the cycle in force today — "You can apply
  // for" from leaveTypeApplySummary, the Apply popup's own figure (= the submit guard, test/r75). Hidden types
  // never arrive; Primary types come before Secondary. The read is where the r209 pool story (whose breakdown a
  // borrower tells) and the ec991c2a archived gate now live; this page computes no balance.
  // r397: read by the loader — myLeaveDashboard(session, me.employmentId, { today, year: sp.leaveYear, locale }) —
  // with `leaveYearAsOf` = the chosen year's 31 December when it is not the current year, else today.

  // ── Replacement Leave: the per-credit register behind its card (feedback 00307068) ─────────────────────
  // Replacement Leave is a stack of separately earned credits, so its card opens a TABLE of those credits
  // rather than the Leave Summary. ONE EXTRA READ, AND ONLY WHEN IT IS RENDERED: loaded only when the dashboard
  // actually carries a Replacement Leave card (matched BY ROLE, the seeded code as the fallback — 5ff7daff).
  // r397: the loader reads the ledger (and the claims below) only when the dashboard carries that card — the
  // first card `isReplacementLeaveType` accepts, exactly the test this page made.
  // 5ff7daff — the employee's own PENDING claims, summed over `pending` rows only (an approved request is
  // already a credit on the ledger above, and counting it in both places would double it).
  const replacementPendingDays =
    Math.round(replacementRequests.filter((r) => r.status === 'pending').reduce((sum, r) => sum + r.totalDays, 0) * 100) / 100;
  const dashboardCards: MyLeaveDashboardCard[] = (dashboard?.cards ?? []).map((c) =>
    replacementLedger && isReplacementLeaveType(c)
      ? {
          ...c,
          replacement: {
            rows: replacementLedger.rows,
            leaveUnit: replacementLedger.leaveUnit,
            explanations: c.breakdown?.formulaExplanations ?? {},
            pendingDays: replacementPendingDays,
          },
          pendingInLieu: replacementPendingDays,
        }
      : c,
  );

  // ── Shared leave groups, as ONE pooled balance each (feedback 46afcc48) ──────────────────────────────
  // `sharedLeaveGroupBalances` returns only the groups HR has PLACED (Hidden groups never come back), each with
  // the genuinely drawable figure. r302: placement is ORDER now — Primary groups first, then Secondary — drawn
  // as tiles in the dashboard grid, for the chosen year (a group's cycle is the calendar year of `asOf`).
  // r397: read by the loader — sharedLeaveGroupBalances(session, me.employmentId, { locale, asOf: leaveYearAsOf }).
  // Pre-translate here (t() is server-side) so the tile stays a plain presentational element.
  const sharedGroupEntriesAt = (placement: 'primary' | 'secondary') =>
    sharedGroupBalances
      .filter((g) => g.placement === placement)
      .map((g) => ({
        id: g.id,
        name: g.name,
        available: g.available,
        // The ceiling is CONTEXT beside the figure, never the figure.
        limitLabel: tMe('sharedLeaveGroups.ofLimit', { limit: formatDays(g.totalLimitDays) }),
        capLabel:
          g.maxDaysPerApplication == null
            ? null
            : tMe('sharedLeaveGroups.maxPerApplication', { days: formatDays(g.maxDaysPerApplication) }),
        membersLabel: tMe('sharedLeaveGroups.sharedAcross', { types: g.memberNames.join(', ') }),
        // ⚠️ r355 (8d3a7bff) — NO `detailsHref` / `detailsLabel` ANY MORE. 76dbcaa1 built them here as the
        // way in to /leave/shared/[groupId]; that page is deleted (it read as a configuration screen and,
        // after r341 folded the tile onto the leave-type card, repeated three of its five figures). The
        // fourth — how much of the pool has gone this year — moved onto the merged card below, which is
        // where the link used to be. These entries are the STANDALONE tiles and never carried a rendered
        // link at all (the tile at components/leave/my-leave-dashboard.tsx has no <Link>), so nothing that
        // was reachable from them is lost and their shape is otherwise untouched.
      }));
  const sharedGroupsPrimary = sharedGroupEntriesAt('primary');
  const sharedGroupsSecondary = sharedGroupEntriesAt('secondary');

  /**
   * r341 (8d3a7bff) — ONE CARD FOR THE POOL: THE GROUP'S TILE MOVES ONTO THE CARD THAT HOLDS ITS LEDGER.
   *
   * The reporter saw two cards headed "Special Leave" and asked for the second to go. Both were accurate and
   * both were about the same pot: the leave TYPE whose ledger holds the days, and the shared GROUP that caps
   * what may be taken across its seven members. Two different settings (lib/shared-leave-pool.ts records why
   * they must not be reconciled into one member list), one pot on screen — so the tile's lines move onto the
   * type's card and the tile is not drawn.
   *
   * ⚠️ AND THE FIVE MEMBERS THAT HOLD THEIR OWN DAYS KEEP THEIR CARDS, which is the half of the ticket we
   * argued back and they approved. Marriage Leave holds 177.00 days across 59 employments (re-measured
   * 2026-09-26); folding its card would hide a balance 59 people can actually spend. It gains one line naming
   * the ceiling instead. Only CPL and NDL — whose `balance_source_type_id` IS the pool — lose their cards, and
   * that happens in core/read.ts, not here.
   *
   * ⚠️ A GROUP WITH NO POOLED MEMBER STILL DRAWS ITS OWN TILE, byte-identical to before. `pnpm db:seed`
   * configures no pooled type and no shared group, so that branch is the one most tenants are on.
   */
  const ceilingPlan = planSharedGroupCeilings(dashboardCards, sharedGroupBalances);
  const sharedGroupEntryById = new Map(
    [...sharedGroupsPrimary, ...sharedGroupsSecondary].map((g) => [g.id, g] as const),
  );
  const dashboardCardsWithCeilings: MyLeaveDashboardCard[] = dashboardCards.map((c) => {
    const merged = ceilingPlan.mergedOnto.get(c.leaveTypeId);
    const also = ceilingPlan.alsoCounts.get(c.leaveTypeId) ?? [];
    if (merged == null && also.length === 0) return c;
    const entry = merged == null ? undefined : sharedGroupEntryById.get(merged.id);
    return {
      ...c,
      pooledCeiling:
        entry == null || merged == null
          ? null
          : {
              // The ceiling is CONTEXT beside the drawable figure, never in place of it (46afcc48): a card
              // promising ten days the group guard would refuse is worse than no card.
              // ⚠️ COMPOSED FROM THE KEYS THE VANISHED TILE ALREADY USED, NOT A NEW SENTENCE.
              // The tile printed `formatDays(available)` as its headline with `ofLimit` beneath it, and
              // `ofLimit` is TRANSLATED in all six catalogues ("共享额度 {limit} 天", "Baki dikongsi
              // {limit} hari", …). A new combined string would have been English-until-translated and
              // would have REPLACED a localised line — a zh employee reading English where they used to
              // read Chinese. Nothing here is new information, so nothing here needs a new word.
              availableLabel: formatDays(entry.available),
              limitLabel: tMe('sharedLeaveGroups.ofLimit', { limit: formatDays(merged.totalLimitDays) }),
              membersLine: entry.membersLabel,
              capLine: entry.capLabel,
              // r355 (8d3a7bff) — THE ONE FIGURE THE DELETED PAGE HELD ALONE, so deleting it loses nothing.
              // /leave/shared/[groupId] printed five things: the drawable pooled figure, the ceiling, the
              // per-application cap, the membership and this. The first four were already on this card
              // (r341); `usedDays` was not on any other employee surface — `sharedLeaveGroupBalances` has
              // exactly two callers, this page and the deleted one, and this page never read the field. So
              // it comes here, in the SAME key the page used (`usedThisYear`, translated in all six
              // catalogues) rather than a new English-until-translated sentence.
              //
              // ⚠️ `merged.usedDays`, NOT `entry` — the pre-translated entry carries only what the tile
              // needed. The figure is the whole cycle's pending + approved across every member type, the
              // same measure `enforceSharedLeaveGroupLimit` takes, so `availableLabel` and this line cannot
              // disagree about the same pot.
              usedLine: tMe('sharedLeaveGroups.usedThisYear', { days: formatDays(merged.usedDays) }),
            },
      ceilingLines: also.map((g) => tMe('sharedLeaveGroups.alsoCountsToward', { group: g.name })),
    };
  });
  // Placement is ORDER (r302), so the tiles that survive keep it: Primary groups before Secondary ones.
  const standaloneGroupIds = new Set(ceilingPlan.standalone.map((g) => g.id));
  const standaloneSharedGroups = [...sharedGroupsPrimary, ...sharedGroupsSecondary].filter((g) =>
    standaloneGroupIds.has(g.id),
  );

  /**
   * 76dbcaa1 — WHICH POOL EACH TYPE DRAWS ON, for the Request Leave picker. The reporter's requirement is
   * that the list stops reading as a flat set of every leave type in the database: the six Special Leave
   * reasons belong under one heading, because they are one entitlement.
   *
   * A LABEL ONLY. The form still posts one `leaveTypeId` and the engine still debits that type — grouping
   * the options changes what the employee reads, never what is submitted or what the shared-group guard
   * enforces. Built from `sharedLeaveGroupBalances`, so the picker and the balance card can never disagree
   * about who is in the pool.
   *
   * Empty on the on-behalf path (that read is self-service only), which simply means no grouping — the
   * same flat list as before, rather than a half-grouped one.
   */
  const groupNameByTypeId = new Map(
    sharedGroupBalances.flatMap((g) => g.members.map((m) => [m.id, g.name] as const)),
  );
  const requestLeaveTypeOptionsGrouped = requestLeaveTypeOptions.map((o) => ({
    ...o,
    groupName: groupNameByTypeId.get(o.id) ?? null,
  }));

  // r397: `upcoming` and `historyFilterParams` come from the loader's loadOwnUpcomingLeave — the two things this
  // page ever used of loadOwnLeaveHistory, without the history card's reads (that card is /leave/history's).
  const historyLinkParams = new URLSearchParams();
  for (const [key, value] of Object.entries(historyFilterParams)) for (const one of Array.isArray(value) ? value : [value]) historyLinkParams.append(key, one);
  for (const key of ['leaveYear', 'warnHoliday', 'loaded', 'state', 'year'] as const) if (sp[key]) historyLinkParams.set(key, sp[key]);

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
              {/* r302 (6c9802c9) — THE YEAR, beside Apply Leave. A plain GET form (works without script): it
                  posts `leaveYear` and carries the history filter and tab so choosing a year resets nothing
                  else. The options are the current leave year and earlier years with records — never a future
                  year. It replaces the "As at" date the My balances card had. */}
              {dashboard && (
                <form method="GET" action="/leave" className="flex items-center gap-1.5">
                  {Object.entries(historyFilterParams).flatMap(([k, v]) =>
                    (Array.isArray(v) ? v : [v]).map((one, i) => <input key={`${k}-${i}`} type="hidden" name={k} value={one} />),
                  )}
                  <label htmlFor="leave-year" className="text-xs text-muted-foreground">
                    {t('myLeave.yearLabel')}
                  </label>
                  <select
                    id="leave-year"
                    name="leaveYear"
                    defaultValue={String(dashboard.selectedYear)}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  >
                    {dashboard.years.map((y) => (
                      <option key={y} value={String(y)}>
                        {y}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="h-9 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground hover:bg-muted dark:hover:bg-muted/40"
                  >
                    {t('myLeave.yearApply')}
                  </button>
                </form>
              )}
              {/* Request Leave (feedback 48e69709): primary "+" trigger opening the apply form in a modal.
                  Feedback 8ec63139 narrowed it to the SELF-SERVICE viewer — on the HR-admin landing page it
                  was one of the three own-leave affordances the reporter asked to remove. The action, the
                  form and the on-behalf-of employee selector are untouched; only this trigger's audience
                  changed. Managers keep the TRIGGER (they are not `admin`) — but 5206539f took the employee
                  selector inside it away from them: being a line manager is not a permission, so the form a
                  manager opens here now files for the manager. */}
              {/* ad965821 — and only when there is something to offer. An employee who qualifies for
                  nothing gets no trigger rather than an empty form, which is the same courtesy the
                  Replacement Leave button immediately below already gives (replacementRequest.allowed). */}
              {ess && requestLeaveTypeOptions.length > 0 && (
                <RequestLeaveDialog
                  types={requestLeaveTypeOptionsGrouped}
                  // 5206539f — the per-subject type map is NOT passed any more, and the dialog's optional
                  // prop is left unset rather than fed an empty object. It existed to re-draw the offer as a
                  // line manager switched between reports; with that selector gone the self-service path has
                  // one subject and `types` is already exactly their set.
                  // 2166ef79 — `?start=` when My Attendance sent the employee here to explain an absent
                  // day, otherwise today, exactly as before. Shape-checked, never passed through raw: this
                  // value seeds a date input and rides no further.
                  startDefault={/^\d{4}-\d{2}-\d{2}$/.test(sp.start ?? '') ? sp.start! : today}
                  // 76dbcaa1 — `?type=` when a named Apply action sent the employee here (the Special
                  // Leave details screen has one per reason). Shape-checked like `?start=` above and never
                  // trusted: LeaveDurationFields falls back to the first option if the id is not one the
                  // subject may take, so a stale or hand-typed link cannot preselect an ineligible type.
                  defaultTypeId={
                    typeof sp.applyType === 'string' && /^[0-9a-f-]{36}$/i.test(sp.applyType) ? sp.applyType : null
                  }
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
              {/* ad965821 rev 2 — …and only when there is a credit target to name. THE GUARD STAYS; 2a237f5f
                  CHANGED WHAT IT GUARDS AGAINST. Rev 2's reason was an empty eligible list: the dialog's
                  type <select> carried neither `required` nor a placeholder row, so an empty list rendered
                  an empty control and posted leaveTypeId=''. There is no <select> any more — the leave type
                  is fixed — so the list that could be empty is now a single resolved type, and the case this
                  guards is A TENANT WITH NO REPLACEMENT LEAVE TYPE IN ITS CATALOGUE. Without it the dialog
                  would render a leave-type box with no name in it and post leaveTypeId='' — the same empty
                  control, reached by the one route still open to it.

                  KNOWN NARROWING, recorded rather than discovered later: `replacementRequestAvailability`
                  never asks whether the type exists, so an employee in such a tenant loses a button that
                  would have worked (the type is created at APPROVAL by `ensureReplacementLeaveType`). That
                  is r219's own model — "a tenant that has never had a Replacement Leave type has nothing to
                  explain: the request option was never on offer" — now true of the button as well as the
                  notice. The alternative was drawing a page that creates a leave type, which is worse. */}
              {ess && replacementRequest.allowed && replacementLeaveType != null && (
                <ReplacementLeaveRequestDialog
                  replacementType={{ id: replacementLeaveType.id, name: replacementLeaveType.name }}
                  // r343 — the SINGLE-TABLE submit. It adjudicates each row's chosen Day Type against the
                  // roster before composing `submitReplacementLeaveRequest`, which still enforces every
                  // control it ever did. r389 (ba039150): it redirects back to this page with the
                  // confirmation, as Request Leave does; the request is listed under My Leave › Leave Credit
                  // History.
                  submitAction={submitLeaveCreditRequestAction}
                  today={today}
                  requiresFirstScheduleConsent={replacementRequest.requiresFirstScheduleConsent}
                  // r343 — one read per date for EVERY row: what the roster holds (the thing the chosen Day
                  // Type is adjudicated against) plus the scheduled shift end and the actual clock-out. It
                  // replaces r336's pair of actions, one of which answered only for ordinary-day rows.
                  dayFactsAction={leaveCreditDayFactsAction}
                  // r358 — the ladder applies to every day type; `ordinaryDayAllowed` is the switch, and
                  // it now decides one thing only: whether an Ordinary Day row can earn a credit here.
                  tiers={leaveCreditOffer?.tiers ?? null}
                  ordinaryDayAllowed={leaveCreditOffer?.ordinaryDayAllowed ?? false}
                />
              )}
              {/* r389 (ba039150) — THE "View my leave credit requests" LINK THAT STOOD HERE IS GONE, and so
                  is the duplicate form it led to. r343 put it beside the button because the itemised list
                  of submitted requests lived only on that page, and a summary with no route to its detail is
                  half-delivered. The route still exists, from the menu instead of from beside a button: the
                  page is My Leave › Leave Credit History (packs/leave/index.ts LEAVE_SELF_NAV), gated on the
                  same `toil` module. Its key is retired in all six catalogues, not deleted. */}
            </div>
          }
        />
      </div>

      {/* r219 (7966ee35) — WHERE THE "+ Replacement Leave Request" BUTTON WOULD BE, THE REASON IT IS NOT.
          Directly under the header that carries the button, because that is where the employee looked for
          it. NOT inside the header's action row: this is two sentences, and a wrapped paragraph inside a
          row of buttons reads as a broken control rather than an explanation.

          It renders nothing when the employee may submit — except for the one allowed state worth naming,
          the First Schedule consent the form is about to ask for (see the component). So the page in its
          normal condition is byte-identical to before this item. */}
      {ess && tenantHasReplacementLeave && (
        <ReplacementAvailabilityNotice availability={replacementRequest} audience="self" />
      )}

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
      {/* r301 (83511d3b) — the leave type approves cancellations automatically: already cancelled, days back. */}
      {sp.toast === 'cancellationApproved' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('cancelAutoApprovedToast')}
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

      {/* ── r302 (6c9802c9) · THE LEAVE BALANCE DASHBOARD ─────────────────────────────────────────────────
          One card per leave type that applies to the employee — the Annual Leave type with its ring, every
          other type a smaller card with the same figures, a type with no entitlement showing Taken only — plus
          any shared leave group HR placed, all for the chosen leave year. It replaces the "My Leave Balance"
          tiles, the collapsible "My balances" table (and its As-at form and cookie), the "Shared leave
          balances" card and the "Other leave types" card. The `me-leave` tour anchor stays on this Card (the My
          Profile walkthrough lands here) and the `leave-balance` anchor on the dashboard inside it. */}
      {ess && dashboard && (
        <Card className="p-5" data-tour="me-leave">
          <h2 className="text-sm font-semibold">{t('myLeave.dashboardTitle')}</h2>
          <div className="mt-3" data-tour="leave-balance">
            {/* r341 (8d3a7bff) — the cards carry any merged shared-group ceiling, and `sharedGroups` is now
                only the groups with no pooled member to merge onto (they keep their own tile). */}
            <MyLeaveDashboard
              cards={dashboardCardsWithCeilings}
              sharedGroups={standaloneSharedGroups}
              locale={locale}
            />
          </div>
        </Card>
      )}

      {/* r302 — UPCOMING LEAVE: approved and pending leave from today onwards, soonest first. This reverses
          11876072's removal of the side panel's upcoming list at the reporter's request — as a section of the
          page; the Leave Details panel itself still has no upcoming list. */}
      {ess && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('myLeave.upcomingTitle')}</h2>
          <div className="mt-2">
            <UpcomingLeave rows={upcoming} locale={locale} />
          </div>
        </Card>
      )}

      {/* r302 — MY LEAVE HISTORY, ACROSS THE FULL WIDTH, with its four tabs. The type/date filter (5f2e20fb)
          stays; the tabs narrow by status on the server. Each row opens View — the same slide-out panel,
          now with the reason, the date submitted, the approval progress with names, a rejection's reason and
          a cancellation's who and when. Rows, actions, gates and the per-date outcome are unchanged. */}

      <Link href={`/leave/history${historyLinkParams.size ? `?${historyLinkParams}` : ''}`} className="text-sm text-primary hover:underline">{t('historyHeading')}</Link>

      {/* Feedback 8ec63139: the HR admin's own full-width "Other leave" breakdown card (56a0deb9) is gone —
          it was the third face of My Balances on a page that is now about employees, not the viewer. The
          self-service pairing above is untouched. */}
      {/* ── The HR-admin leave inquiry has MOVED (feedback 388e53c2) ──────────────────────────────────
          Employee Details — the employee listing you search, narrow and page through, whose rows open
          Employee Balances — now opens from the Team Leave Tracker row instead of from here. See
          app/leave/tracker/page.tsx: the listing is the same code with its base path repointed, and the
          other two inquiry screens keep their addresses untouched.

          WHY IT MOVED, since this page is where a reader will come looking for it: the sidebar lights a
          row by path PREFIX, so every /leave/* screen kept "My Leave" lit while an HR administrator read
          somebody else's leave record. The reporter's screenshot was of exactly that. Rather than dress
          the symptom up, the entry point moved to the row that should have been lit all along.

          afd0a87c — THE ORG-WIDE LEAVE-REQUEST TABLE IS GONE, and this note is kept as the record of why
          it survived twice before. It was held in 8ec63139 (the reporter had just asked for a filter on
          every one of its columns) and again in r80 (reported as a duplicate of Approval Items, which it
          was not). The reporter then asked plainly for the removal itself, with no relocation, and said
          they will redesign Employee Leave Record separately. Two capabilities went with it and have no
          other home, both disclosed in that plan and accepted: the org-wide register over every status
          with its eleven filters, and an HR admin editing their OWN pending application.

          WHAT DID NOT GO: withdrawing and giving back dates on your own leave still work from the leave
          calendar — components/planned-absences.tsx gates those on personId === viewerPersonId with no
          admin exclusion. AdminCancelLeaveDialog over someone else's leave lives on Employee Leave Record
          and on that calendar. */}
    </div>
  );
}
