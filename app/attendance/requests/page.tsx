import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import {
  attendanceForEmploymentRange,
  myAttendanceCorrections,
  myOvertimePlans,
} from '@/packs/attendance/service';
import { myTravelRequests } from '@/core/travel-request';
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  inputCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  myCancelAttendanceRequest,
  myRequestCorrection,
  myRequestTravel,
  myWithdrawOvertimePlan,
} from '@/app/me/actions';
import {
  KIND_OF_SECTION,
  defaultSection,
  groupExceptions,
  parseSection,
  type AttendanceSection,
  type ExceptionDay,
} from './sections';

/**
 * My Attendance (2166ef79 stage one) — the employee's own attendance exceptions, and the requests that
 * fix them.
 *
 * WHAT WAS ACTUALLY WRONG, because it was not what the ticket's title suggests. Nothing here needed to be
 * DETECTED for the first time. `flagOf` / `statusOf` (core/attendance-derive.ts) have decided, for every
 * day, whether a punch is missing, the arrival was late, the day finished short or the employee was
 * absent — since bbada39c. They run on Attendance > Records > Individual, which is HR's verification
 * table: seventeen columns, an employee dropdown, and no action on any row. So the employee could in
 * principle reach the answer and could do nothing with it, and in practice never looked. This screen shows
 * them THEIR OWN flagged days and puts the request that fixes each one on the row. Across 35 clocking
 * employees, 56 days sit with a clock-in and no clock-out — 22 different people — every one of them
 * counting zero hours worked and zero overtime, and in seven weeks exactly three attendance requests have
 * ever been filed. That gap is the item.
 *
 * MOVED, NOT REBUILT — the pattern 0bb0e303 and 1e9145d4 already used on these same forms:
 *   • Self Overtime IS the Plan OT list (myOvertimePlans), rendered here. /attendance/plan-ot forwards to
 *     this section, so the nav row staff already use keeps resolving and the Apply form is untouched.
 *   • Every request still goes through requestAttendanceCorrection → decideAttendanceCorrection. There is
 *     no second request type, no second detection path and no second approval route.
 *   • Travel Request stays on this screen, unchanged. It is not one of the four and is not being folded in.
 *
 * THE WINDOW IS THE CUT-OFF, and they are deliberately the same number. Stage one runs on fixed rules
 * until the Attendance Request Settings screen exists (stage two), and one of them is that a correction
 * can be asked for up to 30 days back — so listing days you could not act on would be a screen full of
 * dead rows. TODAY IS EXCLUDED: a day still being worked has no clock-out yet and would be flagged as an
 * Incomplete Entry every single morning.
 *
 * NOT IN STAGE ONE, and deliberately not half-built: the ~40-setting Attendance Request Settings screen,
 * approval chains with more than one level and the level-by-level progress, Pay Mode (overtime pay vs
 * replacement leave), and Request-to-Void. Each changes what somebody is paid or who signs it off.
 * Request-to-Void in particular needs a stored waiver mark on the day, and with the live rule's
 * apply_deductions switched off it would change nothing anybody could see — so it cannot honestly ship as
 * a no-op.
 *
 * TRUST MODEL: unchanged from the screen this replaces. The viewer's OWN employment is resolved from the
 * session, every read is RLS-scoped to it, and each action re-resolves the caller server-side. Self-
 * service, so NO page guard — see the nav row in packs/attendance/index.ts and the assertion in
 * test/attendance-menu-relocation.test.ts.
 *
 * DATES: every day key comes from todayInKualaLumpur; date-only arithmetic stays UTC. An ISO timestamp
 * sliced to ten characters names YESTERDAY between 00:00 and 08:00 MYT (bb4f2265) — and a night-shift
 * employee filing a correction is exactly the person who would meet that.
 */
