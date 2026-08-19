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
  myEmploymentIdsAll,
  listEmployees,
  listLeaveTypes,
  listLeaveRequestsPage,
  // ad965821 — the eligibility-filtered apply source, and its multi-employment sibling for the
  // manager-applying-on-behalf case.
  listEligibleLeaveTypesFor,
  eligibleLeaveTypeIdsFor,
  reportingLinesFor,
  replacementLeaveLedger,
} from '@/core/read';
// 5f2e20fb — the SAME filter control the three HR leave screens use, on the employee's own history box.
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { todayInKualaLumpur } from '@/core/leave';
import { essViewHasAnyVisibleRow, isReplacementLeaveType } from '@/core/ess-view';
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
import { listReplacementLeaveRequests, replacementRequestAvailability } from '@/packs/leave/service';
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
// Shared Leave Group display (feedback 46afcc48): the pooled allowance several leave types draw on, drawn
// as ONE balance at the placement HR chose for the GROUP. Independent of each member type's own placement.
import { SharedLeaveGroupCards } from '@/components/leave/shared-leave-group-cards';
import { sharedLeaveGroupBalances } from '@/core/leave-shared-group';
// deriveBalanceRow lives in a SERVER-SAFE module (no 'use client'), so this RSC can call it at render
// time — importing it from the client table would trip the RSC boundary guard (b7d84266). R37 e5a158d3.
import { deriveBalanceRow } from '@/components/leave/leave-balance-row';
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
    // 388e53c2 - `emp` and the `ed*` listing params went to app/leave/tracker/page.tsx WITH the Employee
    // Details listing that read them. Declaring a param nothing on this page reads would advertise a
    // filter that silently does nothing. Their PREFIX is unchanged over there, so every admin link
    // already saved keeps working against its new base path.
    // R37 e5a158d3: as-at date for the (relocated) detailed leave-balance table's entitlement breakdown.
    asOf?: string;
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
    listLeaveTypes(session, { locale }),
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

  // Request Leave (feedback 48e69709): the apply form moved from a collapsed Card at the page bottom into a
  // modal launched from a "+" primary button in the PageHeader. These are the exact props the form used to
  // compute inline — mapped here in the RSC (t() runs server-side) and handed to the client dialog.
  //
  // ad965821 — MAPPED OFF THE ELIGIBLE LIST, not the catalogue. A male employee has no Maternity row here at
  // all; an unmarried one has no Paternity row. Nothing on the screen indicates a row was removed, which is
  // the reporter's explicit ask: a hint that a leave type exists is the thing they said must not happen.
  const requestLeaveTypeOptions = eligibleLeaveTypes.map((lt) => ({
    id: lt.id,
    // 5570c6a2 — AN OPTION IS THE LEAVE TYPE'S NAME AND NOTHING ELSE.
    //
    // This used to append "· document required" (leave.documentRequiredBadge) for a type carrying
    // requiresDocument. Sitting inside the option it read as part of the type's NAME ("Caregiver Leave -
    // document required"), it made the list harder to scan, and it put an internal HR setting in front of
    // the employee. One line covers BOTH dropdowns: this array is handed to RequestLeaveDialog and to
    // ReplacementLeaveRequestDialog, and each renders `label` verbatim.
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
  // ad965821 — membership test for the Edit box's union below. Built once here rather than per row.
  const eligibleTypeIds = new Set(eligibleLeaveTypes.map((lt) => lt.id));
  const requestLeaveEmployeeOptions = active.map((e) => ({ id: e.employmentId, name: e.name }));
  // Employee selector visibility (item 69088c13): only an on-behalf-of applicant needs to pick WHO the leave
  // is for. A plain self-service employee applies for themselves, so the selector is hidden and the submit
  // binds to their own employment server-side.
  //
  // ad965821 — the ADMIN arm of this question is dead code and has been since 8ec63139 / 388e53c2: the short
  // page above returns for `admin`, so `admin` is necessarily false here. What is left is the real case, a
  // line manager with direct reports. The read is bound to a name because the eligible-types map below needs
  // the same answer and calling reportingLinesFor twice would ask the database the same question twice.
  const reportingLines = await reportingLinesFor(session, me.employmentId);
  const canApplyOnBehalf = reportingLines.reports.length > 0;
  // ad965821 — WHOSE list is on offer changes when the manager changes the employee, so the answer is
  // resolved for every employment the selector can name (plus the manager's own) and handed to the client
  // form as a map. Keyed on the SELECTOR's ids rather than only the direct reports: `listEmployees` is what
  // populates that <select>, and an option with no entry in the map would render an empty type list.
  // ONE extra query for the whole set — see eligibleLeaveTypeIdsFor on why this is not an N+1.
  const eligibleTypeIdsByEmployment = canApplyOnBehalf
    ? await eligibleLeaveTypeIdsFor(session, [me.employmentId, ...requestLeaveEmployeeOptions.map((e) => e.id)])
    : undefined;

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
  //
  // 5ff7daff: matched BY ROLE, with the seeded code as the fallback. The code-only match was reading a
  // tenant's catalogue against the code the SEED writes, and production's own replacement type is coded
  // `RL` — so on the tenant that asked for this feature the customer's own card never matched, and the
  // panel opened on an auto-created duplicate instead. Same fix, same precedence, as `leaveTypeIs`.
  const replacementBalance = ess ? selfBalances.find((b) => b.placement === 'primary' && isReplacementLeaveType(b)) : undefined;
  const replacementLedger = replacementBalance && me ? await replacementLeaveLedger(session, me.employmentId) : null;
  // 5ff7daff — THE EMPLOYEE'S OWN PENDING CLAIMS. `listReplacementLeaveRequests` had no UI caller either,
  // so once an employee pressed Submit nothing on My Leave acknowledged the request existed. Summed over
  // `pending` rows only: an approved request has already become a credit on the ledger above, and counting
  // it in both places would double it. Loaded on exactly the same condition as the ledger, so a page
  // without a Replacement Leave card still pays nothing.
  const replacementRequests = replacementBalance && me ? await listReplacementLeaveRequests(session, me.employmentId) : [];
  const replacementPendingDays =
    Math.round(replacementRequests.filter((r) => r.status === 'pending').reduce((sum, r) => sum + r.totalDays, 0) * 100) / 100;

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
        replacementLedger && isReplacementLeaveType(b)
          ? {
              rows: replacementLedger.rows,
              leaveUnit: replacementLedger.leaveUnit,
              explanations: breakdownByType.get(b.leaveTypeId)?.formulaExplanations ?? {},
              pendingDays: replacementPendingDays,
            }
          : null,
      // The card's own "waiting on your line manager" line. Undefined on every other type.
      pendingInLieu: replacementLedger && isReplacementLeaveType(b) ? replacementPendingDays : undefined,
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

  // ── Shared leave groups, as ONE pooled balance each (feedback 46afcc48) ──────────────────────────────
  //
  // `sharedLeaveGroupBalances` returns only the groups HR has actually PLACED (Hidden groups never come
  // back), each with the figure that is genuinely drawable — min(what is left under the shared ceiling,
  // what the member types still hold) — NOT the raw ceiling. It also sums the member types WITHOUT regard
  // to their visibility, which is the point of the request: hiding a member is a display decision and
  // changes neither this figure nor what the group guard allows.
  //
  // ESS-only, like the cards and the balance table below it: an HR admin's own pooled balance does not
  // belong on their employee-inquiry page (8ec63139), and the `ess` gate suppresses the READ as well.
  const sharedGroupBalances =
    ess && me ? await sharedLeaveGroupBalances(session, me.employmentId, { locale, asOf: breakdownAsOf }) : [];
  // Pre-translate here (t() is server-side) so the card component stays a plain presentational function.
  const sharedGroupEntriesAt = (placement: 'primary' | 'secondary') =>
    sharedGroupBalances
      .filter((g) => g.placement === placement)
      .map((g) => ({
        id: g.id,
        name: g.name,
        available: g.available,
        // The ceiling is CONTEXT beside the figure, never the figure — see the component header.
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
  const hTypeIds = hArr(sp.hType).filter((v) => v.length > 0);
  const hFrom = sp.hFrom || undefined;
  const hTo = sp.hTo || undefined;
  const historyFiltered = hTypeIds.length > 0 || hFrom != null || hTo != null;
  // The SYMMETRIC carrier. The filter panel already carries `asOf` so applying a filter cannot reset the
  // as-at date; this is the same courtesy the other way round — the as-at GET forms (the one under the
  // balance table and the one inside every EntitlementBreakdown side-sheet) post only `asOf`, so without
  // these hidden inputs pressing Apply on a breakdown would silently clear the employee's history filter.
  // `hType` REPEATS, which is why the shared hiddenParams prop takes an array rather than a single string.
  const historyFilterParams: Record<string, string | string[]> = {
    ...(hTypeIds.length > 0 ? { hType: hTypeIds } : {}),
    ...(hFrom ? { hFrom } : {}),
    ...(hTo ? { hTo } : {}),
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
  const historyShown = historyFiltered
    ? await listLeaveRequestsPage(session, {
        employmentIds: historyEmploymentIds,
        leaveTypeIds: hTypeIds.length > 0 ? hTypeIds : undefined,
        from: hFrom,
        to: hTo,
        sort: 'start',
        dir: 'desc',
        limit: 200,
        offset: 0,
      })
    : historyAll;
  const total = historyAll.total;
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
  // ride along as a hidden input — otherwise applying a history filter would silently reset the as-at date
  // on the balance breakdown and drop the holiday warning banner mid-read.
  const historyHiddenParams: [string, string][] = (
    [
      ['asOf', sp.asOf],
      ['year', sp.year],
      ['state', sp.state],
      ['loaded', sp.loaded],
    ] as [string, string | undefined][]
  ).flatMap(([k, v]) => (v ? [[k, v] as [string, string]] : []));
  const historyClearHref =
    historyHiddenParams.length > 0 ? `/leave?${new URLSearchParams(historyHiddenParams).toString()}` : '/leave';

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
                      // 5f2e20fb — the side-sheet's own as-at form posts only asOf; carry the history
                      // filter so re-dating a breakdown does not clear the list behind the panel.
                      hiddenParams={historyFilterParams}
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
              {/* ad965821 — and only when there is something to offer. An employee who qualifies for
                  nothing gets no trigger rather than an empty form, which is the same courtesy the
                  Replacement Leave button immediately below already gives (replacementRequest.allowed). */}
              {ess && requestLeaveTypeOptions.length > 0 && (
                <RequestLeaveDialog
                  types={requestLeaveTypeOptions}
                  // The manager-on-behalf case: whose list is on offer re-draws when the employee changes,
                  // and a type that does not apply to the newly selected person is cleared rather than
                  // quietly carried across. Undefined for a plain employee — there is only one subject.
                  eligibleTypeIdsByEmployment={eligibleTypeIdsByEmployment}
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
      {/* Shared leave groups placed PRIMARY (46afcc48): the pooled balance now sits INSIDE the "My Leave
          Balance" row as a non-clickable tile (passed as sharedGroups into <LeaveCards>), not in its own
          "Shared leave balances" category — that is what "Primary" placement means on this screen and what
          the reporter asked to see. Empty ⇒ omitted, which is every tenant on the day this ships (the
          placement column defaults to Hidden). */}
      {ess && primaryCards.length > 0 && (
        <Card className="p-5" data-tour="me-leave">
          <LeaveCards entries={primaryCards} sharedGroups={sharedGroupsPrimary} />
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
              {/* 5f2e20fb — this form posts ONLY asOf, so the history filter rides along as hidden inputs
                  or pressing Apply here would silently clear it. hType repeats, one input per ticked type. */}
              {Object.entries(historyFilterParams).flatMap(([k, v]) =>
                (Array.isArray(v) ? v : [v]).map((one, i) => (
                  <input key={`${k}-${i}`} type="hidden" name={k} value={one} />
                )),
              )}
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
                        // 5f2e20fb — same carrier as the balance-table breakdown above.
                        hiddenParams={historyFilterParams}
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

      {/* Shared leave groups placed SECONDARY (46afcc48): the same pooled balance, drawn lower down —
          below the detailed balance table, above the "Other leave" / history pairing. Deliberately its own
          full-width Card rather than a row inside SecondaryLeaveGroups: that component's rows are LEAVE
          TYPES with a per-type breakdown side-sheet, and a group has no per-type breakdown to open, so
          folding it in would put a row there that behaves unlike every other row in the list. */}
      {ess && sharedGroupsSecondary.length > 0 && (
        <Card className="p-5">
          <SharedLeaveGroupCards heading={tMe('sharedLeaveGroups.heading')} entries={sharedGroupsSecondary} />
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
          {/* 5f2e20fb LAYOUT TRAP: `overflow-hidden` used to sit on this Card, and FilterPanel's popover is
              an absolutely positioned div rather than a portal — inside a clipping ancestor the whole panel
              would have been cut off at the card edge. The clipping moved to the inner scrolling div, which
              is the element that actually needs it (it is what scrolls); the card keeps its rounded corners
              because nothing now paints outside them except the popover, which is the point. */}
          <Card className={`flex flex-col ${COLUMN_CAP}`} data-tour="leave-requests">
            <div className="shrink-0 space-y-2 border-b border-border px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {/* "Showing 3 of 14" while a filter is on, plain "14" once cleared. */}
                  {historyFiltered
                    ? t('filters.showingOf', { shown: selfHistory.length, total })
                    : t('historyCount', { count: total })}
                </span>
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
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {historyEntries.length === 0 ? (
                historyFiltered ? (
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
                  <p className="text-sm text-muted-foreground">{t('requestsEmpty')}</p>
                )
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
