import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  dashboardStats,
  groupBreakdown,
  leaveBalances,
  listCompanies,
  myEmployment,
  plannedAbsences,
  recentActivity,
  recentHires,
  reportingLinesFor,
  upcomingHolidays,
} from '@/core/read';
import { pendingManagerReviewsFor } from '@/core/employment-review';
import { myFeedbackRequests } from '@/core/performance';
import { pendingApprovalsCount } from '@/core/approvals-inbox';
import { todayInKualaLumpur } from '@/core/leave';
import { Card, PageHeader, StatusBadge } from '@/components/ui';
import { PlannedAbsences } from '@/components/planned-absences';
import { LeaveBalanceCard } from '@/components/leave-balance-card';
import { TimelineNav } from '@/components/timeline-nav';
import { requestLeaveCancellationAction, adminCancelLeaveAction, cancelOwnLeaveAction } from '@/app/leave/actions';
import {
  type DashboardCardId,
  pendingTasksCount,
  resolveDashboardRole,
  ROLE_CARDS,
  teamAwayToday,
  upcomingRemindersCount,
} from '@/lib/dashboard-cards';
import { ACTOR_DOT, aggregateHref, aggregateLabel, humanizeEvent, relativeTime } from '@/lib/audit-format';
import { getDashboardLayout } from '@/core/dashboard-prefs';
import { listEmployeeDashboardCards, type EmployeeDashboardCard } from '@/core/dashboard-card-config';
import { DashboardCustomizer, type CustomizerCard } from '@/components/dashboard-customizer';
import { saveDashboardLayoutAction, resetDashboardLayoutAction } from '@/app/dashboard-layout-actions';
import { BUILTIN_DASHBOARD_CARDS, type DashboardLayout } from '@/lib/dashboard-layout';

