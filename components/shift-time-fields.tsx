'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

// cf21e554 stage 1 — `paid` is the reference Break tab's "Paid?" tick. Optional, and ABSENT MEANS UNPAID,
// so a shift saved before this release round-trips byte-identically (see BreakPeriod in db/schema.ts).
//
// b8aa3466 — `flexible` is the new Fixed tick, stored INVERTED and only when TRUE. Fixed (the tick ON) is
// what every stored window means today, so a legacy row opens ticked and posts back without the key: the
// JSON is byte-identical unless the operator actually unticks it. f3321963 already defined the flag; this
// is the first editor for it.
type BreakRow = { start: string; end: string; paid?: boolean; flexible?: boolean };

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
/** minutes → a clock time on the shift's own day, for the derived Semi-Flexi half-day readout. */
const clock = (mins: number) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

export type ShiftFormType = 'normal' | 'semi_flexi' | 'full_flexi';

/**
 * R7 Multi-Shift Phase 1 — the shift form's time fields: start/end, repeatable break windows, a LIVE auto
 * normal-hours readout, and a manual override that wins when filled. Valid break rows post as one JSON
 * `breakPeriods` field; with no rows the legacy single `breakMinutes` input is the fallback.
 *
 * The live figure here is a DISPLAY preview only — the authoritative math is the shared server helper
 * (core/attendance.ts shiftSpan/netScheduledMinutes), which the service re-derives on save.
 *
 * b8aa3466 — this island now also owns the SHIFT TYPE select, because the type is what decides which of
 * these boxes a shift needs, and that decision has to happen in the browser as the operator changes it:
 *
 *   • Normal      — Time in / Time out. Total normal working hours is prefilled from the times and the
 *                   unpaid breaks and is optional. Half-day cut-off is a clock time.
 *   • Semi Flexi  — the SAME two stored columns, relabelled Earliest time in / Latest time out (that is
 *                   how SemiFlex01 already stores 07:00–20:00; early_in / late_out are recorded-only and
 *                   blank on that row, so promoting those instead would have moved the engine). Total
 *                   normal working hours is REQUIRED with no prefill — without it the engine reads a
 *                   normal day on that shift as the whole 12-hour window and no overtime accrues until
 *                   hour 12. Half-day cut-off is DERIVED (half the required hours of work) and therefore
 *                   not asked for.
 *   • Full Flexi  — still unpickable, exactly as before. Nothing here turns it on.
 *
 * EVERY BOX HAS A PRINTED LABEL. Ten controls used to carry only an aria-label or a placeholder — four of
 * them the first four things you type into.
 *
 * THE PREVIEW BELOW IS THE SIXTH INLINED COPY of span-minus-break (HANDOFF.md names it the one most likely
 * to drift from core/attendance.ts netScheduledMinutes). Two rules keep it honest, and both are load-bearing:
 *   • only the UNPAID windows are subtracted — `flexible` must NEVER enter breakSum, because core/roster.ts
 *     persists break_minutes as Σ of the UNPAID windows and nothing else;
 *   • a type whose span is not the normal-hours figure SUPPRESSES the preview rather than computing one
 *     from a window it does not mean (Semi Flexi).
 */
