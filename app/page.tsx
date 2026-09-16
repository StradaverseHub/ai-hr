import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  awayTodayCount,
  dashboardStats,
  groupBreakdown,
  leaveBalances,
  listCompanies,
  myEmployment,
  recentActivity,
  recentHires,
  reportingLinesFor,
  upcomingHolidays,
} from '@/core/read';
import { pendingManagerReviewsFor } from '@/core/employment-review';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { myFeedbackRequests } from '@/packs/performance/service';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { MODULE_CATALOG } from '@/packs/catalog';
import { pendingApprovalsCount } from '@/core/approvals-inbox';
import { Card, PageHeader, StatusBadge } from '@/components/ui';
import { LeaveBalanceCard } from '@/components/leave-balance-card';
import {
  type DashboardCardId,
  pendingTasksCount,
  resolveDashboardRole,
  upcomingRemindersCount,
} from '@/lib/dashboard-cards';
import {
  ACTOR_DOT,
  aggregateHref,
  aggregateLabel,
  canOpenAggregate,
  humanizeEvent,
  relativeTime,
} from '@/lib/audit-format';
import { getDashboardLayout } from '@/core/dashboard-prefs';
import { listDashboardCards, type EmployeeDashboardCard } from '@/core/dashboard-card-config';
import { DashboardCustomizer, type CustomizerCard } from '@/components/dashboard-customizer';
import { saveDashboardLayoutAction, resetDashboardLayoutAction } from '@/app/dashboard-layout-actions';
import { BUILTIN_ROLE_DASHBOARD_CARDS, type DashboardLayout } from '@/lib/dashboard-layout';
import { NoticeBoardCardSlot } from '@/components/notice/notice-surfaces';

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
    <Link href={href} className="block h-full">
      <Card className="h-full p-5 transition-colors hover:border-foreground/20">
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

