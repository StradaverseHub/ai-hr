import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceForEmploymentRange, attendancePunchesForRange } from '@/core/attendance';
import { otByRate, flagOf, statusOf, type AttendanceStatus, type AttendanceFlag } from '@/core/attendance-derive';
import { explainAttendanceDay } from '@/core/attendance-explain';
import { listEmployees } from '@/core/read';
import { Button, Card, PageHeader, inputCls } from '@/components/ui';
import { fmtMin, fmtDayDate, fmtDayName } from '@/components/attendance-format';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * 22d67223 — ATTENDANCE › ATTENDANCE BREAKDOWN DETAIL.
 *
 * The reporter's words: "primarily intended for viewing, verification, troubleshooting, and
 * payroll/attendance calculation checking". So this is the AUDIT surface, and it is the deliberate opposite
 * of 570fd56e — which took eight calculation columns OFF Individual Attendance because eighteen columns
 * could not be scanned. One screen to review a month, one to interrogate it. They are not in tension; they
 * answer different questions.
 *
 * ⚠️ NOT A SECOND SOURCE OF FIGURES, which is the reporter's own requirement 6 ("shall use the existing
 * attendance calculation data… shall not create a separate calculation"). Every number here comes from
 * `attendanceForEmploymentRange` — the SAME read Individual Attendance and its day screen use — and every
 * duration is formatted by the SAME `fmtMin` the other tables use. Nothing is recomputed and nothing is
 * stored.
 *
 * THE TRACE IS READ THROUGH `explainAttendanceDay`, NEVER OFF `calcTrace` DIRECTLY. That field is typed
 * `unknown` on purpose (core/attendance.ts ~:2314) so only the module that validates its version may read
 * it; a screen reaching for `.overtime.minutes` on a row written by an older build is exactly what the
 * typing forbids. A day whose trace is missing or from an unknown version prints "not recorded" rather than
 * a confident blank.
 *
 * ── COLUMNS THE REPORTER ASKED FOR THAT ARE NOT HERE, AND WHY ────────────────────────────────────────
 * About a third of the ~35 requested fields have no source in this system, and on a screen whose entire
 * purpose is checking figures a plausible-but-wrong column is worse than an absent one. The plan put each
 * of these to the reporter as a question rather than guessing:
 *   · Shift First/Second Half Working Mins, Leave Code 1st/2nd Half — no half-day split is stored.
 *   · Late on Shift Break / Early Out on Shift Break / Flexi Break — the trace holds `breakMinutes` and
 *     `breakSpanned` only; there are no punches WITHIN a break.
 *   · Early In / Early In Shift / Late In Shift / Late Out / Early Out in Shift — lateness and early-out
 *     exist; minutes before and after the shift exist as OVERTIME. Whether the reporter means those figures
 *     or something else is UNKNOWN.
 *   · Shift Group ID, Day Type Today, Day Code — UNKNOWN. `schedule.ruleId` is the attendance rule and may
 *     be what "Shift Group ID" means; that is a guess, so it is asked rather than shipped.
 *   · Schedule Overtime vs Approved Overtime — planned OT is its own function; how the two line up per row
 *     needs deciding.
 */
