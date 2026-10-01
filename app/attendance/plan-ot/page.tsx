import { formatMinutesToHM } from '@/lib/overtime-duration';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { myOvertimePlanCounts, myOvertimePlans, otPlanCalendarMonth } from '@/packs/attendance/service';
import type { OvertimePlanSort } from '@/packs/attendance/service';
import {
  Button,
  Card,
  ErrorBanner,
  PageHeader,
  inputCls,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { Pager } from '@/components/pager';
import { pageHref, pageState, parsePageQuery } from '@/lib/pagination';
import { OtPlanCalendar, type OtCalendarCell, type OtCalendarPlanStatus } from '@/components/ot-plan-calendar';
import { addMonths, isMonthParam, monthRange } from '@/lib/roster-month';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myWithdrawOvertimePlan } from '@/app/me/actions';
import { Pill, REQUEST_STATUSES, statusLabel, type RequestStatus } from '../request-ui';

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
 * ── f618065d (r362) — FULL WIDTH, AND THE LIST BECOMES A LIST ────────────────────────────────────────
 * The reporter raised the width; reading the screen showed the width was the smallest part of it. What
 * changed, and the reasoning that is not obvious from the diff:
 *
 *  · `pageWideCls`, and this file is now in WIDE_LIST_SCREENS (test/attendance-screens-layout.test.ts) so
 *    a cap cannot quietly come back. No side padding is added: app/layout.tsx's shell already supplies the
 *    same edges the eight attendance screens beside this one have.
 *  · STATUS CHIPS WITH COUNTS, derived from `REQUEST_STATUSES` rather than restated — the tuple is pinned
 *    against the database enum, so a fifth status cannot reach this row without someone deciding it does.
 *  · ⚠️ THE COUNTS DO NOT COME FROM THE ROWS. The list is paged; counting the fetched page would make a
 *    chip say 25 over a set of 300. `myOvertimePlanCounts` is a second GROUP BY that also yields the
 *    pager's total and the summary hours, so the screen is two queries rather than one plus a lie.
 *  · A DATE WINDOW THAT IS OPEN AT THE TOP by default. "Last 3 months" closed at today would hide next
 *    week's plan — and filing before the day is what this screen is FOR. Hence "and upcoming", and hence
 *    the summary line says which window it is talking about.
 *  · "GOES TO" ONLY WHILE PENDING. It printed the employee's CURRENT administrative manager on every row,
 *    including rejected and withdrawn ones: a statement that the request is still with that person when it
 *    was decided weeks ago, and possibly not even the right name. Same decision, same reasoning, already
 *    taken on the sibling screen (app/attendance/request-status/page.tsx).
 *  · THE DEAD WITHDRAW WORD IS GONE. The eligibility rule is UNCHANGED and deliberately wider than
 *    pending (the ticket asked for pending-only, which would remove a capability `cancelPlannedOvertime`
 *    still allows); what went is the greyed-out, non-interactive word rendered where it does nothing.
 *  · SUBMITTED ON uses `todayInKualaLumpur(createdAt)`, NOT `createdAt.toISOString().slice(0,10)`. The
 *    sibling screen's column is a UTC slice shown to a UTC+8 audience and prints the previous day for
 *    anything filed before 08:00 MYT; its own comment calls that a real pre-existing defect. This column
 *    is right from the start. Fixing that screen is deliberately not in this round.
 *
 *  · r362 could display only the employee note and answer date because rejection explanations were
 *    not then recorded. r378 adds the stored approver explanation, while legacy rows explicitly say
 *    it was not recorded. The employee note remains a distinct field.
 *
 * Withdraw confirmation, a narrow-screen block face, and 20-row paging remain outside this change.
 */
