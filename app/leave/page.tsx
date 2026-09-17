import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  leaveRequestDateBreakdown,
  leaveRequestsFor,
  myEmployment,
  myEmploymentIdsAll,
  listEmployees,
  listLeaveTypes,
  listLeaveRequestsPage,
  // ad965821 — the eligibility-filtered apply source for the viewer's own dropdown. Its multi-employment
  // sibling, and the reporting-lines read that used to decide who got an Employee selector, both left with
  // 5206539f: the selector is a named permission now, not a shape of the org chart.
  listEligibleLeaveTypesFor,
  replacementLeaveLedger,
  // r301 (83511d3b) — Cancel Approved Leave: THE button predicate (shared with the Team Leave Tracker) and the
  // Pending Cancellation progress on the viewer's own records.
  employeeCancelOffers,
  pendingCancellationProgress,
} from '@/core/read';
// 5f2e20fb — the SAME filter control the three HR leave screens use, on the employee's own history box.
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
// 5206539f — `leave.apply_on_behalf`, resolved by the SAME function requestLeave's own gate calls, so the
// selector below and the refusal in the service can never answer differently.
import { canApplyLeaveOnBehalf, todayInKualaLumpur } from '@/core/leave';
import { isReplacementLeaveType } from '@/core/ess-view';
// r302 (6c9802c9) — My Leave dashboard: the per-leave-year figures, Upcoming Leave, and the names of the people
// who decide the viewer's OWN requests (migration 0472). Every figure is a pick in core/my-leave.ts.
import {
  myLeaveDashboard,
  myUpcomingLeave,
  ownLeaveApprovalTrails,
  ownLeaveCancellations,
  ownLeaveRejectionReasons,
} from '@/core/my-leave';
import { MyLeaveDashboard, type MyLeaveDashboardCard } from '@/components/leave/my-leave-dashboard';
import { UpcomingLeave, type UpcomingLeaveRow } from '@/components/leave/upcoming-leave';
import {
  LEAVE_HISTORY_TABS,
  approverKindLabelKey,
  pendingApprovalLine,
  resolveHistoryTab,
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
// 296fc027 — the employee replacement-leave request: the button beside "+ Request Leave", the availability
// read that decides whether to offer it, and the action it posts to.
import { ReplacementLeaveRequestDialog } from '@/components/leave/replacement-leave-request-dialog';
// r219 (7966ee35) — …and, when that availability read says NO, the sentence saying why. The read has always
// carried a discriminated reason; this page rendered the boolean and dropped it, so the reporter spent a
// round changing Leave config settings against a cause that sits above Leave config.
import { ReplacementAvailabilityNotice } from '@/components/leave/replacement-availability-notice';
import { listReplacementLeaveRequests, replacementRequestAvailability } from '@/packs/leave/service';
import { LeaveDateOutcome } from '@/components/leave/leave-date-outcome';
// My Leave History — tabs, one row per request, and the slide-out View panel (657962ec, reshaped by r302).
import { LeaveHistoryCards, type LeaveHistoryEntry, type LeaveProgressStep } from '@/components/leave/leave-history-cards';
// Shared Leave Group display (feedback 46afcc48): the pooled allowance several leave types draw on, drawn
// as ONE balance, independent of each member type's own placement. r302: a tile in the dashboard grid.
import { sharedLeaveGroupBalances } from '@/core/leave-shared-group';
import { durationLabel } from '@/lib/leave-duration';
// 46afcc48 — the shared-group context lines interpolate day figures, and a day figure is printed one way
// in this repo (4a1abc4a). Interpolating a raw Number would print "10" beside the card's "9.00".
import { formatDays } from '@/lib/day-format';
// fef49b9a — ONE derivation of the paid/unpaid breakdown, shared with the other three surfaces.
import { leaveDisplaySplit } from '@/lib/leave-split';
import { LEAVE_STATUS_PILL, LEAVE_STATUS_PILL_DEFAULT } from '@/lib/leave-status';
import {
  requestLeaveAction,
  submitReplacementLeaveRequestAction,
  leaveCreditDayKindAction,
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
  // R37 e5a158d3: the balance view is the viewer's OWN detailed table (was an all-employee pivot). Resolved
  // BEFORE anything else because it is what decides whether this page has a subject at all.
  const me = await myEmployment(session);

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
  const [employees, leaveTypes, eligibleLeaveTypes] = await Promise.all([
    listEmployees(session, scopeIds),
    // Employee apply-popup enhancement: pass the viewer's locale so listLeaveTypes localizes `name` through
    // pickName. Without it the list is always English, which also makes an alphabetical sort meaningless
    // outside English. Admin master screens deliberately keep passing no locale (they edit the English name).
    //
    // ad965821 — THE FULL CATALOGUE IS STILL READ, and deliberately: two consumers on this page need it and
    // would break silently on the narrowed list. (1) `unpaidTypeName` just below, which supplies the
    // tenant's own name for unpaid leave to the fef49b9a balance split — UNPAID is a plausible hidden or
    // not-can-apply type, so filtering it away would drop that name from the breakdown. (2) the
    // EditLeaveDialog list, which must keep a request's OWN type selectable even when the employee no
    // longer qualifies for it. What it no longer feeds is the apply dropdown.
    //
    // ec991c2a — `includeArchived: false` written out, and it is already `listLeaveTypes`' default
    // (core/read.ts: `.where(opts.includeArchived ? undefined : isNull(leaveType.archivedAt))`). The item's
    // build notes read this call as the one deciding the apply list; it is NOT — see the line below. It
    // feeds `unpaidTypeName`, the EditLeaveDialog list and the replacement-leave notice, all of which want
    // the live catalogue. Stated explicitly so the next reader does not have to go and check the default.
    listLeaveTypes(session, { locale, includeArchived: false }),
    // …which now comes from HERE: the types this employee actually qualifies for, resolved through the ONE
    // gate in core/read.ts (conditions + employee_can_apply + hidden placement). An ineligible type is
    // ABSENT — no message, no greyed row, no badge, no count. requestLeave still refuses the submission.
    listEligibleLeaveTypesFor(session, me.employmentId, locale),
  ]);
  // Sort ONCE, at the source: every consumer on this page maps off one of these two arrays (the
  // request-leave dialog options, the two edit-leave dialog lists), so one sort makes them agree instead of
  // one popup being ordered and another not. NOT pushed into core/read.ts listLeaveTypes — the admin master
  // listing has its own ordering.
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, locale, { sensitivity: 'base' });
  leaveTypes.sort(byName);
  eligibleLeaveTypes.sort(byName);
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
  const myCompanyId = active.find((e) => e.employmentId === me.employmentId)?.companyId ?? null;
  const canApplyOnBehalf = await canApplyLeaveOnBehalf(session, myCompanyId);
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
    // the employee. The rule covers BOTH employee dropdowns — this array and `replacementLeaveTypeOptions`
    // just below — and each renders `label` verbatim. (Until ad965821 rev 2 it was literally one array; the
    // two now differ in WHICH ROWS they carry, never in what an option is.)
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
  // ad965821 rev 2 — THE REPLACEMENT LEAVE LIST IS THE VIEWER'S OWN, and is a separate array for exactly one
  // reason: that dialog has no employee selector. It asks to be CREDITED for time the SIGNED-IN employee
  // already worked, so the union assembled above (which spans a manager's reports) would offer them credit
  // targets belonging to somebody else. Same narrowing as the plan asked for — "the two ways into leave
  // agree with each other" — applied to the one subject this form actually has.
  const replacementLeaveTypeOptions = eligibleLeaveTypes.map((lt) => ({ id: lt.id, label: lt.name }));

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
  const replacementRequest = ess && me ? await replacementRequestAvailability(session, me.employmentId, today) : { allowed: false };
  // r219 — WHO IS SHOWN THE REASON, and why it is not simply everyone whose read said no.
  //
  // A tenant that has never had a Replacement Leave type in its catalogue has nothing to explain: the
  // request option was never on offer, and a banner saying "not part of this plan" on every employee's
  // leave page would be an answer to a question nobody asked. Scoped to tenants whose catalogue HAS one,
  // read off the unfiltered `leaveTypes` above rather than the eligible/visible subsets — the notice must
  // survive the very configuration it is explaining, and BY ROLE with the seeded code as the fallback
  // (`isReplacementLeaveType`), because production's own replacement type is coded `RL` (5ff7daff).
  const tenantHasReplacementLeave = leaveTypes.some(isReplacementLeaveType);

  // r302 — EVERY FIGURE ON THE DASHBOARD, PER LEAVE YEAR, from core/my-leave.ts: a pick off
  // leaveEntitlementBreakdown for the chosen year's cycle, and — for the cycle in force today — "You can apply
  // for" from leaveTypeApplySummary, the Apply popup's own figure (= the submit guard, test/r75). Hidden types
  // never arrive; Primary types come before Secondary. The read is where the r209 pool story (whose breakdown a
  // borrower tells) and the ec991c2a archived gate now live; this page computes no balance.
  const dashboard = ess && me ? await myLeaveDashboard(session, me.employmentId, { today, year: sp.leaveYear, locale }) : null;
  const leaveYearAsOf =
    dashboard && dashboard.selectedYear !== dashboard.currentYear ? `${dashboard.selectedYear}-12-31` : today;

  // ── Replacement Leave: the per-credit register behind its card (feedback 00307068) ─────────────────────
  // Replacement Leave is a stack of separately earned credits, so its card opens a TABLE of those credits
  // rather than the Leave Summary. ONE EXTRA READ, AND ONLY WHEN IT IS RENDERED: loaded only when the dashboard
  // actually carries a Replacement Leave card (matched BY ROLE, the seeded code as the fallback — 5ff7daff).
  const replacementCard = dashboard?.cards.find((c) => isReplacementLeaveType(c));
  const replacementLedger = replacementCard && me ? await replacementLeaveLedger(session, me.employmentId) : null;
  // 5ff7daff — the employee's own PENDING claims, summed over `pending` rows only (an approved request is
  // already a credit on the ledger above, and counting it in both places would double it).
  const replacementRequests = replacementCard && me ? await listReplacementLeaveRequests(session, me.employmentId) : [];
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
  const sharedGroupBalances =
    ess && me ? await sharedLeaveGroupBalances(session, me.employmentId, { locale, asOf: leaveYearAsOf }) : [];
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
      }));
  const sharedGroupsPrimary = sharedGroupEntriesAt('primary');
  const sharedGroupsSecondary = sharedGroupEntriesAt('secondary');

  // History: the viewer's OWN requests, and only those.
  //
  // This used to be a two-branch destructure of eight names. afd0a87c emptied the admin branch of its
  // org-wide register, leaving it holding `companies` / `departments` / `employeeList` for the Employee
  // Details listing alone — and 388e53c2 moved that listing to app/leave/tracker/page.tsx, which reads
  // them there. So one path is left, and it is the self-service one. (An administrator never reaches this
  // line at all: the short page returns above.)
  //
  // 5f2e20fb — NARROWED IN SQL, not in JavaScript after the fact. The old shape read the scope-wide flat
  // list (capped at 200 rows) and then kept the viewer's own; RLS on leave_request is `can_see_employment`,
  // so a manager's subordinates filled that cap and the manager's OWN older records fell off the bottom of
  // it before the filter ever ran. Narrowing by employmentId makes the cap per-employee. This does NOT
  // resurrect the org-wide register: there is no company/status/approver dimension here, only "mine".
  //
  // The id list comes from myEmploymentIdsAll — the exact equivalent of the personId test it replaces, and
  // the reason it is not simply [me.employmentId]: a rehired person holds more than one employment and must
  // keep seeing the earlier one's records. Never allowed to be empty, because an empty `employmentIds`
  // applies NO narrowing at all in the read.
  const myEmploymentIds = (await myEmploymentIdsAll(session)).map((e) => e.employmentId);
  const historyEmploymentIds = myEmploymentIds.length > 0 ? myEmploymentIds : [me.employmentId];
  const hArr = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  // SHAPE-CHECKED BEFORE THEY REACH SQL, because these three go straight into typed predicates in
  // core/read.ts — `from`/`to` into lte/gte against `date` columns, `hType` into an inArray against a
  // `uuid` column — and Postgres rejects a malformed literal with 22007 / 22P02 rather than returning
  // nothing. There is no error.tsx anywhere under app/, so that throw is an unhandled 500 that ANY
  // logged-in employee can reach by hand-editing the query string. A bad filter must degrade to "no
  // filter", never to a crash. This is also just the convention this page already follows (startDefault at the
  // Request Leave trigger; r302's `leaveYear` is narrowed the same way in core/my-leave.ts).
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hTypeIds = hArr(sp.hType).filter((v) => UUID.test(v));
  const hFrom = sp.hFrom && ISO_DATE.test(sp.hFrom) ? sp.hFrom : undefined;
  const hTo = sp.hTo && ISO_DATE.test(sp.hTo) ? sp.hTo : undefined;
  const historyFiltered = hTypeIds.length > 0 || hFrom != null || hTo != null;
  // The SYMMETRIC carrier. The filter panel carries `leaveYear` so applying a filter cannot reset the year
  // (r302 — it carried `asOf` until the As-at form went); this is the same courtesy the other way round — the
  // Year form posts only `leaveYear`, so without these hidden inputs choosing a year would silently clear the
  // employee's history filter. `hType` REPEATS, which is why this takes an array rather than a single string.
  const historyFilterParams: Record<string, string | string[]> = {
    ...(hTypeIds.length > 0 ? { hType: hTypeIds } : {}),
    ...(hFrom ? { hFrom } : {}),
    ...(hTo ? { hTo } : {}),
    ...(sp.hTab ? { hTab: sp.hTab } : {}),
  };
  // Call A is UNFILTERED and is what the tick-list is built from — options taken from the filtered set would
  // vanish the moment a filter was applied. It also supplies the "of 14" half of the header count.
  // Call B is the rendered rows. `from`/`to` are OVERLAP semantics inside the read (startDate <= to AND
  // endDate >= from), which is exactly the reporter's three date cases and also catches leave spanning a
  // month boundary. Skipped entirely when nothing is filtered — then the two lists are the same list.
  const historyAll = await listLeaveRequestsPage(session, {
    employmentIds: historyEmploymentIds,
    sort: 'start',
    dir: 'desc',
    limit: 200,
    offset: 0,
  });
  // r302 (6c9802c9) — THE FOUR TABS: Pending, Approved, Rejected, Cancelled. Each is one status, narrowed IN
  // SQL through the read's own `statuses` filter (validated against the enum there), together with the same
  // type/date filter — so a tab's count and its rows can never disagree, and the 200-row cap is per tab rather
  // than a page of mixed statuses filtered afterwards. The count reads ask for one row and keep the total.
  const tabCounts = Object.fromEntries(
    await Promise.all(
      LEAVE_HISTORY_TABS.map(
        async (tab) =>
          [
            tab,
            (
              await listLeaveRequestsPage(session, {
                employmentIds: historyEmploymentIds,
                statuses: [tab],
                leaveTypeIds: hTypeIds.length > 0 ? hTypeIds : undefined,
                from: hFrom,
                to: hTo,
                limit: 1,
                offset: 0,
              })
            ).total,
          ] as const,
      ),
    ),
  ) as Record<LeaveHistoryTab, number>;
  const historyTab = resolveHistoryTab(sp.hTab, tabCounts);
  const historyShown = await listLeaveRequestsPage(session, {
    employmentIds: historyEmploymentIds,
    statuses: [historyTab],
    leaveTypeIds: hTypeIds.length > 0 ? hTypeIds : undefined,
    from: hFrom,
    to: hTo,
    sort: 'start',
    dir: 'desc',
    limit: 200,
    offset: 0,
  });
  const total = historyAll.total;
  const filteredTotal = LEAVE_HISTORY_TABS.reduce((n, tab) => n + tabCounts[tab], 0);
  // Self-service history ordering (feedback 657962ec): cards render newest first BY LEAVE START DATE. SQL
  // now produces exactly that order (sort 'start', dir 'desc'), so the JS re-sort that used to correct the
  // read's createdAt-desc default is gone rather than duplicated.
  const selfHistory = historyShown.rows;

  // Per-date outcome rows for the viewer's OWN recent requests (My Absence merge · a7cbd895): the same
  // 5-most-recent window the /me Leave tab resolved (R17 600be8ac ask #6), so the employee still sees the
  // date-by-date approved/rejected breakdown after the tab moved here — now inside the detail panel
  // (657962ec). The window follows the card order (5 newest by start date).
  // RLS self-branch admits the subject to their rows.
  const dateBreakdownEntries: (readonly [string, Awaited<ReturnType<typeof leaveRequestDateBreakdown>>])[] =
    await Promise.all(
      selfHistory.slice(0, 5).map(async (r) => [r.id, await leaveRequestDateBreakdown(session, r.id)] as const),
    );
  const requestDateBreakdowns = new Map(dateBreakdownEntries);

  // r301 (83511d3b) — Cancel Approved Leave, both read ONCE for the page: the offer per row (null ⇒ no button)
  // and where each pending cancellation stands in its copied approval chain.
  const cancelOffers = await employeeCancelOffers(session, selfHistory, today);
  const cancelProgress = await pendingCancellationProgress(
    session,
    selfHistory.flatMap((r) => (r.pendingCancellationId ? [r.pendingCancellationId] : [])),
  );

  // r302 (6c9802c9) — WHO: the names of the people who decide the viewer's OWN requests (migration 0472; person
  // RLS hides them from an employee, and it is not widened), who cancelled a cancelled one, and a rejection's
  // reason (the rejected event, read under RLS). Every id asked about here is the viewer's own; an id that is
  // not simply comes back absent.
  const [approvalTrails, cancellations, rejectionReasons, upcomingRows] = await Promise.all([
    ownLeaveApprovalTrails(session, selfHistory.map((r) => r.id)),
    ownLeaveCancellations(session, selfHistory.filter((r) => r.status === 'cancelled').map((r) => r.id)),
    ownLeaveRejectionReasons(session, selfHistory.filter((r) => r.status === 'rejected').map((r) => r.id)),
    // Upcoming Leave: approved + pending from today onwards, soonest first (the history read's own filters).
    myUpcomingLeave(session, historyEmploymentIds, today),
  ]);
  const tApproval = await getTranslations('leaveApproval');
  const fmtInstant = (d: Date | null | undefined): string | null => {
    if (!d) return null;
    try {
      return new Intl.DateTimeFormat(locale, {
        timeZone: HR_LOCAL_TZ,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
    } catch {
      return d.toISOString();
    }
  };
  const listNames = (names: string[]): string => {
    try {
      return new Intl.ListFormat(locale, { type: 'disjunction' }).format(names);
    } catch {
      return names.join(' / ');
    }
  };
  // The approver KIND's own label (lib/my-leave-history.ts → `leaveApproval.*`). This replaces the old stage
  // line that called every step which was not the direct manager's "HR review".
  const kindLabel = (kind: string | null): string | null => {
    const key = approverKindLabelKey(kind);
    return key ? tApproval(key) : null;
  };
  /** The display status of a row: Pending Cancellation / Partially approved / the stored status. */
  const displayStatus = (r: (typeof selfHistory)[number]) => {
    const pendingCancel = r.status === 'approved' && r.pendingCancellationId != null;
    const isPartial = r.status === 'approved' && r.hasRejectedDates;
    return pendingCancel
      ? { key: 'pendingCancellation', label: t('pendingCancellationStatus') }
      : isPartial
        ? { key: 'partial', label: tMe('leaveStatus.partiallyApproved') }
        : { key: r.status, label: t(`status.${r.status}`) };
  };
  /** The row's Approver cell. */
  const approverLineFor = (r: (typeof selfHistory)[number]): string | null => {
    const trail = approvalTrails.get(r.id);
    if (r.status === 'pending') {
      const line = pendingApprovalLine(trail);
      if (!line) return null;
      if (line.names.length > 0) return t('myLeave.waitingForName', { name: listNames(line.names), level: line.level, of: line.of });
      const role = kindLabel(line.kind);
      return role
        ? t('myLeave.waitingForRole', { role, level: line.level, of: line.of })
        : t('myLeave.waitingForApproval', { level: line.level, of: line.of });
    }
    if (r.status === 'cancelled') {
      const c = cancellations.get(r.id);
      if (c?.automatic) return t('myLeave.cancelledAutomatically');
      return c?.cancelledByName ? t('myLeave.cancelledBy', { name: c.cancelledByName }) : null;
    }
    const name = trail?.decidedByName;
    if (!name) return null;
    return r.status === 'rejected' ? t('myLeave.rejectedBy', { name }) : t('myLeave.approvedBy', { name });
  };
  /** The View panel's approval progress: Submitted → each level → the outcome, the current level highlighted. */
  const approvalProgressFor = (r: (typeof selfHistory)[number]): LeaveProgressStep[] => {
    const trail = approvalTrails.get(r.id);
    const out: LeaveProgressStep[] = [
      { label: t('myLeave.progressSubmitted'), detail: fmtInstant(r.appliedOn), state: 'done' },
    ];
    const levelLabel = (level: number, kind: string | null, names: string[]) => {
      const role = kindLabel(kind);
      if (role && names.length > 0) return t('myLeave.progressLevelNamed', { level, role, name: listNames(names) });
      if (role) return t('myLeave.progressLevel', { level, role });
      if (names.length > 0) return t('myLeave.progressLevelPerson', { level, name: listNames(names) });
      return t('myLeave.progressLevelOnly', { level });
    };
    const steps = [...(trail?.steps ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
    const firstPending = r.status === 'pending' ? steps.findIndex((st) => st.status === 'pending') : -1;
    if (steps.length > 0) {
      steps.forEach((st, i) => {
        if (st.status === 'approved') {
          out.push({
            label: levelLabel(i + 1, st.kind, st.decidedByName ? [st.decidedByName] : []),
            detail: st.decidedAt ? t('myLeave.progressApprovedAt', { date: fmtInstant(st.decidedAt)! }) : null,
            state: 'done',
          });
        } else if (st.status === 'rejected') {
          out.push({
            label: levelLabel(i + 1, st.kind, st.decidedByName ? [st.decidedByName] : []),
            detail: st.decidedAt ? t('myLeave.progressRejectedAt', { date: fmtInstant(st.decidedAt)! }) : null,
            state: 'rejected',
          });
        } else {
          const current = i === firstPending;
          out.push({
            label: levelLabel(i + 1, st.kind, [st.approverName, ...st.alternateNames].filter((n): n is string => !!n)),
            detail: current ? t('myLeave.progressWaiting') : r.status === 'pending' ? t('myLeave.progressNotReached') : null,
            state: current ? 'current' : 'upcoming',
          });
        }
      });
    } else if (r.status === 'pending') {
      const line = pendingApprovalLine(trail);
      out.push({ label: levelLabel(1, line?.kind ?? null, line?.names ?? []), detail: t('myLeave.progressWaiting'), state: 'current' });
    } else if (trail?.decidedAt) {
      out.push({
        label: levelLabel(1, null, trail.decidedByName ? [trail.decidedByName] : []),
        detail:
          r.status === 'rejected'
            ? t('myLeave.progressRejectedAt', { date: fmtInstant(trail.decidedAt)! })
            : t('myLeave.progressApprovedAt', { date: fmtInstant(trail.decidedAt)! }),
        state: r.status === 'rejected' ? 'rejected' : 'done',
      });
    }
    if (r.status === 'pending') out.push({ label: t('myLeave.progressOutcomeApproved'), detail: null, state: 'upcoming' });
    else if (r.status === 'approved') out.push({ label: t('myLeave.progressOutcomeApproved'), detail: fmtInstant(r.decidedAt), state: 'done' });
    else if (r.status === 'rejected') out.push({ label: t('myLeave.progressOutcomeRejected'), detail: fmtInstant(r.decidedAt), state: 'rejected' });
    else if (r.status === 'cancelled') {
      out.push({ label: t('myLeave.progressOutcomeCancelled'), detail: fmtInstant(cancellations.get(r.id)?.cancelledAt), state: 'done' });
    }
    return out;
  };
  /** A cancelled request's who and when, and the cancellation's reason. */
  const cancellationFor = (r: (typeof selfHistory)[number]): LeaveHistoryEntry['cancellation'] => {
    const c = r.status === 'cancelled' ? cancellations.get(r.id) : undefined;
    if (!c) return null;
    const lines: string[] = [];
    const at = fmtInstant(c.cancelledAt);
    if (at) {
      lines.push(
        c.automatic
          ? t('myLeave.cancelledAutomaticallyAt', { date: at })
          : c.cancelledByName
            ? t('myLeave.cancelledByAt', { name: c.cancelledByName, date: at })
            : t('myLeave.cancelledAt', { date: at }),
      );
    }
    const requested = fmtInstant(c.requestedAt);
    if (requested) lines.push(t('myLeave.cancellationRequestedAt', { date: requested }));
    return lines.length > 0 || c.reason ? { lines, reason: c.reason } : null;
  };

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
            // ad965821 — the eligible set UNION this request's OWN type. The narrowing has to reach the Edit
            // box too or "no indication they exist" would hold on the apply form and fail one click away;
            // the union is the deliberate exception, because an employee who no longer qualifies for the type
            // they already filed under must still be able to edit the request they already have.
            types={leaveTypes
              .filter((lt) => eligibleTypeIds.has(lt.id) || lt.id === r.leaveTypeId)
              .map((lt) => ({
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
      ) : (cancelOffers.get(r.id) ?? null) !== null ? (
        // r301: no button at all when the leave type does not allow it (or the leave has unpaid days, or a
        // cancellation is already waiting) — cancelOffers answers null for every one of those.
        <CancelDatesDialog
          leaveRequestId={r.id}
          candidateDates={cancelOffers.get(r.id) ?? []}
          submitAction={requestLeaveCancellationAction}
        />
      ) : null;
    // r301 (83511d3b) — PENDING CANCELLATION. leave_request.status stays 'approved' (no new enum value); the
    // pending leave_cancellation_request row is what the employee sees as the leave's state, with its
    // progress through the copied approval levels — levels only, never an approver's name.
    const pendingCancellation =
      r.status === 'approved' && r.pendingCancellationId ? (cancelProgress.get(r.pendingCancellationId) ?? null) : null;
    const firstWaiting = pendingCancellation?.levels.find((l) => l.status === 'pending')?.stepIndex ?? null;
    return {
      id: r.id,
      leaveType: r.leaveType,
      // Emergency Leave (0106): tag the ANNUAL/UNPAID children of one EL submission as one Emergency Leave.
      groupLabel: r.parentGroupId ? t('emergency.groupLabel') : null,
      startDate: r.startDate,
      endDate: r.endDate,
      days: Number(r.days),
      // r302 — the date submitted (tenant-local) and the employee's own reason, for the row and for View.
      appliedOn: todayInKualaLumpur(new Date(r.appliedOn)),
      reason: r.reason ?? null,
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
      statusKey: pendingCancellation ? 'pendingCancellation' : isPartial ? 'partial' : r.status,
      statusLabel: pendingCancellation
        ? t('pendingCancellationStatus')
        : isPartial
          ? tMe('leaveStatus.partiallyApproved')
          : t(`status.${r.status}`),
      cancelProgress: pendingCancellation
        ? {
            steps: [
              {
                label: t('cancelProgress.requested', {
                  date: todayInKualaLumpur(new Date(pendingCancellation.requestedAt)),
                }),
                state: 'done' as const,
              },
              ...(pendingCancellation.levels.length === 0
                ? [{ label: t('cancelProgress.waiting'), state: 'current' as const }]
                : pendingCancellation.levels.map((l, i) => ({
                    label:
                      l.status === 'approved'
                        ? t('cancelProgress.levelApproved', { level: i + 1 })
                        : l.stepIndex === firstWaiting
                          ? t('cancelProgress.levelWaiting', { level: i + 1 })
                          : t('cancelProgress.levelUpcoming', { level: i + 1 }),
                    state:
                      l.status === 'approved'
                        ? ('done' as const)
                        : l.stepIndex === firstWaiting
                          ? ('current' as const)
                          : ('upcoming' as const),
                  }))),
              { label: t('cancelProgress.cancelled'), state: 'upcoming' as const },
            ],
            dates: t('cancelProgress.dates', { dates: pendingCancellation.cancelDates.join(', ') }),
            note: pendingCancellation.levels.length > 0 ? t('cancelProgress.sameChainNote') : null,
          }
        : null,
      // r302 (6c9802c9) — WHO it is waiting for and at which level ("Waiting for Marcus Manager · Level 2 of
      // 2"), or who decided it; the step-by-step progress for View; a rejection's reason; a cancellation's who
      // and when. This replaces 567333b7's stage line, which labelled every step that was not the direct
      // manager's "HR review" and could name nobody to an employee (the name read came back null through
      // person RLS — test/r302-my-leave-approver-names.test.ts). Names now come from migration 0472.
      approverLine: approverLineFor(r),
      approvalProgress: approvalProgressFor(r),
      rejectionReason: r.status === 'rejected' ? (rejectionReasons.get(r.id) ?? null) : null,
      cancellation: cancellationFor(r),
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


  // ── My Leave History filter (5f2e20fb) ───────────────────────────────────────────────────────────────
  // Assembly, not invention: components/filter-panel.tsx is the control three HR leave screens already use,
  // and every string it needs already exists in all six catalogs under `leave.filters`. NO new i18n key.
  //
  // The tick-list offers only the types this employee actually HAS records for, taken from the UNFILTERED
  // call above — so nobody ticks a type and gets a blank list, and the options do not shrink as filters are
  // applied. Sorted by name for the same reason the type dropdown is.
  const historyTypeOptions = [
    ...new Map(historyAll.rows.map((r) => [r.leaveTypeId, r.leaveType])).entries(),
  ]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, locale, { sensitivity: 'base' }));
  const historyFilterFields: FilterField[] = [
    {
      kind: 'multi',
      name: 'hType',
      label: t('filters.leaveType'),
      ariaLabel: t('filters.leaveType'),
      options: historyTypeOptions,
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.leaveType') }),
    },
    {
      kind: 'date',
      name: 'hFrom',
      label: t('filters.dateFrom'),
      ariaLabel: t('filters.dateFrom'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.dateFrom') }),
    },
    {
      kind: 'date',
      name: 'hTo',
      label: t('filters.dateTo'),
      ariaLabel: t('filters.dateTo'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.dateTo') }),
    },
  ];
  const historyFilterValues = { hType: hTypeIds, hFrom, hTo };
  const historyFilterLabels = {
    filter: t('filters.filter'),
    apply: t('filters.apply'),
    clearAll: t('filters.clearAll'),
    activeCount: t('filters.activeCount', {
      count: (hTypeIds.length > 0 ? 1 : 0) + (hFrom ? 1 : 0) + (hTo ? 1 : 0),
    }),
    selectAll: t('filters.selectAll'),
    deselectAll: t('filters.deselectAll'),
  };
  // The panel posts a GET form carrying only its OWN fields, so every foreign param this page reads has to
  // ride along as a hidden input — otherwise applying a history filter would silently reset the leave year
  // (r302; the as-at date until then), switch the history tab, and drop the holiday warning banner mid-read.
  const historyHiddenParams: [string, string][] = (
    [
      ['leaveYear', sp.leaveYear],
      ['hTab', sp.hTab],
      ['year', sp.year],
      ['state', sp.state],
      ['loaded', sp.loaded],
    ] as [string, string | undefined][]
  ).flatMap(([k, v]) => (v ? [[k, v] as [string, string]] : []));
  const historyClearHref =
    historyHiddenParams.length > 0 ? `/leave?${new URLSearchParams(historyHiddenParams).toString()}` : '/leave';

  // r302 — the tab links. Each keeps every other param this page reads (the year, the type/date filter, the
  // banner) and sets only `hTab`, so switching tabs never resets anything else.
  const historyTabs = LEAVE_HISTORY_TABS.map((tab) => {
    const q = new URLSearchParams(historyHiddenParams.filter(([k]) => k !== 'hTab'));
    for (const id of hTypeIds) q.append('hType', id);
    if (hFrom) q.set('hFrom', hFrom);
    if (hTo) q.set('hTo', hTo);
    q.set('hTab', tab);
    return { key: tab, label: t(`status.${tab}`), count: tabCounts[tab], href: `/leave?${q.toString()}`, active: tab === historyTab };
  });
  const HISTORY_EMPTY: Record<LeaveHistoryTab, string> = {
    pending: t('myLeave.emptyPending'),
    approved: t('myLeave.emptyApproved'),
    rejected: t('myLeave.emptyRejected'),
    cancelled: t('myLeave.emptyCancelled'),
  };

  // r302 — Upcoming Leave rows, pre-translated for the client island.
  const upcoming: UpcomingLeaveRow[] = upcomingRows.map((r) => {
    const st = displayStatus(r);
    return {
      id: r.id,
      leaveType: r.leaveType,
      startDate: r.startDate,
      endDate: r.endDate,
      days: Number(r.days),
      statusKey: st.key,
      statusLabel: st.label,
    };
  });

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
                  types={requestLeaveTypeOptions}
                  // 5206539f — the per-subject type map is NOT passed any more, and the dialog's optional
                  // prop is left unset rather than fed an empty object. It existed to re-draw the offer as a
                  // line manager switched between reports; with that selector gone the self-service path has
                  // one subject and `types` is already exactly their set.
                  // 2166ef79 — `?start=` when My Attendance sent the employee here to explain an absent
                  // day, otherwise today, exactly as before. Shape-checked, never passed through raw: this
                  // value seeds a date input and rides no further.
                  startDefault={/^\d{4}-\d{2}-\d{2}$/.test(sp.start ?? '') ? sp.start! : today}
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
              {/* ad965821 rev 2 — …and only when there is a credit target to name. This dialog's type
                  <select> carries neither `required` nor a placeholder row, so an empty list would render
                  an empty control and post leaveTypeId='' — the same empty-form trap the Request Leave
                  trigger above is guarded against, in the one dialog that would have failed silently. */}
              {ess && replacementRequest.allowed && replacementLeaveTypeOptions.length > 0 && (
                <ReplacementLeaveRequestDialog
                  types={replacementLeaveTypeOptions}
                  submitAction={submitReplacementLeaveRequestAction}
                  today={today}
                  requiresFirstScheduleConsent={replacementRequest.requiresFirstScheduleConsent}
                  // 3fb1a611 (r299) — the kind-of-day chip beside each date worked (a server action, not a closure).
                  dayKindAction={leaveCreditDayKindAction}
                />
              )}
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
            <MyLeaveDashboard
              cards={dashboardCards}
              sharedGroups={[...sharedGroupsPrimary, ...sharedGroupsSecondary]}
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
      {!admin && (
        <Card className="flex flex-col" data-tour="leave-requests">
          {/* 5f2e20fb LAYOUT TRAP: FilterPanel's popover is an absolutely positioned div rather than a portal,
              so no ancestor of it may clip — the table scrolls sideways in its own wrapper instead. */}
          <div className="shrink-0 space-y-2 border-b border-border px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {/* "Showing 3 of 14" while a filter is on, plain "14" once cleared. */}
                {historyFiltered
                  ? t('filters.showingOf', { shown: filteredTotal, total })
                  : t('historyCount', { count: total })}
              </h2>
              <FilterPanel
                action="/leave"
                fields={historyFilterFields}
                values={historyFilterValues}
                labels={historyFilterLabels}
                hidden={historyHiddenParams}
              />
            </div>
            {/* Removable chips under the top row: it is always visible WHY the list is short, and one
                click puts it back. */}
            <FilterChips
              action="/leave"
              fields={historyFilterFields}
              values={historyFilterValues}
              labels={historyFilterLabels}
              hidden={historyHiddenParams}
            />
          </div>
          <div className="p-4">
            {total === 0 ? (
              <p className="text-sm text-muted-foreground">{t('requestsEmpty')}</p>
            ) : historyFiltered && filteredTotal === 0 ? (
              // NOT `requestsEmpty` — that sentence means "you have no leave records at all", which is a
              // different and, here, untrue statement.
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('filters.emptyFiltered')}</p>
                <Link
                  href={historyClearHref}
                  className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t('filters.clearAll')}
                </Link>
              </div>
            ) : (
              <LeaveHistoryCards
                entries={historyEntries}
                locale={locale}
                tabs={historyTabs}
                emptyLabel={HISTORY_EMPTY[historyTab]}
              />
            )}
          </div>
        </Card>
      )}

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
