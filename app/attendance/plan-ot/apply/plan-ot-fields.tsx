'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

/**
 * 1e9145d4 Plan OT · the ONLY client-side part of Apply OT Plan.
 *
 * WHAT IT EXISTS FOR, and nothing else: the plan asks for a planned start and end "with the hours worked
 * out for you as you type", and for the monthly-ceiling warning to react to those hours. Both are arithmetic
 * on what is in the boxes, which a server round-trip per keystroke cannot do. Everything else on the screen
 * — the day-type warning, the approver's name, the reason text, the submit button — stays server-rendered
 * in page.tsx and posts through the ordinary server action.
 *
 * WHY THE DATE INPUT IS IN HERE TOO. The day-type warning ("Monday 10 August 2026 is an ordinary working
 * day for you") can only be answered by the server: it comes from scheduleFor, the same resolver the
 * clocking path uses, over the roster / holiday calendar / company policy. So changing the date does a soft
 * navigation to ?date=…, which re-renders the server panel beside these fields. React keeps this component's
 * own state across that navigation (same component, same position), so the times and the reason survive it.
 *
 * NO JAVASCRIPT? The fields are plain inputs with their `name`s, the derived hours ride in a hidden input
 * that is pre-filled from the server's own figure, and the form posts normally. The warnings simply stop
 * updating live — they still describe the date the page was loaded with.
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
  initialOtMinutes,
}: {
  /** The overtime date currently selected — the one the server resolved its warnings for. */
  date: string;
  /** OT already recorded + already approved-but-not-yet-counted in this date's month, in minutes. */
  minutesAlreadyCommitted: number;
  /** The statutory monthly ceiling in minutes (104 hours). */
  capMinutes: number;
  /** What to seed the hours box with. 0 = nothing typed yet. */
  initialOtMinutes: number;
}) {
  const t = useTranslations('me');
  const router = useRouter();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [category, setCategory] = useState('project_deadline');

  // Minutes between two HH:MM values. An end at or before the start is not a cross-midnight plan, it is a
  // typo — the same reading requestAttendanceCorrection takes — so it yields nothing rather than a negative
  // or a wrapped figure that would quietly submit the wrong number of hours.
  const otMinutes = useMemo(() => {
    if (!start || !end) return initialOtMinutes;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return 0;
    const mins = eh * 60 + em - (sh * 60 + sm);
    return mins > 0 ? mins : 0;
  }, [start, end, initialOtMinutes]);

  const hours = otMinutes / 60;
  const projectedMinutes = minutesAlreadyCommitted + otMinutes;
  const overCap = otMinutes > 0 && projectedMinutes > capMinutes;

  return (
    <div className="space-y-2.5">
      <Field label={t('dateLabel')}>
        <input
          type="date"
          name="date"
          required
          value={date}
          onChange={(e) => {
            const next = e.target.value;
            // Empty while the user is mid-edit in some browsers — never navigate to a blank date.
            if (next) router.replace(`?date=${encodeURIComponent(next)}`, { scroll: false });
          }}
          className={inputCls}
        />
      </Field>
      <p className="text-[11px] text-muted-foreground">{t('otDateOpensTomorrow')}</p>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('plannedStartLabel')}>
          <input
            type="time"
            name="plannedStart"
            value={start}
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

      <Field label={t('otHoursLabel')}>
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tabular-nums">{fmtHours(otMinutes)}</span>
          <span className="text-[11px] text-muted-foreground">{t('otComputedHoursHelp')}</span>
        </div>
      </Field>
      {/* The single figure the engine reads. Derived here so the employee and the record cannot disagree
          about how many hours the window they typed is worth. */}
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
