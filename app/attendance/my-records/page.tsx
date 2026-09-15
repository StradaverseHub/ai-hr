import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { myEmployment } from '@/core/read';
import { attendanceForEmploymentRange } from '@/core/attendance';
import { otByRate, flagOf, statusOf, type AttendanceStatus, type AttendanceFlag } from '@/core/attendance-derive';
import { explainAttendanceDay } from '@/core/attendance-explain';
import { Card, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { AttendanceFigureCells } from '@/components/attendance-figure-cells';
import { fmtMin } from '@/components/attendance-format';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';

import { todayInKualaLumpur } from '@/lib/hr-date';

const dayName = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** First and last day of a `YYYY-MM`, as ISO dates. Derived from the month, never from a hardcoded clock. */
const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};

/**
 * My Attendance › My Records (feedback f3e6c36e, r287) — THE EMPLOYEE HALF OF A SPLIT, not a second door
 * onto `/attendance`.
 *
 * ── WHY THIS SCREEN EXISTS AT ALL ───────────────────────────────────────────────────────────────────
 * The reporter asked, twice and in writing, for the administrative "Record" function to leave My
 * Attendance for Administration › Attendance, where it already sits as "Employee Attendance". The
 * obstacle was never the menu: `/attendance` is ONE screen serving both audiences (`scopedSession` —
 * a single row to an employee, every employee in scope to an administrator), and the Administration
 * sidebar group gates `adminOnly` at GROUP level, so moving the row there makes the screen INVISIBLE to
 * employees rather than admin-only. a324a4b3 rev2 made exactly that move and rev3 undid it;
 * test/sidebar-attendance-group.test.ts exists to stop a third attempt and is updated, not deleted.
 *
 * The reporter reaffirmed after that challenge, so under the fight-back rule it is the owner's decision.
 * The approved plan (rev 2) delivers it by SPLITTING rather than by moving: this route is the employee's
 * own record, and `/attendance` is left to the administrator alone. Both read the same attendance rows
 * through the same engine — nothing is duplicated, recalculated or re-stored.
 *
 * ── NO TAB STRIP, DELIBERATELY ──────────────────────────────────────────────────────────────────────
 * `components/attendance-tabs.tsx` links to `/attendance`, `/attendance/daily` and
 * `/attendance/individual`. Rendering it here would drop the employee out of their own screen on the
 * first click (r274 recorded this as the reason a second route onto the same page was refused then).
 *
 * The alternative the plan offered — an employee-scoped tab set of its own — was considered and REJECTED.
 * The admin strip's three tabs are three admin questions: everybody's month, everybody's day, pick an
 * employee. For one person looking at their own record there is exactly one view, so a second strip would
 * have to invent routes with no distinct job, each needing its own screen, its own reads and its own
 * matrix column. That is the "duplicate concepts / competing sources of truth" the graph check forbids.
 * So: NO TABS. One screen, one job. Pinned in test/attendance-my-records-split.test.ts.
 *
 * ── WHAT IS ABSENT, AND WHY ABSENT RATHER THAN HIDDEN ───────────────────────────────────────────────
 * No employee picker, no Recompute link, no Import Punches, no OT-report export, no corrections
 * worklist. Not `hidden`, not CSS — not in the tree at all, because this file never renders them. The
 * employee affordance for a wrong day already exists and is its own row in this same menu (Attendance
 * Request → `/attendance/requests`), so nothing is taken away by leaving the decision controls out.
 *
 * ── THE DATA FENCE IS THE EMPLOYMENT ID, NOT A COMPANY SCOPE ────────────────────────────────────────
 * The one attendance read on this page is keyed on `me.employmentId` from `myEmployment(s)` — the
 * caller's OWN employment, resolved server-side, exactly as /me and the clock portal do. It is therefore
 * structurally incapable of showing another person's rows, whoever opens it: an administrator opening
 * this screen sees their own record and nobody else's. That is a stronger fence than a company scope
 * narrowed by a filter, and it is what makes "and nothing else" in the plan literally true.
 *
 * The session comes through the SAME helper `/attendance` uses, and only the session is taken from it —
 * the company scope it also returns is deliberately unused, because this screen answers no question
 * about other people. Using that helper is what makes the lib/permissions.ts column beside it honest:
 * the route is registered as reachable by every authenticated role, scoped to the caller's own rows.
 *
 * Read-only: no action, no form, no DomainEvent. This round creates, deletes and recomputes zero
 * attendance rows.
 */
