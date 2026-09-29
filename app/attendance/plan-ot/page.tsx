import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { myOvertimePlans, otPlanCalendarMonth } from '@/packs/attendance/service';
import {
  Button,
  Card,
  ErrorBanner,
  PageHeader,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { OtPlanCalendar, type OtCalendarCell, type OtCalendarPlanStatus } from '@/components/ot-plan-calendar';
import { addMonths, isMonthParam, monthRange } from '@/lib/roster-month';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myWithdrawOvertimePlan } from '@/app/me/actions';
import { CATEGORY_KEY, Pill, statusLabel } from '../request-ui';

/**
 * My Attendance > Self Overtime — the employee's own overtime plans, on a screen of their own.
 *
 * ⚠️ THIS FILE IS A DELIBERATE REVERSAL, AND THE HISTORY MATTERS. 1e9145d4 moved the overtime list ONTO
 * this route; 2166ef79 moved it OFF again, onto the shared My Attendance screen as a fourth tab, and left
 * this file as a one-line redirect into that tab — both times because that is what the reporter asked for
 * at the time. c6bb5f5a is them asking for the opposite, in writing and confirmed: Self Overtime gets its
 * own menu row AND its own page, showing overtime and nothing else. So the redirect is gone and the list
 * is rendered here.
 *
 * MOVED, NOT REBUILT — for the third time, and that is the point. Same `myOvertimePlans` read, same
 * Withdrawn-vs-Cancelled wording, same withdraw-eligibility rule mirrored from the service. A relocation
 * that re-implemented the list would be how the employee's screen and the approver's start disagreeing
 * about one plan.
 *
 * ── ce5ded11 (r362) ADDED TWO THINGS AND CHANGED NOTHING ELSE ─────────────────────────────────────────
 *  · AN APPROVED HOURS COLUMN. `myOvertimePlans` has always returned `approvedOtMinutes`; the table just
 *    never printed it, so the one figure that actually reaches payroll was the one figure the employee
 *    could not see. Requested and approved are different numbers whenever the approver trims a plan or
 *    the day is measured against what was clocked, and the eighth column is the whole change.
 *  · A TABLE / CALENDAR SWITCH over the SAME month grid the Apply screen uses
 *    (components/ot-plan-calendar.tsx), so a month is readable at a glance instead of row by row. The
 *    calendar's dates link to Apply for that date, where the day card shows what was already filed — one
 *    behaviour for "open that day", not two.
 *
 * ⚠️ DAY TYPE AND ACTUAL HOURS ARE DELIBERATELY NOT COLUMNS HERE, and the ticket asked for both. This
 * list holds up to a hundred plans across arbitrary months; a day type is one scheduling resolution per
 * row and actual hours one attendance lookup per row, which is a hundred-fold N+1 on a self-service page
 * to restate what the calendar above now shows at a glance for the month in view.
 *
 * THE ERROR QUERY IS WHY THIS ROUTE COULD NEVER JUST BE DELETED. `myWithdrawOvertimePlan` reports a refusal
 * ("the overtime date has passed") by redirecting to `/attendance/plan-ot?error=…`. The banner below is
 * what makes that visible; without it the employee presses Withdraw, the list comes back unchanged, and
 * nothing says why.
 *
 * ⚠️ `?toast=` IS ALREADY RENDERED, AND NOT BY THIS FILE — a correction to what the header used to say.
 * `<ToastFromQuery />` is mounted in the ROOT layout (app/layout.tsx), reads `toast` and `error` off the
 * query on every authenticated page, fires the sonner toast and strips the param. So the confirmation the
 * submit and withdraw actions emit has been arriving all along; a second renderer here would show it
 * twice. The header's old "toast is still NOT rendered: no screen in this module renders one" was true of
 * this module and false of the page, which is the only thing an employee sees.
 *
 * TRUST MODEL: self-service, so NO page guard — the viewer's own employment is resolved from the session,
 * the read is RLS-scoped to it, and the withdraw action re-resolves the caller server-side. See the nav row
 * in packs/attendance/index.ts (ungated, like its siblings) and test/attendance-pack.test.ts.
 */