export default async function SelfOvertimePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    view?: string;
    month?: string;
    /** pending | approved | rejected | cancelled (absent = All). */
    status?: string;
    /** Only ever 'custom': the other three windows ARE their from/to pair in the address. */
    preset?: string;
    from?: string;
    to?: string;
    q?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const t = await getTranslations('me');
  const attendanceLabels = await getTranslations('attendance');
  const locale = await getLocale();
  const sp = await searchParams;
  const s = await getSession();
  const me = await myEmployment(s);

  if (!me) {
    return (
      // A one-sentence notice, so it stays centred and narrow while the SCREEN is full width.
      // `max-w-md` rather than `max-w-2xl` deliberately, the same choice and for the same reason as
      // app/attendance/requests/page.tsx: test/attendance-screens-layout.test.ts reads this file for a
      // page-level `mx-auto` + `max-w-…xl` cap, which is exactly the shape this round took off the screen.
      <div className="mx-auto max-w-md">
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

  // ── The filter state, resolved from the address ────────────────────────────────────────────────────
  // The URL whitelist is the SAME tuple the chips are drawn from, never a second copy: a filter that
  // looked right and returned nothing forever is how those two come to disagree.
  const statusFilter: RequestStatus | null = REQUEST_STATUSES.includes(sp.status as never)
    ? (sp.status as RequestStatus)
    : null;
  const q = (sp.q ?? '').trim();
  const windows = datePresetWindows(today);
  const askedFrom = isIsoDate(sp.from) ? sp.from : undefined;
  const askedTo = isIsoDate(sp.to) ? sp.to : undefined;
  const preset = activePreset(sp.preset, askedFrom, askedTo, windows);
  const dateWindow = preset === 'custom' ? { from: askedFrom, to: askedTo } : windows[preset];
  const sortKey: OvertimePlanSort = SORTS.includes(sp.sort as never) ? (sp.sort as OvertimePlanSort) : 'date';
  const sortDir: 'asc' | 'desc' = sp.dir === 'asc' ? 'asc' : 'desc';
  const pq = parsePageQuery(sp);
  const filter = { from: dateWindow.from, to: dateWindow.to, q: q || undefined };

  const [plans, lines, calendar, monthPlans, counts] = await Promise.all([
    myOvertimePlans(s, me.employmentId, {
      ...filter,
      status: statusFilter ?? undefined,
      sort: sortKey,
      dir: sortDir,
      limit: pq.limit,
      offset: pq.offset,
    }),
    reportingLinesFor(s, me.employmentId),
    // The calendar's two reads are paid for ONLY when the calendar is on screen. The table is the
    // default and is byte-identical to what it costs today.
    isCalendar ? otPlanCalendarMonth(s, me.employmentId, month) : Promise.resolve([]),
    isCalendar
      ? myOvertimePlans(s, me.employmentId, { from: monthFrom, to: monthTo, limit: 200 })
      : Promise.resolve([]),
    // ⚠️ The SAME `filter` the rows were read with, minus the status — that is what makes every chip's
    // number describe the same set the list underneath is a page of.
    myOvertimePlanCounts(s, me.employmentId, filter),
  ]);
  // Who the plan goes to. Resolved from the administrative reporting line — the edge assertCanDecide routes
  // the decision along — falling back to HR rather than blank, because "nobody" is never the answer.
  const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');

  const byStatus = new Map(counts.map((c) => [c.status, c]));
  const chipCount = (st: RequestStatus | null) =>
    st ? (byStatus.get(st)?.count ?? 0) : counts.reduce((n, c) => n + c.count, 0);
  const total = chipCount(statusFilter);
  // "Hours requested" is the only figure true of every row in a mixed list: approvedOtMinutes is null on
  // pending, rejected and withdrawn rows, so a mixed sum of it would not be a number of anything.
  const requestedMinutes = statusFilter
    ? (byStatus.get(statusFilter)?.requestedMinutes ?? 0)
    : counts.reduce((n, c) => n + c.requestedMinutes, 0);
  const approvedMinutes = byStatus.get('approved')?.approvedMinutes ?? 0;
  const state = pageState(pq, total, plans.length);

  // ── Addresses. Everything rides in the URL, so a copied link opens the view its sender was reading ──
  const viewParams: Record<string, string | undefined> = {
    status: statusFilter ?? undefined,
    preset: preset === 'custom' ? 'custom' : undefined,
    // The default window is the one thing NOT written into the address: pinning "three months back" to a
    // literal date would freeze a bookmark's window on the day it was made, and this screen's default is
    // deliberately relative to today.
    from: preset === 'recent' ? undefined : dateWindow.from,
    to: preset === 'recent' ? undefined : dateWindow.to,
    q: q || undefined,
    sort: sortKey === 'date' && sortDir === 'desc' ? undefined : sortKey,
    dir: sortKey === 'date' && sortDir === 'desc' ? undefined : sortDir,
    size: sp.size,
  };
  const hrefFor = (over: Record<string, string | number | undefined>) => pageHref(LIST_PATH, viewParams, over);
  // A page step is the one thing a filter change must NOT keep: page 4 of the old filter is nowhere in
  // the new one. `page` is absent from viewParams, so every link below already drops it.
  const presetHref = (p: DatePreset) =>
    hrefFor(
      p === 'custom'
        ? { preset: 'custom', from: dateWindow.from, to: dateWindow.to }
        : { preset: undefined, from: p === 'recent' ? undefined : windows[p].from, to: p === 'recent' ? undefined : windows[p].to },
    );
  const sortHref = (key: OvertimePlanSort) =>
    hrefFor({ sort: key, dir: sortKey === key && sortDir === 'desc' ? 'asc' : 'desc' });
  // The filter panel is a plain GET form carrying only its OWN fields, so every other param the screen
  // reads has to ride along as a hidden input — otherwise applying a search would silently reset the
  // chip, the window and the sort. Same treatment as the history filter on app/leave.
  const formHidden: [string, string][] = Object.entries({
    ...viewParams,
    q: undefined,
    ...(preset === 'custom' ? { from: undefined, to: undefined } : {}),
  }).flatMap(([k, v]) => (v ? [[k, v] as [string, string]] : []));
  const filtered = statusFilter != null || q !== '' || preset !== 'recent' || sortKey !== 'date' || sortDir !== 'desc';

  // ⚠️ EVERY EMPTY STATE NAMES THE PERIOD, and the old one did not. `otNoPlans` read "You have not filed
  // any overtime plans yet" — which the default window makes false the moment an employee's only plan is
  // four months old. A caption that asserts something untrue is worse than one that is merely terse.
  const EMPTY: Record<RequestStatus, string> = {
    pending: t('otEmptyPending'),
    approved: t('otEmptyApproved'),
    rejected: t('otEmptyRejected'),
    cancelled: t('otEmptyWithdrawn'),
  };
  const emptyMessage = statusFilter ? EMPTY[statusFilter] : t('otEmptyAll');
  const windowCaption = dateWindow.to
    ? t('otWindowRange', { from: dateWindow.from ?? '—', to: dateWindow.to })
    : dateWindow.from
      ? t('otWindowFrom', { from: dateWindow.from })
      : '';

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
  const sortTh = (key: OvertimePlanSort, label: string) => {
    const on = sortKey === key;
    return (
      <th className={thCls} aria-sort={on ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <Link href={sortHref(key)} aria-label={t('otSortBy', { column: label })} className="inline-flex items-center gap-1 hover:text-foreground">
          {label}
          <span aria-hidden="true">{on ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
        </Link>
      </th>
    );
  };

  return (
    <div className={pageWideCls}>
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
        ) : (
          <>
            {/* THE CHIPS. Derived from the ONE tuple, never restated — and labelled through
                statusLabel(…, true), which is what turns the stored `cancelled` into "Withdrawn". */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              {STATUS_FILTERS.map((f) => {
                const on = (f ?? null) === statusFilter;
                return (
                  <Link
                    key={f ?? 'all'}
                    href={hrefFor({ status: f ?? undefined })}
                    // Not visible: without it, colour is the ONLY carrier of which filter is applied, so
                    // a screen reader hears five identical links.
                    aria-current={on ? 'true' : undefined}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {f == null ? t('maFilterAll') : statusLabel(f, t, true)}{' '}
                    <span className="tabular-nums opacity-80">{chipCount(f ?? null)}</span>
                  </Link>
                );
              })}
            </div>

            <form method="get" action={LIST_PATH} className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
              {formHidden.map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('otDateFilterLabel')}
                </span>
                <span className="inline-flex overflow-hidden rounded-md border border-border">
                  {DATE_PRESETS.map((p) => (
                    <Link
                      key={p}
                      href={presetHref(p)}
                      aria-current={preset === p ? 'page' : undefined}
                      className={`px-3 py-1 text-sm ${
                        preset === p ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'
                      }`}
                    >
                      {t(PRESET_KEY[p])}
                    </Link>
                  ))}
                </span>
              </div>
              {/* ONE control per view: a From/To pair sitting inert beside a chosen month preset is a
                  control that does nothing, which is worse than a control that is absent. */}
              {preset === 'custom' && (
                <>
                  <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('fromLabel')}
                    <input type="date" name="from" defaultValue={askedFrom ?? ''} className={inputCls} />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('toLabel')}
                    <input type="date" name="to" defaultValue={askedTo ?? ''} className={inputCls} />
                  </label>
                </>
              )}
              <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('otSearchLabel')}
                <input name="q" defaultValue={q} placeholder={t('otSearchPlaceholder')} className={inputCls} />
              </label>
              <Button type="submit" size="sm" variant="outline">
                {t('otFilterApply')}
              </Button>
              {filtered && (
                <Link href={LIST_PATH} className="pb-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline">
                  {t('otResetFilters')}
                </Link>
              )}
            </form>

            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-sm">
              <span className="font-medium">{t('otSummaryRequests', { count: total })}</span>
              <span className="text-muted-foreground">·</span>
              <span className="font-medium tabular-nums">
                {t('otSummaryHoursRequested', { hours: formatMinutesToHM(requestedMinutes) })}
              </span>
              {/* Only on the Approved chip. Approved hours can be LOWER than requested — the approver may
                  trim a plan, or the rule may measure the day against what was actually clocked. */}
              {statusFilter === 'approved' && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-medium tabular-nums">
                    {t('otSummaryHoursApproved', { hours: formatMinutesToHM(approvedMinutes) })}
                  </span>
                </>
              )}
              {windowCaption && <span className="text-xs text-muted-foreground">{windowCaption}</span>}
            </div>

            {plans.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
            ) : (
              <div className={tableWrapCls}>
                <table className="w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      {sortTh('date', t('otDateColumn'))}
                      <th className={thCls}>{t('otPlannedTimeColumn')}</th>
                      {sortTh('hours', t('otHoursColumn'))}
                      {/* ce5ded11 — the figure that actually reaches payroll, which was fetched and never
                          printed. Blank until a decision exists: a plan still waiting has no approved figure,
                          and echoing the requested one there would claim an approval nobody has given. */}
                      <th className={thCls}>{t('otApprovedHoursColumn')}</th>
                      <th className={thCls}>{t('reasonRequired')}</th>
                      <th className={thCls}>{t('otGoesToColumn')}</th>
                      {sortTh('submitted', t('maColSubmitted'))}
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
                            {p.requestedOtMinutes != null ? formatMinutesToHM(p.requestedOtMinutes) : '—'}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {p.approvedOtMinutes != null ? formatMinutesToHM(p.approvedOtMinutes) : '—'}
                          </td>
                          {/* The wide page's room goes here, and anything still too long is shortened on
                              screen with the whole of it on the native title — the house pattern; there is
                              no Tooltip component in this codebase. */}
                          <td
                            className="max-w-[28rem] truncate px-3 py-2"
                            // The note is inside the truncating cell, so it has to be inside the title
                            // too — the plan's promise is that anything shortened on screen can be read
                            // by resting on it, and that is the whole cell, not the first line of it.
                            title={[p.reason, p.remark].filter(Boolean).join('\n')}
                          >


                            <span className="text-muted-foreground">{p.reason ?? ''}</span>
                            {/* The EMPLOYEE's own optional note, which the plan promised on a rejected row
                                in place of the approver's reason the system does not hold. Same shape as
                                the sibling screen: italic, underneath, never mistaken for the reason. */}
                            {p.remark && <span className="block text-[11px] italic text-muted-foreground">{p.remark}</span>}
                          </td>
                          {/* ⚠️ ONLY WHILE IT IS STILL TRUE — see the header. */}
                          <td className="px-3 py-2 text-muted-foreground">{p.status === 'pending' ? approver : '—'}</td>
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">
                            {todayInKualaLumpur(p.createdAt)}
                          </td>
                          <td className="px-3 py-2">
                            <Pill status={p.status} label={statusLabel(p.status, t, true)} />
                            {p.status === 'approved' && (
                              <div className="mt-0.5 text-[11px] text-muted-foreground">
                                {/* ⚠️ LEFT AS IT WAS, AND IT IS THE SAME UTC-SLICE DEFECT the Submitted on
                                    column above already avoids. `appliedAt` is an INSTANT, and naming it
                                    in UTC for a UTC+8 reader prints the previous day for anything counted
                                    before 08:00 MYT. It was left in the f618065d build on the reasoning
                                    that changing a shipped date is not presentational — but the stored
                                    timestamp does not move, only which calendar day we name it, and the
                                    day it named was wrong for a third of every day. Two dates on one
                                    screen resolved by two different rules is the worse outcome.

                                    test/today-in-myt-drift.test.ts does NOT catch this: it is scoped, on
                                    purpose, to the argless `new Date().toISOString()` "what date is NOW"
                                    form, because `new Date(iso).toISOString()` date-only ARITHMETIC is
                                    correct in UTC and must stay there. A stored instant rendered as a
                                    calendar day is neither, and falls in the gap between them. */}
                                {p.appliedAt
                                  ? t('otCountedOnDay', { date: todayInKualaLumpur(p.appliedAt) })
                                  : t('otNotWorkedYet')}
                              </div>
                            )}
                            {p.status === 'rejected' && <div className="mt-0.5 text-[11px] text-red-700 dark:text-red-300">
                              {attendanceLabels('rejectReasonLabel')}: {p.rejectReason ?? attendanceLabels('rejectNotRecorded')}
                            </div>}
                            {p.status === 'rejected' && p.decidedAt && (
                              <div className="mt-0.5 text-[11px] text-muted-foreground">
                                {t('decidedOn', { date: todayInKualaLumpur(p.decidedAt) })}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {canWithdraw ? (
                              <form action={myWithdrawOvertimePlan}>
                                <input type="hidden" name="correctionId" value={p.id} />
                                <Button type="submit" size="sm" variant="outline" aria-label={`${t('otWithdraw')} · ${p.attendanceDate}`}>
                                  {t('otWithdraw')}
                                </Button>
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <Pager basePath={LIST_PATH} params={viewParams} state={state} />
          </>
        )}
      </Card>
    </div>
  );
}

/** This screen's own address, in one place, so the form, the links and the pager cannot disagree. */
const LIST_PATH = '/attendance/plan-ot';

/** The chip row: All, then the four stored statuses — derived from the ONE tuple, never restated. */
const STATUS_FILTERS = [null, ...REQUEST_STATUSES] as const;

/** …and the sort whitelist is the service's own list, so the address bar cannot name a column. */
const SORTS: readonly OvertimePlanSort[] = ['date', 'hours', 'submitted'];

const DATE_PRESETS = ['recent', 'thisMonth', 'lastMonth', 'custom'] as const;
type DatePreset = (typeof DATE_PRESETS)[number];

const PRESET_KEY: Record<DatePreset, string> = {
  recent: 'otPresetRecent',
  thisMonth: 'otPresetThisMonth',
  lastMonth: 'otPresetLastMonth',
  custom: 'otPresetCustom',
};

/** yyyy-mm-dd, the only date shape this screen accepts off the address bar. */
const isIsoDate = (v: string | undefined): v is string => v != null && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * The three computed windows, resolved against the tenant's calendar day.
 *
 * ⚠️ `recent` HAS NO UPPER BOUND, AND THAT IS THE POINT. Overtime is filed BEFORE the day, so a closed
 * three-month window would hide the very plan an employee opens this screen to watch. The caption says
 * "and upcoming" for the same reason: a preset labelled "Last 3 months" that shows next month's plan is a
 * caption asserting something untrue.
 */
function datePresetWindows(today: string): Record<'recent' | 'thisMonth' | 'lastMonth', { from?: string; to?: string }> {
  const [y, m, d] = today.split('-').map(Number);
  // Three months back on the same day of the month, clamped to that month's length so 31 May does not
  // roll forward into March.
  const start = new Date(Date.UTC(y, m - 4, 1));
  const lastDayThere = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(d, lastDayThere));
  const monthPair = (back: number) => ({
    from: new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(y, m - back, 0)).toISOString().slice(0, 10),
  });
  return {
    recent: { from: start.toISOString().slice(0, 10), to: undefined },
    thisMonth: monthPair(0),
    lastMonth: monthPair(1),
  };
}

/**
 * Which preset the address is describing.
 *
 * The two month presets ARE their from/to pair in the URL, so a copied link reproduces the window it was
 * copied from. `recent` is the bare address (see viewParams for why it is not written out), and anything
 * else — including an explicit `?preset=custom` with the boxes still empty — is Custom.
 */
function activePreset(
  raw: string | undefined,
  from: string | undefined,
  to: string | undefined,
  windows: ReturnType<typeof datePresetWindows>,
): DatePreset {
  if (raw === 'custom') return 'custom';
  if (from == null && to == null) return 'recent';
  const match = (['thisMonth', 'lastMonth'] as const).find((k) => windows[k].from === from && windows[k].to === to);
  if (match) return match;
  return from === windows.recent.from && to == null ? 'recent' : 'custom';
}