export default async function MyAttendanceRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; month?: string; page?: string; size?: string }>;
}) {
  const t = await getTranslations('attendance');
  // The courtesy redirect for a tenant that has not bought the module (ADR-0077 slice 4). This row is an
  // employee's ENTRY POINT to attendance now that Records has left this menu, so it carries the same
  // guard `/attendance` does; the reads below still refuse on their own.
  await requireModule('attendance');
  const { s } = await scopedSession();
  const sp = await searchParams;
  const me = await myEmployment(s);

  const todayIso = todayInKualaLumpur();
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : todayIso.slice(0, 7);

  if (!me) {
    // A real, named person who is linked to no active employment (the seeded HR administrator is exactly
    // this). Saying so is better than an empty table that reads as "you were never here".
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('myRecords.title')} />
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">{t('myRecords.notLinked')}</p>
        </Card>
      </div>
    );
  }

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

  const { from, to } = monthRange(month);
  // THE ONLY ATTENDANCE READ ON THIS PAGE, and it is keyed on the caller's own employment id.
  const rows = await attendanceForEmploymentRange(s, me.employmentId, from, to);
  const { rows: dayPage, state: pgState } = paginateRows(rows, parsePageQuery(sp));
  const monthHref = (m: string) => `/attendance/my-records?month=${m}`;

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('myRecords.title')} />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <SectionHeader title={monthLabel(month)} count={rows.length} />
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">{t('myRecords.intro')}</p>
          <div className="flex items-center gap-1.5">
            <Link
              href={monthHref(shiftMonth(month, -1))}
              aria-label={t('previousMonth')}
              className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </Link>
            <Link
              href={monthHref(shiftMonth(month, 1))}
              aria-label={t('nextMonth')}
              className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>

        {/* Wide table — the extra columns scroll horizontally on narrow screens, exactly as the
            Individual tab's does. The columns are the SAME columns, from the SAME formatters and the
            SAME explanation island, so the employee's screen and the administrator's cannot describe one
            day two different ways. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[76rem] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('colDate')}</th>
                <th className="px-3 py-2 font-medium">{t('colDay')}</th>
                <th className="px-3 py-2 font-medium">{t('colShiftCode')}</th>
                <th className="px-3 py-2 font-medium">{t('colCheckIn')}</th>
                <th className="px-3 py-2 font-medium">{t('colCheckOut')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colShiftHours')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colActualHours')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colLateness')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colEarlyOut')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOtFlat')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt00')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt10')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt15')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt20')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt30')}</th>
                <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-3 py-2 font-medium">{t('colFlag')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {dayPage.map((r) => {
                const ot = otByRate(r);
                const status = statusOf(r);
                const flag = flagOf(r);
                return (
                  <tr key={r.date}>
                    <td className="px-3 py-2.5 tabular-nums">{r.date}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{dayName(r.date)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{r.shiftCode ?? '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{r.checkInAt?.slice(0, 5) ?? '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{r.checkOutAt?.slice(0, 5) ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMin(r.scheduledMinutes)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMin(r.workedMinutes)}</td>
                    <AttendanceFigureCells
                      lateMinutes={r.lateMinutes}
                      earlyOutMinutes={r.earlyOutMinutes}
                      ot={ot}
                      hasRow={r.attendanceId != null}
                      explanation={explainAttendanceDay(r.calcTrace)}
                    />
                    <td className="px-3 py-2.5">
                      {/* Only Absent in red; every other status uses the standard text colour. */}
                      <span
                        className={`capitalize ${status === 'absent' ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-foreground'}`}
                      >
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
                  </tr>
                );
              })}
              {dayPage.length === 0 && (
                <tr>
                  <td colSpan={17} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noRecords')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager basePath="/attendance/my-records" params={{ month: sp.month }} state={pgState} />
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t('myRecords.correctionNote')}
        </p>
      </Card>
    </div>
  );
}
