'use client';

import Link from 'next/link';
import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { addDaysIso, isoWeekdayOf, monthDates } from '@/lib/roster-month';

/**
 * ce5ded11 (r362) · THE MONTH CALENDAR the Plan OT screens pick a date on.
 *
 * WHY IT IS NEW CODE. There was no month calendar in this repo and no calendar library: `grid-cols-7`
 * returned exactly one hit before this file, a hard-coded 31-cell picture inside the Mobile App Preview,
 * and every date control in the product is a native `<input type="date">`. So the grid genuinely had to
 * be written. What did NOT have to be written is the month arithmetic or the cell precedence — those
 * belong to lib/roster-month.ts, which the duty roster, its export and its upload analyzer already share,
 * and this file imports them rather than restating them. The SHADES are resolved on the server by
 * `otPlanCalendarMonth`, which reads the same scheduling ladder the engine does; this component colours
 * in what it is handed and decides nothing about what a date is.
 *
 * ⚠️ EVERY COLOUR ALSO CARRIES TEXT. Four shades and a dashed outline are five states nobody can be
 * expected to tell apart, and a fifth of men see two of them as the same colour. Each cell therefore
 * carries an `sr-only` word for its kind, an `aria-label` that spells out the whole cell (date, kind,
 * and the status of any plan already filed), and there is a legend under the grid. The day card beside
 * the calendar names the selected day's kind in words as well.
 *
 * ⚠️ IT IS STILL A LIST OF LINKS. Every date is a real `<a href>`, so the calendar works with JavaScript
 * off and with a screen reader that ignores the key handler entirely. The arrow keys below are an
 * ADDITION to tab order, not a replacement for it: a 31-cell grid is legal but tedious to tab through,
 * so ← ↑ → ↓ / Home / End move focus by day and by week inside the month.
 *
 * SERIALISABLE PROPS ONLY (test/server-client-boundary.test.ts): strings, numbers and plain objects.
 * The month label and the weekday headings are formatted through Intl on the SERVER and handed over as
 * strings, which is the convention app/roster/page.tsx set — it keeps one rendition of a date per screen
 * and keeps Intl out of the client bundle.
 */

/** The four day kinds the scheduling ladder can answer truthfully. There is no fifth. */
export type OtCalendarKind = 'workday' | 'rest_day' | 'off_day' | 'holiday';

/** The four request statuses that exist (db/schema.ts attendanceCorrectionStatusEnum). No Draft, no Resubmit. */
export type OtCalendarPlanStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type OtCalendarCell = {
  date: string;
  kind: OtCalendarKind;
  /**
   * TRUE only on the company-policy rung: no roster row for the date AND no usual shift either, so the
   * hours that apply are the company's standard ones. Drawn as an outline rather than a fill, because it
   * is a statement about where the answer CAME FROM, not a fifth kind of day.
   */
  noRosterEntry: boolean;
  /** The status of the plan already filed for this date, or null. Several plans ⇒ the most live one. */
  plan: OtCalendarPlanStatus | null;
};

const KIND_CLS: Record<OtCalendarKind, string> = {
  workday: 'border-border bg-card',
  rest_day:
    'border-purple-300 bg-purple-100 text-purple-900 dark:border-purple-500/40 dark:bg-purple-500/15 dark:text-purple-200',
  holiday:
    'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
  off_day: 'border-border bg-muted text-muted-foreground',
};

/** The pill palette of app/attendance/request-ui.tsx, as dots — so the calendar and the list cannot
 *  disagree about what "approved" looks like. */
const PLAN_DOT: Record<OtCalendarPlanStatus, string> = {
  pending: 'bg-amber-500',
  approved: 'bg-emerald-500',
  rejected: 'bg-rose-500',
  cancelled: 'bg-muted-foreground/50',
};

const KIND_LABEL_KEY: Record<OtCalendarKind, string> = {
  workday: 'otCalWorkingDay',
  rest_day: 'otCalRestDay',
  holiday: 'otCalPublicHoliday',
  off_day: 'otCalOffDay',
};

const PLAN_LABEL_KEY: Record<OtCalendarPlanStatus, string> = {
  pending: 'otCalPlanPending',
  approved: 'otCalPlanApproved',
  rejected: 'otCalPlanRejected',
  cancelled: 'otCalPlanWithdrawn',
};

