'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';

type BreakRow = { start: string; end: string };

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

/**
 * R7 Multi-Shift Phase 1 — the shift form's time fields: start/end, repeatable break windows, a LIVE auto
 * normal-hours readout, and a manual override that wins when filled. Valid break rows post as one JSON
 * `breakPeriods` field; with no rows the legacy single `breakMinutes` input is the fallback.
 *
 * The live figure here is a DISPLAY preview only — the authoritative math is the shared server helper
 * (core/attendance.ts shiftSpan/netScheduledMinutes), which the service re-derives on save. Multi-break is
 * STORAGE-ONLY this phase: deducted hours still use the combined total (see the hint under the form).
 */
export function ShiftTimeFields({
  defaultStart = '09:00',
  defaultEnd = '18:00',
  defaultBreaks = [],
  defaultBreakMinutes = '60',
  defaultOverride = '',
}: {
  defaultStart?: string;
  defaultEnd?: string;
  /** Edit form: seed the repeatable break-window rows (times as 'HH:MM'). Empty ⇒ single-scalar mode. */
  defaultBreaks?: BreakRow[];
  /** Edit form: seed the single break-minutes scalar shown when there are no break-window rows. */
  defaultBreakMinutes?: string;
  /** Edit form: seed the manual normal-minutes override (empty ⇒ auto). */
  defaultOverride?: string;
}) {
  const t = useTranslations('roster');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [breaks, setBreaks] = useState<BreakRow[]>(defaultBreaks);
  const [breakMinutes, setBreakMinutes] = useState(defaultBreakMinutes);
  const [override, setOverride] = useState(defaultOverride);

  const validBreaks = breaks.filter((bp) => bp.start && bp.end && bp.end > bp.start);
  // end ≤ start ⇒ crosses midnight (mirrors shiftCrossesMidnight; times are HH:MM, lexicographic = chronological)
  const crosses = !!start && !!end && end <= start;
  const span = start && end ? (crosses ? toMin(end) + 1440 - toMin(start) : toMin(end) - toMin(start)) : 0;
  const breakSum = breaks.length > 0 ? validBreaks.reduce((acc, bp) => acc + (toMin(bp.end) - toMin(bp.start)), 0) : Number(breakMinutes) || 0;
  const auto = Math.max(0, span - breakSum);
  const overrideMin = override.trim() === '' ? null : Number(override);

  const setBreak = (i: number, patch: Partial<BreakRow>) => setBreaks((prev) => prev.map((bp, j) => (j === i ? { ...bp, ...patch } : bp)));

  return (
    <>
      <input name="startTime" type="time" required value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} aria-label={t('start')} />
      <input name="endTime" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} aria-label={t('end')} />

      {breaks.length === 0 ? (
        <input
          name="breakMinutes"
          type="number"
          min={0}
          value={breakMinutes}
          onChange={(e) => setBreakMinutes(e.target.value)}
          className={`${inputCls} w-20`}
          aria-label={t('breakMins')}
        />
      ) : (
        <span className="flex flex-col gap-1.5" aria-label={t('breakPeriods')}>
          {breaks.map((bp, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <input type="time" value={bp.start} onChange={(e) => setBreak(i, { start: e.target.value })} className={inputCls} aria-label={t('breakStart')} />
              <span className="text-xs text-muted-foreground">–</span>
              <input type="time" value={bp.end} onChange={(e) => setBreak(i, { end: e.target.value })} className={inputCls} aria-label={t('breakEnd')} />
              <button
                type="button"
                onClick={() => setBreaks((prev) => prev.filter((_, j) => j !== i))}
                className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
                aria-label={t('removeBreak')}
              >
                ×
              </button>
            </span>
          ))}
          <input type="hidden" name="breakPeriods" value={JSON.stringify(validBreaks)} />
        </span>
      )}
      <button
        type="button"
        onClick={() => setBreaks((prev) => [...prev, { start: '12:00', end: '13:00' }])}
        className="rounded-md border border-border px-2.5 py-1 text-sm text-foreground hover:bg-muted"
      >
        {t('addBreak')}
      </button>

      <span className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t('normalHours')}: <span className="font-medium text-foreground">{hm(overrideMin ?? auto)}</span>
          {overrideMin == null && <> ({t('autoCalculated')})</>}
        </span>
        <input
          name="normalMinutesOverride"
          type="number"
          min={0}
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          placeholder={t('manualOverride')}
          className={`${inputCls} w-36`}
          aria-label={t('manualOverride')}
        />
      </span>
    </>
  );
}
