import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { myEmployment } from '@/core/read';
import {
  ATTENDANCE_RANGE_MAX_DAYS,
  attendanceForEmploymentRange,
  flagOf,
  statusOf,
  type AttendanceFlag,
  type AttendanceStatus,
} from '@/packs/attendance/service';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { fmtDayDate, fmtDayName, fmtHours2, fmtMin } from '@/components/attendance-format';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { resolveMyAttendanceRange } from './range';

/**
 * My Attendance › Attendance Overview (feedback 67268d83 round one, r367) — THE DAY LIST IS BACK.
 *
 * ── WHAT THIS ROUND IS ──────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE CLAIM THIS FILE MADE UNTIL NOW WAS: "DELIBERATELY BLANK BELOW THE TITLE … A title and nothing
 * else", and it recorded, as a consequence rather than an oversight, that "an employee has nowhere in the
 * product to look up their own attendance". That was 2aef3cd8 (r362), and it was the reporter's explicit
 * instruction: rename the row and clear everything under it. 67268d83 is the other half of that same
 * reporter's intention — they cleared the page IN ORDER to have it rebuilt in a better shape — so the
 * sentence above is now SPENT rather than wrong, and the consequence it recorded is closed.
 *
 * r362 removed `myEmployment`, `attendanceForEmploymentRange`, a seventeen-column day table, two month
 * arrows, the pager, the intro line and a correction footer. Round one brings back the read, the
 * derivations and the pager on a SANER COLUMN SET, and replaces the month arrows with the Date From /
 * Date To / Apply filter the reporter drew. The correction footer stays retired; a per-row correction
 * marker is round three's and needs a date-filtered read that does not exist yet.
 *
 * ── THE SPEC IS OUR OWN ADMIN SCREEN, NOT A NEW DESIGN ──────────────────────────────────────────────
 * All three screenshots on the ticket are ours: the empty page, and `app/attendance/individual/page.tsx`
 * plus its `[date]` day view, which HR already uses. The ask is therefore "give the employee the screen HR
 * already has, scoped to themselves", so this file borrows that screen's derivation rather than writing a
 * second one — same `attendanceForEmploymentRange`, same `statusOf` / `flagOf`, same formatters. That is
 * what makes it impossible for the two screens to tell one person two different things about one day, and
 * it is the rule test/attendance-my-records-split.test.ts holds this file to.
 *
 * ── THE DATA FENCE IS THE EMPLOYMENT ID, RESTATED DELIBERATELY ──────────────────────────────────────
 * r362's guard comments instruct whoever brings content back to state which fence it chooses instead of
 * finding no assertion at all. It is the one r287 chose: the single attendance read is keyed on
 * `me.employmentId` from `myEmployment(s)` — the caller's OWN employment, resolved server-side — so the
 * screen is structurally incapable of showing another person's rows, whoever opens it. An administrator
 * opening it sees their own record and nobody else's. `scopedSession()` is still called and its company
 * scope still deliberately unused: this screen answers no question about other people, and `scopeIds` here
 * would mean it had started to.
 *
 * ── THE LIVE HAZARD THIS ROUND CLOSES ───────────────────────────────────────────────────────────────
 * `attendanceForEmploymentRange` has no LIMIT and a hard day-loop ceiling, and past it the loop simply
 * STOPS: a short array that reads as "you have no attendance after that date". That was unreachable while
 * only administrators chose ranges. A From / To pair in an employee's hands makes it one address-bar edit
 * away, so the range is bounded against the kernel's own published `ATTENDANCE_RANGE_MAX_DAYS` and the
 * screen REFUSES politely instead of printing a truncated record. See ./range.ts.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────────────
 * 1. View opens the employee-only day route, with the current date filter retained.
 * 2. NO TAB STRIP. `components/attendance-tabs.tsx` links to `/attendance`, `/attendance/daily` and
 *    `/attendance/individual` — three ADMIN questions, and clicking one drops the employee out of their
 *    own screen (r274, then r287). One screen, one job.
 * 3. NO employee picker, no Recompute, no Import, no OT export, no corrections worklist. Not hidden by
 *    CSS — absent from the tree, because this file never names them.
 * 4. NO PHONE LAYOUT and NO correction marker: round three.
 *
 * Read-only. No server action, no write, no DomainEvent; the filter is a plain GET form, which submits by
 * navigating. This round creates, deletes and recomputes zero attendance rows and touches no calculation.
 */