const rm = (n: unknown) =>
  n == null
    ? '—'
    : `RM ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const monthAbbr = (iso: string) => MONTHS[utc(iso).getUTCMonth()];
const dayOf = (iso: string) => utc(iso).getUTCDate();
const weekdayOf = (iso: string) => WK[utc(iso).getUTCDay()];
type Translator = (key: string, values?: Record<string, string | number>) => string;

const daysAway = (iso: string, todayMs: number, t: Translator) => {
  const d = Math.round((Date.parse(`${iso}T00:00:00Z`) - todayMs) / 86_400_000);
  return d <= 0 ? t('today') : d === 1 ? t('tomorrow') : t('inDays', { d });
};
const joinedAgo = (iso: string, todayMs: number, t: Translator) => {
  const d = Math.round((todayMs - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
  if (d <= 0) return t('joinedToday');
  if (d === 1) return t('joinedYesterday');
  if (d < 14) return t('joinedDaysAgo', { d });
  if (d < 60) return t('joinedWeeksAgo', { w: Math.round(d / 7) });
  return t('joinedMonthsAgo', { m: Math.round(d / 30) });
};

const PAYROLL_STATUS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  processed: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  closed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};

function StatCard({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  href: string;
}) {
  return (
    <Link href={href} className="block">
      <Card className="p-5 transition-colors hover:border-foreground/20">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </Card>
    </Link>
  );
}

type BreakdownRow = { id: string; name: string; parentId: string | null; headcount: number };

function orderTree(rows: BreakdownRow[]) {
  const out: { row: BreakdownRow; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const row of rows
      .filter((r) => r.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ row, depth });
      visit(row.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ abs?: string }>;
}) {
  const t = await getTranslations('dashboard');
  const locale = await getLocale(); // R37: render leave-type names in the viewer's language
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  // Date window: a 14-day planned-absences strip, by default starting 2 days before
  // today; ?abs=YYYY-MM-DD (from the timeline nav) overrides the window start.
  const now = new Date();
  const nowMs = now.getTime();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayIso = new Date(todayMs).toISOString().slice(0, 10);
  const ABS_DAYS = 14;
  const absParam = sp.abs && /^\d{4}-\d{2}-\d{2}$/.test(sp.abs) ? sp.abs : null;
  const startMs = absParam ? Date.parse(`${absParam}T00:00:00Z`) : todayMs - 2 * 86_400_000;
  const absFrom = new Date(startMs).toISOString().slice(0, 10);
  const absTo = new Date(startMs + (ABS_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const since60 = new Date(todayMs - 60 * 86_400_000).toISOString().slice(0, 10);

  // R17 e6f0384c — role-based summary cards. Resolve the viewer's dashboard role FIRST (cheap: own
  // employment + reporting edges), then fetch only what the resolved role's cards render. Every read
  // below is an existing scope-fenced read; the role only selects WHICH fenced reads run — it never
  // widens access.
  const me = await myEmployment(s);
  const admin = isAdmin(s);
  const managerRole = (s.roles ?? []).includes('manager');
  // A Direct Manager via a reporting_line edge may not hold the `manager` platform role (0110); OR it in.
  const hasDirectReports =
    !admin && !managerRole && me
      ? (await reportingLinesFor(s, me.employmentId)).reports.length > 0
      : false;
  const role = resolveDashboardRole({ admin, managerRole, hasDirectReports });
  const wantStats = role === 'hr_admin' || role === 'manager'; // manager needs attendance breakdown
  const wantBreakdown = role === 'hr_admin';

  const [stats, activity, companies, breakdown, absences, hires, events] = await Promise.all([
    wantStats ? dashboardStats(s, scopeIds) : Promise.resolve(null),
    recentActivity(s, 8),
    listCompanies(s),
    wantBreakdown ? groupBreakdown(s) : Promise.resolve([]),
    // Partial Leave Cancellation from the calendar (ADR-0065): pass MYT "today" so each approved row's
    // cancellable candidate dates match the Leave page / service cut-off exactly (strictly-after-MYT).
    plannedAbsences(s, scopeIds, { from: absFrom, to: absTo }, todayInKualaLumpur()),
    recentHires(s, scopeIds, { since: since60, limit: 5 }),
    upcomingHolidays(s, { from: todayIso, limit: 5 }),
  ]);

  // Employee card data: own leave balance + own PENDING TASKS. "Pending Tasks" = action items the
  // employee must complete themselves (e.g. give 360 feedback; document-upload obligations plug in as
  // those task types ship) — deliberately NOT the inverse "my requests awaiting someone else's decision".
  // All reads are self-scoped via RLS.
  let empBalances: { leaveTypeId: string; leaveType: string; available: number }[] = [];
  let empTaskCount = 0;
  // Customizable dashboard layout (feedback 7d9d145d → add/remove/shortcut 578a2fcf): the employee's saved
  // { selected, order } of cardKeys, normalised against the HR card master (feedback 1586d2f5). Employee
  // role ONLY — manager/admin dashboards are untouched.
  let savedLayout: DashboardLayout | null = null;
  let employeeCards: EmployeeDashboardCard[] = [];
  if (role === 'employee' && me) {
    // The tenant's active dashboard-card catalog drives which cards the employee may show / add; fall back
    // to the built-in set when a tenant has no config rows so the dashboard never renders blank.
    const configured = await listEmployeeDashboardCards(s);
    employeeCards = configured.length
      ? configured
      : BUILTIN_DASHBOARD_CARDS.map((c) => ({
          cardKey: c.cardKey,
          name: c.name,
          cardType: c.cardType,
          href: c.href,
          employeeSelectable: c.employeeSelectable,
          defaultDisplay: c.defaultDisplay,
          mandatory: c.mandatory,
          displayOrder: c.displayOrder,
        }));
    const [balances, feedbackRequests, layout] = await Promise.all([
      leaveBalances(s, me.employmentId, locale),
      myFeedbackRequests(s), // pending 360 peer-feedback the employee must submit
      getDashboardLayout(s, employeeCards), // own-row read via the SECURITY DEFINER seam, normalised to config
    ]);
    empBalances = balances.map((b) => ({ leaveTypeId: b.leaveTypeId, leaveType: b.leaveType, available: b.available }));
    empTaskCount = pendingTasksCount([feedbackRequests.length]);
    savedLayout = layout;
  }

  // Manager card data: team away today, the same approvals count as the bell, and the Upcoming Reminders
  // digest (review deadlines assigned to this manager + company holidays soon).
  let mgrAwayCount = 0;
  let mgrApprovals = 0;
  let mgrReminders = 0;
  if (role === 'manager') {
    // teamAwayToday must be computed over a window that always covers today. The strip's window shifts
    // with ?abs=, so when it's overridden, fetch the default (today-2 … +11) window just for the count.
    const defaultFrom = new Date(todayMs - 2 * 86_400_000).toISOString().slice(0, 10);
    const defaultTo = new Date(todayMs + (ABS_DAYS - 3) * 86_400_000).toISOString().slice(0, 10);
    const [awayRows, approvals, reviewDeadlines] = await Promise.all([
      absParam
        ? plannedAbsences(s, scopeIds, { from: defaultFrom, to: defaultTo }, todayInKualaLumpur())
        : Promise.resolve(absences),
      pendingApprovalsCount(s, scopeIds),
      // Performance / probation review deadlines assigned to this manager (the reporter's "review
      // deadlines" reminder). Same queue the bell counts — surfaced here as an upcoming reminder too.
      me ? pendingManagerReviewsFor(s, me.employmentId) : Promise.resolve([]),
    ]);
    mgrAwayCount = teamAwayToday(awayRows, todayIso, s.personId ?? null);
    mgrApprovals = approvals;
    // Reminder window: holidays in the next 30 days + the manager's open review deadlines. (No training
    // module yet, so training reminders contribute 0 — the helper absorbs them when one ships.)
    const reminderCutoffIso = new Date(todayMs + 30 * 86_400_000).toISOString().slice(0, 10);
    mgrReminders = upcomingRemindersCount(events, reviewDeadlines.length, todayIso, reminderCutoffIso);
  }

  const att = stats?.attendance ?? { date: null as string | null, present: 0, late: 0, halfDay: 0, absent: 0 };
  const attTotal = att.present + att.late + att.halfDay + att.absent;
  const pct = (n: number) => (attTotal ? `${(n / attTotal) * 100}%` : '0%');

  // Map a card id → its rendered card. Order comes from ROLE_CARDS[role]. `leaveBalance` renders the
  // interactive client island; the rest are plain StatCards. Non-`#` hrefs navigate; `#…` scroll to
  // an in-page anchor added below.
  const renderCard = (id: DashboardCardId): ReactNode => {
    switch (id) {
      case 'headcount':
        return <StatCard key={id} label={t('headcount')} value={stats?.headcount ?? 0} hint={t('activeEmployees')} href="/personnel" />;
      case 'pendingLeave':
        return <StatCard key={id} label={t('pendingLeave')} value={stats?.pendingLeave ?? 0} hint={t('awaitingApproval')} href="/leave" />;
      case 'companies':
        return (
          <StatCard
            key={id}
            label={t('companies')}
            value={stats?.companies ?? 0}
            hint={t('departments', { count: stats?.departments ?? 0 })}
            href="/admin/organization"
          />
        );
      case 'latestPayroll':
        return (
          <StatCard
            key={id}
            label={t('latestPayroll')}
            value={stats?.latestPayroll ? rm(stats.latestPayroll.net) : '—'}
            hint={stats?.latestPayroll ? `${stats.latestPayroll.payPeriod} · ${stats.latestPayroll.status}` : t('noRunsYet')}
            href="/payroll"
          />
        );
      case 'leaveBalance':
        return <LeaveBalanceCard key={id} balances={empBalances} href="/leave" />;
      case 'nextHoliday':
        return (
          <StatCard
            key={id}
            label={t('nextHoliday')}
            value={<span className="text-xl">{events[0] ? events[0].name : '—'}</span>}
            hint={events[0] ? daysAway(events[0].date, todayMs, t) : t('nothingScheduled')}
            href="#upcoming-events"
          />
        );
      case 'pendingTasks':
        return <StatCard key={id} label={t('pendingTasks')} value={empTaskCount} hint={t('requireYourAttention')} href="/me" />;
      case 'teamAwayToday':
        return <StatCard key={id} label={t('teamAwayToday')} value={mgrAwayCount} hint={t('onApprovedLeaveToday')} href="#planned-absences" />;
      case 'approvalRequests':
        return <StatCard key={id} label={t('approvalRequests')} value={mgrApprovals} hint={t('awaitingYourAction')} href="/approvals" />;
      case 'upcomingReminders':
        return <StatCard key={id} label={t('upcomingReminders')} value={mgrReminders} hint={t('reviewsAndHolidays')} href="#upcoming-events" />;
    }
  };

  // Feedback 7d9d145d — the reorderable employee-dashboard sections, each pre-rendered here on the
  // server and stacked in the employee's saved order by the <DashboardCustomizer> client island (v1 =
  // vertical reorder of existing sections; the island only chooses ORDER, it reads no data). The exact
  // same nodes render inline for manager/admin below, so those dashboards are byte-for-byte untouched.
  const cardsGrid = (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{ROLE_CARDS[role].map(renderCard)}</div>
  );

  const plannedAbsencesBlock = (
    <div id="planned-absences" className="scroll-mt-4">
      <PlannedAbsences
        rows={absences}
        from={absFrom}
        days={ABS_DAYS}
        todayIso={todayIso}
        controls={<TimelineNav from={absFrom} isDefault={!absParam} />}
        // Partial Leave Cancellation from the calendar (ADR-0065): the viewer gates "own leave only"; the action
        // is the SAME one the Leave page posts (redirects to /leave?toast=cancellationRequested + revalidates /).
        viewerPersonId={s.personId}
        cancelAction={requestLeaveCancellationAction}
        // HR Admin Leave Cancellation on behalf (feedback 22e68ff0): admins get an immediate cancel
        // affordance on other employees' pills; same action the Leave page posts.
        viewerIsAdmin={isAdmin(s)}
        adminCancelAction={adminCancelLeaveAction}
        // Edit/cancel-by-status (item c9a19e34): the viewer self-withdraws their own PENDING leave directly
        // from the calendar; the SAME action the Leave page posts (re-asserts subject-only + pending).
        selfCancelAction={cancelOwnLeaveAction}
      />
    </div>
  );

  const recentlyJoinedCard = (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">{t('onboarding')}</h2>
          <p className="text-xs text-muted-foreground">{t('recentlyJoined')}</p>
        </div>
        <Link href="/personnel" className="text-xs text-muted-foreground hover:text-foreground">
          {t('viewAll')}
        </Link>
      </div>
      {hires.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('noHires', { days: 60 })}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {hires.map((h) => (
            <li key={h.employmentId} className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {initials(h.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{h.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {h.role ?? h.department ?? '—'} · {joinedAgo(h.hiredOn, todayMs, t)}
                </div>
              </div>
              <StatusBadge status={h.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  const upcomingEventsCard = (
    <Card id="upcoming-events" className="scroll-mt-4 p-5">
      <h2 className="text-sm font-semibold">{t('upcomingEvents')}</h2>
      <p className="text-xs text-muted-foreground">{t('publicHolidays')}</p>
      {events.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('nothingScheduled')}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {events.map((e) => (
            <li key={e.date} className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 flex-col items-center justify-center rounded-xl border border-border bg-muted/50 leading-none">
                <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {monthAbbr(e.date)}
                </span>
                <span className="text-sm font-semibold tabular-nums">{dayOf(e.date)}</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{e.name}</div>
                <div className="text-xs text-muted-foreground">
                  {weekdayOf(e.date)} · {daysAway(e.date, todayMs, t)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  const recentActivityCard = (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('recentActivity')}</h2>
        {isAdmin(s) && (
          <Link href="/admin/audit" className="text-xs text-primary hover:underline">
            {t('viewAll')}
          </Link>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('recentActivitySubtitle')}</p>
      {activity.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('noActivity')}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {activity.map((a, i) => {
            const href = aggregateHref(a.aggregateType, a.aggregateId);
            const who = a.actorName ?? a.actorType;
            return (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${ACTOR_DOT[a.actorType] ?? 'bg-muted-foreground'}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{humanizeEvent(a.eventType)}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {href ? (
                      <Link href={href} className="text-primary/90 hover:underline">
                        {aggregateLabel(a.aggregateType)}
                      </Link>
                    ) : (
                      aggregateLabel(a.aggregateType)
                    )}{' '}
                    · {who} · {relativeTime(a.occurredAt, nowMs)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );

  const pageHeader = (
    <PageHeader
      title={t('title')}
      description={
        scopeIds.length >= companies.length
          ? t('overviewAll')
          : t('overviewScoped', { count: scopeIds.length, total: companies.length })
      }
    />
  );

  // Employee dashboard: the fixed block set flattens into individually add/remove/reorderable cards
  // (feedback 578a2fcf) driven by the HR card master. The three summary cards (leaveBalance / nextHoliday
  // / pendingTasks) render via renderCard; the four section blocks render their existing nodes; any
  // HR-configured shortcut/action card with no bespoke node renders as a clickable link inside the island.
  // Manager/admin dashboards fall through to the fixed layout below — deliberately untouched.
  if (role === 'employee') {
    // Pre-render the bespoke information-card nodes keyed by cardKey. Shortcut/action cards without a node
    // here are rendered generically by the customizer from their configured href.
    const cardNodes: Record<string, ReactNode> = {
      leaveBalance: renderCard('leaveBalance'),
      nextHoliday: renderCard('nextHoliday'),
      pendingTasks: renderCard('pendingTasks'),
      plannedAbsences: plannedAbsencesBlock,
      recentlyJoined: recentlyJoinedCard,
      upcomingEvents: upcomingEventsCard,
      recentActivity: recentActivityCard,
    };
    const customizerCards: CustomizerCard[] = employeeCards.map((c) => ({
      key: c.cardKey,
      label: c.name,
      cardType: c.cardType,
      href: c.href,
      mandatory: c.mandatory,
      defaultDisplay: c.defaultDisplay,
      employeeSelectable: c.employeeSelectable,
    }));
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        {pageHeader}
        <DashboardCustomizer
          cards={customizerCards}
          blocks={cardNodes}
          layout={savedLayout ?? { selected: [], order: [] }}
          saveAction={saveDashboardLayoutAction}
          resetAction={resetDashboardLayoutAction}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {pageHeader}

      {cardsGrid}

      {plannedAbsencesBlock}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {recentlyJoinedCard}
        {upcomingEventsCard}
      </div>

      {/* R17: company-wide headcount breakdown is HR-only (data was admin-gated in the read anyway). */}
      {role === 'hr_admin' && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-sm font-semibold">{t('headcountByCompany')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('totalCount', { count: breakdown.reduce((sum, c) => sum + c.headcount, 0) })}
            </span>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border border-t border-border">
              {orderTree(breakdown).map(({ row, depth }) => (
                <tr key={row.id} className="hover:bg-muted/40">
                  <td className="py-2 pr-4" style={{ paddingLeft: `${1 + depth * 1.5}rem` }}>
                    {row.name}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.headcount}</td>
                </tr>
              ))}
              {breakdown.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-muted-foreground" colSpan={2}>
                    {t('noCompanies')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* R17: attendance breakdown for HR + managers (team attendance); an employee's single own
              record already lives on /me's clock card. The employee role returns early above (its
              dashboard is the reorderable block list), so this branch is always manager/hr_admin. */}
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('attendance')}</h2>
              <span className="text-xs text-muted-foreground">{att.date ? t('asOf', { date: att.date }) : t('noRecords')}</span>
            </div>
            {attTotal === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">{t('noAttendance')}</p>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-4 gap-3">
                  {(
                    [
                      [t('present'), att.present, 'text-emerald-600 dark:text-emerald-400'],
                      [t('late'), att.late, 'text-amber-600 dark:text-amber-400'],
                      [t('halfDay'), att.halfDay, 'text-blue-600 dark:text-blue-400'],
                      [t('absent'), att.absent, 'text-rose-600 dark:text-rose-400'],
                    ] as const
                  ).map(([label, value, color]) => (
                    <div key={label}>
                      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
                      <div className="text-xs text-muted-foreground">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-muted">
                  <div className="bg-emerald-500" style={{ width: pct(att.present) }} />
                  <div className="bg-amber-500" style={{ width: pct(att.late) }} />
                  <div className="bg-blue-500" style={{ width: pct(att.halfDay) }} />
                  <div className="bg-rose-500" style={{ width: pct(att.absent) }} />
                </div>
              </>
            )}
          </Card>

          {/* R17: latest-payroll-run detail is HR-only — kills the misleading employee-facing
              "No payroll runs yet · Create one →" prompt they can't act on. */}
          {role === 'hr_admin' && (
          <Card className="p-5">
            <h2 className="text-sm font-semibold">{t('latestPayrollRun')}</h2>
            {stats?.latestPayroll ? (
              <div className="mt-3 flex items-center justify-between">
                <div>
                  <div className="text-lg font-semibold">{stats.latestPayroll.payPeriod}</div>
                  <div className="text-xs text-muted-foreground">{t('net', { amount: rm(stats.latestPayroll.net) })}</div>
                </div>
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${PAYROLL_STATUS[stats.latestPayroll.status]}`}
                >
                  {stats.latestPayroll.status}
                </span>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                {t('noPayrollRuns')}{' '}
                <Link href="/payroll" className="text-primary hover:underline">
                  {t('createOne')}
                </Link>
              </p>
            )}
          </Card>
          )}
        </div>

        {recentActivityCard}
      </div>
    </div>
  );
}
