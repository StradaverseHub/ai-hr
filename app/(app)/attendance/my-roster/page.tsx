import {notFound} from 'next/navigation';
import {ownAttendanceRecordSubject} from '../my-records/subject';
import {personalCalendarHolidayContext} from './holiday-context';
import {personalHolidayContext} from '@/lib/personal-holiday-context';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import type { MyRosterDay, MyRosterView } from '@/core/roster';
import { myAttendanceCalendarWindow, type AttendanceStatus, type AttendanceFlag } from '@/packs/attendance/service';
import { attendanceCalendarDetailHref, attendanceCalendarHref, resolveAttendanceCalendarState, type AttendanceCalendarState, type AttendanceCalendarQuery } from './attendance-links';
import { AttendanceRecordList } from './record-list';
import { PersonalAttendanceStatus } from '@/components/personal-attendance-status';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { isoWeekdayOf, rosterDateLocale } from '@/lib/roster-month';
import { shiftChipClass, shiftChipStyle } from '@/lib/shift-visual';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  MY_ROSTER_VIEWS,
  resolveMyRosterWindow,
  stepMyRosterWindow,
  switchMyRosterView,
  type MyRosterViewKind,
  type MyRosterWindow,
} from './view';

/** Attendance Calendar composes the existing personal roster and attendance owners.
 * Explicit own-employment selection retains the same subject proof; writes use the daily workflow.
 */
