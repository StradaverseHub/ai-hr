import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CalendarPlus } from 'lucide-react';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { attendanceForEmploymentRange, myAttendanceCorrections } from '@/packs/attendance/service';
import {
  Button,
  Card,
  ErrorBanner,
  PageHeader,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myRequestCorrection } from '@/app/me/actions';
import { CorrectionDialog, CorrectionForm, LeaveInsteadNote, type CorrectionCopy } from './correction-form';
import {
  KIND_OF_SECTION,
  defaultSection,
  groupExceptions,
  parseSection,
  type AttendanceSection,
  type ExceptionDay,
} from './sections';

/**
 * Attendance Irregularity — the employee's own flagged days, and the request that fixes each one.
 *
 * WHAT WAS ACTUALLY WRONG, because it was not what the ticket's title suggested. Nothing here needed to be
 * DETECTED for the first time. `flagOf` / `statusOf` (core/attendance-derive.ts) have decided, for every
 * day, whether a punch is missing, the arrival was late, the day finished short or the employee was
 * absent — since bbada39c. They run on Attendance > Records > Individual, which is HR's verification
 * table: seventeen columns, an employee dropdown, and no action on any row. So the employee could in
 * principle reach the answer and could do nothing with it, and in practice never looked. This screen shows
 * them THEIR OWN flagged days and puts the request that fixes each one on the row.
 *
 * ⚠️ c6bb5f5a SPLIT THIS SCREEN INTO FOUR, and three things LEFT — read this before putting any of them
 * back. 2166ef79 stacked Self Overtime, Short Hours, Incomplete Entry and Absent onto one screen as tabs,
 * with Travel Request and the request-history list underneath, because that is what the reporter asked for
 * then. They have since asked for the opposite, in writing and confirmed, and each of the three now has
 * its own menu row and its own page:
 *   • Self Overtime → /attendance/plan-ot (the route that used to forward HERE now renders the list)
 *   • Travel Request → its own screen at the time; b833a077 (r362) then removed My Travel completely
 *     (row, screen, form and approvals section). Its address redirects to Clock in/out and no travel
 *     request can be filed from anywhere. The travel_request rows are kept for audit.
 *   • "My attendance requests" → /attendance/request-status, the row and page now named "My Request"
 *     (7709ffd1, r369 — a label change only; the route is unchanged, so this pointer still holds)
 * What is left is what the screen is named after: genuine attendance EXCEPTIONS. `?section=overtime`, the
 * address the old tab and every stale link use, forwards to Self Overtime rather than 404-ing on a tab
 * that no longer exists.
 *
 * THE TITLE NOW MATCHES THE MENU ROW. It read "My Attendance" while the row that opens it read "Attendance
 * Irregularity"; with four screens where there was one, a page whose name is not its row's name is a
 * screen the employee cannot find twice. `me.attendanceRequest` is the row's own string.
 *
 * "CORRECT ANOTHER DAY" IS A POP-UP NOW, not the empty state of the Fix panel. Both faces of that form are
 * one component (./correction-form) so they cannot disagree about the 30-day bounds or the locked half of
 * an incomplete punch.
 *
 * r227 — THE SCREEN IS FULL WIDTH AND EVERY REQUEST IS THAT SAME POP-UP. Two complaints, one shape: the
 * page was capped at `max-w-6xl` and then split AGAIN into a list column and a 22rem Fix column, so the
 * table the employee came to read got about half of a wide monitor. The Fix column is gone — Request on a
 * row opens the pop-up that "Correct another day" already opened, handed that row's day — and the wrapper
 * is `pageWideCls`. THREE THINGS HAD TO TRAVEL WITH THE FORM, and losing any one is the defect:
 *   1. `?fix=YYYY-MM-DD` is no longer GENERATED, but the branch that renders it is kept below: links and
 *      bookmarks written while it was the only way in must still open the form for that day.
 *   2. An "Also waiting for you" row belongs to a DIFFERENT section from the open tab. The old link
 *      switched section on the way in, which is how the request got the right `request_kind`; the pop-up
 *      is handed `d.section` / KIND_OF_SECTION[d.section] off the row instead.
 *   3. `maRequestLeaveHelp` + the `/leave?apply=1&start=` button sat OUTSIDE the form, under it, and are
 *      the second of the two routes `maAbsentTwoRoutes` promises out loud. They travel into the pop-up as
 *      LeaveInsteadNote — the same component the kept inline panel renders.
 * No DRAFT state was built and none was implied: attendance_correction_status is
 * pending|approved|rejected|cancelled, so there is ONE confirm button, with Cancel beside it.
 *
 * THE WINDOW IS THE CUT-OFF, and they are deliberately the same number. Stage one runs on fixed rules
 * until the Attendance Request Settings screen exists (stage two), and one of them is that a correction
 * can be asked for up to 30 days back — so listing days you could not act on would be a screen full of
 * dead rows. TODAY IS EXCLUDED: a day still being worked has no clock-out yet and would be flagged as an
 * Incomplete Entry every single morning.
 *
 * NOT IN STAGE ONE, and deliberately not half-built: the ~40-setting Attendance Request Settings screen,
 * approval chains with more than one level and the level-by-level progress, Pay Mode (overtime pay vs
 * replacement leave), and Request-to-Void.
 *
 * TRUST MODEL: the viewer's OWN employment is resolved from the session, every read is RLS-scoped to it,
 * and each action re-resolves the caller server-side. Self-service, so NO page guard — see the nav row in
 * packs/attendance/index.ts and the assertion in test/attendance-menu-relocation.test.ts.
 *
 * DATES: every day key comes from todayInKualaLumpur; date-only arithmetic stays UTC. An ISO timestamp
 * sliced to ten characters names YESTERDAY between 00:00 and 08:00 MYT (bb4f2265) — and a night-shift
 * employee filing a correction is exactly the person who would meet that.
 */
