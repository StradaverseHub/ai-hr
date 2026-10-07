import type { ReactNode } from 'react';
import Link from 'next/link';
import type { dashboardStats, groupBreakdown, recentActivity, recentHires, upcomingHolidays } from '@/core/read';
import { deriveEmploymentStatus, type EmploymentStatus } from '@/core/employment-status';
import { HairlineList, Kv, OrdinalSection, Status, type StatusTone } from '@/components/monolith';
import { MONO_LABEL, MONO_NUM } from '@/components/monolith/classes';
import { LeaveBalanceCard } from '@/components/leave-balance-card';
import { aggregateHref, aggregateLabel, canOpenAggregate, humanizeEvent, relativeTime } from '@/lib/audit-format';
import { cn } from '@/lib/utils';

/**
 * r401 — THE DASHBOARD IN MONOLITH (docs/design/monolith/reference/P-Dashboard.dc.html; README §3, §4, §7 step 4).
 *
 * RENDERING ONLY. app/page.tsx runs every read exactly as it always has and hands the SAME values here; this
 * file decides how each of the user's chosen cards looks under <html data-ui-theme="monolith">, nothing else.
 * The Classic cards stay inline in app/page.tsx, byte for byte. Nothing here reads, widens or invents data:
 * every figure, name, date and status word on these nodes is one of the values passed in.
 *
 * THE CUSTOMIZER STILL ARRANGES THE SCREEN. Each node is keyed by the same cardKey the Classic map uses, so
 * the user's saved choice and order — and the Customize mode — work unchanged; a summary card renders as a
 * board `.cell` (mono label, big mono figure, one line under it), every other information card as a `.sec`
 * section whose `01 ·` index is its place in the user's order (components/monolith/section-ordinal.tsx).
 *
 * OMITTED FROM THE BOARD, for want of a real source (never faked): the tower object and its panel (step 5,
 * and no object on this step), the greeting and streak/points/quests line, the "Needs you" approvals TABLE
 * (the page reads the approvals COUNT, not the list), "Departments … needs 2", "230 in now", and the footer's
 * "Sys OK · last sweep" (the shell's status line shows scope only, r398).
 */

type Translator = (key: string, values?: Record<string, string | number>) => string;
type Stats = Awaited<ReturnType<typeof dashboardStats>>;
type Hire = Awaited<ReturnType<typeof recentHires>>[number];
type Holiday = Awaited<ReturnType<typeof upcomingHolidays>>[number];
type Activity = Awaited<ReturnType<typeof recentActivity>>[number];
type Breakdown = Awaited<ReturnType<typeof groupBreakdown>>;

/** The cardKeys that render as numbered sections (everything else on the Monolith dashboard is a cell or a
 *  shortcut). Handed to the customizer so it can number them in the user's order. */
export const MONOLITH_SECTION_KEYS = [
  'attendanceOverview',
  'recentlyJoined',
  'upcomingEvents',
  'recentActivity',
  'headcountByCompany',
  'latestPayrollRun',
  'noticeBoard',
] as const;

/** The board's `.cell`, as a link to the card's destination (the Classic StatCard is a link too). */
export const MONO_CELL = 'flex h-full flex-col gap-1.5 pt-4 pb-[18px] text-ink no-underline';

function Cell({
  label,
  value,
  sub,
  href,
  signal = false,
  text = false,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  href: string;
  /** Needs the viewer: label and figure in signal-text (README §1). Never a fill. */
  signal?: boolean;
  /** The value is a name, not a figure (the next holiday): set in the body face, smaller. */
  text?: boolean;
}) {
  return (
    <Link href={href} data-mono-cell className={cn(MONO_CELL, 'group')}>
      <span className={cn(MONO_LABEL, signal ? 'text-signal-text' : 'text-mid', 'group-hover:text-ink')}>{label}</span>
      <b
        className={cn(
          text
            ? 'text-[22px] font-medium leading-tight tracking-[-0.02em]'
            : cn(MONO_NUM, 'text-[36px] font-medium leading-none tracking-[-0.03em]'),
          signal ? 'text-signal-text' : 'text-ink',
        )}
      >
        {value}
      </b>
      {sub != null && <span className="text-[13px] text-mid">{sub}</span>}
    </Link>
  );
}

/** components.md status tones over the derived Employee Status buckets (core/employment-status.ts). */
const EMPLOYEE_STATUS_TONE: Record<EmploymentStatus, StatusTone> = {
  probation: 'ink',
  active: 'ink',
  active_serving_notice: 'signal',
  resigned: 'mid',
  blacklisted: 'signal',
  withhold: 'signal',
};

