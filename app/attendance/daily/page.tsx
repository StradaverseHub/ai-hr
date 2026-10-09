import Link from 'next/link';
import { Fragment } from 'react';
import { getTranslations } from 'next-intl/server';
import { placeStickyColumns } from '@/lib/sticky-columns';
import { scopedSession } from '@/lib/scope';
import { attendanceForDatePage, attendancePunchesForDays, ATTENDANCE_DAILY_Q_MAX } from '@/core/attendance';
import { flagOf, statusOf } from '@/core/attendance-derive';
import { listCompanies, listDepartments } from '@/core/read';
import { Avatar, Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { AttendanceTabs } from '@/components/attendance-tabs';
import { AttendanceDayCells, AttendanceTrailRow, dayCellLabels } from '@/components/attendance-day-cells';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Attendance > Employee Attendance — Daily Attendance tab. r432 (e721a355): "Individual Attendance, for
 * everyone, on one day". The same ten columns as Individual Attendance, in the same order, with the same
 * Status / Flag cells and the same multi-clocking line (all drawn by components/attendance-day-cells), with
 * Code and Name where Individual has Date and Day. The lateness / early-out / overtime figures and the typed
 * clock-in / clock-out boxes left the list (570fd56e made the same decision for Individual): the figures
 * and the one-action correction live on the day screen, one click away through "View/Edit".
 *
 * Search (name or employee ID) and paging are done in SQL (attendanceForDatePage): only the people on the
 * page are derived. Who can be seen is unchanged: scopedSession + the company switcher scope + row-level
 * security. Read-only: no DomainEvent — this view persists nothing.
 */
export default async function DailyAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    date?: string;
    company?: string;
    dept?: string;
    q?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const t = await getTranslations('attendance');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const labels = dayCellLabels(t);
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
  const q = (sp.q ?? '').trim().slice(0, ATTENDANCE_DAILY_Q_MAX);
  const pq = parsePageQuery(sp);
  const { rows: dayPage, total } = await attendanceForDatePage(s, date, effectiveScope, {
    departmentId: deptFilter,
    q,
    limit: pq.limit,
    offset: pq.offset,
  });
  const pgState = pageState(pq, total, dayPage.length);
  // R45 — the clocking trail for the page's days only (one read), for the "several clockings" line.
  const punchesByAttendance = await attendancePunchesForDays(
    s,
    dayPage.flatMap((r) => (r.attendanceId ? [r.attendanceId] : [])),
  );

  /**
   * dde08629 (r319) — the sticky identity columns. `left-[7rem]` is arithmetic, not a guess: the code
   * column is `px-3` (0.75rem each side) around a tabular-nums code, and 7rem is where the name column
   * therefore begins. A sticky cell MUST carry an opaque background — the default is transparent, and a
   * transparent sticky cell shows the scrolled content passing underneath it.
   */
  /**
   * f728826a — THE SAME LATENT FAULT AS THE BREAKDOWN SCREEN, FIXED BEFORE IT WAS REPORTED.
   *
   * These two were `left-0` / `left-[7rem]` with no width on either, so the 7rem offset was an assumption
   * about how wide the code column happened to render. `min-w-[80rem]` masked it here — the table was
   * rarely squeezed, so the columns rarely drifted — but the arithmetic was just as unbacked. Width and
   * offset now come from the single declaration in lib/sticky-columns.ts.
   */
  const STICKY = placeStickyColumns([
    { key: 'employeeCode', rem: 7 },
    { key: 'employeeName', rem: 14 },
  ]);
  const stick = (head: boolean) =>
    `sticky z-10 whitespace-nowrap px-3 ${head ? 'py-2 font-medium bg-muted' : 'py-2.5 bg-card'}`;

  return (
    <div className={pageWideCls}>
      {/* dde08629 (r319) — FULL WIDTH, the same `pageWideCls` eight other Attendance screens already use
          and test/attendance-screens-layout.test.ts already pins for them. These three were simply never
          added: at `mx-auto max-w-6xl` a sixteen-column table sat in a 72rem middle column with roughly a
          third of a wide monitor as empty margin either side — the reporter's complaint verbatim. The
          one-column rule form stays capped on purpose; see NARROW_FORM_SCREENS in that guard. */}
      <PageHeader title={t('title')} />
      <AttendanceTabs active="daily" />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden" data-tour="attendance-day">
        <SectionHeader title={date === todayIso ? t('today') : date} count={total} />
        {/* Filter panel — plain GET form (server-driven, no-JS): Search · Company · Department · Date. */}
        <form method="GET" className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.search')}
            <input
              type="search"
              name="q"
              defaultValue={q}
              maxLength={ATTENDANCE_DAILY_Q_MAX}
              placeholder={t('filters.searchPlaceholder')}
              className={inputCls}
            />
          </label>
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
          <table className="w-max min-w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {/* dde08629 (r319) — the two identity columns stay put while the other sixteen scroll.
                    Same shape as 22d67223's `stick()` on the Breakdown screen, and for the same reason a
                    sticky cell there carries its own surface colour: a transparent one shows the scrolled
                    content sliding underneath it. The header takes the table head's own background, the
                    body cells the card's. */}
                <th className={stick(true)} style={STICKY[0].style}>{t('colEmployeeCode')}</th>
                <th className={stick(true)} style={STICKY[1].style}>{t('colEmployeeName')}</th>
                <th className="px-3 py-2 font-medium">{t('colShiftCode')}</th>
                <th className="px-3 py-2 font-medium">{t('colCheckIn')}</th>
                <th className="px-3 py-2 font-medium">{t('colCheckOut')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colShiftHours')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colActualHours')}</th>
                <th className="px-3 py-2 font-medium" data-tour="attendance-status">{t('colStatus')}</th>
                <th className="px-3 py-2 font-medium">{t('colFlag')}</th>
                <th className="px-3 py-2 font-medium" data-tour="attendance-action">{t('colAction')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {dayPage.map((r) => {
                const status = statusOf(r);
                const flag = flagOf(r);
                const punches = r.attendanceId ? punchesByAttendance.get(r.attendanceId) ?? [] : [];
                return (
                  <Fragment key={r.employmentId}>
                    <tr>
                      <td className={`${stick(false)} tabular-nums text-muted-foreground`} style={STICKY[0].style}>
                        {r.employeeCode ?? '—'}
                      </td>
                      <td className={`${stick(false)} overflow-hidden`} style={STICKY[1].style} title={r.name}>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={r.name} className="size-7 text-[10px]" />
                          <span className="truncate font-medium">{r.name}</span>
                        </div>
                      </td>
                      <AttendanceDayCells row={r} status={status} flag={flag} labels={labels} />
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/attendance/individual/${date}?emp=${encodeURIComponent(r.employmentId)}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {t('dayViewEdit')}
                        </Link>
                      </td>
                    </tr>
                    <AttendanceTrailRow punches={punches} colSpan={10} labels={labels} />
                  </Fragment>
                );
              })}
              {dayPage.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noEmployees')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath="/attendance/daily"
          params={{ date: sp.date, company: sp.company, dept: sp.dept, q: q || undefined }}
          state={pgState}
        />
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t('dailyCalcNote')}</p>
      </Card>
    </div>
  );
}