export function ShiftTimeFields({
  defaultType = 'normal',
  defaultStart = '09:00',
  defaultEnd = '18:00',
  defaultBreaks = [],
  defaultBreakMinutes = '60',
  defaultOverride = '',
  defaultRounding = '',
  defaultHalfDayFirstOut = '',
  defaultDailyCutoffEnabled = false,
  defaultDailyCutoffTime = '',
}: {
  /** b8aa3466 — the shift template type, now client state because it drives the field set. */
  defaultType?: ShiftFormType;
  defaultStart?: string;
  defaultEnd?: string;
  /** Edit form: seed the repeatable break-window rows (times as 'HH:MM'). Empty ⇒ single-scalar mode. */
  defaultBreaks?: BreakRow[];
  /** Edit form: seed the single break-minutes scalar shown when there are no break-window rows. */
  defaultBreakMinutes?: string;
  /** Edit form: seed the stored normal-minutes figure (empty ⇒ none stored). */
  defaultOverride?: string;
  /** cf21e554 — the shift's Normal-Hours Rounding, so the live readout shows the SAME figure the engine
   *  will use (netScheduledMinutes rounds the net figure DOWN to a multiple of this). Display only: the
   *  input itself lives in More settings. */
  defaultRounding?: string;
  /** b8aa3466 — the half-day cut-off (stored half_day_first_out). Normal only; Semi Flexi derives it. */
  defaultHalfDayFirstOut?: string;
  /** b8aa3466 — the daily cut-off pair (migration 0429). */
  defaultDailyCutoffEnabled?: boolean;
  defaultDailyCutoffTime?: string;
}) {
  const t = useTranslations('roster');
  const ta = useTranslations('admin.attendancePolicy');
  const [type, setType] = useState<ShiftFormType>(defaultType);
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [breaks, setBreaks] = useState<BreakRow[]>(defaultBreaks);
  const [breakMinutes, setBreakMinutes] = useState(defaultBreakMinutes);
  const [cutoffOn, setCutoffOn] = useState(defaultDailyCutoffEnabled);
  const [cutoffAt, setCutoffAt] = useState(defaultDailyCutoffTime || '02:00');

  const semiFlexi = type === 'semi_flexi';

  const validBreaks = breaks.filter((bp) => bp.start && bp.end && bp.end > bp.start);
  // end ≤ start ⇒ crosses midnight (mirrors shiftCrossesMidnight; times are HH:MM, lexicographic = chronological)
  const crosses = !!start && !!end && end <= start;
  const span = start && end ? (crosses ? toMin(end) + 1440 - toMin(start) : toMin(end) - toMin(start)) : 0;
  // Only the UNPAID windows come off — the same rule core/roster.ts applies when it persists break_minutes.
  // `flexible` deliberately plays no part here: a flexible break is still deducted, it just is not pinned
  // to a clock time.
  const breakSum =
    breaks.length > 0
      ? validBreaks.filter((bp) => !bp.paid).reduce((acc, bp) => acc + (toMin(bp.end) - toMin(bp.start)), 0)
      : Number(breakMinutes) || 0;
  const roundTo = Number(defaultRounding) || 0;
  const net = Math.max(0, span - breakSum);
  const auto = roundTo > 0 ? Math.floor(net / roundTo) * roundTo : net;

  // ── b8aa3466 item 4 · TOTAL NORMAL WORKING HOURS ────────────────────────────────────────────────────
  // ONE control replacing the read-only readout plus the "Override (minutes)" box beside it. Entered as
  // hours + minutes because that is how the reporter wrote it; STORED AS MINUTES, unchanged — changing the
  // stored unit would make every saved value 60× wrong.
  //
  // Normal: seeded from the computed figure and editable. A value equal to the computed one posts BLANK,
  // so a shift only carries an override once the operator actually disagrees with the arithmetic — which
  // is exactly the pre-b8aa3466 storage contract.
  // Semi Flexi: required, and never seeded from the span (the span is the flexible WINDOW, not a day's work).
  const seed = defaultOverride !== '' ? Number(defaultOverride) : semiFlexi ? null : auto;
  const [totalH, setTotalH] = useState(seed == null ? '' : String(Math.floor(seed / 60)));
  const [totalM, setTotalM] = useState(seed == null ? '' : String(seed % 60));
  const [totalTouched, setTotalTouched] = useState(defaultOverride !== '');
  // Untouched on a Normal shift ⇒ follow the live arithmetic as the operator edits the times and breaks.
  const shownH = totalTouched || semiFlexi ? totalH : String(Math.floor(auto / 60));
  const shownM = totalTouched || semiFlexi ? totalM : String(auto % 60);
  const totalMinutes =
    shownH === '' && shownM === '' ? null : Math.max(0, (Number(shownH) || 0) * 60 + (Number(shownM) || 0));
  // What actually POSTS into normalMinutesOverride: blank when it agrees with the computed figure on a
  // Normal shift (no override stored), the number otherwise.
  const postedOverride =
    totalMinutes == null || (!semiFlexi && totalMinutes === auto) ? '' : String(totalMinutes);

  const setTotal = (h: string, m: string) => {
    setTotalTouched(true);
    setTotalH(h);
    setTotalM(m);
  };

  const setBreak = (i: number, patch: Partial<BreakRow>) => setBreaks((prev) => prev.map((bp, j) => (j === i ? { ...bp, ...patch } : bp)));

  return (
    <div className="space-y-4">
      {/* f3321963 — Shift Type. Normal + Semi-Flexi are selectable; Full-Flexi is reserved for a FUTURE
          enhancement (reporter-sanctioned), so its option stays disabled and the note below explains it.
          b8aa3466 — client state: it decides which boxes below are asked for. */}
      <Field label={ta('shiftTypeLabel')}>
        <select
          name="shiftTemplateType"
          value={type}
          onChange={(e) => setType(e.target.value as ShiftFormType)}
          className={inputCls}
        >
          <option value="normal">{ta('shiftTypeNormal')}</option>
          <option value="semi_flexi">{ta('shiftTypeSemiFlexi')}</option>
          <option value="full_flexi" disabled>
            {ta('shiftTypeFullFlexi')}
          </option>
        </select>
      </Field>

      <fieldset className="space-y-4">
        <legend className="mb-1.5 text-sm font-medium text-foreground">{t('workingTimesLegend')}</legend>

        {/* 1 + 2 — the SAME two stored columns either way; only the wording changes with the type. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={semiFlexi ? t('earliestTimeIn') : t('timeIn')}>
            <input
              name="startTime"
              type="time"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label={semiFlexi ? t('latestTimeOut') : t('timeOut')}>
            <input
              name="endTime"
              type="time"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        {/* 3 — Total normal working hours. Hours + minutes on screen, MINUTES in the database. */}
        <div>
          <Field label={t('totalNormalWorkingHours')} required={semiFlexi} requiredAriaLabel={t('requiredField')}>
            <span className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={24}
                required={semiFlexi}
                value={shownH}
                onChange={(e) => setTotal(e.target.value, shownM)}
                className={inputCls}
                aria-label={t('unitHoursLong')}
              />
              <span className="text-xs text-muted-foreground">{t('unitHoursShort')}</span>
              <input
                type="number"
                min={0}
                max={59}
                value={shownM}
                onChange={(e) => setTotal(shownH, e.target.value)}
                className={inputCls}
                aria-label={t('unitMinutesLong')}
              />
              <span className="text-xs text-muted-foreground">{t('unitMinutesShort')}</span>
            </span>
          </Field>
          {/* STORAGE STAYS MINUTES — this is the only thing that reaches the database. */}
          <input type="hidden" name="normalMinutesOverride" value={postedOverride} />
          <p className="mt-1 text-xs text-muted-foreground">
            {semiFlexi ? t('totalNormalHoursSemiHint') : t('totalNormalHoursNormalHint')}
          </p>
        </div>

        {/* 4 — Breaks, with the new Fixed tick beside the existing Paid one. */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-foreground">{t('breaksLabel')}</span>
          {breaks.length === 0 ? (
            <Field label={t('breakMins')}>
              <input
                name="breakMinutes"
                type="number"
                min={0}
                value={breakMinutes}
                onChange={(e) => setBreakMinutes(e.target.value)}
                className={inputCls}
              />
            </Field>
          ) : (
            <span className="flex flex-col gap-1.5" aria-label={t('breakPeriods')}>
              {breaks.map((bp, i) => {
                const rowMinutes = bp.start && bp.end && bp.end > bp.start ? toMin(bp.end) - toMin(bp.start) : null;
                return (
                  <span key={i} className="flex flex-wrap items-end gap-1.5">
                    {/* Sequence No. — the reference grid's first column. */}
                    <span className="w-5 pb-2 text-right text-xs tabular-nums text-muted-foreground" aria-hidden="true">
                      {i + 1}.
                    </span>
                    <Field label={t('breakStart')}>
                      <input type="time" value={bp.start} onChange={(e) => setBreak(i, { start: e.target.value })} className={inputCls} />
                    </Field>
                    <Field label={t('breakEnd')}>
                      <input type="time" value={bp.end} onChange={(e) => setBreak(i, { end: e.target.value })} className={inputCls} />
                    </Field>
                    {/* This row's own duration — the reference grid's Duration column. */}
                    <span className="w-16 pb-2 text-xs tabular-nums text-muted-foreground">
                      {rowMinutes == null ? '—' : hm(rowMinutes)}
                    </span>
                    <label className="inline-flex cursor-pointer items-center gap-1 pb-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={bp.paid ?? false}
                        onChange={(e) => setBreak(i, { paid: e.target.checked })}
                        className="h-3.5 w-3.5 accent-primary"
                        aria-label={t('breakPaid')}
                      />
                      {t('breakPaid')}
                    </label>
                    {/* b8aa3466 — FIXED. Stored inverted as `flexible`, and only when the tick is OFF, so a
                        window saved before this release posts back byte-identically. Semi Flexi forces every
                        break flexible in core/roster.ts, so the tick is shown OFF and disabled there rather
                        than letting the screen promise something the service will overwrite. */}
                    <label
                      className={`inline-flex items-center gap-1 pb-2 text-xs text-muted-foreground ${semiFlexi ? 'opacity-60' : 'cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        disabled={semiFlexi}
                        checked={semiFlexi ? false : bp.flexible !== true}
                        onChange={(e) => setBreak(i, { flexible: !e.target.checked })}
                        className="h-3.5 w-3.5 accent-primary"
                        aria-label={t('breakFixed')}
                      />
                      {t('breakFixed')}
                    </label>
                    <button
                      type="button"
                      onClick={() => setBreaks((prev) => prev.filter((_, j) => j !== i))}
                      className="pb-2 text-rose-600 hover:text-rose-700 dark:text-rose-400"
                      aria-label={t('removeBreak')}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              {/* `paid` is emitted ONLY when true and `flexible` ONLY when true, so a break row that predates
                  either tick posts exactly the { start, end } shape it always posted. */}
              <input
                type="hidden"
                name="breakPeriods"
                value={JSON.stringify(
                  validBreaks.map((bp) => ({
                    start: bp.start,
                    end: bp.end,
                    ...(bp.paid ? { paid: true } : {}),
                    ...(bp.flexible ? { flexible: true } : {}),
                  })),
                )}
              />
            </span>
          )}
          <span className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setBreaks((prev) => [...prev, { start: '12:00', end: '13:00' }])}
              className="rounded-md border border-border px-2.5 py-1 text-sm text-foreground hover:bg-muted"
            >
              {t('addBreak')}
            </button>
            <span className="text-xs text-muted-foreground">{t('breakFixedHint')}</span>
          </span>
        </div>

        {/* 5 — the DAILY CUT-OFF (b8aa3466, migration 0429). */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-foreground">{t('dailyCutoffLegend')}</span>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
            <input
              type="checkbox"
              name="dailyCutoffEnabled"
              checked={cutoffOn}
              onChange={(e) => setCutoffOn(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {t('dailyCutoffUse')}
          </label>
          {cutoffOn && (
            <span className="mt-1.5 block max-w-xs">
              <Field label={t('dailyCutoffAt')}>
                <input
                  name="dailyCutoffTime"
                  type="time"
                  required
                  value={cutoffAt}
                  onChange={(e) => setCutoffAt(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </span>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{t('dailyCutoffHint')}</p>
        </div>

        {/* 6 — the HALF-DAY CUT-OFF. A clock time on a Normal shift (the stored half_day_first_out, simply
            relabelled); DERIVED on Semi Flexi from half the required hours of WORK, breaks excluded — so
            nothing is asked for, and nothing is posted, which is what makes the server derive it. */}
        <div>
          {semiFlexi ? (
            <>
              <span className="mb-1.5 block text-sm font-medium text-foreground">{t('halfDayCutoffLabel')}</span>
              <p className="text-sm text-foreground">
                {totalMinutes == null || totalMinutes === 0
                  ? t('halfDayCutoffDerivedPending')
                  : t('halfDayCutoffDerived', {
                      half: hm(Math.floor(totalMinutes / 2)),
                      total: hm(totalMinutes),
                      at: clock(toMin(start || '00:00') + Math.floor(totalMinutes / 2)),
                    })}
              </p>
            </>
          ) : (
            <>
              <Field label={t('halfDayCutoffLabel')}>
                <input
                  name="halfDayFirstOut"
                  type="time"
                  defaultValue={defaultHalfDayFirstOut}
                  className={inputCls}
                />
              </Field>
              <p className="mt-1 text-xs text-muted-foreground">{t('halfDayCutoffHint')}</p>
            </>
          )}
        </div>
      </fieldset>
    </div>
  );
}
