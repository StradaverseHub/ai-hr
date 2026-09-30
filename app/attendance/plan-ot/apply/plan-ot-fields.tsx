'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

/**
 * 1e9145d4 Plan OT · the ONLY client-side part of Apply OT Plan.
 *
 * WHAT IT EXISTS FOR, and nothing else: the plan asks for a planned start and end "with the hours worked
 * out for you as you type", and for the monthly-ceiling warning to react to those hours. Both are arithmetic
 * on what is in the boxes, which a server round-trip per keystroke cannot do. Everything else on the screen
 * — the calendar, the roster card, the approver's name, the reason text, the submit button — stays
 * server-rendered in page.tsx and posts through the ordinary server action.
 *
 * ⚠️ ce5ded11 (r362) TOOK THE DATE BOX OUT OF HERE. The date is chosen on the calendar now, which is a
 * grid of ordinary links, so the soft navigation to `?date=…` that this island used to perform is done by
 * the browser following an `<a href>`. React keeps this component's own state across that navigation
 * (same component, same position), so the times, the reason and the category survive picking a new date —
 * which is the whole reason the calendar links rather than posting. `date` still rides in the form as a
 * hidden field: it is what the server action reads and what the request row is filed against.
 *
 * ⚠️ NO JAVASCRIPT, STATED HONESTLY THIS TIME. The previous header claimed the hidden `otHours` was
 * "pre-filled from the server's own figure"; page.tsx hard-coded `initialOtMinutes={0}`, so it was always
 * empty and the form could NEVER succeed without JavaScript — the service refused with "Provide at least
 * one of a clock-in time, a clock-out time, or overtime hours." There is no server-side figure to pre-fill
 * with (nothing is drafted), so the fix is on the other side: when `otHours` arrives blank and a planned
 * window was posted, myRequestOvertime DERIVES the minutes from the window. The times are plain named
 * inputs, so the form now posts and succeeds with scripting off; the hours read-out below simply stops
 * updating as you type.
 *
 * That same change is what makes "The planned end time must be after the planned start time." REACHABLE.
 * An inverted pair yields nothing here (it is a typo, not a cross-midnight plan — the reading
 * requestAttendanceCorrection takes), the hidden field posts blank, and the action's derivation hands the
 * service a zero for a window it can then refuse ON ITS OWN TERMS. Before this it collapsed to "no hours
 * at all" and the employee got the generic at-least-one message about a field they had filled in.
 *
 * `t` IS OPENED HERE rather than taking pre-translated label props (the components/company-filter-select
 * convention) because two of these strings take live arguments — the running hours total. Client-side
 * useTranslations is established in this codebase (components/attendance-figure-cells.tsx); the single
 * namespace keeps test/i18n-coverage.test.ts Check C able to attribute every key.
 */
/** "3.5", "6", "105.5" — two decimals with the trailing zeros trimmed, so the hours read like hours. */
const fmtHours = (minutes: number) => (minutes / 60).toFixed(2).replace(/\.?0+$/, '');

export function PlanOtFields({
  date,
  minutesAlreadyCommitted,
  capMinutes,
  plannedStartPrefill,
}: {
  /** The overtime date currently selected — the one the calendar picked and the server resolved for. */
  date: string;
  /** OT already recorded + already approved-but-not-yet-counted in this date's month, in minutes. */
  minutesAlreadyCommitted: number;
  /** The statutory monthly ceiling in minutes (104 hours). */
  capMinutes: number;
  /**
   * ce5ded11 — the scheduled finishing time of the selected day (HH:MM), or '' where the day has none.
   * On an ordinary working day overtime starts when the shift ends, so the box opens filled in; on a rest
   * day, a public holiday or an off day there is no finishing time to start from and it opens empty.
   */
  plannedStartPrefill: string;
}) {
  const t = useTranslations('me');
  // NULL means "the employee has not touched this box", which is not the same as "they emptied it". Only
  // an untouched box follows the prefill, so picking a different date moves the suggested start with it
  // while a time somebody actually chose is never overwritten behind their back.
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState('');
  const [category, setCategory] = useState('project_deadline');
  const startValue = start ?? plannedStartPrefill;

  // Minutes between two HH:MM values. An end at or before the start is not a cross-midnight plan, it is a
  // typo — the same reading requestAttendanceCorrection takes — so it yields nothing rather than a negative
  // or a wrapped figure that would quietly submit the wrong number of hours.
  const otMinutes = useMemo(() => {
    if (!startValue || !end) return 0;
    const [sh, sm] = startValue.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return 0;
    const mins = eh * 60 + em - (sh * 60 + sm);
    return mins > 0 ? mins : 0;
  }, [startValue, end]);

  const hours = otMinutes / 60;
  const projectedMinutes = minutesAlreadyCommitted + otMinutes;
  const overCap = otMinutes > 0 && projectedMinutes > capMinutes;

  return (
    <div className="space-y-2.5">
      {/* The date the calendar picked. Named `date` because that is what myRequestOvertime reads and what
          test/me-tabs.test.ts follows through to the redirect. */}
      <input type="hidden" name="date" value={date} />

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('plannedStartLabel')}>
          <input
            type="time"
            name="plannedStart"
            value={startValue}
            onChange={(e) => setStart(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={t('plannedEndLabel')}>
          <input
            type="time"
            name="plannedEnd"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>
      {start == null && plannedStartPrefill !== '' && (
        <p className="text-[11px] text-primary">{t('otStartFromShiftEnd')}</p>
      )}

      {/* c7c69a18 — "Overtime duration", on a key of this screen's own. me.otHoursLabel ("Overtime hours")
          is RETIRED IN PLACE in all six catalogues rather than reworded, so nothing that resolves it later
          silently acquires this screen's wording. (The approved plan's build note says the approvals queue
          shares this key; it does not — app/approvals/page.tsx opens getTranslations('approvals') and reads
          approvals.otHoursLabel, whose value is "OT". The correction is in the round's report.) */}
      <Field label={t('otDurationLabel')}>
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tabular-nums">{fmtHours(otMinutes)}</span>
          <span className="text-[11px] text-muted-foreground">{t('otComputedHoursHelp')}</span>
        </div>
      </Field>
      {/* The single figure the engine reads. Derived here so the employee and the record cannot disagree
          about how many hours the window they typed is worth. Blank when the window yields nothing, which
          is the signal myRequestOvertime derives from the window itself (see the header). */}
      <input type="hidden" name="otHours" value={hours ? hours.toFixed(4) : ''} />

      <Field label={t('otReasonCategoryLabel')}>
        <select
          name="otReasonCategory"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={inputCls}
        >
          <option value="project_deadline">{t('otCategoryProjectDeadline')}</option>
          <option value="system_maintenance">{t('otCategorySystemMaintenance')}</option>
          <option value="month_end_closing">{t('otCategoryMonthEndClosing')}</option>
          <option value="client_request">{t('otCategoryClientRequest')}</option>
          <option value="other">{t('otCategoryOther')}</option>
        </select>
      </Field>

      {/* WARNS, DOES NOT BLOCK — there is no `disabled` anywhere on this screen. A genuine month-end can
          legitimately cross the ceiling, and the approver is the right person to weigh that, not a form. */}
      {overCap && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-medium">{t('otCapHeading')}</p>
          <p className="mt-1">
            {t('otCapWarning', { hours: fmtHours(otMinutes), total: fmtHours(projectedMinutes) })}
          </p>
        </div>
      )}
    </div>
  );
}
