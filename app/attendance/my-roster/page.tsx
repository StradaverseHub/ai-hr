import {withTenant} from '@/db/client';
import {originalHolidayCalendarFor} from '@/core/holidays';
import {replacementHolidayCalendarNotes} from '@/core/holiday-replacement-read';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import type { MyRosterDay, MyRosterView } from '@/core/roster';
import { myAttendanceCalendarWindow, type AttendanceStatus, type AttendanceFlag } from '@/packs/attendance/service';
import { attendanceCalendarDetailHref } from './attendance-links';
import { isIsoDate } from '@/lib/roster-month';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { isoWeekdayOf, rosterDateLocale } from '@/lib/roster-month';
import { shiftChipClass, shiftChipStyle } from '@/lib/shift-visual';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  MY_ROSTER_VIEWS,
  myRosterHref,
  resolveMyRosterWindow,
  stepMyRosterWindow,
  switchMyRosterView,
  type MyRosterViewKind,
  type MyRosterWindow,
} from './view';

/** Attendance Calendar composes the existing personal roster and attendance owners.
 * No employment selection is accepted; all writes remain in the existing daily workflow.
 */
export default async function MyRosterPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string; date?: string; selected?: string }>;
}) {
  const t = await getTranslations('attendance');
  const locale = await getLocale();
  // The courtesy redirect for a tenant that has not bought the module (ADR-0077 slice 4); the read below
  // still refuses on its own.
  await requireModule('attendance');
  // The authentication boundary (and what keeps test/function-access.test.ts's "no stale routes"
  // satisfied for this registered route). Only the session is taken — see the fence note in the header.
  const { s } = await scopedSession();
  const sp = await searchParams;

  const today = todayInKualaLumpur();
  const w = resolveMyRosterWindow({ view: sp.view, month: sp.month, date: sp.date, today });
  const view = await myAttendanceCalendarWindow(s, { from: w.from, to: w.to });

  if (!view) {
    /**
     * A real, named person linked to no active employment — the seeded HR administrator is exactly this.
     * Saying so beats an empty calendar, which reads as "your supervisor has rostered you for nothing".
     * `max-w-md`, not `max-w-2xl`: test/attendance-screens-layout.test.ts reads this file for a page-level
     * `mx-auto` + `max-w-…xl` cap, and `capsPage` deliberately does not count `max-w-md`. The idiom is
     * app/attendance/my-records/page.tsx's, for the same reason.
     */
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('myCalendar.title')} />
        <div className="mx-auto max-w-md">
          <Card className="p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('myRoster.notLinked')}</p>
          </Card>
        </div>
      </div>
    );
  }

  const replacementT=await getTranslations('replacementHoliday');
  const [originals,replacements]=await Promise.all([withTenant(s,tx=>originalHolidayCalendarFor(tx,{employmentId:view.employmentId,startDate:w.from,endDate:w.to})),replacementHolidayCalendarNotes(s,{employmentId:view.employmentId,from:w.from,to:w.to})]);
  view.days=view.days.map(day=>({...day,selected:isIsoDate(sp.selected??'')&&day.date===sp.selected,holidayNote:replacements.some(r=>r.replacementDate===day.date)?{label:replacementT('replacement'),name:replacements.find(r=>r.replacementDate===day.date)!.sourceName}:originals.some(h=>h.date===day.date)?{label:replacementT('original'),name:originals.filter(h=>h.date===day.date).map(h=>h.name).join(', ')}:undefined}));
  const dl = rosterDateLocale(locale);
  const fmtDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(dl, { day: '2-digit', month: 'short', year: 'numeric' });
  const fmtLongDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(dl, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtMonth = (month: string) => new Date(`${month}-01T00:00:00`).toLocaleDateString(dl, { month: 'long', year: 'numeric' });
  const fmtWeekday = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(dl, { weekday: 'short' });
  const fmtStamp = (d: Date) => d.toLocaleString(dl, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  // Hours to one decimal: the tile says "180 hrs", not "180.00". Minutes are the stored unit everywhere
  // else on this screen, so the division happens once, here.
  const fmtHrs = (min: number) => (min / 60).toLocaleString(dl, { maximumFractionDigits: 1 });
  const hhmm = (t24:string|null) => t24?.slice(0,5)??'—';

  const caption =
    w.view === 'month' ? fmtMonth(w.month) : w.view === 'week' ? `${fmtDate(w.from)} – ${fmtDate(w.to)}` : fmtLongDate(w.focus ?? w.from);
  const viewLabel: Record<MyRosterViewKind, string> = {
    day: t('myRoster.viewDaily'),
    week: t('myRoster.viewWeekly'),
    month: t('myRoster.viewMonthly'),
  };
  // "This month" / "This week" / "Today" — the same shortcut, named for the view it lands in.
  const nowLabel: Record<MyRosterViewKind, string> = {
    day: t('myRoster.today'),
    week: t('myRoster.thisWeek'),
    month: t('myRoster.thisMonth'),
  };

  const subtitleParts = [
    view.employeeCode ? `${view.name} (${view.employeeCode})` : view.name,
    view.position,
    view.managerName ? t('myRoster.supervisorNamed', { manager: view.managerName }) : null,
  ].filter((v): v is string => !!v);

  const stepCls =
    'inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('myCalendar.title')} description={subtitleParts.join(' · ')} />
      <Link href={`/attendance/my-records?${new URLSearchParams({from:w.from,to:w.to})}`} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{t('myCalendar.records')}</Link>
      {replacements.length>0&&<Card className="space-y-2 p-4"><h2 className="text-sm font-medium">{replacementT('calendarHint')}</h2><p className="text-xs text-muted-foreground">{replacementT('originalKept')}</p><ul className="space-y-1 text-sm">{replacements.map(r=><li key={r.id}>{r.replacementDate} · {r.sourceName} ({r.sourceDate}){r.status==='review'&&` · ${replacementT('review')}`}</li>)}</ul></Card>}

      {/* View switch on the left, window stepper on the right — the approved picture's control row. */}
      <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('myRoster.viewLabel')}</span>
          <div className="flex items-center rounded-md border border-border p-0.5">
            {MY_ROSTER_VIEWS.map((k) => (
              <Link
                key={k}
                href={myRosterHref(switchMyRosterView(w, k, today))}
                aria-current={w.view === k ? 'page' : undefined}
                className={`rounded px-3 py-1 text-sm transition-colors ${
                  w.view === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {viewLabel[k]}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href={myRosterHref(stepMyRosterWindow(w, -1))} className={stepCls} aria-label={t('myRoster.previous')}>
            ‹
          </Link>
          <span className="min-w-40 text-center text-sm font-medium">{caption}</span>
          <Link href={myRosterHref(stepMyRosterWindow(w, 1))} className={stepCls} aria-label={t('myRoster.next')}>
            ›
          </Link>
          <Link
            href={myRosterHref(resolveMyRosterWindow({ view: w.view, today }))}
            className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            {nowLabel[w.view]}
          </Link>
        </div>
      </Card>

      {/*
        THE FOUR TILES ARE MONTHLY-ONLY, and that is a decision rather than an omission. Their captions
        are the reporter's own ("Work days this month"), and a caption that says "this month" over a
        seven-day window would be false — CLAUDE.md §8: a shared caption may say only what is true of
        every case it covers. The Weekly and Daily views carry their own figures instead, exactly as the
        approved picture draws them.
      */}
      {w.view === 'month' && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label={t('myRoster.statWorkDays')} value={String(view.workDays)} />
          <Stat label={t('myRoster.statRostered')} value={String(view.rosteredDays)} unit={t('myRoster.unitDays')} />
          <Stat label={t('myRoster.statRestDays')} value={String(view.restDays)} />
          <Stat label={t('myRoster.statPlannedHours')} value={fmtHrs(view.plannedMinutes)} unit={t('myRoster.unitHours')} />
        </div>
      )}

      <Card className="space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('myRoster.legend')}</span>
          {view.legend.map((sh) => (
            <span
              key={sh.id}
              style={shiftChipStyle(sh.color)}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${
                shiftChipClass(sh.color) ?? 'border-border bg-muted text-muted-foreground'
              }`}
            >
              <span className="font-mono font-medium">{sh.code}</span>
              <span className="tabular-nums opacity-80">
                {hhmm(sh.startTime)}–{hhmm(sh.endTime)}
              </span>
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
            <span className="font-mono font-medium">{t('myRoster.restShort')}</span>
            {t('myRoster.sourceRest')}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
            <span className="font-mono font-medium">{t('myRoster.offShort')}</span>
            {t('myRoster.sourceOff')}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {/* Named when an administrative reporting line is in force today; otherwise the same sentence
              without a name. Never a guess — see point 3 in the header. Up to r375 this also went
              nameless whenever the session could not READ that person, which for a plain employee was
              always (visibility walks downward only) — so the one reader this screen is for never saw
              the name the approved design prints. Migration 0498 answers it for the viewer's own
              supervisor, and `administrativeManagerNameTx` is now the only thing between the two. */}
          {view.managerName ? t('myRoster.readOnlyNamed', { manager: view.managerName }) : t('myRoster.readOnly')}{' '}
          <span className="italic">{t('myRoster.usualNote')}</span>
        </p>
        {/* An absent caption asserts nothing; one printed over a window the supervisor has never touched
            would assert a change that never happened (CLAUDE.md §8). */}
        {view.lastUpdatedAt && (
          <p className="text-xs text-muted-foreground">{t('myRoster.lastUpdated', { when: fmtStamp(view.lastUpdatedAt) })}</p>
        )}
      </Card>

      {w.view === 'month' && <MonthGrid view={view} w={w} t={t} fmtWeekday={fmtWeekday} hhmm={hhmm} />}
      {w.view === 'week' && <WeekCards view={view} w={w} t={t} fmtWeekday={fmtWeekday} hhmm={hhmm} fmtHrs={fmtHrs} />}
      {w.view === 'day' && (
        <DayPanel view={view} w={w} t={t} fmtWeekday={fmtWeekday} hhmm={hhmm} fmtHrs={fmtHrs} fmtLongDate={fmtLongDate} />
      )}
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────────────

type T = Awaited<ReturnType<typeof getTranslations<'attendance'>>>;
type CalendarRosterDay=MyRosterDay&{holidayNote?:{label:string;name:string};selected?:boolean;attendance?:{status:AttendanceStatus|null;flag:AttendanceFlag;checkInAt:string|null;checkOutAt:string|null}|null};
type CalendarRosterView=Omit<MyRosterView,'days'>&{days:CalendarRosterDay[]};

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>}
      </p>
    </Card>
  );
}

/** What a day's SOURCE says. Never a person's name — the roster row keeps the date of a change, not who. */
function sourceKey(d: MyRosterDay): 'sourceRostered' | 'sourceUsual' | 'sourceRest' | 'sourceOff' {
  switch (d.cell.kind) {
    case 'shift':
      return 'sourceRostered';
    case 'usual':
      return 'sourceUsual';
    case 'rest':
      return 'sourceRest';
    default:
      return 'sourceOff';
  }
}

/**
 * ONE day, drawn the same way in all three views. A `usual` day is GREY ITALIC — the legend's sentence
 * says what that means — and a rostered day carries its shift's own colour token.
 */
function DayBody({d,t,hhmm}:{d:CalendarRosterDay;t:T;hhmm:(v:string|null)=>string}) {
 return <div className="space-y-1">{d.holidayNote&&<span className="block text-xs font-medium text-foreground" title={d.holidayNote.name}>{d.holidayNote.label}: {d.holidayNote.name}</span>}<DayBodyContent d={d} t={t} hhmm={hhmm}/></div>;
}

function DayBodyContent({ d, t, hhmm }: { d: MyRosterDay; t: T; hhmm: (v: string | null) => string }) {
  if (d.cell.kind === 'rest') {
    return (
      <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-xs font-medium">
        {t('myRoster.restShort')}
      </span>
    );
  }
  if (d.cell.kind === 'off' || !d.shift) {
    return <span className="font-mono text-xs text-muted-foreground">{t('myRoster.offShort')}</span>;
  }
  const ghost = d.cell.kind === 'usual';
  return (
    <div className="space-y-0.5">
      {ghost ? (
        <span className="font-mono text-xs italic text-muted-foreground">{d.shift.code}</span>
      ) : (
        <span
          style={shiftChipStyle(d.shift.color)}
          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-xs font-medium ${
            shiftChipClass(d.shift.color) ?? 'border-border bg-muted text-foreground'
          }`}
        >
          {d.shift.code}
        </span>
      )}
      <p className={`text-xs tabular-nums ${ghost ? 'italic text-muted-foreground' : 'text-muted-foreground'}`}>
        {hhmm(d.shift.startTime)}–{hhmm(d.shift.endTime)}
      </p>
    </div>
  );
}

/** Status and flag stay independent; an incomplete punch never becomes an invented absence. */
function AttendanceDayContext({ day, window, t }: { day: CalendarRosterDay; window: MyRosterWindow; t:T }) {
  const statusKeys = { present:'statusPresent', absent:'statusAbsent', exempt:'statusExempt', rest:'statusRest', off:'statusOff', ph:'statusPh', on_leave:'statusOnLeave' } as const;
  const flagKeys = { late:'flagLate', under:'flagUnder', odd:'flagOdd' } as const;
  return <div className="space-y-1 border-t border-border pt-2">
    {day.attendance?.status && <p className="text-xs font-medium">{t(statusKeys[day.attendance.status])}</p>}
    {day.attendance?.flag && <p className="text-xs text-amber-700 dark:text-amber-400">{t(flagKeys[day.attendance.flag])}</p>}
    {(day.attendance?.checkInAt || day.attendance?.checkOutAt) && <p className="text-xs tabular-nums text-muted-foreground">{t('colCheckIn')}: {day.attendance.checkInAt?.slice(0,5)??'—'} · {t('colCheckOut')}: {day.attendance.checkOutAt?.slice(0,5)??'—'}</p>}
    <Link href={attendanceCalendarDetailHref(day.date, window)} aria-label={t('myCalendar.viewDate',{date:day.date})} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{t('breakdownView')}</Link>
  </div>;
}

const WEEKDAY_ANCHORS = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'] as const;

/**
 * The month as a Monday-first grid.
 *
 * `grid-cols-1 sm:grid-cols-7` is how the plan's "on a phone the grid becomes one row per day" is met
 * with no JavaScript: at phone width every cell is its own row and carries its own weekday name, and the
 * leading blanks that pad the first week are simply not rendered there.
 */
function MonthGrid({
  view,
  w,
  t,
  fmtWeekday,
  hhmm,
}: {
  view: CalendarRosterView;
  w: MyRosterWindow;
  t: T;
  fmtWeekday: (iso: string) => string;
  hhmm: (v: string | null) => string;
}) {
  const pad = isoWeekdayOf(view.days[0]!.date) - 1;
  return (
    <Card className="overflow-hidden">
      <div className="hidden grid-cols-7 border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground sm:grid">
        {WEEKDAY_ANCHORS.map((iso) => (
          <div key={iso} className="px-3 py-2 font-medium">
            {fmtWeekday(iso)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-7">
        {Array.from({ length: pad }, (_, i) => (
          // Padding for the first week. `hidden sm:block` — a blank row on a phone is noise, not a day.
          <div key={`pad-${i}`} className="hidden border-b border-r border-border sm:block" />
        ))}
        {view.days.map((d) => (
          <div
            key={d.date}
            aria-current={d.selected ? 'date' : undefined}
            className={`min-h-24 space-y-1 border-b border-r border-border px-3 py-2 transition-colors hover:bg-muted/60 ${
              d.selected ? 'bg-primary/5 ring-2 ring-inset ring-primary' : isoWeekdayOf(d.date) >= 6 ? 'bg-amber-50/60 dark:bg-amber-500/5' : ''
            }`}
          >
            <Link href={myRosterHref({ view: 'day', from: d.date, to: d.date, month: w.month, focus: d.date })} className="block min-h-8 text-xs text-muted-foreground hover:text-primary">
              <span className="tabular-nums">{d.date.slice(8)}</span>
              <span className="ml-1 sm:hidden">{fmtWeekday(d.date)}</span>
            </Link>
            <DayBody d={d} t={t} hhmm={hhmm} />
            {d.note && <p className="truncate text-xs text-primary">• {t('myRoster.noteMarker')}</p>}
            <AttendanceDayContext day={d} window={w} t={t} />
          </div>
        ))}
      </div>
      <p className="px-4 py-2.5 text-xs text-muted-foreground">{t('myRoster.clickDay')}</p>
    </Card>
  );
}

/** Seven cards, Monday to Sunday — the picture's Weekly view. */
function WeekCards({
  view,
  w,
  t,
  fmtWeekday,
  hhmm,
  fmtHrs,
}: {
  view: CalendarRosterView;
  w: MyRosterWindow;
  t: T;
  fmtWeekday: (iso: string) => string;
  hhmm: (v: string | null) => string;
  fmtHrs: (min: number) => string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 xl:grid-cols-7">
      {view.days.map((d) => (
        <Card
          key={d.date}
          aria-current={d.selected ? 'date' : undefined}
          className={`space-y-2 px-3 py-3 ${d.selected ? 'bg-primary/5 ring-2 ring-inset ring-primary' : isoWeekdayOf(d.date) >= 6 ? 'bg-amber-50/60 dark:bg-amber-500/5' : ''}`}
        >
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{fmtWeekday(d.date)}</p>
            <p className="text-lg font-semibold tabular-nums">{d.date.slice(8)}</p>
          </div>
          <DayBody d={d} t={t} hhmm={hhmm} />
          <AttendanceDayContext day={d} window={w} t={t} />
          {d.shift && (
            <p className="text-xs text-muted-foreground">
              {t('myRoster.hoursAndBreak', { hours: fmtHrs(d.shift.workingMinutes), minutes: d.shift.breakMinutes })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t(`myRoster.${sourceKey(d)}`)}</p>
          {d.note && <p className="text-xs text-primary">• {d.note}</p>}
          <Link
            href={myRosterHref({ view: 'day', from: d.date, to: d.date, month: w.month, focus: d.date })}
            className="inline-block text-xs text-primary hover:underline"
          >
            {t('myRoster.openDay')}
          </Link>
        </Card>
      ))}
    </div>
  );
}

/** The week strip plus one day's detail — the picture's Daily view. */
function DayPanel({
  view,
  w,
  t,
  fmtWeekday,
  hhmm,
  fmtHrs,
  fmtLongDate,
}: {
  view: CalendarRosterView;
  w: MyRosterWindow;
  t: T;
  fmtWeekday: (iso: string) => string;
  hhmm: (v: string | null) => string;
  fmtHrs: (min: number) => string;
  fmtLongDate: (iso: string) => string;
}) {
  // `focus` is inside [from, to] by construction (./view.ts resolves the week AROUND it), so this find
  // cannot miss; the fallback is belt-and-braces rather than a real branch.
  const day = view.days.find((d) => d.date === w.focus) ?? view.days[0]!;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-7 gap-2">
        {view.days.map((d) => (
          <Link
            key={d.date}
            href={myRosterHref({ view: 'day', from: d.date, to: d.date, month: w.month, focus: d.date })}
            aria-current={d.date === day.date ? 'date' : undefined}
            className={`rounded-md border px-2 py-2 text-center transition-colors ${
              d.date === day.date ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
            }`}
          >
            <span className="block text-xs text-muted-foreground">{fmtWeekday(d.date)}</span>
            <span className="block text-sm font-semibold tabular-nums">{d.date.slice(8)}</span>
          </Link>
        ))}
      </div>

      <Card className="space-y-4 p-4">
        <div>
          <p className="text-sm text-muted-foreground">{t(`myRoster.${sourceKey(day)}`)}</p>
          <h2 className="text-lg font-semibold">{fmtLongDate(day.date)}</h2>
          {day.holidayNote&&<p className="text-sm font-medium">{day.holidayNote.label}: {day.holidayNote.name}</p>}
          {day.shift && (
            <p className="text-sm text-muted-foreground">
              {day.shift.code} — {day.shift.name}
            </p>
          )}
        </div>

        {day.shift ? (
          <>
            <p className="text-3xl font-semibold tabular-nums">
              {hhmm(day.shift.startTime)} – {hhmm(day.shift.endTime)}
            </p>
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Detail term={t('colShiftCode')} value={day.shift.code} />
              <Detail term={t('myRoster.breakLabel')} value={t('myRoster.minutes', { minutes: day.shift.breakMinutes })} />
              <Detail
                term={t('myRoster.workingHoursLabel')}
                value={t('myRoster.hours', { hours: fmtHrs(day.shift.workingMinutes) })}
              />
              {/* The SOURCE, and never a person: the roster record keeps the date of a change, not who
                  made it, so a name here would be invented. */}
              <Detail term={t('myRoster.sourceLabel')} value={t(`myRoster.${sourceKey(day)}`)} />
            </dl>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {day.cell.kind === 'rest' ? t('myRoster.restDayBody') : t('myRoster.notScheduledBody')}
          </p>
        )}

        <AttendanceDayContext day={day} window={w} t={t} />
        {day.note && (
          <div className="border-l-2 border-primary pl-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('colNote')}</p>
            <p className="text-sm">{day.note}</p>
          </div>
        )}
      </Card>
    </div>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{term}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}
