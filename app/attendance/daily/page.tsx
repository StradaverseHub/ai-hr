import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { attendanceForDate } from '@/core/attendance';
import { otByRate, flagOf, statusOf, type AttendanceStatus, type AttendanceFlag } from '@/core/attendance-derive';
import { listCompanies, listDepartments } from '@/core/read';
import { Avatar, Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { AttendanceTabs } from '@/components/attendance-tabs';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { checkInAction, checkOutAction } from '../actions';

import { todayInKualaLumpur } from '@/lib/hr-date';

const fmtMin = (m: number | null | undefined) =>
  m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
/** OT columns render as decimal hours (2 dp), matching the request's example (0.50 / 1.00). */
const fmtHours2 = (m: number) => (m / 60).toFixed(2);
/** Lateness / Early Out are small figures — "12m" reads better than "0h 12m". NULL stays an em dash: it
 *  means no engine computed the day, which is not at all the same claim as "on time". */
const fmtShort = (m: number | null | undefined) =>
  m == null ? '—' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

/**
 * Attendance > Records — Daily Attendance tab. Enhanced verification table (feedback bbada39c): employee
 * code + name split into two columns, the assigned Shift Code, scheduled-vs-actual hours, the day's
 * lateness and early-out, the day's overtime split across the rate buckets, a single always-present Status
 * (Absent in red only) and an operational Flag (Late / Under / Odd). The check-in / check-out controls (the
 * Approved/Lock action area) and the Company / Department / Date filters are unchanged.
 *
 * Read-only: no DomainEvent — this view persists nothing new (the substrate skip is deliberate).
 */
export default async function DailyAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    date?: string;
    company?: string;
    dept?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const t = await getTranslations('attendance');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  // v1 Status labels. present/absent reuse the existing keys (capitalised in render); the finer leave
  // sub-codes (AL/ML/EL/RL) + Travel/Training remain a documented follow-up — the loader collapses all
  // approved leave to a single On-Leave context.
  const statusText: Record<AttendanceStatus, string> = {
    present: t('statusPresent'),
    absent: t('statusAbsent'),
    rest: t('statusRest'),
    off: t('statusOff'),
    ph: t('statusPh'),
    on_leave: t('statusOnLeave'),
  };
  const flagText: Record<Exclude<AttendanceFlag, null>, string> = {
    late: t('flagLate'),
    under: t('flagUnder'),
    odd: t('flagOdd'),
  };
  const todayIso = todayInKualaLumpur();
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso;

  const [companies, departments] = await Promise.all([
    listCompanies(s),
    listDepartments(s, { companyIds: scopeIds }),
  ]);
  // Company filter narrows the scope to a single company (still fenced by the switcher scope); Department
  // filters via the employee's current assignment. Blank = all companies in scope / all departments.
  const companyFilter = sp.company && scopeIds.includes(sp.company) ? sp.company : undefined;
  const deptFilter = sp.dept && departments.some((d) => d.id === sp.dept) ? sp.dept : undefined;
  const effectiveScope = companyFilter ? [companyFilter] : scopeIds;
  const rows = await attendanceForDate(s, date, effectiveScope, { departmentId: deptFilter });
  // fc776376 — one row per employee for the chosen day: a genuine list that grows with headcount.
  const { rows: dayPage, state: pgState } = paginateRows(rows, parsePageQuery(sp));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} />
      <AttendanceTabs active="daily" />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden" data-tour="attendance-day">
        <SectionHeader title={date === todayIso ? t('today') : date} count={rows.length} />
        {/* Filter panel — plain GET form (server-driven, no-JS): Company · Department · Date. Unchanged. */}
        <form method="GET" className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.company')}
            <select name="company" defaultValue={companyFilter ?? ''} className={inputCls}>
              <option value="">{t('filters.allCompanies')}</option>
              {companies
                .filter((c) => scopeIds.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.department')}
            <select name="dept" defaultValue={deptFilter ?? ''} className={inputCls}>
              <option value="">{t('filters.allDepartments')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.date')}
            <input type="date" name="date" defaultValue={date} className={inputCls} />
          </label>
          <Button type="submit" variant="outline" size="sm">
            {t('filters.apply')}
          </Button>
        </form>
        {/* Wide table — the extra columns scroll horizontally on narrow screens. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[80rem] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('colEmployeeCode')}</th>
                <th className="px-3 py-2 font-medium">{t('colEmployeeName')}</th>
                <th className="px-3 py-2 font-medium">{t('colShiftCode')}</th>
                <th className="px-3 py-2 font-medium">{t('colCheckIn')}</th>
                <th className="px-3 py-2 font-medium">{t('colCheckOut')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colShiftHours')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colActualHours')}</th>
                {/* 7c834696 rev 2 point 2 — Lateness / Early Out, in the position the reporter specified:
                    after Actual Working Hours, before the OT columns. Stored since migration 0394. */}
                <th className="px-3 py-2 text-right font-medium">{t('colLateness')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colEarlyOut')}</th>
                {/* 7c834696 rev 2 point 1 — the six OT columns are OVERTIME ONLY and sum to the day's OT,
                    not to the Actual Hours beside them. Normal hours are that column's job. */}
                <th className="px-3 py-2 text-right font-medium">{t('colOtFlat')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt00')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt10')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt15')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt20')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt30')}</th>
                <th className="px-3 py-2 font-medium" data-tour="attendance-status">{t('colStatus')}</th>
                <th className="px-3 py-2 font-medium">{t('colFlag')}</th>
                <th className="px-3 py-2 text-right font-medium" data-tour="attendance-action">{t('colAction')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {dayPage.map((r) => {
                const ot = otByRate(r);
                const status = statusOf(r);
                const flag = flagOf(r);
                return (
                  <tr key={r.employmentId}>
                    <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{r.employeeCode ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={r.name} className="size-7 text-[10px]" />
                        <span className="font-medium">{r.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{r.shiftCode ?? '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{r.checkInAt?.slice(0, 5) ?? '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{r.checkOutAt?.slice(0, 5) ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMin(r.scheduledMinutes)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMin(r.workedMinutes)}</td>
                    {/* NULL, not 0, for a day no engine has computed — an em dash rather than a confident
                        "on time". Days before the stage-1 release carry null and read as "—". */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtShort(r.lateMinutes)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtShort(r.earlyOutMinutes)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.attendanceId ? fmtHours2(ot.flat) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.attendanceId ? fmtHours2(ot.ot00) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.attendanceId ? fmtHours2(ot.ot10) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.attendanceId ? fmtHours2(ot.ot15) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.attendanceId ? fmtHours2(ot.ot20) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.attendanceId ? fmtHours2(ot.ot30) : '—'}</td>
                    <td className="px-3 py-2.5">
                      {/* Only Absent in red; every other status uses the standard text colour. */}
                      <span className={`capitalize ${status === 'absent' ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                        {statusText[status]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {flag ? (
                        <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{flagText[flag]}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {/* Approved/Lock action area — unchanged check-in / check-out controls. */}
                      <div className="flex justify-end">
                        {!r.attendanceId ? (
                          <form action={checkInAction} className="flex items-center gap-2">
                            <input type="hidden" name="employmentId" value={r.employmentId} />
                            <input type="hidden" name="date" value={date} />
                            <input name="time" type="time" defaultValue="09:00" className={`${inputCls} h-8 w-28`} />
                            <Button type="submit" size="sm">
                              {t('checkIn')}
                            </Button>
                          </form>
                        ) : !r.checkOutAt ? (
                          <form action={checkOutAction} className="flex items-center gap-2">
                            <input type="hidden" name="employmentId" value={r.employmentId} />
                            <input type="hidden" name="date" value={date} />
                            <input name="time" type="time" defaultValue="18:00" className={`${inputCls} h-8 w-28`} />
                            <Button type="submit" size="sm" variant="secondary">
                              {t('checkOut')}
                            </Button>
                          </form>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('done')}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {dayPage.length === 0 && (
                <tr>
                  <td colSpan={18} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noEmployees')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath="/attendance/daily"
          params={{ date: sp.date, company: sp.company, dept: sp.dept }}
          state={pgState}
        />
      </Card>
    </div>
  );
}