export default async function MyAttendanceRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; from?: string; to?: string; page?: string; size?: string }>;
}) {
  const t = await getTranslations('attendance');
  const locale = await getLocale();
  // The courtesy redirect for a tenant that has not bought the module (ADR-0077 slice 4). This row is an
  // employee's entry point to attendance, so it carries the same guard `/attendance` does; the read below
  // still refuses on its own.
  await requireModule('attendance');
  // The authentication boundary (and what keeps test/function-access.test.ts's "no stale routes" satisfied
  // for this registered route). Only the session is taken: see the fence note in the header.
  const { s } = await scopedSession();
  const sp = await searchParams;
  const me = await myEmployment(s);

  if (!me) {
    /**
     * A real, named person linked to no active employment — the seeded HR administrator is exactly this.
     * Saying so beats an empty table, which reads as "you were never here". `myRecords.notLinked` is REVIVED
     * from its r362 retirement rather than replaced by a new key: the branch is back, so the string has its
     * subject back. `max-w-md`, not `max-w-2xl` — test/attendance-screens-layout.test.ts reads this file for
     * a page-level `mx-auto` + `max-w-…xl` cap and a one-sentence notice needs no more room (the idiom is
     * app/attendance/requests/page.tsx's, for the same reason).
     */
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('myRecords.title')} />
        <div className="mx-auto max-w-md">
          <Card className="p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('myRecords.notLinked')}</p>
          </Card>
        </div>
      </div>
    );
  }

  /**
   * THE SIX STATUSES THE KERNEL CAN PRODUCE, AND NOT ONE MORE.
   *
   * The reporter listed eight — Present, Absent, Off Day, Rest Day, Public Holiday, Late, Incomplete,
   * Leave — and six of them are statuses. `statusOf` (core/attendance-derive.ts) answers exactly
   * present · absent · rest · off · ph · on_leave, and Late and Incomplete are NOT among them because they
   * are not the same KIND of fact: a day you arrived late is still a day you were present for, and a day
   * with one punch missing is too. They live on a second axis, `flagOf` → late · under · odd, and they are
   * rendered in the Note column beside the status. Drawing either as a status would assert a choice the
   * kernel never makes, and would put this screen's account of a day at odds with HR's.
   *
   * `under` is the third flag the reporter did not ask for and gets anyway: the system knows when a day
   * finished short of its scheduled hours, and that is exactly the kind of thing this screen exists to let
   * someone see for themselves.
   *
   * The `Record<AttendanceStatus, …>` annotation is load-bearing, not decoration — a seventh entry is a tsc
   * error and a missing one is too, so the map cannot drift away from the union.
   */
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
  /**
   * The visual indicator the reporter asked for — a coloured chip per status, each one CARRYING ITS WORD.
   * Never colour alone: a reader who cannot separate the hues, or who prints the page, must still be able
   * to read the day. The admin list reddens Absent only; this adds the other five rather than changing that
   * screen's long-settled emphasis, and Absent keeps the same red so the two agree on the one that matters.
   */
  const statusChip: Record<AttendanceStatus, string> = {
    present: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    absent: 'border-rose-500/30 bg-rose-500/10 font-medium text-rose-700 dark:text-rose-400',
    rest: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
    off: 'border-border bg-muted text-muted-foreground',
    ph: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400',
    on_leave: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  };

  const todayIso = todayInKualaLumpur();
  // The kernel's own ceiling, passed in rather than re-typed here, so the screen's limit and the loop's
  // limit are one number (core/attendance.ts ATTENDANCE_RANGE_MAX_DAYS).
  const range = resolveMyAttendanceRange(sp, todayIso, ATTENDANCE_RANGE_MAX_DAYS);
  const { from, to } = range;

  /**
   * THE REFUSAL, and why it is a refusal rather than a clamp.
   *
   * Silently narrowing the range to the last 400 days would show a record the reader did not ask for while
   * looking exactly like the one they did — the same defect as the truncation, moved one step later. So the
   * read is NOT ISSUED: the filter keeps what they typed, and the screen says what is wrong and what the
   * limit is. `days` is the range they asked for, so the message can be specific rather than a shrug.
   */
  const refusalText =
    range.refusal === 'too_long'
      ? t('myRecords.rangeTooLong', { days: range.days, max: ATTENDANCE_RANGE_MAX_DAYS })
      : range.refusal === 'inverted'
        ? t('myRecords.rangeInverted')
        : undefined;

  // THE ONLY ATTENDANCE READ ON THIS PAGE, keyed on the caller's own employment id — and not made at all
  // when the range was refused, which is the whole point of refusing.
  const rows = range.refusal ? [] : await attendanceForEmploymentRange(s, me.employmentId, from, to);
  // One row per calendar day. paginateRows slices an array already in hand, so `rows.length` in the section
  // header is the TRUE total for the range and not a page count (fc776376).
  const { rows: dayPage, state: pgState } = paginateRows(rows, parsePageQuery(sp));
  /**
   * The one thing this screen cannot say, said out loud and only when it applies.
   * `approvedLeaveDates` returns no leave-type code — the engine deliberately treats every approved
   * full-day leave the same when it works out attendance — so a leave day can be reported as On Leave and
   * nothing more. Naming the leave type is separate work, not a label we are choosing not to print. The
   * note renders only when a leave day is actually on screen: an absent caption asserts nothing, while one
   * printed over a month with no leave in it is noise (CLAUDE.md §8).
   */
  const showsLeave = dayPage.some((r) => statusOf(r) === 'on_leave');

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('myRecords.title')} />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <SectionHeader
          title={`${fmtDayDate(from, locale)} – ${fmtDayDate(to, locale)}`}
          count={range.refusal ? undefined : rows.length}
          subtitle={t('myRecords.intro')}
        />
        {/* Date From · Date To · Apply. A plain GET form, exactly the admin list's filter minus the employee
            picker: it navigates, it posts nothing, and it needs no client component. The dates ride the
            address so the pager keeps the filter and a copied link opens the same view. */}
        <form method="GET" className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.dateFrom')}
            <input type="date" name="from" defaultValue={from} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.dateTo')}
            <input type="date" name="to" defaultValue={to} className={inputCls} />
          </label>
          <Button type="submit" variant="outline" size="sm">
            {t('filters.apply')}
          </Button>
        </form>

        {refusalText ? (
          <p className="px-4 py-10 text-center text-sm text-destructive">{refusalText}</p>
        ) : (
          /* Ten columns — the extra ones scroll horizontally on a narrow screen until round three lays the
             list out for a phone. `w-max min-w-full`, not `w-full`: w-full compresses every cell below its
             content width and nowrap text then paints over the next column (f728826a). */
          <div className="overflow-x-auto">
            <table className="w-max min-w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colDate')}</th>
                  <th className="px-3 py-2 font-medium">{t('colDay')}</th>
                  <th className="px-3 py-2 font-medium">{t('colShiftCode')}</th>
                  <th className="px-3 py-2 font-medium">{t('colCheckIn')}</th>
                  <th className="px-3 py-2 font-medium">{t('colCheckOut')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colShiftHours')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colActualHours')}</th>
                  {/* The day's OVERTIME as one figure. The six rate buckets are NOT on this list: six of
                      them hold 0.00 on an ordinary day and they are the reason a seventeen-column row could
                      not be scanned (570fd56e took them off HR's list for exactly that). They belong on the
                      day screen, through the same explanation island HR's day screen uses — round two. */}
                  <th className="px-3 py-2 text-right font-medium">{t('colOtTotal')}</th>
                  <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                  {/* The SECOND AXIS. Late / Under / Odd are flags, not statuses — see the statusText note. */}
                  <th className="px-3 py-2 font-medium">{t('colNote')}</th>
                  <th className="sticky right-0 bg-card px-3 py-2 font-medium">{t('colAction')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dayPage.map((r) => {
                  const status = statusOf(r);
                  const flag = flagOf(r);
                  return (
                    <tr key={r.date}>
                      <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">{fmtDayDate(r.date, locale)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{fmtDayName(r.date, locale)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{r.shiftCode ?? '—'}</td>
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{r.checkInAt?.slice(0, 5) ?? '—'}</td>
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{r.checkOutAt?.slice(0, 5) ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMin(r.scheduledMinutes)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMin(r.workedMinutes)}</td>
                      {/* An em dash where no engine computed the day, never a confident 0.00 — the same
                          distinction fmtMin makes for the hour columns. */}
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {r.otMinutes == null ? '—' : fmtHours2(r.otMinutes)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${statusChip[status]}`}
                        >
                          <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
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
                      <td className="sticky right-0 whitespace-nowrap bg-card px-3 py-2.5">
                        <Link className="font-medium text-primary hover:underline" href={`/attendance/my-records/${r.date}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`}>
                          {t('breakdownView')}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {dayPage.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noRecords')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <Pager basePath="/attendance/my-records" params={{ from: sp.from, to: sp.to }} state={pgState} />
            {showsLeave && (
              <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                {t('myRecords.leaveTypeNote')}
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
