'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';

// cf21e554 stage 1 — `paid` is the reference Break tab's "Paid?" tick. Optional, and ABSENT MEANS UNPAID,
// so a shift saved before this release round-trips byte-identically (see BreakPeriod in db/schema.ts).
type BreakRow = { start: string; end: string; paid?: boolean };

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
 * (core/attendance.ts shiftSpan/netScheduledMinutes), which the service re-derives on save.
 *
 * cf21e554 stage 1 adds the reference Break tab's three missing columns:
 *   • Sequence No.  — the row number, shown beside each row.
 *   • Duration      — that row's own length, so a five-row grid does not have to be added up by hand.
 *   • Paid?         — an UNPAID break comes off the hours exactly as it does today; a PAID one does not.
 *     The preview below therefore subtracts only the unpaid rows, matching core/roster.ts
 *     normalizeShiftInput, which computes break_minutes as Σ of the UNPAID windows.
 */
export function ShiftTimeFields({
  defaultStart = '09:00',
  defaultEnd = '18:00',
  defaultBreaks = [],
  defaultBreakMinutes = '60',
  defaultOverride = '',
  defaultRounding = '',
}: {
  defaultStart?: string;
  defaultEnd?: string;
  /** Edit form: seed the repeatable break-window rows (times as 'HH:MM'). Empty ⇒ single-scalar mode. */
  defaultBreaks?: BreakRow[];
  /** Edit form: seed the single break-minutes scalar shown when there are no break-window rows. */
  defaultBreakMinutes?: string;
  /** Edit form: seed the manual normal-minutes override (empty ⇒ auto). */
  defaultOverride?: string;
  /** cf21e554 — the shift's Normal-Hours Rounding, so the live readout shows the SAME figure the engine
   *  will use (netScheduledMinutes rounds the net figure DOWN to a multiple of this). Display only: the
   *  input itself lives on the General section of the form. */
  defaultRounding?: string;
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
  // Only the UNPAID windows come off — the same rule core/roster.ts applies when it persists break_minutes.
  const breakSum =
    breaks.length > 0
      ? validBreaks.filter((bp) => !bp.paid).reduce((acc, bp) => acc + (toMin(bp.end) - toMin(bp.start)), 0)
      : Number(breakMinutes) || 0;
  const roundTo = Number(defaultRounding) || 0;
  const net = Math.max(0, span - breakSum);
  const auto = roundTo > 0 ? Math.floor(net / roundTo) * roundTo : net;
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
          {breaks.map((bp, i) => {
            const rowMinutes = bp.start && bp.end && bp.end > bp.start ? toMin(bp.end) - toMin(bp.start) : null;
            return (
              <span key={i} className="flex items-center gap-1.5">
                {/* Sequence No. — the reference grid's first column. */}
                <span className="w-5 text-right text-xs tabular-nums text-muted-foreground" aria-hidden="true">
                  {i + 1}.
                </span>
                <input type="time" value={bp.start} onChange={(e) => setBreak(i, { start: e.target.value })} className={inputCls} aria-label={t('breakStart')} />
                <span className="text-xs text-muted-foreground">–</span>
                <input type="time" value={bp.end} onChange={(e) => setBreak(i, { end: e.target.value })} className={inputCls} aria-label={t('breakEnd')} />
                {/* This row's own duration — the reference grid's Duration column. */}
                <span className="w-16 text-xs tabular-nums text-muted-foreground">{rowMinutes == null ? '—' : hm(rowMinutes)}</span>
                <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={bp.paid ?? false}
                    onChange={(e) => setBreak(i, { paid: e.target.checked })}
                    className="h-3.5 w-3.5 accent-primary"
                    aria-label={t('breakPaid')}
                  />
                  {t('breakPaid')}
                </label>
                <button
                  type="button"
                  onClick={() => setBreaks((prev) => prev.filter((_, j) => j !== i))}
                  className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
                  aria-label={t('removeBreak')}
                >
                  ×
                </button>
              </span>
            );
          })}
          {/* `paid` is emitted ONLY when true, so an unpaid row posts exactly the { start, end } shape it
              posted before this release. */}
          <input
            type="hidden"
            name="breakPeriods"
            value={JSON.stringify(validBreaks.map((bp) => (bp.paid ? { start: bp.start, end: bp.end, paid: true } : { start: bp.start, end: bp.end })))}
          />
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