export function OtPlanCalendar({
  month,
  monthLabel,
  weekdayLabels,
  days,
  selected,
  today,
  dayHrefBase,
  prevHref,
  nextHref,
  compact = false,
}: {
  /** YYYY-MM — the month on display. */
  month: string;
  /** The month, named by Intl on the server in the viewer's locale. */
  monthLabel: string;
  /** Seven headings, Monday first, named by Intl on the server. */
  weekdayLabels: string[];
  /** One entry per date of `month`, in order. */
  days: OtCalendarCell[];
  /** The date currently chosen, or '' when nothing is chosen (the list screen's calendar view). */
  selected: string;
  /** Today in the tenant's timezone — passed in, never read from the browser clock. */
  today: string;
  /** Day links are `${dayHrefBase}?date=<iso>`. A string, because a function cannot cross the boundary. */
  dayHrefBase: string;
  prevHref: string;
  nextHref: string;
  /** The phone/list rendering: smaller cells, no "today is ringed" footnote. */
  compact?: boolean;
}) {
  const t = useTranslations('me');
  const gridRef = useRef<HTMLDivElement>(null);

  const dates = monthDates(month);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = dates[0];
  const last = dates[dates.length - 1];
  // Monday-first, matching isoWeekdayOf (1 = Monday) and the duty roster's own week.
  const leading = isoWeekdayOf(first) - 1;
  const trailing = (7 - ((leading + dates.length) % 7)) % 7;

  /** ← ↑ → ↓ / Home / End inside the grid. Clamped to the month: stepping off the end would have to
   *  navigate to another month to have anywhere to land, and a focus move that changes the page is not
   *  what an arrow key means. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -7 : e.key === 'ArrowDown' ? 7 : 0;
    if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;
    const active = document.activeElement as HTMLElement | null;
    const from = active?.dataset?.otcalDate;
    if (!from) return;
    const to = e.key === 'Home' ? first : e.key === 'End' ? last : addDaysIso(from, step);
    if (to < first || to > last) return;
    const target = gridRef.current?.querySelector<HTMLElement>(`[data-otcal-date="${to}"]`);
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  const cellBase = compact
    ? 'relative flex h-10 flex-col items-center justify-center rounded-md border text-xs tabular-nums'
    : 'relative flex h-12 flex-col items-center justify-center rounded-md border text-sm tabular-nums';
  const filler = compact ? 'h-10' : 'h-12';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link
          href={prevHref}
          aria-label={t('otCalPreviousMonth')}
          className="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
        >
          <span aria-hidden="true">‹</span>
        </Link>
        <span className="text-sm font-semibold">{monthLabel}</span>
        <Link
          href={nextHref}
          aria-label={t('otCalNextMonth')}
          className="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
        >
          <span aria-hidden="true">›</span>
        </Link>
      </div>

      <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {weekdayLabels.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>

      {/* role="grid" would oblige a full two-dimensional widget contract (rows, gridcells, a roving
          tabindex) for what is a list of links laid out in seven columns. The links keep their own
          semantics and the arrow keys are an extra. */}
      <div ref={gridRef} onKeyDown={onKeyDown} className="grid grid-cols-7 gap-1">
        {Array.from({ length: leading }, (_, i) => (
          <span key={`lead-${i}`} className={`${filler} rounded-md text-center text-xs leading-[3rem] text-muted-foreground/40`}>
            {addDaysIso(first, i - leading).slice(8)}
          </span>
        ))}
        {dates.map((iso) => {
          const cell = byDate.get(iso);
          const kind = cell?.kind ?? 'workday';
          const isSelected = iso === selected;
          const isToday = iso === today;
          const kindLabel = t(KIND_LABEL_KEY[kind]);
          const planLabel = cell?.plan ? t(PLAN_LABEL_KEY[cell.plan]) : null;
          return (
            <Link
              key={iso}
              href={`${dayHrefBase}?date=${iso}`}
              scroll={false}
              data-otcal-date={iso}
              aria-current={isSelected ? 'date' : undefined}
              aria-label={[iso, kindLabel, cell?.noRosterEntry ? t('otCalNoRosterEntry') : null, planLabel]
                .filter(Boolean)
                .join(' · ')}
              className={[
                cellBase,
                isSelected
                  ? 'border-primary bg-primary font-semibold text-primary-foreground'
                  : `${KIND_CLS[kind]} ${cell?.noRosterEntry ? 'border-dashed' : ''}`,
                isToday && !isSelected ? 'ring-2 ring-primary/60' : '',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring',
              ].join(' ')}
            >
              <span aria-hidden="true">{iso.slice(8)}</span>
              {/* The word behind the shade. Present for every cell, so no state is colour-only. */}
              <span className="sr-only">{kindLabel}</span>
              {cell?.plan && (
                <span
                  aria-hidden="true"
                  className={`absolute bottom-1 size-1.5 rounded-full ${isSelected ? 'bg-primary-foreground' : PLAN_DOT[cell.plan]}`}
                />
              )}
            </Link>
          );
        })}
        {Array.from({ length: trailing }, (_, i) => (
          <span key={`trail-${i}`} className={`${filler} rounded-md text-center text-xs leading-[3rem] text-muted-foreground/40`}>
            {addDaysIso(last, i + 1).slice(8)}
          </span>
        ))}
      </div>

      <div className="mt-3 space-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <LegendSwatch className={KIND_CLS.workday} label={t('otCalWorkingDay')} />
          <LegendSwatch className={KIND_CLS.rest_day} label={t('otCalRestDay')} />
          <LegendSwatch className={KIND_CLS.holiday} label={t('otCalPublicHoliday')} />
          <LegendSwatch className={KIND_CLS.off_day} label={t('otCalOffDay')} />
          <LegendSwatch className="border-dashed border-border bg-transparent" label={t('otCalNoRosterEntry')} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <LegendDot className={PLAN_DOT.pending} label={t('otCalPlanPending')} />
          <LegendDot className={PLAN_DOT.approved} label={t('otCalPlanApproved')} />
          <LegendDot className={PLAN_DOT.rejected} label={t('otCalPlanRejected')} />
          <LegendDot className={PLAN_DOT.cancelled} label={t('otCalPlanWithdrawn')} />
        </div>
        {!compact && <p>{t('otCalTodayRinged')}</p>}
      </div>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden="true" className={`inline-block size-3 rounded border ${className}`} />
      {label}
    </span>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden="true" className={`inline-block size-1.5 rounded-full ${className}`} />
      {label}
    </span>
  );
}