export default async function AttendanceIrregularityPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    /** Which of the three exception sections is open. */
    section?: string;
    /** The day whose Fix panel is open (YYYY-MM-DD). */
    fix?: string;
  }>;
}) {
  const t = await getTranslations('me');
  const sp = await searchParams;

  // The Self Overtime tab's old address. Forwarded rather than ignored: `?section=overtime` is what every
  // link, bookmark and redirect written between 2166ef79 and c6bb5f5a points at, and dropping it silently
  // would land the employee on Short Hours with no explanation. redirect() signals by THROWING.
  if (parseSection(sp.section) === 'overtime') redirect('/attendance/plan-ot');

  const s = await getSession();
  const me = await myEmployment(s);

  if (!me) {
    return (
      // A one-sentence notice, so it stays centred and narrow while the SCREEN below is full width
      // (r227). `max-w-md` rather than `max-w-2xl` deliberately: test/attendance-screens-layout.test.ts
      // reads this file for a page-level `mx-auto` + `max-w-…xl` cap, which is exactly the shape the
      // reporter asked us to take off this screen — and a lone sentence needs no more room than this.
      <div className="mx-auto max-w-md">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('attendanceRequest')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const today = todayInKualaLumpur();
  const from = addDays(today, -CORRECTION_WINDOW_DAYS);
  const to = addDays(today, -1); // yesterday — see the header note on why today is out.

  const [days, requests, lines] = await Promise.all([
    attendanceForEmploymentRange(s, me.employmentId, from, to),
    // Read for ONE thing now: which dates already have a request waiting. The list itself moved to
    // /attendance/request-status; what stays here is the marker on the row, which is a different statement.
    myAttendanceCorrections(s, me.employmentId, { limit: 200 }),
    reportingLinesFor(s, me.employmentId),
  ]);
  // Who a request goes to. Resolved from the administrative reporting line — the edge assertCanDecide
  // routes an attendance decision along — falling back to HR rather than blank, because "nobody" is never
  // the answer: an employee with no line still has their request decided, by HR. The employee NEVER picks.
  const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');

  // An employee who is not on clocking at all has no attendance rows, and every scheduled day in the
  // window would then read as an unexplained absence — a wall of red for somebody whose company simply
  // does not clock them. That is a false positive, not a finding, so the sections say so instead.
  const onClocking = days.some((d) => d.attendanceId != null);
  const found = onClocking ? groupExceptions(days) : { incomplete: [], short: [], absent: [] };
  const counts = { incomplete: found.incomplete.length, short: found.short.length, absent: found.absent.length };
  /**
   * afc29d75 — `all` IS THE DEFAULT AND THE FIRST TAB, and the three sections become FILTERS over one
   * list rather than three screens. The reporter's complaint was that the same six days rearranged
   * themselves into a different set of boxes depending on which tab you were on; there is one list now,
   * and the tab decides only how much of it you are looking at.
   *
   * `defaultSection` is no longer consulted here and is NOT deleted: it is exported, unit-tested, and
   * still the right answer to "which single section would you open on" — which is a question this screen
   * has simply stopped asking.
   */
  const parsed = parseSection(sp.section);
  const section: FilterSection = parsed && parsed !== 'overtime' ? parsed : 'all';

  // A date that already has a request WAITING cannot take a second one: attendance_correction carries a
  // partial unique index on (employment, date) WHERE status = 'pending'. The row shows "Requested" rather
  // than a Request button that the service would refuse — the service is still the authority, this only
  // decides whether to draw a control.
  const pendingDates = new Set(requests.filter((r) => r.status === 'pending').map((r) => r.attendanceDate));

  /**
   * ONE list, in date order, whatever kinds are in it. Sorted here rather than by `groupExceptions`,
   * which is pure and still returns the three groups the counts and the filters are read off.
   */
  const allDays: ExceptionDay[] = [...found.incomplete, ...found.short, ...found.absent].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const sectionDays: ExceptionDay[] =
    section === 'all'
      ? allDays
      : section === 'incomplete'
        ? found.incomplete
        : section === 'short'
          ? found.short
          : found.absent;
  // The legacy `?fix=` branch resolves against the WHOLE list, not the filtered one: a bookmark written
  // when that address was the only way in named a day, not a tab, and must still open its form.
  const fixDay = sp.fix ? allDays.find((d) => d.date === sp.fix) ?? null : null;

  const href = (next: { section?: FilterSection; fix?: string | null }) => {
    const q = new URLSearchParams();
    q.set('section', next.section ?? section);
    const fix = next.fix === undefined ? sp.fix : next.fix;
    if (fix) q.set('fix', fix);
    return `/attendance/requests?${q.toString()}`;
  };

  // `all` leads, and its count is the SUM — the figure the reporter actually wants ("what needs me?").
  const TABS: { key: FilterSection; label: string; help: string; count: number }[] = [
    { key: 'all', label: t('maSectionAll'), help: t('maSectionAllHelp'), count: allDays.length },
    { key: 'short', label: t('maSectionShort'), help: t('maSectionShortHelp'), count: counts.short },
    { key: 'incomplete', label: t('maSectionIncomplete'), help: t('maSectionIncompleteHelp'), count: counts.incomplete },
    { key: 'absent', label: t('maSectionAbsent'), help: t('maSectionAbsentHelp'), count: counts.absent },
  ];

  // Every string the correction form renders, resolved HERE. The form is a client component so that one
  // implementation can serve both the inline panel and the pop-up; `t` may not cross that boundary
  // (test/server-client-boundary.test.ts), so plain text does.
  const copy: CorrectionCopy = {
    dateLabel: t('dateLabel'),
    anotherHelp: t('maFixAnotherHelp'),
    checkIn: t('checkInLabel'),
    checkOut: t('checkOutLabel'),
    required: t('maRequired'),
    reason: t('reasonRequired'),
    reasonPlaceholder: t('reasonPlaceholder'),
    remark: t('maRemarkLabel'),
    remarkPlaceholder: t('maRemarkPlaceholder'),
    attachment: t('maAttachmentLabel'),
    attachmentHelp: t('maAttachmentHelp'),
    goesTo: t('otGoesToLabel'),
    originalKept: t('maOriginalKept'),
    submit: t('maSubmitRequest'),
  };

  // Everything a row's pop-up needs that is NOT about the day. The day itself — and, crucially, the
  // section and request_kind it files under — comes off the ROW inside ExceptionTable, so an "Also
  // waiting for you" row from another section still files under its own kind (r227).
  const request: CorrectionRequest = {
    copy,
    approver,
    submitAction: myRequestCorrection,
    minDate: from,
    maxDate: to,
  };

  return (
    // FULL WIDTH (r227). This was `mx-auto max-w-6xl`, which left a wide monitor with empty margins either
    // side of the one table the employee came to read — the same complaint 026e16b9 answered on /leave and
    // af7a8eb4 on the five admin Attendance screens. `pageWideCls` rather than a hand-written class so the
    // screens that went wide did it by ONE means; <body> already carries the gutters (app/layout.tsx).
    <div className={pageWideCls}>
      <PageHeader
        title={t('attendanceRequest')}
        description={
          <>
            {/* Whose days these are, and over what window. The employee is looking at their own record,
                so the identity line is confirmation rather than disclosure — and the window matters
                because it IS the correction cut-off: a day outside it cannot be asked about. */}
            <span>{[me.name, me.employeeCode, me.position, me.company].filter(Boolean).join(' · ')}</span>
            <span className="mt-0.5 block">{t('maPeriodRange', { from, to })}</span>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* The request list left this screen, so the way to what happened next is a link rather than a
                card. Without it the employee files a request and the screen has nowhere to send them. */}
            <Button asChild size="sm" variant="ghost">
              <Link href="/attendance/request-status">{t('maSeeRequestStatus')}</Link>
            </Button>
            {/* "Correct another day" — a day that is NOT flagged above. The SAME pop-up every row opens
                now (r227), with `day={null}`, which is the only thing that makes it the free-date face.
                The stored kind is `other`, which is what that fifth value has always been for. */}
            <CorrectionDialog
              title={t('maFixAnotherHeading')}
              triggerLabel={t('maFixAnotherHeading')}
              triggerIcon={<CalendarPlus className="size-3.5" />}
              closeLabel={t('maClose')}
              cancelLabel={t('maCancel')}
              copy={copy}
              approver={approver}
              submitAction={myRequestCorrection}
              section="other"
              requestKind="other"
              day={null}
              minDate={from}
              maxDate={to}
            />
          </div>
        }
      />

      <ErrorBanner message={sp.error} />

      {/* ── The three exception sections ──────────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TABS.map((tab) => {
          const on = tab.key === section;
          return (
            <Link
              key={tab.key}
              href={href({ section: tab.key, fix: null })}
              className={`rounded-lg border p-3 transition-colors ${
                on ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-card hover:bg-accent/40'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold">
                {tab.label}
                {tab.count > 0 && (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                    {tab.count}
                  </span>
                )}
              </div>
              <p className={`mt-1 text-[11px] ${on ? '' : 'text-muted-foreground'}`}>{tab.help}</p>
            </Link>
          );
        })}
      </div>

      {/* ONE COLUMN (r227). This was a two-column grid whose right-hand 22rem held the Fix panel — the
          split that made a table on a 1920px monitor about half as wide as the screen it sat on. The
          request opens in a pop-up now, so there is nothing left to make room for and the table takes the
          whole width. */}
      <div className="space-y-4">
        {/* ── The Fix panel · a `?fix=YYYY-MM-DD` LINK, and nothing else ──────────────────────────────
            NOTHING GENERATES THIS ADDRESS ANY MORE — the rows open the pop-up. It is kept because the
            address was real for two rounds: a bookmark, or a link already sent to somebody, must still
            open the form for that day rather than land on a screen that ignores half of it. Capped to a
            form's reading width because the page around it is now full width. */}
        {fixDay && (
          <Card className="overflow-hidden sm:max-w-md">
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">
              {t('maFixHeading', { date: fixDay.date })}
            </div>
            <CorrectionForm
              copy={copy}
              approver={approver}
              submitAction={myRequestCorrection}
              /* OFF THE DAY, NOT THE TAB. With one mixed list the open filter no longer implies the
                 kind, and taking it from `section` would file an `all` request under a section that is
                 not one — the r227 lesson, which was about exactly this. */
              section={fixDay.section}
              requestKind={KIND_OF_SECTION[fixDay.section]}
              day={{
                date: fixDay.date,
                missing: fixDay.missing,
                prefillIn: fixDay.prefillIn,
                prefillOut: fixDay.prefillOut,
              }}
              minDate={from}
              maxDate={to}
            />
            {fixDay.section === 'absent' && (
              /* The reporter's second route for an absent day: don't correct the clock, ask for leave —
                 with the date carried across so it does not have to be typed again. The same note the
                 pop-up carries (LeaveInsteadNote), so the two faces cannot offer different routes. */
              <LeaveInsteadNote
                href={`/leave?apply=1&start=${fixDay.date}`}
                help={t('maRequestLeaveHelp')}
                label={t('maRequestLeaveInstead')}
              />
            )}
          </Card>
        )}

        {/* ── Short Hours · Incomplete Entry · Absent — the days found FOR the employee ──────────── */}
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">
            {section === 'all' ? t('maFoundForYouAll') : t('maFoundForYou', { section: TABS.find((x) => x.key === section)!.label })}
          </div>
          {!onClocking ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('maNoClockingRecords')}</p>
          ) : sectionDays.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {section === 'all'
                ? t('maEmptyAll')
                : section === 'incomplete'
                  ? t('maEmptyIncomplete')
                  : section === 'short'
                    ? t('maEmptyShort')
                    : t('maEmptyAbsent')}
            </p>
          ) : (
            <ExceptionTable days={sectionDays} t={t} openDate={sp.fix} pendingDates={pendingDates} request={request} />
          )}
          {/* ⚠️ KEYED ON THE LIST, NOT ON THE TAB. `maAbsentTwoRoutes` promises a second route out loud,
              and on the `all` filter an absent day is on screen while the tab is not "Absent" — a note
              keyed on the tab would silently stop naming a route the row still offers. */}
          {sectionDays.some((d) => d.section === 'absent') && (
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              {t('maAbsentTwoRoutes')}
            </p>
          )}
        </Card>

      </div>
    </div>
  );
}

