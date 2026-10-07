/** Shared own-history projection; reads and action owners are unchanged. */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { leaveRequestDateBreakdown, myEmployment, myEmploymentIdsAll, listLeaveTypes, listLeaveRequestsPage, countLeaveRequestsByStatus, employeeCancelOffers, pendingCancellationProgress } from '@/core/read';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { todayInKualaLumpur } from '@/packs/leave/service';
import { myUpcomingLeave, ownLeaveApprovalTrails, ownLeaveCancellations, ownLeaveRejections } from '@/core/my-leave';
import { type UpcomingLeaveRow } from '@/components/leave/upcoming-leave';
import { LEAVE_HISTORY_TABS, applicationDateOutcomeRows, approvalProgress, approverKindLabelKey, approverLine, cancellationLines, isPartiallyApproved, resolveHistoryTab, type HistoryLineDeps, type LeaveHistoryTab } from '@/lib/my-leave-history';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import { Card } from '@/components/ui';
import { CancelDatesDialog } from '@/components/leave/cancel-dates-dialog';
import { EditLeaveDialog } from '@/components/leave/edit-leave-dialog';
import { CancelLeaveDialog } from '@/components/leave/cancel-leave-dialog';
import { LeaveDateOutcome } from '@/components/leave/leave-date-outcome';
import { LeaveHistoryCards, type LeaveHistoryEntry } from '@/components/leave/leave-history-cards';
import { durationLabel } from '@/lib/leave-duration';
import { leaveDisplaySplit } from '@/lib/leave-split';
import { requestLeaveCancellationAction, editLeaveAction, cancelOwnLeaveAction } from '@/app/leave/actions';

export type HistorySearch = { warnHoliday?: string; hTab?: string; hType?: string | string[]; hFrom?: string; hTo?: string; leaveYear?: string; year?: string; state?: string; loaded?: string };

type OwnSession = Awaited<ReturnType<typeof scopedSession>>['s'];
type OwnMe = NonNullable<Awaited<ReturnType<typeof myEmployment>>>;
type OwnRequestRow = Awaited<ReturnType<typeof myUpcomingLeave>>[number];

/**
 * r397 — the history filter, shape-checked. MOVED VERBATIM out of loadOwnLeaveHistory (which calls it) so the
 * My Leave page can carry the same filter params without running the history reads it never renders.
 */
function ownHistoryFilter(sp: HistorySearch) {
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
  return { hTypeIds, hFrom, hTo, historyFiltered, historyFilterParams };
}

/** r397 — WHOSE records: moved verbatim out of loadOwnLeaveHistory, which calls it. */
async function ownHistoryEmploymentIds(session: OwnSession, me: OwnMe): Promise<string[]> {
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
  return historyEmploymentIds;
}

/**
 * r397 — Upcoming Leave rows, pre-translated for the client island. MOVED VERBATIM out of loadOwnLeaveHistory
 * (the display status and the row map), so the history route and the My Leave page share one projection.
 * `approvalTrails` must answer for every row in `upcomingRows`; a trail is a per-request fact
 * (ownLeaveApprovalTrails resolves each id on its own), so asking for more ids changes nothing about these.
 */