export default async function AttendanceBreakdownPage({
  searchParams,
}: {
  searchParams: Promise<{ emp?: string; from?: string; to?: string; page?: string; size?: string }>;
}) {
  const t = await getTranslations('attendance');
  const locale = await getLocale();
  // ⚠️ scopedAdmin, NOT scopedSession, and the difference is a leak rather than a preference.
  // `scopedSession` resolves a COMPANY scope; `listEmployees` below is tenant-scoped and filtered only by
  // those company ids, with no narrowing by role. Under scopedSession a plain employee deep-linking this
  // URL would get a picker naming every colleague in their company and could read any one of their full
  // calculation audits. The adminOnly flag on the nav row hides the link and protects nothing — which is
  // the exact failure test/attendance-menu-relocation.test.ts exists to catch. '/attendance' next door can
  // be scopedSession because it is genuinely self-service and its service narrows the reading; this screen
  // has no self-service entry point, so it refuses instead.
  const { s, scopeIds } = await scopedAdmin();
  const sp = await searchParams;

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const todayIso = todayInKualaLumpur();
  const from = sp.from && dateRe.test(sp.from) ? sp.from : `${todayIso.slice(0, 7)}-01`;
  const to = sp.to && dateRe.test(sp.to) ? sp.to : todayIso;

  const employees = await listEmployees(s, scopeIds);
  const selectedEmp = sp.emp && employees.some((e) => e.employmentId === sp.emp) ? sp.emp : undefined;
  const selected = employees.find((e) => e.employmentId === selectedEmp);

  const rows = selectedEmp ? await attendanceForEmploymentRange(s, selectedEmp, from, to) : [];
  const punchesByAttendance = selectedEmp
    ? await attendancePunchesForRange(s, selectedEmp, from, to)
    : new Map();

  // paginateRows fetches then SLICES and hands back the page state with it — the same call shape
  // Individual Attendance uses, so the two screens page identically.
  const { rows: dayPage, state: pgState } = paginateRows(rows, parsePageQuery(sp));

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

  const DASH = '—';
  const th = 'whitespace-nowrap px-2 py-2 font-medium';
  const thNum = `${th} text-right`;
  const td = 'whitespace-nowrap px-2 py-2 text-muted-foreground';
  const tdNum = `${td} text-right tabular-nums`;
  /** Sticky identity columns. A transparent sticky cell shows the scrolled content underneath, so each
   *  carries the surface colour of the row it belongs to. */
  const stick = (left: string, head: boolean) =>
    `sticky ${left} z-10 whitespace-nowrap px-2 py-2 ${head ? 'bg-muted font-medium' : 'bg-card'}`;

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader title={t('breakdownTitle')} description={t('breakdownDescription')} />

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('colEmployeeName')}
          <select name="emp" defaultValue={selectedEmp ?? ''} className={inputCls}>
            <option value="">—</option>
            {employees.map((e) => (
              <option key={e.employmentId} value={e.employmentId}>
                {e.employeeCode ? `${e.employeeCode} — ${e.name}` : e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('filters.dateFrom')}
          <input type="date" name="from" defaultValue={from} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('filters.dateTo')}
          <input type="date" name="to" defaultValue={to} className={inputCls} />
        </label>
        <Button type="submit">{t('breakdownView')}</Button>
      </form>

      {!selectedEmp ? (
        <Card className="p-6 text-sm text-muted-foreground">{t('breakdownPickEmployee')}</Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            {selected ? `${selected.employeeCode ? `${selected.employeeCode} — ` : ''}${selected.name}` : DASH}
            <span className="ml-2 font-normal text-muted-foreground">
              {fmtDayDate(from, locale)} – {fmtDayDate(to, locale)}
            </span>
          </div>
          {/* The TABLE scrolls, never the page — the rule test/leave-inquiry-layout.test.ts states for the
              inquiry tables, and the reason this screen can afford thirty columns at all. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className={stick('left-0', true)}>{t('colEmployeeId')}</th>
                  <th className={stick('left-[7rem]', true)}>{t('colEmployeeName')}</th>
                  <th className={stick('left-[19rem]', true)}>{t('colDate')}</th>
                  <th className={th}>{t('colDay')}</th>
                  <th className={th}>{t('colShiftCode')}</th>
                  <th className={th}>{t('colDayType')}</th>
                  <th className={th}>{t('colScheduleSource')}</th>
                  <th className={th}>{t('colCheckIn')}</th>
                  <th className={th}>{t('colCheckOut')}</th>
                  <th className={thNum}>{t('colShiftHours')}</th>
                  <th className={thNum}>{t('colBreakDeclared')}</th>
                  <th className={thNum}>{t('colBreakTaken')}</th>
                  <th className={thNum}>{t('colSpan')}</th>
                  <th className={thNum}>{t('colActualHours')}</th>
                  <th className={thNum}>{t('colLateness')}</th>
                  <th className={thNum}>{t('colLateDeduct')}</th>
                  <th className={thNum}>{t('colEarlyOut')}</th>
                  <th className={thNum}>{t('colEarlyOutDeduct')}</th>
                  <th className={thNum}>{t('colUnder')}</th>
                  <th className={thNum}>{t('colOtTotal')}</th>
                  <th className={thNum}>{t('colOtFlat')}</th>
                  <th className={thNum}>{t('colOt00')}</th>
                  <th className={thNum}>{t('colOt10')}</th>
                  <th className={thNum}>{t('colOt15')}</th>
                  <th className={thNum}>{t('colOt20')}</th>
                  <th className={thNum}>{t('colOt30')}</th>
                  <th className={th}>{t('colStatus')}</th>
                  <th className={th}>{t('colFlag')}</th>
                  <th className={th}>{t('punchTrail')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dayPage.length === 0 && (
                  <tr>
                    <td colSpan={29} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noRecords')}
                    </td>
                  </tr>
                )}
                {dayPage.map((r) => {
                  const ot = otByRate(r);
                  const status = statusOf(r);
                  const flag = flagOf(r);
                  // The sanctioned reader. `unavailable` is a real answer — a day the engine never traced —
                  // and it is printed as such rather than as an empty cell.
                  const ex = explainAttendanceDay(r.calcTrace);
                  const sched = ex.kind === 'explained' ? ex.schedule : null;
                  const punch = ex.kind === 'explained' ? ex.punch : null;
                  const trail = r.attendanceId ? (punchesByAttendance.get(r.attendanceId) ?? []) : [];
                  const noTrace = <span className="italic">{t('breakdownNoTrace')}</span>;
                  return (
                    <tr key={r.date} className="hover:bg-muted/40">
                      <td className={stick('left-0', false)}>{r.employeeCode ?? DASH}</td>
                      <td className={stick('left-[7rem]', false)}>{r.name}</td>
                      <td className={`${stick('left-[19rem]', false)} tabular-nums`}>
                        {fmtDayDate(r.date, locale)}
                      </td>
                      <td className={td}>{fmtDayName(r.date, locale)}</td>
                      <td className={td}>{r.shiftCode ?? DASH}</td>
                      <td className={td}>{sched ? (sched.dayType ?? DASH) : noTrace}</td>
                      <td className={td}>{sched ? (sched.source ?? DASH) : noTrace}</td>
                      <td className={`${td} tabular-nums`}>{r.checkInAt?.slice(0, 5) ?? DASH}</td>
                      <td className={`${td} tabular-nums`}>{r.checkOutAt?.slice(0, 5) ?? DASH}</td>
                      <td className={tdNum}>{fmtMin(r.scheduledMinutes)}</td>
                      <td className={tdNum}>{sched ? fmtMin(sched.breakMinutes) : noTrace}</td>
                      {/* `breakSpanned` null means no break WINDOW was declared and the legacy 6-hour cliff
                          decided it instead — a real difference in how the figure was reached, which the
                          trace records and this column must not flatten into a 0. */}
                      <td className={tdNum}>{sched ? fmtMin(sched.breakSpanned) : noTrace}</td>
                      <td className={tdNum}>{punch ? fmtMin(punch.spanMinutes) : noTrace}</td>
                      <td className={tdNum}>{fmtMin(r.workedMinutes)}</td>
                      <td className={tdNum}>{fmtMin(r.lateMinutes)}</td>
                      <td className={tdNum}>{fmtMin(r.lateDeductMinutes)}</td>
                      <td className={tdNum}>{fmtMin(r.earlyOutMinutes)}</td>
                      <td className={tdNum}>{fmtMin(r.earlyOutDeductMinutes)}</td>
                      <td className={tdNum}>{fmtMin(r.underMinutes)}</td>
                      <td className={`${tdNum} font-medium text-foreground`}>{fmtMin(r.otMinutes)}</td>
                      <td className={tdNum}>{fmtMin(ot.flat)}</td>
                      <td className={tdNum}>{fmtMin(ot.ot00)}</td>
                      <td className={tdNum}>{fmtMin(ot.ot10)}</td>
                      <td className={tdNum}>{fmtMin(ot.ot15)}</td>
                      <td className={tdNum}>{fmtMin(ot.ot20)}</td>
                      <td className={tdNum}>{fmtMin(ot.ot30)}</td>
                      <td className={td}>
                        <span className={status === 'absent' ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-foreground'}>
                          {statusText[status]}
                        </span>
                      </td>
                      <td className={td}>
                        {flag ? (
                          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                            {flagText[flag]}
                          </span>
                        ) : (
                          DASH
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>
                        {trail.length > 0
                          ? trail.map((p: { punchAt: string }) => p.punchAt.slice(0, 5)).join(' · ')
                          : DASH}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager
            hrefFor={(p) => {
              const q = new URLSearchParams();
              if (selectedEmp) q.set('emp', selectedEmp);
              q.set('from', from);
              q.set('to', to);
              q.set('page', String(p));
              return `/attendance/breakdown?${q.toString()}`;
            }}
            state={pgState}
          />
        </Card>
      )}
    </div>
  );
}