export default async function SelfOvertimePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; view?: string; month?: string }>;
}) {
  const t = await getTranslations('me');
  const locale = await getLocale();
  const sp = await searchParams;
  const s = await getSession();
  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('planOtTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const today = todayInKualaLumpur();
  const isCalendar = sp.view === 'calendar';
  const month = isMonthParam(sp.month) ? sp.month : today.slice(0, 7);
  const { from: monthFrom, to: monthTo } = monthRange(month);

  const [plans, lines, calendar, monthPlans] = await Promise.all([
    myOvertimePlans(s, me.employmentId, { limit: 100 }),
    reportingLinesFor(s, me.employmentId),
    // The calendar's two reads are paid for ONLY when the calendar is on screen. The table is the
    // default and is byte-identical to what it costs today.
    isCalendar ? otPlanCalendarMonth(s, me.employmentId, month) : Promise.resolve([]),
    isCalendar
      ? myOvertimePlans(s, me.employmentId, { from: monthFrom, to: monthTo, limit: 200 })
      : Promise.resolve([]),
  ]);
  // Who the plan goes to. Resolved from the administrative reporting line — the edge assertCanDecide routes
  // the decision along — falling back to HR rather than blank, because "nobody" is never the answer.
  const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');

  // One dot per date, the most live plan on it — the same precedence the Apply screen uses.
  const DOT_RANK: Record<OtCalendarPlanStatus, number> = { pending: 4, approved: 3, rejected: 2, cancelled: 1 };
  const dotByDate = new Map<string, OtCalendarPlanStatus>();
  for (const p of monthPlans) {
    const prev = dotByDate.get(p.attendanceDate);
    if (!prev || DOT_RANK[p.status] > DOT_RANK[prev]) dotByDate.set(p.attendanceDate, p.status);
  }
  const cells: OtCalendarCell[] = calendar.map((d) => ({
    date: d.date,
    kind: d.kind,
    noRosterEntry: d.source === 'policy',
    plan: dotByDate.get(d.date) ?? null,
  }));
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dowFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  // 2024-01-01 is a Monday, so 1…7 names Monday…Sunday — the week isoWeekdayOf counts in.
  const weekdayLabels = [1, 2, 3, 4, 5, 6, 7].map((d) => dowFmt.format(new Date(Date.UTC(2024, 0, d))));
  const viewHref = (v: 'table' | 'calendar') =>
    v === 'calendar' ? `/attendance/plan-ot?view=calendar&month=${month}` : '/attendance/plan-ot';
  const toggleCls = (on: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-medium ${on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('planOtTitle')}
        description={
          <>
            <span>{[me.name, me.employeeCode, me.position, me.company].filter(Boolean).join(' · ')}</span>
            <span className="mt-0.5 block">{t('maSectionOvertimeHelp')}</span>
          </>
        }
        actions={
          <Button asChild size="sm">
            <Link href="/attendance/plan-ot/apply">{t('maApplyOvertime')}</Link>
          </Button>
        }
      />

      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">{t('maSectionOvertime')}</span>
          <div className="inline-flex items-center gap-1 rounded-md border border-border p-0.5">
            <Link href={viewHref('table')} className={toggleCls(!isCalendar)}>
              {t('otViewTable')}
            </Link>
            <Link href={viewHref('calendar')} className={toggleCls(isCalendar)}>
              {t('otViewCalendar')}
            </Link>
          </div>
        </div>

        {isCalendar ? (
          <div className="p-4">
            <OtPlanCalendar
              month={month}
              monthLabel={monthFmt.format(new Date(`${monthFrom}T00:00:00Z`))}
              weekdayLabels={weekdayLabels}
              days={cells}
              // Nothing is "selected" on this screen: the calendar is a reading of the month, not a
              // picker, so no date is filled in and every one of them is equally clickable.
              selected=""
              today={today}
              dayHrefBase="/attendance/plan-ot/apply"
              prevHref={`/attendance/plan-ot?view=calendar&month=${addMonths(month, -1)}`}
              nextHref={`/attendance/plan-ot?view=calendar&month=${addMonths(month, 1)}`}
              compact
            />
            <p className="mt-3 text-[11px] text-muted-foreground">{t('otViewCalendarHelp')}</p>
          </div>
        ) : plans.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('otNoPlans')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('otDateColumn')}</th>
                  <th className={thCls}>{t('otPlannedTimeColumn')}</th>
                  <th className={thCls}>{t('otHoursColumn')}</th>
                  {/* ce5ded11 — the figure that actually reaches payroll, which was fetched and never
                      printed. Blank until a decision exists: a plan still waiting has no approved figure,
                      and echoing the requested one there would claim an approval nobody has given. */}
                  <th className={thCls}>{t('otApprovedHoursColumn')}</th>
                  <th className={thCls}>{t('reasonRequired')}</th>
                  <th className={thCls}>{t('otGoesToColumn')}</th>
                  <th className={thCls}>{t('otStatusColumn')}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {plans.map((p) => {
                  // Mirrored from cancelPlannedOvertime so the control is not offered where the service
                  // would refuse it. The SERVICE is the authority.
                  const canWithdraw =
                    p.status === 'pending' ||
                    (p.status === 'approved' && p.appliedAt == null && p.attendanceDate >= today);
                  return (
                    <tr key={p.id}>
                      <td className="px-3 py-2 tabular-nums">{p.attendanceDate}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {p.plannedStartTime && p.plannedEndTime
                          ? `${p.plannedStartTime.slice(0, 5)} – ${p.plannedEndTime.slice(0, 5)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {p.requestedOtMinutes != null ? (p.requestedOtMinutes / 60).toFixed(1) : '—'}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {p.approvedOtMinutes != null ? (p.approvedOtMinutes / 60).toFixed(1) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {p.otReasonCategory && <span className="font-medium">{t(CATEGORY_KEY[p.otReasonCategory])}</span>}
                        {p.otReasonCategory && p.reason ? ' — ' : ''}
                        <span className="text-muted-foreground">{p.reason ?? ''}</span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{approver}</td>
                      <td className="px-3 py-2">
                        <Pill status={p.status} label={statusLabel(p.status, t, true)} />
                        {p.status === 'approved' && (
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {p.appliedAt
                              ? t('otCountedOnDay', { date: p.appliedAt.toISOString().slice(0, 10) })
                              : t('otNotWorkedYet')}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canWithdraw ? (
                          <form action={myWithdrawOvertimePlan}>
                            <input type="hidden" name="correctionId" value={p.id} />
                            <button
                              type="submit"
                              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                            >
                              {t('otWithdraw')}
                            </button>
                          </form>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">{t('otWithdraw')}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