async function ownUpcomingView(
  upcomingRows: OwnRequestRow[],
  approvalTrails: Awaited<ReturnType<typeof ownLeaveApprovalTrails>>,
): Promise<UpcomingLeaveRow[]> {
  const t = await getTranslations('leave');
  const tMe = await getTranslations('me');
  /** The display status of a row: Pending Cancellation / Partially approved / the stored status. */
  const displayStatus = (r: OwnRequestRow) => {
    const pendingCancel = r.status === 'approved' && r.pendingCancellationId != null;
    const isPartial = isPartiallyApproved(r, approvalTrails.get(r.id));
    return pendingCancel
      ? { key: 'pendingCancellation', label: t('pendingCancellationStatus') }
      : isPartial
        ? { key: 'partial', label: tMe('leaveStatus.partiallyApproved') }
        : { key: r.status, label: t(`status.${r.status}`) };
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
  return upcoming;
}

/**
 * r397 — WHAT THE MY LEAVE PAGE (app/leave/page.tsx) USES of loadOwnLeaveHistory, and only that: the Upcoming
 * Leave rows and the history filter it carries on the Year form. The page has always discarded `history`
 * (the card is on /leave/history), yet paid for every read behind it on each visit — the unfiltered list and
 * its count, the grouped tab counts, the shown list and its count, five date breakdowns, the cancel offers,
 * the cancellation progress, the cancellations and the rejections, eight sequential steps.
 *
 * SAME OUTPUT BY CONSTRUCTION: the same three helpers loadOwnLeaveHistory calls (ownHistoryFilter,
 * ownHistoryEmploymentIds, ownUpcomingView), the same myUpcomingLeave read, and the approval trails asked for
 * the Upcoming rows alone — the only rows `upcoming` reads a trail for. test/r397-my-leave-equivalence.test.ts
 * compares this against loadOwnLeaveHistory's own `upcoming` and `historyFilterParams`.
 */
export async function loadOwnUpcomingLeave({ session, me, sp }: { session: OwnSession; me: OwnMe; sp: HistorySearch }) {
  const today = todayInKualaLumpur();
  const { historyFilterParams } = ownHistoryFilter(sp);
  const historyEmploymentIds = await ownHistoryEmploymentIds(session, me);
  const upcomingRows = await myUpcomingLeave(session, historyEmploymentIds, today);
  // No rows ⇒ no trail can be read for any of them; ownLeaveApprovalTrails answers an empty Map for an empty list.
  const approvalTrails = upcomingRows.length > 0 ? await ownLeaveApprovalTrails(session, upcomingRows.map((r) => r.id)) : new Map();
  const upcoming = await ownUpcomingView(upcomingRows, approvalTrails);
  return { upcoming, historyFilterParams };
}

/** One server-owned projection for the unchanged history and upcoming consumers. */
export async function loadOwnLeaveHistory({session, me, sp, locale, leaveTypes, eligibleTypeIds}: {
  session: Awaited<ReturnType<typeof scopedSession>>['s'];
  me: NonNullable<Awaited<ReturnType<typeof myEmployment>>>;
  sp: HistorySearch;
  locale: string;
  leaveTypes: Awaited<ReturnType<typeof listLeaveTypes>>;
  eligibleTypeIds: Set<string>;
}) {
  const t = await getTranslations('leave');
  const tMe = await getTranslations('me');
  const today = todayInKualaLumpur();
  const unpaidTypeName = leaveTypes.find((lt) => lt.code === 'UNPAID')?.name;
  const historyEmploymentIds = await ownHistoryEmploymentIds(session, me);
  const { hTypeIds, hFrom, hTo, historyFiltered, historyFilterParams } = ownHistoryFilter(sp);
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
  // r394: ONE grouped count with the list's own filter (countLeaveRequestsByStatus shares
  // leaveRequestPageWhere with listLeaveRequestsPage), not one list read per tab — that was four
  // transactions on every visit. A tab with no rows is absent from the result and reads 0.
  const byStatus = await countLeaveRequestsByStatus(session, {
    employmentIds: historyEmploymentIds,
    statuses: [...LEAVE_HISTORY_TABS],
    leaveTypeIds: hTypeIds.length > 0 ? hTypeIds : undefined,
    from: hFrom,
    to: hTo,
  });
  const tabCounts = Object.fromEntries(LEAVE_HISTORY_TABS.map((tab) => [tab, byStatus[tab] ?? 0])) as Record<LeaveHistoryTab, number>;
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
  // Upcoming Leave: approved + pending from today onwards, soonest first (the history read's own filters).
  const upcomingRows = await myUpcomingLeave(session, historyEmploymentIds, today);
  const [approvalTrails, cancellations, rejections] = await Promise.all([
    // r302 fix pass — Upcoming rows too: a split survivor there is "Partially approved" by its application's
    // outcome (defects 3/4: a split row reads its ROOT request's trail and per-date outcome).
    ownLeaveApprovalTrails(session, [...selfHistory.map((r) => r.id), ...upcomingRows.map((r) => r.id)]),
    ownLeaveCancellations(session, selfHistory.filter((r) => r.status === 'cancelled').map((r) => r.id)),
    ownLeaveRejections(session, selfHistory.filter((r) => r.status === 'rejected').map((r) => r.id)),
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
  // The row's Approver cell, the View panel's approval progress and a cancellation's who/when — pure functions
  // in lib/my-leave-history.ts over this request's translator, so they are tested against the six catalogues.
  const lineDeps: HistoryLineDeps = { t: (key, values) => t(key, values), kindLabel, fmtInstant, listNames };
  const approverLineFor = (r: (typeof selfHistory)[number]) =>
    approverLine(r, approvalTrails.get(r.id), cancellations.get(r.id), lineDeps);
  const approvalProgressFor = (r: (typeof selfHistory)[number]) =>
    approvalProgress(r, approvalTrails.get(r.id), cancellations.get(r.id), lineDeps);
  const cancellationFor = (r: (typeof selfHistory)[number]) => cancellationLines(r, cancellations.get(r.id), lineDeps);

  // ── Self-service history cards (feedback 657962ec) ───────────────────────────────────────────────────
  // Each of the viewer's OWN records becomes a plain, pre-translated entry for the LeaveHistoryCards client
  // island: the card shows type / dates / duration / status only, while the slide-out detail panel carries
  // the session, stage, per-date outcomes, document link and the SAME action dialogs the old list rendered
  // inline — same gates (item c9a19e34 edit/cancel-by-status, ADR-0065 cancel-dates), same server actions,
  // services still re-assert subject/status authoritatively. Presentation-only: no data or permission change.
  const returnContext = new URLSearchParams(Object.entries(sp).flatMap(([key, value]) => (Array.isArray(value) ? value : value ? [value] : []).map((one) => [key, one]))).toString();
  const historyEntries: LeaveHistoryEntry[] = selfHistory.map((r) => {
    // "Partially approved" display badge (R17 600be8ac ask #4): display-derived; DB status stays 'approved'.
    // r302 fix pass (verifier defect 4): also when the APPLICATION's approval rejected a date — a row split off by
    // a partial cancellation no longer holds the rejected date's own record, so it reads its root's outcome.
    const trail = approvalTrails.get(r.id);
    const isPartial = isPartiallyApproved(r, trail);
    const rejection = r.status === 'rejected' ? rejections.get(r.id) : undefined;
    const applicationOutcome = trail?.perDateOutcome ?? null;
    const dateRows = applicationOutcome ? applicationDateOutcomeRows(applicationOutcome) : (requestDateBreakdowns.get(r.id) ?? []);
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
            returnContext={returnContext}
          />
          <CancelLeaveDialog leaveRequestId={r.id} submitAction={cancelOwnLeaveAction} returnContext={returnContext} />
        </>
      ) : (cancelOffers.get(r.id) ?? null) !== null ? (
        // r301: no button at all when the leave type does not allow it (or the leave has unpaid days, or a
        // cancellation is already waiting) — cancelOffers answers null for every one of those.
        <CancelDatesDialog
          leaveRequestId={r.id}
          candidateDates={cancelOffers.get(r.id) ?? []}
          submitAction={requestLeaveCancellationAction}
          returnContext={returnContext}
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
      // r302 fix pass: a row split off by a partial cancellation was created by the split, so its application's
      // submission is its root request's (the trail's `submittedAt`), matching the approval progress in View.
      // r302 hand-fix (second verification, defect 4): a split whose lineage was not recorded (before r299) was
      // CREATED by the split, so its own creation is not when the application was submitted — no date, not a wrong one.
      appliedOn: trail?.lineage === 'unrecorded' ? null : todayInKualaLumpur(trail?.submittedAt ?? new Date(r.appliedOn)),
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
      rejectionReason: rejection?.reason ?? null,
      // r302 fix pass (verifier defect 7): a per-date rejection's dates and reasons, formatted in the viewer's
      // locale by the island — never the event's audit string of raw ISO dates.
      rejectedDates: rejection && rejection.dates.length > 0 ? rejection.dates : null,
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
              cancelled: tMe('dateBreakdown.cancelled'),
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
    historyHiddenParams.length > 0 ? `/leave/history?${new URLSearchParams(historyHiddenParams).toString()}` : '/leave/history';

  // r302 — the tab links. Each keeps every other param this page reads (the year, the type/date filter, the
  // banner) and sets only `hTab`, so switching tabs never resets anything else.
  const historyTabs = LEAVE_HISTORY_TABS.map((tab) => {
    const q = new URLSearchParams(historyHiddenParams.filter(([k]) => k !== 'hTab'));
    for (const id of hTypeIds) q.append('hType', id);
    if (hFrom) q.set('hFrom', hFrom);
    if (hTo) q.set('hTo', hTo);
    q.set('hTab', tab);
    return { key: tab, label: t(`status.${tab}`), count: tabCounts[tab], href: `/leave/history?${q.toString()}`, active: tab === historyTab };
  });
  const HISTORY_EMPTY: Record<LeaveHistoryTab, string> = {
    pending: t('myLeave.emptyPending'),
    approved: t('myLeave.emptyApproved'),
    rejected: t('myLeave.emptyRejected'),
    cancelled: t('myLeave.emptyCancelled'),
  };

  const upcoming = await ownUpcomingView(upcomingRows, approvalTrails);

  const history = (
<Card className="flex flex-col" data-tour="leave-requests">
          {/* 5f2e20fb LAYOUT TRAP: FilterPanel's popover is an absolutely positioned div rather than a portal,
              so no ancestor of it may clip — the table scrolls sideways in its own wrapper instead. */}
          <div className="shrink-0 space-y-2 border-b border-border px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {t('historyHeading')} · 
                {historyFiltered
                  ? t('filters.showingOf', { shown: filteredTotal, total })
                  : t('historyCount', { count: total })}
              </h2>
              <FilterPanel
                action="/leave/history"
                fields={historyFilterFields}
                values={historyFilterValues}
                labels={historyFilterLabels}
                hidden={historyHiddenParams}
              />
            </div>
            {/* Removable chips under the top row: it is always visible WHY the list is short, and one
                click puts it back. */}
            <FilterChips
              action="/leave/history"
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
  );
  return { history, upcoming, historyFilterParams };
}