/** The three sections this screen keeps — Self Overtime is a screen of its own now (c6bb5f5a). */
type ExceptionSection = Exclude<AttendanceSection, 'overtime'>;

/** What the tab strip can be on: the three kinds, or all of them at once (afc29d75, and the default). */
type FilterSection = ExceptionSection | 'all';

/** Stage one's FIXED cut-off: a correction can be asked for up to 30 days back. It is fixed because the
 *  Attendance Request Settings screen that would make it configurable is deliberately stage two — a
 *  hard-coded number that the screen states out loud is honest; a hidden one is not. */
const CORRECTION_WINDOW_DAYS = 30;

/** Date-only arithmetic on a KNOWN day key — the form that must stay UTC (the day key itself came from
 *  todayInKualaLumpur, which is where the timezone belongs). */
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const dayName = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });

type T = Awaited<ReturnType<typeof getTranslations<'me'>>>;

/** The day-INDEPENDENT half of a correction request, handed down to every row's pop-up. Split out so the
 *  day-dependent half (date, section, request_kind, prefills, and the absent day's leave route) is read
 *  off the row and cannot be taken from the open tab by accident. */
type CorrectionRequest = {
  copy: CorrectionCopy;
  approver: string;
  submitAction: (formData: FormData) => void | Promise<void>;
  minDate: string;
  maxDate: string;
};