export default async function MyRosterPage({
  searchParams,
}: {
  searchParams: Promise<AttendanceCalendarQuery>;
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
  if(sp.employmentId!==undefined&&!await ownAttendanceRecordSubject(s,sp.employmentId))notFound();

  const today = todayInKualaLumpur();
  const state = resolveAttendanceCalendarState(sp, today);
  const w = state.window;
  const calendarHref = (window:MyRosterWindow, selected=state.selected) => attendanceCalendarHref({...state,tab:'calendar',window,selected});
  const loaded = await myAttendanceCalendarWindow(s, { from: w.from, to: w.to,...(state.employmentId?{employmentId:state.employmentId}:{}) });

  if (!loaded) {
    /**
     * A real, named person linked to no active employment — the seeded HR administrator is exactly this.
     * Saying so beats an empty calendar, which reads as "your supervisor has rostered you for nothing".
     * `max-w-md`, not `max-w-2xl`: test/attendance-screens-layout.test.ts reads this file for a page-level
     * `mx-auto` + `max-w-…xl` cap, and `capsPage` deliberately does not count `max-w-md`. The idiom is
     * app/(app)/attendance/my-records/page.tsx's, for the same reason.
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

  const identity = [loaded.employeeCode ? `${loaded.name} (${loaded.employeeCode})` : loaded.name,loaded.position,loaded.managerName ? t('myRoster.supervisorNamed',{manager:loaded.managerName}) : null].filter(Boolean).join(' · ');
  if(state.tab==='list') return <div className={pageWideCls}>
    <PageHeader title={t('myCalendar.title')} description={identity}/>
    <PersonalAttendanceTabs state={state} t={t}/>
    <AttendanceRecordList s={s} state={state} query={sp}/>
  </div>;

  const replacementT=await getTranslations('replacementHoliday');
  const {originals,replacements}=await personalCalendarHolidayContext(s,loaded.employmentId,w.from,w.to);
  const view:CalendarRosterView={...loaded,days:loaded.days.map(day=>({...day,
    selected:day.date===state.selected,isToday:day.date===today,navigation:state,
    holidayNotes:personalHolidayContext(day.date,originals,replacements,{original:replacementT('original'),replacement:replacementT('replacement'),review:replacementT('review')}),
  }))};
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
  const subtitleParts = [
    view.employeeCode ? `${view.name} (${view.employeeCode})` : view.name,
    view.position,
    view.managerName ? t('myRoster.supervisorNamed', { manager: view.managerName }) : null,
  ].filter((v): v is string => !!v);

  const stepCls =
    'inline-flex size-11 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('myCalendar.title')} description={subtitleParts.join(' · ')} />
      <PersonalAttendanceTabs state={state} t={t}/>
      {replacements.length>0&&<Card className="space-y-2 p-4"><h2 className="text-sm font-medium">{replacementT('calendarHint')}</h2><p className="text-xs text-muted-foreground">{replacementT('originalKept')}</p><ul className="space-y-1 text-sm">{replacements.map(r=><li key={r.id}>{r.replacementDate} · {r.sourceName} ({r.sourceDate}){(r.status==='review'||r.coverageReason)&&` · ${replacementT('review')}`}</li>)}</ul></Card>}

      {/* View switch on the left, window stepper on the right — the approved picture's control row. */}
      <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('myRoster.viewLabel')}</span>
          <div className="flex items-center rounded-md border border-border p-0.5">
            {MY_ROSTER_VIEWS.map((k) => (
              <Link
                key={k}
                href={calendarHref(switchMyRosterView(w, k, today))}
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
          <Link href={calendarHref(stepMyRosterWindow(w, -1))} className={stepCls} aria-label={t('myRoster.previous')}>
            ‹
          </Link>
          <span className="min-w-40 text-center text-sm font-medium">{caption}</span>
          <Link href={calendarHref(stepMyRosterWindow(w, 1))} className={stepCls} aria-label={t('myRoster.next')}>
            ›
          </Link>
          <Link
            href={calendarHref(resolveMyRosterWindow({ view: w.view, today }),today)}
            className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            {t('myRoster.today')}
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

      <Card className="space-y-2 px-4 py-3">
        <h2 className="text-xs font-semibold">{t('myCalendar.attendanceLegend')}</h2>
        <div className="flex flex-wrap gap-2 text-xs">{(['present','absent','exempt','rest','off','ph','on_leave'] as const).map(status=><PersonalAttendanceStatus key={status} status={status} label={t(PERSONAL_STATUS_KEYS[status])}/>)}</div>
        <p className="text-xs text-muted-foreground">{t('flagLate')} · {t('myCalendar.shortHours')} · {t('myCalendar.incompleteEntry')}</p>
        <p className="text-xs text-muted-foreground">{t('myCalendar.contextHelp')}</p>
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

const PERSONAL_STATUS_KEYS = {present:'statusPresent',absent:'statusAbsent',exempt:'statusExempt',rest:'statusRest',off:'statusOff',ph:'statusPh',on_leave:'statusOnLeave'} as const;
type T = Awaited<ReturnType<typeof getTranslations<'attendance'>>>;
type CalendarRosterDay=MyRosterDay&{holidayNotes:string[];selected:boolean;isToday:boolean;navigation:AttendanceCalendarState;attendance?:{status:AttendanceStatus|null;flag:AttendanceFlag;checkInAt:string|null;checkOutAt:string|null}|null};
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
 return <div className="space-y-1">{d.holidayNotes.map(note=><span key={note} className="block text-xs font-medium text-foreground">{note}</span>)}<DayBodyContent d={d} t={t} hhmm={hhmm}/></div>;
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
  const flagKeys = { late:'flagLate', under:'myCalendar.shortHours', odd:'myCalendar.incompleteEntry' } as const;
  return <div className="space-y-1 border-t border-border pt-2">
    {day.attendance?.status && <PersonalAttendanceStatus status={day.attendance.status} label={t(PERSONAL_STATUS_KEYS[day.attendance.status])}/>}
    {day.attendance?.flag && <p className="text-xs text-amber-700 dark:text-amber-400">{t(flagKeys[day.attendance.flag])}</p>}
    {(day.attendance?.checkInAt || day.attendance?.checkOutAt) && <p className="text-xs tabular-nums text-muted-foreground">{t('colCheckIn')}: {day.attendance.checkInAt?.slice(0,5)??'—'} · {t('colCheckOut')}: {day.attendance.checkOutAt?.slice(0,5)??'—'}</p>}
    <Link href={attendanceCalendarDetailHref(day.date, window, day.navigation)} aria-label={t('myCalendar.viewDate',{date:day.date})} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{t('breakdownView')}</Link>
  </div>;
}

const WEEKDAY_ANCHORS = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'] as const;

/** Aligned month; compact dates on tablets/phones and one readable selected-day panel. */
function MonthGrid({view,w,t,fmtWeekday,hhmm}:{view:CalendarRosterView;w:MyRosterWindow;t:T;fmtWeekday:(iso:string)=>string;hhmm:(v:string|null)=>string}) {
  const pad=isoWeekdayOf(view.days[0]!.date)-1;
  const selected=view.days.find(day=>day.selected)??view.days[0]!;
  return <div className="space-y-4">
    <Card className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-border text-xs text-muted-foreground">{WEEKDAY_ANCHORS.map(iso=><div key={iso} className="px-1 py-2 text-center font-medium lg:text-left lg:px-3">{fmtWeekday(iso)}</div>)}</div>
      <div className="grid grid-cols-7">
        {Array.from({length:pad},(_,i)=><div key={`pad-${i}`} className="border-b border-r border-border"/>)}
        {view.days.map(day=><div key={day.date} className={`min-w-0 border-b border-r border-border ${day.selected?'bg-primary/5 ring-2 ring-inset ring-primary':isoWeekdayOf(day.date)>=6?'bg-amber-50/60 dark:bg-amber-500/5':''}`}>
          <Link href={attendanceCalendarHref({...day.navigation,selected:day.date})} aria-current={day.isToday?'date':undefined} aria-label={[day.date,day.isToday?t('myRoster.today'):null,day.attendance?.status?t(PERSONAL_STATUS_KEYS[day.attendance.status]):null,day.holidayNotes.join(' · ')].filter(Boolean).join(' · ')} className="flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-2 text-xs focus-visible:outline-2 focus-visible:outline-primary lg:min-h-11 lg:flex-row lg:justify-between lg:px-3">
            <span className={`tabular-nums ${day.isToday?'font-bold text-primary':''}`}>{day.date.slice(8)}</span>
            {day.isToday&&<span className="text-[10px] font-semibold text-primary">{t('myRoster.today')}</span>}
            <span aria-hidden className={`size-1.5 rounded-full lg:hidden ${day.attendance?.status==='absent'?'bg-rose-500':day.attendance?.flag?'bg-amber-500':day.attendance?.status==='present'?'bg-emerald-500':'bg-muted-foreground/50'}`}/>
          </Link>
          <div className="hidden space-y-1 px-3 pb-2 lg:block"><DayBody d={day} t={t} hhmm={hhmm}/>{day.note&&<p className="truncate text-xs text-primary">• {t('myRoster.noteMarker')}</p>}<AttendanceDayContext day={day} window={w} t={t}/></div>
        </div>)}
      </div>
      <p className="px-4 py-3 text-xs text-muted-foreground">{t('myCalendar.selectDay')}</p>
    </Card>
    <Card className="space-y-3 p-4 lg:hidden"><h2 className="text-sm font-semibold">{selected.date} · {fmtWeekday(selected.date)}</h2><DayBody d={selected} t={t} hhmm={hhmm}/><AttendanceDayContext day={selected} window={w} t={t}/>{selected.note&&<p className="text-xs text-muted-foreground">{selected.note}</p>}</Card>
  </div>;
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
          aria-current={d.isToday ? 'date' : undefined}
          className={`space-y-2 px-3 py-3 ${d.selected ? 'bg-primary/5 ring-2 ring-inset ring-primary' : isoWeekdayOf(d.date) >= 6 ? 'bg-amber-50/60 dark:bg-amber-500/5' : ''}`}
        >
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{fmtWeekday(d.date)}</p>
            <p className="text-lg font-semibold tabular-nums">{d.date.slice(8)}</p>{d.isToday&&<span className="text-xs font-semibold text-primary">{t('myRoster.today')}</span>}
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
            href={calendarDayHref(d, w)}
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
            href={calendarDayHref(d, w)}
            aria-current={d.isToday ? 'date' : undefined}
            className={`rounded-md border px-2 py-2 text-center transition-colors ${
              d.date === day.date ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
            }`}
          >
            <span className="block text-xs text-muted-foreground">{fmtWeekday(d.date)}</span>
            <span className="block text-sm font-semibold tabular-nums">{d.date.slice(8)}</span>{d.isToday&&<span className="block text-[10px] font-semibold text-primary">{t('myRoster.today')}</span>}
          </Link>
        ))}
      </div>

      <Card className="space-y-4 p-4">
        <div>
          <p className="text-sm text-muted-foreground">{t(`myRoster.${sourceKey(day)}`)}</p>
          <h2 className="text-lg font-semibold">{fmtLongDate(day.date)}</h2>
          {day.holidayNotes.map(note=><p key={note} className="text-sm font-medium">{note}</p>)}
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

function PersonalAttendanceTabs({state,t}:{state:AttendanceCalendarState;t:T}) {
  return <nav aria-label={t('myCalendar.viewNavigation')} className="flex gap-5 border-b border-border">
    {(['calendar','list'] as const).map(tab=><Link key={tab} href={attendanceCalendarHref({...state,tab})} aria-current={state.tab===tab?'page':undefined} className={`inline-flex min-h-11 items-center border-b-2 px-1 text-sm ${state.tab===tab?'border-primary font-semibold text-primary':'border-transparent text-muted-foreground hover:text-foreground'}`}>{t(tab==='calendar'?'myCalendar.calendarView':'myCalendar.listView')}</Link>)}
  </nav>;
}
function calendarDayHref(day:CalendarRosterDay,window:MyRosterWindow) {
  const next={view:'day' as const,from:day.date,to:day.date,month:window.month,focus:day.date};
  return attendanceCalendarHref({...day.navigation,tab:'calendar',window:next,selected:day.date});
}