export default async function MyAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    /** Which of the four sections is open. */
    section?: string;
    /** The day whose Fix panel is open (YYYY-MM-DD). */
    fix?: string;
    /** The request-list status filter: pending | approved | rejected | cancelled (absent = All). */
    status?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const t = await getTranslations('me');
  const sp = await searchParams;
  const s = await getSession();
  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('myAttendanceTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const today = todayInKualaLumpur();
  const from = addDays(today, -CORRECTION_WINDOW_DAYS);
  const to = addDays(today, -1); // yesterday — see the header note on why today is out.

  const [days, requests, plans, travelRequests, lines] = await Promise.all([
    attendanceForEmploymentRange(s, me.employmentId, from, to),
    myAttendanceCorrections(s, me.employmentId, { limit: 200 }),
    myOvertimePlans(s, me.employmentId, { limit: 100 }),
    myTravelRequests(s, me.employmentId),
    reportingLinesFor(s, me.employmentId),
  ]);
  // Who a request goes to. Resolved from the administrative reporting line — the edge assertCanDecide
  // routes an attendance decision along — falling back to HR rather than blank, because "nobody" is never
  // the answer: an employee with no line still has their request decided, by HR. The employee NEVER picks
  // (they cannot, and never will be able to); what is missing today is more than one LEVEL, and that is
  // stage two.
  const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');

  // An employee who is not on clocking at all has no attendance rows, and every scheduled day in the
  // window would then read as an unexplained absence — a wall of red for somebody whose company simply
  // does not clock them. That is a false positive, not a finding, so the sections say so instead.
  const onClocking = days.some((d) => d.attendanceId != null);
  const found = onClocking
    ? groupExceptions(days)
    : { incomplete: [], short: [], absent: [] };
  const counts = { incomplete: found.incomplete.length, short: found.short.length, absent: found.absent.length };
  const section: AttendanceSection = parseSection(sp.section) ?? defaultSection(counts);

  // A date that already has a request WAITING cannot take a second one: attendance_correction carries a
  // partial unique index on (employment, date) WHERE status = 'pending'. The row shows "Requested" rather
  // than a Fix button that the service would refuse — the service is still the authority, this only
  // decides whether to draw a control.
  const pendingDates = new Set(requests.filter((r) => r.status === 'pending').map((r) => r.attendanceDate));

  const sectionDays: ExceptionDay[] =
    section === 'incomplete' ? found.incomplete : section === 'short' ? found.short : section === 'absent' ? found.absent : [];
  const fixDay = sp.fix ? sectionDays.find((d) => d.date === sp.fix) ?? null : null;

  const statusFilter = parseStatus(sp.status);
  const shownRequests = statusFilter ? requests.filter((r) => r.status === statusFilter) : requests;
  const reqPage = paginateRows(shownRequests, parsePageQuery(sp));

  const href = (next: { section?: AttendanceSection; fix?: string | null; status?: string | null }) => {
    const q = new URLSearchParams();
    q.set('section', next.section ?? section);
    const fix = next.fix === undefined ? sp.fix : next.fix;
    if (fix) q.set('fix', fix);
    const st = next.status === undefined ? statusFilter : next.status;
    if (st) q.set('status', st);
    return `/attendance/requests?${q.toString()}`;
  };

  const TABS: { key: AttendanceSection; label: string; help: string; count: number | null }[] = [
    { key: 'overtime', label: t('maSectionOvertime'), help: t('maSectionOvertimeHelp'), count: null },
    { key: 'short', label: t('maSectionShort'), help: t('maSectionShortHelp'), count: counts.short },
    { key: 'incomplete', label: t('maSectionIncomplete'), help: t('maSectionIncompleteHelp'), count: counts.incomplete },
    { key: 'absent', label: t('maSectionAbsent'), help: t('maSectionAbsentHelp'), count: counts.absent },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('myAttendanceTitle')}
        description={
          <>
            {/* Whose days these are, and over what window. The employee is looking at their own record,
                so the identity line is confirmation rather than disclosure — and the window matters
                because it IS the correction cut-off: a day outside it cannot be asked about. */}
            <span>
              {[me.name, me.employeeCode, me.position, me.company].filter(Boolean).join(' · ')}
            </span>
            <span className="mt-0.5 block">{t('maPeriodRange', { from, to })}</span>
          </>
        }
        actions={
          <Button asChild size="sm">
            {/* Apply OT Plan is UNTOUCHED where it lives; only its entry point moved onto this screen. */}
            <Link href="/attendance/plan-ot/apply">{t('maApplyOvertime')}</Link>
          </Button>
        }
      />

      <ErrorBanner message={sp.error} />

      {/* ── The four sections ─────────────────────────────────────────────────────────────────────── */}
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
                {tab.count != null && tab.count > 0 && (
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

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          {section === 'overtime' ? (
            /* ── Self Overtime — the Plan OT list, moved in whole (1e9145d4). Same rows, same wording,
                 same withdraw rule, same service. ─────────────────────────────────────────────────── */
            <Card className="overflow-hidden">
              <div className="border-b border-border px-4 py-3 text-sm font-semibold">{t('maSectionOvertime')}</div>
              {plans.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('otNoPlans')}</p>
              ) : (
                <div className={tableWrapCls}>
                  <table className="w-full text-sm">
                    <thead className={theadCls}>
                      <tr>
                        <th className={thCls}>{t('otDateColumn')}</th>
                        <th className={thCls}>{t('otPlannedTimeColumn')}</th>
                        <th className={thCls}>{t('otHoursColumn')}</th>
                        <th className={thCls}>{t('reasonRequired')}</th>
                        <th className={thCls}>{t('otGoesToColumn')}</th>
                        <th className={thCls}>{t('otStatusColumn')}</th>
                        <th className={thCls} />
                      </tr>
                    </thead>
                    <tbody className={tbodyCls}>
                      {plans.map((p) => {
                        // Mirrored from cancelPlannedOvertime so the control is not offered where the
                        // service would refuse it. The SERVICE is the authority.
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
                            <td className="px-3 py-2">
                              {p.otReasonCategory && (
                                <span className="font-medium">{t(CATEGORY_KEY[p.otReasonCategory])}</span>
                              )}
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
          ) : (
            <>
              {/* ── Short Hours · Incomplete Entry · Absent — the days found FOR the employee ───────── */}
              <Card className="overflow-hidden">
                <div className="border-b border-border px-4 py-3 text-sm font-semibold">
                  {t('maFoundForYou', { section: TABS.find((x) => x.key === section)!.label })}
                </div>
                {!onClocking ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('maNoClockingRecords')}</p>
                ) : sectionDays.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {section === 'incomplete'
                      ? t('maEmptyIncomplete')
                      : section === 'short'
                        ? t('maEmptyShort')
                        : t('maEmptyAbsent')}
                  </p>
                ) : (
                  <ExceptionTable
                    days={sectionDays}
                    t={t}
                    openDate={sp.fix}
                    pendingDates={pendingDates}
                    fixHref={(d) => href({ fix: d })}
                  />
                )}
                {section === 'absent' && sectionDays.length > 0 && (
                  <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                    {t('maAbsentTwoRoutes')}
                  </p>
                )}
              </Card>

              {/* ── "Also waiting for you" — the OTHER sections' days, in view. ──────────────────────
                  The counts on the tabs already say a section is not empty; this says WHAT is in it, so a
                  missing clock-out and a late arrival do not need two visits to be seen. Only the first
                  few rows, with a link into the section for the rest — the mockup draws one such card,
                  and an Absent section with twenty days would otherwise bury the tab the employee chose. */}
              {onClocking &&
                OTHER_SECTIONS[section].map((other) => {
                  const days = other === 'incomplete' ? found.incomplete : other === 'short' ? found.short : found.absent;
                  if (days.length === 0) return null;
                  const label = TABS.find((x) => x.key === other)!.label;
                  return (
                    <Card key={other} className="overflow-hidden">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                        <span className="text-sm font-semibold">{t('maAlsoWaiting', { section: label })}</span>
                        {days.length > ALSO_ROWS && (
                          <Link
                            href={href({ section: other, fix: null })}
                            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                          >
                            {t('maSeeAllInSection', { count: days.length })}
                          </Link>
                        )}
                      </div>
                      <ExceptionTable
                        days={days.slice(0, ALSO_ROWS)}
                        t={t}
                        openDate={undefined}
                        pendingDates={pendingDates}
                        // Fixing from here SWITCHES to that section, so the panel beside it files the
                        // request under the right kind — the stored kind is what the request list reads.
                        fixHref={(d) => href({ section: other, fix: d })}
                      />
                    </Card>
                  );
                })}
            </>
          )}
        </div>

        {/* ── The Fix panel · the request, already filled in ───────────────────────────────────────── */}
        {section !== 'overtime' && (
          <Card className="overflow-hidden">
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">
              {fixDay ? t('maFixHeading', { date: fixDay.date }) : t('maFixAnotherHeading')}
            </div>
            {/* NO explicit encType: React sets multipart itself for a form whose action is a function, and
                spelling it out earns "Cannot specify a encType or method for a form that specifies a
                function as the action" in the dev log on every render. The file input below still uploads. */}
            <form action={myRequestCorrection} className="space-y-2.5 p-4">
              <input type="hidden" name="section" value={section} />
              <input type="hidden" name="requestKind" value={KIND_OF_SECTION[section]} />
              {fixDay ? (
                <>
                  <input type="hidden" name="date" value={fixDay.date} />
                  <div className="grid grid-cols-2 gap-2">
                    {/* The half we already hold is LOCKED and travels in a hidden field: the service refuses
                        a clock-out with no clock-in (it has no anchor to derive against), so the prefill has
                        to carry it — and letting the employee retype a punch that is already correct is how
                        a correction introduces a second error. */}
                    {fixDay.missing === 'out' ? (
                      <>
                        <Field label={t('checkInLabel')}>
                          <input type="hidden" name="checkIn" value={fixDay.prefillIn ?? ''} />
                          <div className={`${inputCls} flex items-center bg-muted/40`}>{fixDay.prefillIn ?? '—'}</div>
                        </Field>
                        <Field label={t('checkOutLabel')} required requiredAriaLabel={t('maRequired')}>
                          <input
                            type="time"
                            name="checkOut"
                            required
                            defaultValue={fixDay.prefillOut ?? ''}
                            className={inputCls}
                          />
                        </Field>
                      </>
                    ) : (
                      <>
                        <Field label={t('checkInLabel')} required requiredAriaLabel={t('maRequired')}>
                          <input
                            type="time"
                            name="checkIn"
                            required
                            defaultValue={fixDay.prefillIn ?? ''}
                            className={inputCls}
                          />
                        </Field>
                        <Field label={t('checkOutLabel')}>
                          <input
                            type="time"
                            name="checkOut"
                            defaultValue={fixDay.prefillOut ?? ''}
                            className={inputCls}
                          />
                        </Field>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground">{t('maFixAnotherHelp')}</p>
                  <Field label={t('dateLabel')} required requiredAriaLabel={t('maRequired')}>
                    <input type="date" name="date" required max={to} min={from} className={inputCls} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t('checkInLabel')}>
                      <input type="time" name="checkIn" defaultValue="09:00" className={inputCls} />
                    </Field>
                    <Field label={t('checkOutLabel')}>
                      <input type="time" name="checkOut" defaultValue="18:00" className={inputCls} />
                    </Field>
                  </div>
                </>
              )}

              <Field label={t('reasonRequired')} required requiredAriaLabel={t('maRequired')}>
                <input name="reason" required placeholder={t('reasonPlaceholder')} className={inputCls} />
              </Field>
              <Field label={t('maRemarkLabel')}>
                <input name="remark" placeholder={t('maRemarkPlaceholder')} className={inputCls} />
              </Field>
              <Field label={t('maAttachmentLabel')}>
                <input
                  type="file"
                  name="attachment"
                  accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                  className={`${inputCls} py-1.5 text-xs file:mr-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs`}
                />
              </Field>
              <p className="text-[11px] text-muted-foreground">{t('maAttachmentHelp')}</p>
              <Field label={t('otGoesToLabel')}>
                {/* Read-only and deliberately NOT a form field: the approver is resolved from the reporting
                    line at decide time (assertCanDecide), so anything posted from here would be ignored. */}
                <div className={`${inputCls} flex items-center bg-muted/40`}>{approver}</div>
              </Field>
              <p className="text-[11px] text-muted-foreground">{t('maOriginalKept')}</p>
              <div className="flex justify-end pt-1">
                <Button type="submit" size="sm">
                  {t('maSubmitRequest')}
                </Button>
              </div>
            </form>
            {fixDay && section === 'absent' && (
              /* The reporter's second route for an absent day: don't correct the clock, ask for leave —
                 with the date carried across so it does not have to be typed again. The existing Request
                 Leave dialog on /leave opens itself from the query string; no second dialog is built. */
              <div className="border-t border-border px-4 py-3">
                <p className="text-[11px] text-muted-foreground">{t('maRequestLeaveHelp')}</p>
                <Button asChild size="sm" variant="outline" className="mt-2">
                  <Link href={`/leave?apply=1&start=${fixDay.date}`}>{t('maRequestLeaveInstead')}</Link>
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ── My attendance requests · every kind, filtered by status ──────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">{t('maRequestsTitle')}</div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          {STATUS_FILTERS.map((f) => {
            const on = (f ?? null) === statusFilter;
            return (
              <Link
                key={f ?? 'all'}
                href={href({ status: f ?? null })}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
                }`}
              >
                {f == null ? t('maFilterAll') : statusLabel(f, t, false)}
              </Link>
            );
          })}
        </div>
        {reqPage.rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('maNoRequests')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('maColDate')}</th>
                  <th className={thCls}>{t('maColType')}</th>
                  <th className={thCls}>{t('maColAsked')}</th>
                  <th className={thCls}>{t('maColSubmitted')}</th>
                  <th className={thCls}>{t('otGoesToColumn')}</th>
                  <th className={thCls}>{t('otStatusColumn')}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {reqPage.rows.map((r) => {
                  const isOt = r.proposedCheckIn == null && r.requestedOtMinutes != null;
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-2.5 tabular-nums">{r.attendanceDate}</td>
                      <td className="px-3 py-2.5">{t(KIND_LABEL[r.requestKind ?? (isOt ? 'self_overtime' : 'other')])}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        <div className="tabular-nums">{askedFor(r, t)}</div>
                        {r.reason && <div className="text-[11px]">{r.reason}</div>}
                        {r.remark && <div className="text-[11px] italic">{r.remark}</div>}
                        {r.hasAttachment && (
                          <a
                            href={`/attendance/requests/attachment/${r.id}`}
                            className="text-[11px] font-medium text-primary underline-offset-2 hover:underline"
                          >
                            {t('maAttachmentOnRequest')}
                          </a>
                        )}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                        {r.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{approver}</td>
                      <td className="px-3 py-2.5">
                        <Pill status={r.status} label={statusLabel(r.status, t, isOt)} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {/* Overtime is WITHDRAWN from the Self Overtime list, under its own state rule
                            (approved-but-not-yet-counted may still be taken back). A clock correction may
                            only be cancelled while pending: approving one rewrites the attendance day. */}
                        {!isOt && r.status === 'pending' ? (
                          <form action={myCancelAttendanceRequest}>
                            <input type="hidden" name="correctionId" value={r.id} />
                            <input type="hidden" name="section" value={section} />
                            <button
                              type="submit"
                              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                            >
                              {t('maCancelRequest')}
                            </button>
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
        <Pager
          basePath="/attendance/requests"
          params={{ section, fix: sp.fix, status: sp.status }}
          state={reqPage.state}
        />
      </Card>

      {/* Travel Request — NOT one of the four, and deliberately kept exactly as it was. Same fields, same
          wording, same server action, same approvals inbox. (Replacement-leave requests live on My Absence.) */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('travelRequest')}</h2>
        <form action={myRequestTravel} className="mt-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('travelFromLabel')}>
              <input type="date" name="travelFrom" required defaultValue={to} className={inputCls} />
            </Field>
            <Field label={t('travelToLabel')}>
              <input type="date" name="travelTo" required defaultValue={to} className={inputCls} />
            </Field>
          </div>
          <Field label={t('reasonRequired')}>
            <input name="remarks" required placeholder={t('travelRemarksPlaceholder')} className={inputCls} />
          </Field>
          <Button type="submit" size="sm">
            {t('requestTravelButton')}
          </Button>
        </form>
        {travelRequests.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-xs">
            {travelRequests.map((tr) => (
              <li key={tr.id} className="flex items-center justify-between gap-2">
                <span className="tabular-nums text-muted-foreground">
                  {tr.travelFrom} → {tr.travelTo}
                </span>
                <Pill status={tr.status} label={statusLabel(tr.status, t, false)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

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

/** How many rows an "Also waiting for you" card shows before it links into its own section. */
const ALSO_ROWS = 3;

/** For each exception section, the OTHER two — in the same worst-first order the tabs use. */
const OTHER_SECTIONS: Record<AttendanceSection, Exclude<AttendanceSection, 'overtime'>[]> = {
  overtime: [],
  incomplete: ['short', 'absent'],
  short: ['incomplete', 'absent'],
  absent: ['incomplete', 'short'],
};

const STATUS_FILTERS = [null, 'pending', 'approved', 'rejected', 'cancelled'] as const;

const parseStatus = (raw: string | undefined) =>
  (['pending', 'approved', 'rejected', 'cancelled'] as const).includes(raw as never)
    ? (raw as 'pending' | 'approved' | 'rejected' | 'cancelled')
    : null;

/** request_kind → the `me` key naming it. `other` is the free-form "correct another day" route and every
 *  request filed before migration 0434 (which carries no kind at all). */
const KIND_LABEL = {
  self_overtime: 'maSectionOvertime',
  short_hours: 'maSectionShort',
  incomplete_entry: 'maSectionIncomplete',
  absent: 'maSectionAbsent',
  other: 'maKindOther',
} as const;

/** ot_reason_category → the `me` key naming it. Exhaustive over db/schema OT_REASON_CATEGORIES. */
const CATEGORY_KEY = {
  project_deadline: 'otCategoryProjectDeadline',
  system_maintenance: 'otCategorySystemMaintenance',
  month_end_closing: 'otCategoryMonthEndClosing',
  client_request: 'otCategoryClientRequest',
  other: 'otCategoryOther',
} as const;

type T = Awaited<ReturnType<typeof getTranslations<'me'>>>;

/**
 * The days-we-found table, stated ONCE and rendered in two places (the open section, and the "Also
 * waiting for you" cards). A second copy would be the fastest way for the two to start describing the
 * same day differently.
 *
 * A plain function taking `t` rather than a `<Component>` boundary: this is server-rendered throughout,
 * so there is no serialisation to respect — and passing `t` or `fixHref` across a real client boundary is
 * exactly the closure-from-a-server-component 500 that test/server-client-boundary.test.ts exists for.
 */
function ExceptionTable({
  days,
  t,
  openDate,
  pendingDates,
  fixHref,
}: {
  days: ExceptionDay[];
  t: T;
  openDate: string | undefined;
  pendingDates: Set<string>;
  fixHref: (date: string) => string;
}) {
  return (
    <div className={tableWrapCls}>
      <table className="w-full text-sm">
        <thead className={theadCls}>
          <tr>
            <th className={thCls}>{t('maColDate')}</th>
            <th className={thCls}>{t('maColScheduled')}</th>
            <th className={thCls}>{t('maColFound')}</th>
            <th className={thCls}>{t('maColHave')}</th>
            <th className={thCls} />
          </tr>
        </thead>
        <tbody className={tbodyCls}>
          {days.map((d) => (
            <tr key={d.date} className={d.date === openDate ? 'bg-accent/40' : undefined}>
              <td className="px-3 py-2.5">
                <div className="tabular-nums">{d.date}</div>
                <div className="text-[11px] text-muted-foreground">{dayName(d.date)}</div>
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
                    index), so it says so rather than offering a button the service would refuse. */}
                {pendingDates.has(d.date) ? (
                  <span className="text-xs text-muted-foreground">{t('maAlreadyRequested')}</span>
                ) : (
                  <Button asChild size="sm" variant={d.date === openDate ? 'default' : 'outline'}>
                    <Link href={fixHref(d.date)}>{t('maFixThis')}</Link>
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * `cancelled` is the STORED status; on an overtime plan the employee WITHDREW it, and "Cancelled" would
 * read as somebody else having called it off. That wording shipped with Plan OT and must survive the move.
 */
function statusLabel(status: string, t: T, isOvertime: boolean): string {
  if (status === 'cancelled') return isOvertime ? t('otStatusWithdrawn') : t('leaveStatus.cancelled');
  if (status === 'approved') return t('leaveStatus.approved');
  if (status === 'rejected') return t('leaveStatus.rejected');
  return t('leaveStatus.pending');
}

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

/** What the request asked for, in one line. */
function askedFor(
  r: { proposedCheckIn: string | null; proposedCheckOut: string | null; requestedOtMinutes: number | null },
  t: T,
): string {
  if (r.proposedCheckIn == null && r.requestedOtMinutes != null) {
    return t('maAskedOvertime', { hours: (r.requestedOtMinutes / 60).toFixed(1) });
  }
  return t('maAskedTimes', {
    in: r.proposedCheckIn?.slice(0, 5) ?? '—',
    out: r.proposedCheckOut?.slice(0, 5) ?? '—',
  });
}

// The request-status colours, kept identical to the two lists this screen absorbed so a moved list looks
// like the one it replaced. Deliberately NOT components/ui's StatusBadge: that palette is the Employee
// Status vocabulary (probation/active/resigned…), which has no entry for pending/approved/rejected —
// every pill here would render neutral grey.
const REQUEST_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  cancelled: 'bg-muted text-muted-foreground',
};

function Pill({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${REQUEST_STATUS[status] ?? 'bg-muted text-muted-foreground'}`}
    >
      {label}
    </span>
  );
}