// a00c4f64 — no `searchParams` any more. The four params this page read (?abs / ?view / ?cal / ?focus)
// belonged to the Leave Calendar, which moved to /leave/tracker and still reads all four there.
//
// r292 REINSTATES `searchParams` for ONE param, and does not undo a00c4f64: the four calendar params are
// still gone and still read at /leave/tracker. `?moduleUnavailable=<code>` is the destination half of
// `lib/authz.ts requireModule`, which has redirected here since ADR-0077 slice 4 — carrying the module
// code precisely "so the destination can explain WHICH module" — while this page read the param nowhere
// and said nothing. r292 takes the count of routes that can perform that redirect from 7 to ~90, so a
// silent bounce to the dashboard stops being a rare curiosity and becomes the normal experience of
// declining a module. The code is resolved against MODULE_CATALOG and DISCARDED if unknown: nothing from
// the query string is ever rendered, only a catalogue name that was compiled into the build.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ moduleUnavailable?: string | string[] }>;
}) {
  const t = await getTranslations('dashboard');
  const tModule = await getTranslations('moduleUnavailable');
  const rawUnavailable = (await searchParams)?.moduleUnavailable;
  const unavailableCode = Array.isArray(rawUnavailable) ? rawUnavailable[0] : rawUnavailable;
  const unavailableModule = MODULE_CATALOG.find((m) => m.code === unavailableCode && !m.isCore) ?? null;
  // Employee Status sync (5afcda91): the Onboarding card badge shows the system-derived Employee Status
  // (deriveEmploymentStatus over lifecycle dates) with the shared localized labels — never the legacy
  // stored assignment.status.
  const tEmployeeStatus = await getTranslations('people.employeeStatus');
  const locale = await getLocale(); // R37: render leave-type names in the viewer's language
  const { s, scopeIds, allowedCount } = await scopedSession();
  const now = new Date();
  const nowMs = now.getTime();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayIso = new Date(todayMs).toISOString().slice(0, 10);
  const since60 = new Date(todayMs - 60 * 86_400_000).toISOString().slice(0, 10);

  // R17 e6f0384c — role-based summary cards. Resolve the viewer's dashboard role FIRST (cheap: own
  // employment + reporting edges), then fetch only what the resolved role's cards render. Every read
  // below is an existing scope-fenced read; the role only selects WHICH fenced reads run — it never
  // widens access.
  const me = await myEmployment(s);
  const admin = isAdmin(s);
  const managerRole = (s.roles ?? []).includes('manager');
  // The viewer's reporting edges decide the dashboard ROLE (a Direct Manager by reporting_line edge may
  // hold no `manager` platform role). a00c4f64: this used to also feed the Leave Calendar's person scope
  // and My/Team switch; both moved with the calendar to app/leave/tracker/page.tsx.
  const reportingLines = me ? await reportingLinesFor(s, me.employmentId) : null;
  const hasDirectReports = (reportingLines?.reports.length ?? 0) > 0;
  // A Direct Manager via a reporting_line edge may not hold the `manager` platform role (0110); OR it in.
  const role = resolveDashboardRole({ admin, managerRole, hasDirectReports });
  const wantStats = role === 'hr_admin' || role === 'manager'; // manager needs attendance breakdown
  const wantBreakdown = role === 'hr_admin';

  const [stats, activity, companies, breakdown, hires, events] = await Promise.all([
    wantStats ? dashboardStats(s, scopeIds) : Promise.resolve(null),
    recentActivity(s, 8),
    listCompanies(s),
    wantBreakdown ? groupBreakdown(s) : Promise.resolve([]),
    recentHires(s, scopeIds, { since: since60, limit: 5 }),
    upcomingHolidays(s, { from: todayIso, limit: 5 }),
  ]);

  // Employee card data: own leave balance + own PENDING TASKS. "Pending Tasks" = action items the
  // employee must complete themselves (e.g. give 360 feedback; document-upload obligations plug in as
  // those task types ship) — deliberately NOT the inverse "my requests awaiting someone else's decision".
  // All reads are self-scoped via RLS.
  let empBalances: { leaveTypeId: string; leaveType: string; available: number }[] = [];
  let empTaskCount = 0;
  // Customizable dashboard layout (feedback 7d9d145d → add/remove/shortcut 578a2fcf → per-ROLE 9606c59f):
  // EVERY role now renders through the customizer against its role-filtered catalog (audience column) and
  // its own saved layout slot. The employee path keeps requiring an employment (unchanged behaviour);
  // manager/admin need none. Fall back to the role's built-in set when a tenant has no config rows for the
  // role so no dashboard ever renders blank.
  let savedLayout: DashboardLayout | null = null;
  let roleCards: EmployeeDashboardCard[] = [];
  if (role !== 'employee' || me) {
    const configured = await listDashboardCards(s, role);
    roleCards = configured.length
      ? configured
      : BUILTIN_ROLE_DASHBOARD_CARDS[role].map((c) => ({
          cardKey: c.cardKey,
          name: c.name,
          cardType: c.cardType,
          href: c.href,
          employeeSelectable: c.employeeSelectable,
          defaultDisplay: c.defaultDisplay,
          mandatory: c.mandatory,
          displayOrder: c.displayOrder,
        }));
    // Own-row read via the SECURITY DEFINER seam, normalised to the role's config (legacy flat values are
    // the employee slot, so existing saved employee layouts keep working exactly as they are).
    savedLayout = await getDashboardLayout(s, roleCards, role);
  }
  if (role === 'employee' && me) {
    const [balances, feedbackRequests] = await Promise.all([
      // ec991c2a — the dashboard's own leave card is the SAME employee-facing list as My Leave, and an
      // archived type must not sit on it either. `false` is the default; written out for the same reason
      // the /leave call site writes it out.
      leaveBalances(s, me.employmentId, locale, { includeArchived: false }),
      // r292 — THE DASHBOARD IS THE CORE SCREEN THIS CHANGE COULD MOST PLAUSIBLY BREAK. Performance is an
      // optional pack and `myFeedbackRequests` is now service-gated (core/module-gate.ts), so an
      // unconditional call would throw ModuleNotEnabledError and 500 the dashboard for every employee of a
      // tenant that declined Performance. No module ⇒ no peer-feedback requests ⇒ an empty list is also the
      // truthful answer, not merely the safe one.
      isModuleEnabledOrFalse(s, 'performance') ? myFeedbackRequests(s) : Promise.resolve([]),
    ]);
    empBalances = balances.map((b) => ({ leaveTypeId: b.leaveTypeId, leaveType: b.leaveType, available: b.available }));
    empTaskCount = pendingTasksCount([feedbackRequests.length]);
  }

  // Manager card data: team away today, the same approvals count as the bell, and the Upcoming Reminders
  // digest (review deadlines assigned to this manager + company holidays soon).
  let mgrAwayCount = 0;
  let mgrApprovals = 0;
  let mgrReminders = 0;
  if (role === 'manager') {
    // "Team Away Today" is counted over the SAME population it counted before eae550e9 (company scope
    // under RLS) by one narrow indexed count — core/read.ts awayTodayCount — rather than by projecting the
    // calendar. That independence is why a00c4f64 could move the calendar off this page without touching
    // the figure. Semantics preserved bit-for-bit: distinct persons ≠ viewer with an approved leave
    // covering today (per-date-approval aware).
    const [awayCount, approvals, reviewDeadlines] = await Promise.all([
      awayTodayCount(s, scopeIds, todayIso, s.personId ?? null),
      // r292 — see core/approvals-inbox.ts InboxModules. The dashboard is a page, so the quiet form is
      // the right one: a resolver outage must cost the two module queues, not the whole tile.
      pendingApprovalsCount(s, scopeIds, {
        attendance: isModuleEnabledOrFalse(s, 'attendance'),
        claims: isModuleEnabledOrFalse(s, 'claims'),
      }),
      // Performance / probation review deadlines assigned to this manager (the reporter's "review
      // deadlines" reminder). Same queue the bell counts — surfaced here as an upcoming reminder too.
      me ? pendingManagerReviewsFor(s, me.employmentId) : Promise.resolve([]),
    ]);
    mgrAwayCount = awayCount;
    mgrApprovals = approvals;
    // Reminder window: holidays in the next 30 days + the manager's open review deadlines. (No training
    // module yet, so training reminders contribute 0 — the helper absorbs them when one ships.)
    const reminderCutoffIso = new Date(todayMs + 30 * 86_400_000).toISOString().slice(0, 10);
    mgrReminders = upcomingRemindersCount(events, reviewDeadlines.length, todayIso, reminderCutoffIso);
  }

  const att = stats?.attendance ?? { date: null as string | null, present: 0, late: 0, halfDay: 0, absent: 0 };
  const attTotal = att.present + att.late + att.halfDay + att.absent;
  const pct = (n: number) => (attTotal ? `${(n / attTotal) * 100}%` : '0%');

  // Map a card id → its rendered card (the role summary cards; arrangement now comes from the per-role
  // customizer layout, 9606c59f). `leaveBalance` renders the interactive client island; the rest are plain
  // StatCards. Non-`#` hrefs navigate; `#…` scroll to an in-page anchor added below.
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
        // a00c4f64 — a NAVIGATION to the Team Leave Tracker, not an anchor jump: the calendar this card
        // was a shortcut into is no longer on this page. Mirrors lib/dashboard-cards CARD_META.teamAwayToday.
        return <StatCard key={id} label={t('teamAwayToday')} value={mgrAwayCount} hint={t('onApprovedLeaveToday')} href="/leave/tracker" />;
      case 'approvalRequests':
        return <StatCard key={id} label={t('approvalRequests')} value={mgrApprovals} hint={t('awaitingYourAction')} href="/approvals" />;
      case 'upcomingReminders':
        return <StatCard key={id} label={t('upcomingReminders')} value={mgrReminders} hint={t('reviewsAndHolidays')} href="#upcoming-events" />;
    }
  };

  const recentlyJoinedCard = (
    <Card className="h-full p-5">
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
              {(() => {
                const st = deriveEmploymentStatus(h, todayIso);
                return <StatusBadge status={st} label={tEmployeeStatus(st)} />;
              })()}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  const upcomingEventsCard = (
    <Card id="upcoming-events" className="h-full scroll-mt-4 p-5">
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
    <Card className="h-full p-5">
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
            // 47609f53 — offer the link only when this reader can actually open the destination.
            // `admin` is isAdmin(s), hoisted above. A non-admin's feed is RLS-limited to rows about
            // people they can see, so what they lose is the link into the admin-only Personnel screen
            // that redirected them back here; the performance-review link (which they CAN open) stays.
            const href = canOpenAggregate(a.aggregateType, admin)
              ? aggregateHref(a.aggregateType, a.aggregateId)
              : undefined;
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

  // 9606c59f — the manager/admin dashboard sections card-wrapped so the customizer can arrange them.
  // R17 semantics preserved: attendance breakdown is manager + hr_admin (audience-gated in the catalog);
  // headcount-by-company and the latest-payroll-run detail are hr_admin-only.
  const attendanceOverviewCard = (
    <Card className="h-full p-5">
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
  );

  const headcountByCompanyCard = (
    <Card className="h-full overflow-hidden">
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
  );

  const latestPayrollRunCard = (
    <Card className="h-full p-5">
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
  );

  const pageHeader = (
    <PageHeader
      title={t('title')}
      description={
        // Counted against what this user may REACH, not against every company in the tenant
        // (feedback ab77dc1f). `companies` comes from listCompanies, which is tenant-scoped, so a user
        // allowed 2 of 8 was told "2 of 8" — reading as six companies withheld, and telling them the
        // organisation's company count, which their access does not otherwise reveal. With the right
        // denominator that same user now sees "all", because they genuinely are seeing all of theirs.
        scopeIds.length >= allowedCount
          ? t('overviewAll')
          : t('overviewScoped', { count: scopeIds.length, total: allowedCount })
      }
    />
  );

  // One customizer for EVERY role (feedback 9606c59f): the role-filtered catalog decides which cards are
  // on the shelf; the bespoke information-card nodes are pre-rendered here keyed by cardKey. Only nodes
  // whose data was loaded for this role are mapped — the audience column keeps the catalog and the node
  // map in step, and a shortcut/action card with no node renders generically from its configured href.
  const cardNodes: Record<string, ReactNode> = {
    recentlyJoined: recentlyJoinedCard,
    upcomingEvents: upcomingEventsCard,
    recentActivity: recentActivityCard,
    // 6e122302 — the Notice Board card, for EVERY role: a notice targets an employment, and an admin or a
    // manager is an employee who receives announcements like anyone else. The slot resolves its own
    // employment and renders null when there is none, so it needs no role branch below. Its copy lives in
    // its own single-namespace module for i18n coverage — see that file's header.
    noticeBoard: <NoticeBoardCardSlot s={s} />,
  };
  if (role === 'employee') {
    cardNodes.leaveBalance = renderCard('leaveBalance');
    cardNodes.nextHoliday = renderCard('nextHoliday');
    cardNodes.pendingTasks = renderCard('pendingTasks');
  } else if (role === 'manager') {
    cardNodes.teamAwayToday = renderCard('teamAwayToday');
    cardNodes.approvalRequests = renderCard('approvalRequests');
    cardNodes.upcomingReminders = renderCard('upcomingReminders');
    cardNodes.attendanceOverview = attendanceOverviewCard;
  } else {
    cardNodes.headcount = renderCard('headcount');
    cardNodes.pendingLeave = renderCard('pendingLeave');
    cardNodes.companies = renderCard('companies');
    cardNodes.latestPayroll = renderCard('latestPayroll');
    cardNodes.attendanceOverview = attendanceOverviewCard;
    cardNodes.headcountByCompany = headcountByCompanyCard;
    cardNodes.latestPayrollRun = latestPayrollRunCard;
  }

  const customizerCards: CustomizerCard[] = roleCards.map((c) => ({
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
      {unavailableModule && (
        <Card className="border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/40">
          <h2 className="text-sm font-semibold">{tModule('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{tModule('body', { module: unavailableModule.name })}</p>
        </Card>
      )}
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