/** Payroll batch status → tone: closed is done; draft and processed still need someone (README §4). */
const PAYROLL_TONE: Record<string, StatusTone> = { draft: 'signal', processed: 'signal', closed: 'ink' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-10-01` → `1 Oct` — the board's list lead. Same month abbreviations the Classic card prints. */
const dayMonth = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

export function monolithDashboardBlocks(p: {
  role: 'employee' | 'manager' | 'hr_admin';
  t: Translator;
  tEmployeeStatus: Translator;
  admin: boolean;
  stats: Stats | null;
  att: { date: string | null; present: number; late: number; halfDay: number; absent: number };
  hires: Hire[];
  events: Holiday[];
  activity: Activity[];
  breakdownRows: { row: Breakdown[number]; depth: number }[];
  breakdownTotal: number;
  empBalances: { leaveTypeId: string; leaveType: string; available: number }[];
  empTaskCount: number;
  mgrAwayCount: number;
  mgrApprovals: number;
  mgrReminders: number;
  todayIso: string;
  nowMs: number;
  rm: (n: unknown) => string;
  daysAway: (iso: string) => string;
  joinedAgo: (iso: string) => string;
  noticeBoard: ReactNode;
}): Record<string, ReactNode> {
  const { t, stats, att } = p;
  const attTotal = att.present + att.late + att.halfDay + att.absent;

  const recentlyJoined = (
    <OrdinalSection
      label={t('recentlyJoined')}
      right={
        <Link href="/personnel" className="text-ink underline-offset-4 hover:text-signal-text">
          {t('viewAll')}
        </Link>
      }
    >
      {p.hires.length === 0 ? (
        <p className="m-0 text-[14px] text-mid">{t('noHires', { days: 60 })}</p>
      ) : (
        <HairlineList
          label={t('recentlyJoined')}
          items={p.hires.map((h) => {
            const st = deriveEmploymentStatus(h, p.todayIso);
            return {
              key: h.employmentId,
              lead: dayMonth(h.hiredOn),
              title: h.name,
              sub: `${h.role ?? h.department ?? '—'} · ${p.joinedAgo(h.hiredOn)}`,
              right: p.tEmployeeStatus(st),
              tone: EMPLOYEE_STATUS_TONE[st],
            };
          })}
        />
      )}
    </OrdinalSection>
  );

  const upcomingEvents = (
    <OrdinalSection id="upcoming-events" label={t('upcomingEvents')} right={t('publicHolidays')}>
      {p.events.length === 0 ? (
        <p className="m-0 text-[14px] text-mid">{t('nothingScheduled')}</p>
      ) : (
        <HairlineList
          label={t('upcomingEvents')}
          items={p.events.map((e) => ({ key: e.date, lead: dayMonth(e.date), title: e.name, right: p.daysAway(e.date), tone: 'mid' as const }))}
        />
      )}
    </OrdinalSection>
  );

  const recentActivityNode = (
    <OrdinalSection
      label={t('recentActivity')}
      right={
        p.admin ? (
          <Link href="/admin/audit" className="text-ink underline-offset-4 hover:text-signal-text">
            {t('viewAll')}
          </Link>
        ) : undefined
      }
    >
      {p.activity.length === 0 ? (
        <p className="m-0 text-[14px] text-mid">{t('noActivity')}</p>
      ) : (
        <HairlineList
          label={t('recentActivity')}
          items={p.activity.map((a, i) => {
            // The same reader-can-open rule as the Classic card (47609f53): no link the reader would bounce off.
            const href = canOpenAggregate(a.aggregateType, p.admin) ? aggregateHref(a.aggregateType, a.aggregateId) : undefined;
            return {
              key: String(i),
              lead: relativeTime(a.occurredAt, p.nowMs),
              title: humanizeEvent(a.eventType),
              sub: a.actorName ?? a.actorType,
              right: href ? (
                <Link href={href} className={cn(MONO_LABEL, 'text-ink underline-offset-4 hover:text-signal-text')}>
                  {aggregateLabel(a.aggregateType)}
                </Link>
              ) : (
                <span className={cn(MONO_LABEL, 'text-mid')}>{aggregateLabel(a.aggregateType)}</span>
              ),
            };
          })}
        />
      )}
    </OrdinalSection>
  );

  const attendanceOverview = (
    <OrdinalSection label={t('attendance')} right={att.date ? t('asOf', { date: att.date }) : t('noRecords')}>
      {attTotal === 0 ? (
        <p className="m-0 text-[14px] text-mid">{t('noAttendance')}</p>
      ) : (
        <Kv
          cols={2}
          items={[
            { label: t('present'), value: att.present, big: true },
            { label: t('late'), value: att.late, big: true, tone: att.late > 0 ? 'signal' : undefined },
            { label: t('halfDay'), value: att.halfDay, big: true },
            { label: t('absent'), value: att.absent, big: true, tone: att.absent > 0 ? 'signal' : undefined },
          ]}
        />
      )}
    </OrdinalSection>
  );

  const headcountByCompany = (
    <OrdinalSection label={t('headcountByCompany')} right={t('totalCount', { count: p.breakdownTotal })}>
      {p.breakdownRows.length === 0 ? (
        <p className="m-0 text-[14px] text-mid">{t('noCompanies')}</p>
      ) : (
        <ul aria-label={t('headcountByCompany')} className="m-0 list-none border-b border-hairline p-0">
          {p.breakdownRows.map(({ row, depth }) => (
            <li
              key={row.id}
              className="grid min-h-[46px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-t border-hairline px-0.5 text-[14px]"
            >
              <span className="min-w-0 truncate font-medium" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                {row.name}
              </span>
              <span className={cn(MONO_NUM, 'text-ink')}>{row.headcount}</span>
            </li>
          ))}
        </ul>
      )}
    </OrdinalSection>
  );

  const run = stats?.latestPayroll ?? null;
  const latestPayrollRun = (
    <OrdinalSection label={t('latestPayrollRun')}>
      {run ? (
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-hairline py-2.5">
          <div className="flex min-w-0 flex-col gap-1">
            <span className={cn(MONO_NUM, 'text-[28px] font-medium leading-none tracking-[-0.03em] text-ink')}>{run.payPeriod}</span>
            <span className="text-[13px] text-mid">{t('net', { amount: p.rm(run.net) })}</span>
          </div>
          <Status word={run.status} tone={PAYROLL_TONE[run.status] ?? 'mid'} />
        </div>
      ) : (
        <p className="m-0 text-[14px] text-mid">
          {t('noPayrollRuns')}{' '}
          <Link href="/payroll" className="border-b border-ink text-ink no-underline hover:border-signal-text hover:text-signal-text">
            {t('createOne')}
          </Link>
        </p>
      )}
    </OrdinalSection>
  );

  const nodes: Record<string, ReactNode> = {
    recentlyJoined,
    upcomingEvents,
    recentActivity: recentActivityNode,
    noticeBoard: p.noticeBoard,
  };
  if (p.role === 'employee') {
    nodes.leaveBalance = <LeaveBalanceCard balances={p.empBalances} href="/leave" />;
    nodes.nextHoliday = (
      <Cell
        label={t('nextHoliday')}
        value={p.events[0] ? p.events[0].name : '—'}
        text={!!p.events[0]}
        sub={p.events[0] ? p.daysAway(p.events[0].date) : t('nothingScheduled')}
        href="#upcoming-events"
      />
    );
    nodes.pendingTasks = (
      <Cell label={t('pendingTasks')} value={p.empTaskCount} sub={t('requireYourAttention')} href="/me" signal={p.empTaskCount > 0} />
    );
  } else if (p.role === 'manager') {
    nodes.teamAwayToday = (
      <Cell label={t('teamAwayToday')} value={p.mgrAwayCount} sub={t('onApprovedLeaveToday')} href="/leave/tracker?calendar=1" />
    );
    nodes.approvalRequests = (
      <Cell label={t('approvalRequests')} value={p.mgrApprovals} sub={t('awaitingYourAction')} href="/approvals" signal={p.mgrApprovals > 0} />
    );
    nodes.upcomingReminders = (
      <Cell label={t('upcomingReminders')} value={p.mgrReminders} sub={t('reviewsAndHolidays')} href="#upcoming-events" />
    );
    nodes.attendanceOverview = attendanceOverview;
  } else {
    nodes.headcount = <Cell label={t('headcount')} value={stats?.headcount ?? 0} sub={t('activeEmployees')} href="/personnel" />;
    nodes.pendingLeave = (
      <Cell
        label={t('pendingLeave')}
        value={stats?.pendingLeave ?? 0}
        sub={t('awaitingApproval')}
        href="/leave"
        signal={(stats?.pendingLeave ?? 0) > 0}
      />
    );
    nodes.companies = (
      <Cell
        label={t('companies')}
        value={stats?.companies ?? 0}
        sub={t('departments', { count: stats?.departments ?? 0 })}
        href="/admin/organization"
      />
    );
    nodes.latestPayroll = (
      <Cell
        label={t('latestPayroll')}
        value={run ? p.rm(run.net) : '—'}
        sub={run ? `${run.payPeriod} · ${run.status}` : t('noRunsYet')}
        href="/payroll"
      />
    );
    nodes.attendanceOverview = attendanceOverview;
    nodes.headcountByCompany = headcountByCompany;
    nodes.latestPayrollRun = latestPayrollRun;
  }
  return nodes;
}
