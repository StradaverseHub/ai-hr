'use client';

import { formatMinutesToHM, plannedOvertimeMinutes } from '@/lib/overtime-duration';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

/** Live display from strict planned HH:mm values; submit integer minutes, never formatted text.
 * Earlier ends wrap to the following day. The server derives the same figure when JavaScript is off. */
const fmtHours = formatMinutesToHM;

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
  const startValue = start ?? plannedStartPrefill;

  // Integer minutes from the shared planned-window validator. Earlier end times wrap overnight;
  // an equal or malformed pair has no duration and cannot be submitted.
  const derivedMinutes = useMemo(() => plannedOvertimeMinutes(startValue, end), [startValue, end]);
  const otMinutes = derivedMinutes ?? 0;

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
          <span className="text-lg font-semibold tabular-nums">{derivedMinutes == null ? '—' : fmtHours(derivedMinutes)}</span>
          <span className="text-[11px] text-muted-foreground">{t('otComputedHoursHelp')}</span>
        </div>
      </Field>
      {/* The single figure the engine reads. Derived here so the employee and the record cannot disagree
          about how many hours the window they typed is worth. Blank when the window yields nothing, which
          is the signal myRequestOvertime derives from the window itself (see the header). */}
      <input type="hidden" name="otMinutes" value={derivedMinutes ?? ''} />

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
