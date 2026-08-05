import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { myEmployment, plannedAbsences, reportingLinesFor } from '@/core/read';
import { todayInKualaLumpur } from '@/core/leave';
import { PageHeader } from '@/components/ui';
import { PlannedAbsences } from '@/components/planned-absences';
import { requestLeaveCancellationAction, adminCancelLeaveAction, cancelOwnLeaveAction } from '@/app/leave/actions';
import { resolveCalendarFetchWindow, resolveViewPreference } from '@/lib/leave-calendar-range';
import { CALENDAR_FOCUS_PARAM, parseCalendarFocus } from '@/lib/calendar-focus';

/**
 * Team Leave Tracker (feedback a00c4f64) — the Leave Calendar's own screen.
 *
 * The calendar used to be the dashboard's one FIXED full-width row, which meant a manager checking who is
 * off had to open the Dashboard and scroll past everything else, and the calendar shared a page with cards
 * each person can rearrange or switch off. This page is that same calendar, RELOCATED: the reporter asked
 * for a move, so nothing about leave calculation, approval or the calendar's own behaviour changed. The
 * dashboard side of the move is app/page.tsx (block gone), lib/dashboard-layout.ts (unpinned, out of the
 * catalogue) and migration 0404 (the tenants' dashboard_card_config rows deleted).
 *
 * The reads below are app/page.tsx's calendar reads MOVED, not rewritten — same scope resolution, same
 * window resolution, same person-scoped `plannedAbsences` projection, same three server actions passed to
 * the same client island. Anything that differs between the two would be a behaviour change the reporter
 * did not ask for.
 *
 * NOT MANAGER-GATED, and that is the whole reason the nav row carries no `managerUp` flag: every employee
 * saw this calendar on their dashboard, so a manager-only screen would be a silent removal of access from
 * plain staff. Staff see their own leave (the My/Team switch only appears with direct reports, exactly as
 * on the dashboard); managers additionally get the Team view. `scopedSession` + RLS do the real fencing.
 */
export default async function TeamLeaveTrackerPage({
  searchParams,
}: {
  searchParams: Promise<{ abs?: string; view?: string; cal?: string; focus?: string }>;
}) {
  const t = await getTranslations('leaveTracker');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;

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
  const admin = isAdmin(s);
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
  const absences = await plannedAbsences(s, scopeIds, { from: absFrom, to: absTo }, todayInKualaLumpur(), {
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
        // affordance on other employees' pills; same action the Leave page posts.
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
