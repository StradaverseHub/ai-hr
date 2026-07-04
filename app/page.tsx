import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  dashboardStats,
  groupBreakdown,
  listCompanies,
  plannedAbsences,
  recentActivity,
  recentHires,
  upcomingHolidays,
} from '@/core/read';
import { todayInKualaLumpur } from '@/core/leave';
import { Card, PageHeader, StatusBadge } from '@/components/ui';
import { PlannedAbsences } from '@/components/planned-absences';
import { TimelineNav } from '@/components/timeline-nav';
import { requestLeaveCancellationAction } from '@/app/leave/actions';
import { ACTOR_DOT, aggregateHref, aggregateLabel, humanizeEvent, relativeTime } from '@/lib/audit-format';

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
  const [stats, activity, companies, breakdown, absences, hires, events] = await Promise.all([
    dashboardStats(s, scopeIds),
    recentActivity(s, 8),
    listCompanies(s),
    groupBreakdown(s),
    // Partial Leave Cancellation from the calendar (ADR-0065): pass MYT "today" so each approved row's
    // cancellable candidate dates match the Leave page / service cut-off exactly (strictly-after-MYT).
    plannedAbsences(s, scopeIds, { from: absFrom, to: absTo }, todayInKualaLumpur()),
    recentHires(s, scopeIds, { since: since60, limit: 5 }),
    upcomingHolidays(s, { from: todayIso, limit: 5 }),
  ]);
  const att = stats.attendance;
  const attTotal = att.present + att.late + att.halfDay + att.absent;
  const pct = (n: number) => (attTotal ? `${(n / attTotal) * 100}%` : '0%');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('title')}
        description={
          scopeIds.length >= companies.length
            ? t('overviewAll')
            : t('overviewScoped', { count: scopeIds.length, total: companies.length })
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t('headcount')} value={stats.headcount} hint={t('activeEmployees')} href="/personnel" />
        <StatCard label={t('pendingLeave')} value={stats.pendingLeave} hint={t('awaitingApproval')} href="/leave" />
        <StatCard
          label={t('companies')}
          value={stats.companies}
          hint={t('departments', { count: stats.departments })}
          href="/admin/organization"
        />
        <StatCard
          label={t('latestPayroll')}
          value={stats.latestPayroll ? rm(stats.latestPayroll.net) : '—'}
          hint={stats.latestPayroll ? `${stats.latestPayroll.payPeriod} · ${stats.latestPayroll.status}` : t('noRunsYet')}
          href="/payroll"
        />
      </div>

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
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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

        <Card className="p-5">
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
      </div>

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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
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

          <Card className="p-5">
            <h2 className="text-sm font-semibold">{t('latestPayrollRun')}</h2>
            {stats.latestPayroll ? (
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
        </div>

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
      </div>
    </div>
  );
}