/**
 * The days-we-found table, stated ONCE and rendered in two places (the open section, and the "Also
 * waiting for you" cards). A second copy would be the fastest way for the two to start describing the
 * same day differently.
 *
 * A plain function taking `t` rather than a `<Component>` boundary: this is server-rendered throughout,
 * so there is no serialisation to respect — and passing `t` across a real client boundary is exactly the
 * closure-from-a-server-component 500 that test/server-client-boundary.test.ts exists for.
 *
 * ⚠️ IT MUST STAY THAT WAY (r227). The Request control is a CLIENT pop-up now, and the temptation is to
 * put `'use client'` at the top of this file to reach it. Don't: this function takes `t`, and the moment
 * it becomes a client component that `t` is a closure crossing the boundary — the r123 shape, which types,
 * `next build` and the whole suite all pass while the page returns 500. The dialog is mounted INSIDE the
 * cell instead, and every prop it is handed is a string, a plain object or the server action itself.
 */
function ExceptionTable({
  days,
  t,
  openDate,
  pendingDates,
  request,
}: {
  days: ExceptionDay[];
  t: T;
  openDate: string | undefined;
  pendingDates: Set<string>;
  request: CorrectionRequest;
}) {
  return (
    <div className={tableWrapCls}>
      <table className="w-full text-sm">
        <thead className={theadCls}>
          <tr>
            <th className={thCls}>{t('maColDate')}</th>
            <th className={thCls}>{t('maColType')}</th>
            <th className={thCls}>{t('maColScheduled')}</th>
            <th className={thCls}>{t('maColFound')}</th>
            <th className={thCls}>{t('maColHave')}</th>
            <th className={thCls} />
          </tr>
        </thead>
        <tbody className={tbodyCls}>
          {days.map((d) => {
            // The absent day's OTHER route, carried into the pop-up with the form (r227). It used to sit
            // in the Card below the inline panel; the form moved and this had to move with it, or
            // `maAbsentTwoRoutes` under the list would name a second route the screen no longer offers.
            const leave =
              d.section === 'absent'
                ? {
                    href: `/leave?apply=1&start=${d.date}`,
                    help: t('maRequestLeaveHelp'),
                    label: t('maRequestLeaveInstead'),
                  }
                : null;
            return (
              <tr key={d.date} className={d.date === openDate ? 'bg-accent/40' : undefined}>
                <td className="px-3 py-2.5">
                  <div className="tabular-nums">{d.date}</div>
                  <div className="text-[11px] text-muted-foreground">{dayName(d.date)}</div>
                </td>
                {/* THE KIND, ON THE ROW. This is what pays for the "Also waiting for you" boxes going
                    away: with one mixed list, nothing about a day's kind is carried by which box it sits
                    in any more, so the row has to say it. Labels are the tabs' own — no new strings for
                    the badge, and no second vocabulary for the same three words. */}
                <td className="px-3 py-2.5">
                  <span
                    className={`inline-flex shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${SECTION_TONE[d.section]}`}
                  >
                    {t(SECTION_LABEL[d.section])}
                  </span>
                </td>
                <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                  {d.scheduledFrom && d.scheduledTo ? `${d.scheduledFrom} – ${d.scheduledTo}` : '—'}
                </td>
                <td className="px-3 py-2.5">
                  <span className="font-medium text-amber-700 dark:text-amber-400">{foundText(d, t)}</span>
                </td>
                <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                  {t('maHaveInOut', { in: d.actualIn ?? '—', out: d.actualOut ?? '—' })}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {/* A date that already has a request WAITING cannot take a second one (the partial unique
                      index), so it says so rather than offering a button the service would refuse. The pair
                      reads Request / Requested since c6bb5f5a — "Fix this" beside "Requested" did not. */}
                  {pendingDates.has(d.date) ? (
                    <span className="text-xs text-muted-foreground">{t('maAlreadyRequested')}</span>
                  ) : (
                    /* r227 — Request OPENS THE POP-UP rather than navigating to `?fix=`. Every label is
                       resolved here, server-side, including the title: `t` may not cross into the client
                       module. `d.section` (not the open tab) decides the kind this files under. */
                    <CorrectionDialog
                      title={t('maFixHeading', { date: d.date })}
                      triggerLabel={t('maFixThis')}
                      // The solid button on the row a legacy `?fix=` link opened, kept exactly as it was —
                      // that row is highlighted and its control should still read as the live one.
                      triggerVariant={d.date === openDate ? 'default' : 'outline'}
                      closeLabel={t('maClose')}
                      cancelLabel={t('maCancel')}
                      copy={request.copy}
                      approver={request.approver}
                      submitAction={request.submitAction}
                      section={d.section}
                      requestKind={KIND_OF_SECTION[d.section]}
                      day={{
                        date: d.date,
                        missing: d.missing,
                        prefillIn: d.prefillIn,
                        prefillOut: d.prefillOut,
                      }}
                      minDate={request.minDate}
                      maxDate={request.maxDate}
                      leaveHref={leave?.href}
                      leaveHelp={leave?.help}
                      leaveLabel={leave?.label}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The three kinds, as the tabs already name them. One mapping, so a badge and a tab can never disagree
 * about what a section is called — and no new message keys, in six locales, for three words the
 * catalogue already holds.
 */
const SECTION_LABEL = {
  short: 'maSectionShort',
  incomplete: 'maSectionIncomplete',
  absent: 'maSectionAbsent',
} as const satisfies Record<ExceptionSection, string>;

/** Colour per kind, matching the approved picture. Absent is the one that stops a day counting at all. */
const SECTION_TONE: Record<ExceptionSection, string> = {
  short: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  incomplete: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  absent: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
};

/** What the row says we found. Duration comes from the STORED figures where there is one; a `late` day
 *  whose late_minutes is null (196 of 270 production rows predate the engine that writes them) is still
 *  listed — the engine did classify it — but says the duration was not recorded rather than "0 min". */
function foundText(d: ExceptionDay, t: T): string {
  if (d.section === 'incomplete') return d.missing === 'in' ? t('maFoundMissingIn') : t('maFoundMissingOut');
  if (d.section === 'absent') return t('maFoundAbsent');
  const parts: string[] = [];
  if (d.flag === 'late') {
    parts.push(d.lateMinutes != null ? t('maFoundLateBy', { minutes: d.lateMinutes }) : t('maFoundLateUnknown'));
  }
  if (d.earlyOutMinutes != null && d.earlyOutMinutes > 0) {
    parts.push(t('maFoundEarlyBy', { minutes: d.earlyOutMinutes }));
  }
  if (parts.length === 0) parts.push(t('maFoundShort'));
  return parts.join(' · ');
}
