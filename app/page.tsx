import type { ReactNode } from 'react';
import Link from 'next/link';
import { scopedSession } from '@/lib/scope';
import { dashboardStats, groupBreakdown, listCompanies, plannedAbsences, recentActivity } from '@/core/read';
import { Card } from '@/components/ui';
import { PlannedAbsences } from '@/components/planned-absences';

const rm = (n: unknown) =>
  n == null
    ? '—'
    : `RM ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function humanizeEvent(type: string) {
  return type
    .split('.')
    .join(' ')
    .replace(/-/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function relativeTime(d: Date | string) {
  const t = typeof d === 'string' ? new Date(d) : d;
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : t.toLocaleDateString();
}

const PAYROLL_STATUS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  processed: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  closed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};

const ACTOR_DOT: Record<string, string> = {
  user: 'bg-primary',
  system: 'bg-muted-foreground',
  agent: 'bg-violet-500',
  external: 'bg-amber-500',
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

export default async function DashboardPage() {
  const { s, scopeIds } = await scopedSession();
  // 14-day planned-absences window, starting 2 days before today.
  const now = new Date();
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 2 * 86_400_000;
  const ABS_DAYS = 14;
  const absFrom = new Date(startMs).toISOString().slice(0, 10);
  const absTo = new Date(startMs + (ABS_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const todayIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  const [stats, activity, companies, breakdown, absences] = await Promise.all([
    dashboardStats(s, scopeIds),
    recentActivity(s, 8),
    listCompanies(s),
    groupBreakdown(s),
    plannedAbsences(s, scopeIds, { from: absFrom, to: absTo }),
  ]);
  const att = stats.attendance;
  const attTotal = att.present + att.late + att.halfDay + att.absent;
  const pct = (n: number) => (attTotal ? `${(n / attTotal) * 100}%` : '0%');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {scopeIds.length >= companies.length
            ? 'All companies'
            : `${scopeIds.length} of ${companies.length} companies`}{' '}
          · overview
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Headcount" value={stats.headcount} hint="Active employees" href="/people" />
        <StatCard label="Pending leave" value={stats.pendingLeave} hint="Awaiting approval" href="/leave" />
        <StatCard
          label="Companies"
          value={stats.companies}
          hint={`${stats.departments} departments`}
          href="/admin/organization"
        />
        <StatCard
          label="Latest payroll"
          value={stats.latestPayroll ? rm(stats.latestPayroll.net) : '—'}
          hint={stats.latestPayroll ? `${stats.latestPayroll.payPeriod} · ${stats.latestPayroll.status}` : 'No runs yet'}
          href="/payroll"
        />
      </div>

      <PlannedAbsences rows={absences} from={absFrom} days={ABS_DAYS} todayIso={todayIso} />

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-semibold">Headcount by company</h2>
          <span className="text-xs text-muted-foreground">
            {breakdown.reduce((sum, c) => sum + c.headcount, 0)} total
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
                  No companies yet.
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
              <h2 className="text-sm font-semibold">Attendance</h2>
              <span className="text-xs text-muted-foreground">{att.date ? `as of ${att.date}` : 'no records'}</span>
            </div>
            {attTotal === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">No attendance recorded yet.</p>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-4 gap-3">
                  {(
                    [
                      ['Present', att.present, 'text-emerald-600 dark:text-emerald-400'],
                      ['Late', att.late, 'text-amber-600 dark:text-amber-400'],
                      ['Half day', att.halfDay, 'text-blue-600 dark:text-blue-400'],
                      ['Absent', att.absent, 'text-rose-600 dark:text-rose-400'],
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
            <h2 className="text-sm font-semibold">Latest payroll run</h2>
            {stats.latestPayroll ? (
              <div className="mt-3 flex items-center justify-between">
                <div>
                  <div className="text-lg font-semibold">{stats.latestPayroll.payPeriod}</div>
                  <div className="text-xs text-muted-foreground">Net {rm(stats.latestPayroll.net)}</div>
                </div>
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${PAYROLL_STATUS[stats.latestPayroll.status]}`}
                >
                  {stats.latestPayroll.status}
                </span>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                No payroll runs yet.{' '}
                <Link href="/payroll" className="text-primary hover:underline">
                  Create one →
                </Link>
              </p>
            )}
          </Card>
        </div>

        <Card className="p-5">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <p className="text-xs text-muted-foreground">From the domain-event log</p>
          {activity.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {activity.map((a, i) => (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${ACTOR_DOT[a.actorType] ?? 'bg-muted-foreground'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{humanizeEvent(a.eventType)}</div>
                    <div className="text-xs text-muted-foreground">
                      {a.aggregateType} · {a.actorType} · {relativeTime(a.occurredAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
