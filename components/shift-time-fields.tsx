'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, Field, inputCls } from '@/components/ui';

// cf21e554 stage 1 — `paid` is the reference Break tab's "Paid?" tick. Optional, and ABSENT MEANS UNPAID,
// so a shift saved before this release round-trips byte-identically (see BreakPeriod in db/schema.ts).
//
// b8aa3466 — `flexible` is the new Fixed tick, stored INVERTED and only when TRUE. Fixed (the tick ON) is
// what every stored window means today, so a legacy row opens ticked and posts back without the key: the
// JSON is byte-identical unless the operator actually unticks it. f3321963 already defined the flag; this
// is the first editor for it.
//
// r277 (439565ff) — `flexibleMinutes` is THIS ROW'S OWN allowance, held as the raw string the number input
// carries so an empty box stays empty (ABSENT ≠ 0 — see BreakPeriod in db/schema.ts). It is offered only on
// a row that is Flexible and unpaid, and only while the shift-level allowance is off; blank posts nothing,
// which is the break the shift deducts today.
type BreakRow = { start: string; end: string; paid?: boolean; flexible?: boolean; flexibleMinutes?: string };

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
/** minutes → a clock time on the shift's own day, for the derived Semi-Flexi half-day readout. */
const clock = (mins: number) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

export type ShiftFormType = 'normal' | 'semi_flexi' | 'full_flexi';

// 6340aecb — the weekly row moved in here with the rest of Working Times. Static literal keys so the i18n
// coverage test's check C can see every one of them (the same reason shift-form.tsx spelled them out).
const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };
const DAY_KIND_KEY = {
  full: 'dayKindFull',
  half: 'dayKindHalf',
  rest: 'dayKindRest',
  off: 'dayKindOff',
} as const;
export type DayKind = keyof typeof DAY_KIND_KEY;

/**
 * R7 Multi-Shift Phase 1 — the shift form's time fields: start/end, repeatable break windows, a LIVE auto
 * normal-hours readout, and a manual override that wins when filled. Valid break rows post as one JSON
 * `breakPeriods` field; with no rows the legacy single `breakMinutes` input is the fallback.
 *
 * The live figure here is a DISPLAY preview only — the authoritative math is the shared server helper
 * (core/attendance.ts shiftSpan/netScheduledMinutes), which the service re-derives on save.
 *
 * b8aa3466 — this island also owns the SHIFT TYPE select, because the type is what decides which of these
 * boxes a shift needs, and that decision has to happen in the browser as the operator changes it:
 *
 *   • Normal      — Time in / Time out. Total normal working hours is prefilled from the times and the
 *                   unpaid breaks and is optional. Half-day cut-off is a clock time.
 *   • Semi Flexi  — the SAME two stored columns, relabelled Earliest time in / Latest time out (that is
 *                   how SemiFlex01 already stores 07:00–20:00; early_in / late_out are recorded-only and
 *                   blank on that row, so promoting those instead would have moved the engine). Total
 *                   normal working hours is REQUIRED with no prefill — without it the engine reads a
 *                   normal day on that shift as the whole 12-hour window and no overtime accrues until
 *                   hour 12. Half-day cut-off is DERIVED (half the required hours of work).
 *   • Full Flexi  — still unpickable, exactly as before. Nothing here turns it on.
 *
 * ── 6340aecb · WHAT THIS COMPONENT NOW IS ────────────────────────────────────────────────────────────
 * It renders TWO of the redesigned screen's four sections — WORKING TIMES and BREAKS — as their own cards,
 * rather than one flat run of boxes. They live together in one client component because they share state:
 * the shift type decides the labels and which boxes are asked for, and the break rows feed the live
 * normal-hours readout. Splitting them into two islands would mean lifting that state into a third.
 *
 * The four boxes that moved IN with the redesign (2nd half start time, the earliest-in / latest-out pair
 * and its next-day tick) are plain uncontrolled inputs — they are here for LAYOUT, not for state, and they
 * post exactly the field names shift-actions.ts already reads.
 *
 * EVERY BOX HAS A PRINTED LABEL. Ten controls used to carry only an aria-label or a placeholder.
 *
 * THE PREVIEW BELOW IS THE SIXTH INLINED COPY of span-minus-break (HANDOFF.md names it the one most likely
 * to drift from core/attendance.ts netScheduledMinutes). Three rules keep it honest, all load-bearing:
 *   • only the UNPAID windows are subtracted — a window's `flexible` flag must NEVER enter breakSum,
 *     because core/roster.ts persists break_minutes as Σ of the UNPAID windows and nothing else;
 *   • when the SHIFT-LEVEL flexible break is on, the ALLOWANCE is the break — core/roster.ts writes it
 *     into break_minutes on save, so the readout must deduct the same figure the engine will;
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
  defaultHalfDaySecondIn = '',
  defaultEarlyIn = '',
  defaultLateOut = '',
  defaultLateOutNextDay = false,
  defaultDailyCutoffEnabled = false,
  defaultDailyCutoffTime = '',
  defaultFlexibleBreakEnabled = false,
  defaultFlexibleBreakMinutes = '',
  dayKinds,
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
   *  input itself lives in General Controls. */
  defaultRounding?: string;
  /** b8aa3466 — the half-day cut-off (stored half_day_first_out). Normal only; Semi Flexi derives it.
   *  6340aecb — the reporter's "1st Half End Time"; its partner below is "2nd Half Start Time". */
  defaultHalfDayFirstOut?: string;
  defaultHalfDaySecondIn?: string;
  /** 6340aecb — the relabelled pair (stored early_in / late_out; the COLUMNS are unchanged, because both
   *  are read across attendance and payroll and a rename buys nothing the label does not). */
  defaultEarlyIn?: string;
  defaultLateOut?: string;
  defaultLateOutNextDay?: boolean;
  /** b8aa3466 — the daily cut-off pair (migration 0429). */
  defaultDailyCutoffEnabled?: boolean;
  defaultDailyCutoffTime?: string;
  /** 6340aecb — the FLEXIBLE BREAK (migration 0457). Off ⇒ the shift computes exactly as it does today. */
  defaultFlexibleBreakEnabled?: boolean;
  defaultFlexibleBreakMinutes?: string;
  /** b8aa3466 — the four-way weekly row, resolved by the caller from the three stored arrays. */
  dayKinds: Record<number, DayKind>;
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
  // 6340aecb — the flexible break. `flexMin` is seeded from the stored allowance, and on a shift that has
  // never had one it is seeded from the break the shift already deducts, so ticking the box does not
  // silently propose a different figure than the operator is looking at.
  const [flexOn, setFlexOn] = useState(defaultFlexibleBreakEnabled);
  const [flexMin, setFlexMin] = useState(defaultFlexibleBreakMinutes);

  const semiFlexi = type === 'semi_flexi';
  /**
   * r274 (439565ff) — FULL FLEXI is enabled, and it needs the SAME required-hours treatment Semi Flexi
   * already has. The figure is not a convenience on either type: it is the only thing that decides whether
   * the day is complete, and a full flexi shift saved without one would fall back to the span between two
   * times that are no longer a requirement — which is exactly the twelve-hour trap SemiFlex01 is sitting
   * in on production today.
   */
  const fullFlexi = type === 'full_flexi';
  const hoursRequired = semiFlexi || fullFlexi;

  const validBreaks = breaks.filter((bp) => bp.start && bp.end && bp.end > bp.start);
  /** r277 — which rows are OFFERED their own allowance box, and therefore post one. Flexible is stored
   *  INVERTED (`bp.flexible !== true` is the Fixed tick), Semi Flexi forces every row flexible in
   *  core/roster.ts, a PAID break is never deducted so an allowance on it would move nothing, and the
   *  SHIFT-LEVEL allowance already answers this question for the whole shift — core/roster.ts refuses to
   *  store both, so the box must not be offered while that switch is on. */
  const rowTakesAllowance = (bp: BreakRow) => !flexOn && !bp.paid && (semiFlexi || bp.flexible === true);
  /** The row's allowance as a NUMBER, or null for "blank ⇒ deduct this row exactly as today". */
  const rowAllowance = (bp: BreakRow): number | null => {
    if (!rowTakesAllowance(bp)) return null;
    const raw = (bp.flexibleMinutes ?? '').trim();
    const n = Math.trunc(Number(raw));
    return raw !== '' && Number.isFinite(n) && n > 0 ? n : null;
  };
  // end ≤ start ⇒ crosses midnight (mirrors shiftCrossesMidnight; times are HH:MM, lexicographic = chronological)
  const crosses = !!start && !!end && end <= start;
  const span = start && end ? (crosses ? toMin(end) + 1440 - toMin(start) : toMin(end) - toMin(start)) : 0;
  // Only the UNPAID windows come off — the same rule core/roster.ts applies when it persists break_minutes.
  // A window's own `flexible` flag deliberately plays no part here: that flag says the window is a target
  // rather than a fixed clock, and the window is still deducted.
  //
  // r277 — …EXCEPT where the row carries its own allowance, which is the one case where `flexible` decides
  // a number: core/roster.ts then writes that allowance into break_minutes in place of the window's length,
  // so this readout has to deduct the same figure the engine will. Blank ⇒ the window's length, i.e. the
  // identical expression this has always been.
  const windowBreakSum =
    breaks.length > 0
      ? validBreaks.filter((bp) => !bp.paid).reduce((acc, bp) => acc + (rowAllowance(bp) ?? toMin(bp.end) - toMin(bp.start)), 0)
      : Number(breakMinutes) || 0;
  // 6340aecb — with the SHIFT-LEVEL flexible break on, the allowance IS the shift's break: core/roster.ts
  // writes it into break_minutes on save, so this readout has to deduct the same number the engine will.
  const flexMinutes = Number(flexMin) || 0;
  const breakSum = flexOn && flexMinutes > 0 ? flexMinutes : windowBreakSum;
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
  const seed = defaultOverride !== '' ? Number(defaultOverride) : hoursRequired ? null : auto;
  const [totalH, setTotalH] = useState(seed == null ? '' : String(Math.floor(seed / 60)));
  const [totalM, setTotalM] = useState(seed == null ? '' : String(seed % 60));
  const [totalTouched, setTotalTouched] = useState(defaultOverride !== '');
  // Untouched on a Normal shift ⇒ follow the live arithmetic as the operator edits the times and breaks.
  const shownH = totalTouched || hoursRequired ? totalH : String(Math.floor(auto / 60));
  const shownM = totalTouched || hoursRequired ? totalM : String(auto % 60);
  const totalMinutes =
    shownH === '' && shownM === '' ? null : Math.max(0, (Number(shownH) || 0) * 60 + (Number(shownM) || 0));
  // What actually POSTS into normalMinutesOverride: blank when it agrees with the computed figure on a
  // Normal shift (no override stored), the number otherwise.
  const postedOverride =
    totalMinutes == null || (!hoursRequired && totalMinutes === auto) ? '' : String(totalMinutes);

  const setTotal = (h: string, m: string) => {
    setTotalTouched(true);
    setTotalH(h);
    setTotalM(m);
  };

  const setBreak = (i: number, patch: Partial<BreakRow>) => setBreaks((prev) => prev.map((bp, j) => (j === i ? { ...bp, ...patch } : bp)));

  /** Ticking Flexible with nothing typed proposes the break the shift already deducts, so the box never
   *  starts at a figure that quietly differs from what the operator can see above it. */
  const toggleFlex = (on: boolean) => {
    setFlexOn(on);
    if (on && flexMin.trim() === '' && windowBreakSum > 0) setFlexMin(String(windowBreakSum));
    // r277 — one allowance for the whole shift and one per break are two answers to the same question, and
    // core/roster.ts refuses to store both. Clearing the per-row boxes here is what keeps that refusal
    // unreachable from the screen: the operator sees the rows lose their figures as the switch goes on.
    if (on) setBreaks((prev) => prev.map((bp) => (bp.flexibleMinutes ? { ...bp, flexibleMinutes: '' } : bp)));
  };

  return (
    <>
      {/* ── SECTION 2 · WORKING TIMES ─────────────────────────────────────────────────────────────── */}
      <Card className="space-y-4 p-4">
        <h2 className="text-sm font-semibold text-foreground">{t('workingTimesLegend')}</h2>

        {/* f3321963 — Shift Type. Normal + Semi-Flexi are selectable; Full-Flexi is reserved for a FUTURE
            enhancement (reporter-sanctioned), so its option stays disabled and the note below explains it.
            It leads Working Times because it is what decides how every time under it is read. */}
        <Field label={ta('shiftTypeLabel')}>
          <select
            name="shiftTemplateType"
            value={type}
            onChange={(e) => setType(e.target.value as ShiftFormType)}
            className={inputCls}
          >
            <option value="normal">{ta('shiftTypeNormal')}</option>
            <option value="semi_flexi">{ta('shiftTypeSemiFlexi')}</option>
            {/* r274 (439565ff) — ENABLED. The value was always accepted and stored (migration 0188,
                core/roster.ts validateShiftType); only this attribute kept it out of reach. */}
            <option value="full_flexi">{ta('shiftTypeFullFlexi')}</option>
          </select>
        </Field>

        {/* 1 + 2 — the SAME two stored columns either way; only the wording changes with the type.
            6340aecb fix — the Semi-Flexi wording used to be "Earliest time in" / "Latest time out", which
            after the point-8 rename sat in the SAME four-column row as early_in / late_out, now labelled
            "Shift Start Time" / "Shift Time Out" and defined by the hint below as the earliest and latest
            ACCEPTED CLOCKING. Two boxes on one line both claiming to be the earliest is how an operator
            types the early-in value into start_time — which is a scheduling column, so it would move the
            shift span, netScheduledMinutes and the OT window. The Semi-Flexi pair is named for what it
            actually is: the window the required hours may be worked within. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={semiFlexi ? t('semiFlexiWindowStart') : t('timeIn')}>
            <input
              name="startTime"
              type="time"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label={semiFlexi ? t('semiFlexiWindowEnd') : t('timeOut')}>
            <input
              name="endTime"
              type="time"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className={inputCls}
            />
          </Field>

          {/* 6340aecb — THE RELABELLED PAIR (request point 8). The COLUMNS are untouched: early_in and
              late_out are read across attendance and payroll, and a column rename buys nothing the label
              does not. Only the message VALUES changed, in all six locales. The hint below stays, and is
              type-aware, because these two names sit in the SAME row as the shift's own times — Time in /
              Time out on a Normal shift, the flexi window on a Semi Flexi one — and the difference between
              the two pairs is the whole point of the hint. */}
          <Field label={ta('shiftEarlyIn')}>
            <input name="earlyIn" type="time" defaultValue={defaultEarlyIn} className={inputCls} />
          </Field>
          <div>
            <Field label={ta('shiftLateOut')}>
              <input name="lateOut" type="time" defaultValue={defaultLateOut} className={inputCls} />
            </Field>
            <label className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                name="lateOutNextDay"
                defaultChecked={defaultLateOutNextDay}
                className="h-3.5 w-3.5 accent-primary"
              />
              {ta('shiftLateOutNextDay')}
            </label>
          </div>
        </div>
        {/* The hint NAMES the boxes above it, so it has to follow the same type switch they do: the Normal
            wording says "Time in and Time out", and on a Semi Flexi shift there is no box by either name. */}
        {/* Two STATIC ta(...) calls rather than one call on a computed key: the i18n guard in
            test/shift-form-sections.test.ts reads literal call sites, and a key it cannot see is a key it
            cannot check. */}
        <p className="text-xs text-muted-foreground">
          {semiFlexi ? ta('shiftClockWindowHintSemi') : ta('shiftClockWindowHint')}
        </p>

        {/* 3 — Total normal working hours. Hours + minutes on screen, MINUTES in the database. */}
        <div>
          <Field label={t('totalNormalWorkingHours')} required={hoursRequired} requiredAriaLabel={t('requiredField')}>
            <span className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={24}
                required={hoursRequired}
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
            {hoursRequired ? t('totalNormalHoursSemiHint') : t('totalNormalHoursNormalHint')}
          </p>
        </div>

        {/* 4 — THE HALF-DAY PAIR (request point 9). Both columns already existed; what they never had was a
            findable home. The first is a clock time on a Normal shift (stored half_day_first_out, which
            also OVERRIDES the company-wide half-day cut-off for this shift); DERIVED on Semi Flexi from
            half the required hours of WORK, so nothing is asked for and nothing is posted — which is what
            makes the server derive it. The second is recorded and validated against the first. */}
        <div className="grid gap-3 sm:grid-cols-2">
          {semiFlexi ? (
            <div>
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
            </div>
          ) : (
            <div>
              <Field label={t('halfDayCutoffLabel')}>
                <input name="halfDayFirstOut" type="time" defaultValue={defaultHalfDayFirstOut} className={inputCls} />
              </Field>
              <p className="mt-1 text-xs text-muted-foreground">{t('halfDayCutoffHint')}</p>
            </div>
          )}
          <div>
            <Field label={ta('shiftHalfDaySecondIn')}>
              <input name="halfDaySecondIn" type="time" defaultValue={defaultHalfDaySecondIn} className={inputCls} />
            </Field>
            <p className="mt-1 text-xs text-muted-foreground">{ta('shiftHalfDayPairHint')}</p>
          </div>
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

        {/* 6 — b8aa3466: the Mon–Sun row, seven dropdowns with four choices each. One <select> per weekday
            posting "full" | "half" | "rest" | "off", decoded server-side in shift-actions.ts into the three
            ISO-weekday arrays the service expects. It sits in Working Times because which days a shift is
            worked is a working time, not a general control. */}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-foreground">{ta('shiftWorkingDays')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {ISO_DAYS.map((d) => (
              <div key={d} className="flex flex-col items-center gap-1 rounded-lg border border-border px-2 py-1.5">
                <span className="text-xs font-medium text-foreground">{ta(DAY_KEY[d])}</span>
                <select
                  name={`dayKind_${d}`}
                  defaultValue={dayKinds[d] ?? 'rest'}
                  className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
                  aria-label={ta(DAY_KEY[d])}
                >
                  <option value="full">{t(DAY_KIND_KEY.full)}</option>
                  <option value="half">{t(DAY_KIND_KEY.half)}</option>
                  <option value="rest">{t(DAY_KIND_KEY.rest)}</option>
                  <option value="off">{t(DAY_KIND_KEY.off)}</option>
                </select>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('dayKindHint')}</p>
        </fieldset>
      </Card>

      {/* ── SECTION 3 · BREAKS ────────────────────────────────────────────────────────────────────── */}
      <Card className="space-y-4 p-4">
        <h2 className="text-sm font-semibold text-foreground">{t('breaksLabel')}</h2>

        <div>
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
                        // r277 — a paid break is not deducted at all, so an allowance beside it would be a
                        // number that moves nothing; ticking Paid clears it rather than leaving it to be
                        // refused on save.
                        onChange={(e) => setBreak(i, { paid: e.target.checked, ...(e.target.checked ? { flexibleMinutes: '' } : {}) })}
                        className="h-3.5 w-3.5 accent-primary"
                        aria-label={t('breakPaid')}
                      />
                      {t('breakPaid')}
                    </label>
                    {/* b8aa3466 — FIXED. Stored inverted as `flexible`, and only when the tick is OFF, so a
                        window saved before this release posts back byte-identically. Semi Flexi forces every
                        break flexible in core/roster.ts, so the tick is shown OFF and disabled there rather
                        than letting the screen promise something the service will overwrite.
                        6340aecb — the SHIFT-LEVEL flexible break does the same, and for the same reason: with
                        an allowance on, the engine never tests the clocking against any window, so a ticked
                        FIXED here would be a promise nothing keeps. core/roster.ts forces the stored flag to
                        match, so what the operator sees is what the row will hold. */}
                    <label
                      className={`inline-flex items-center gap-1 pb-2 text-xs text-muted-foreground ${semiFlexi || flexOn ? 'opacity-60' : 'cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        disabled={semiFlexi || flexOn}
                        checked={semiFlexi || flexOn ? false : bp.flexible !== true}
                        // r277 — going back to Fixed drops this row's allowance: a fixed window IS its own
                        // clock, so the two cannot both be true and core/roster.ts refuses the pair.
                        onChange={(e) => setBreak(i, { flexible: !e.target.checked, ...(e.target.checked ? { flexibleMinutes: '' } : {}) })}
                        className="h-3.5 w-3.5 accent-primary"
                        aria-label={t('breakFixed')}
                      />
                      {t('breakFixed')}
                    </label>
                    {/* ── r277 (439565ff) · THIS ROW'S OWN ALLOWANCE ────────────────────────────────
                        "A sixty-minute lunch and a fifteen-minute tea break can finally have different
                        allowances." Shown ONLY on a row that is Flexible and unpaid, and only while the
                        shift-level allowance is off — see rowTakesAllowance. BLANK IS NOT ZERO: an empty
                        box posts nothing and the row is deducted exactly as it is today. */}
                    {rowTakesAllowance(bp) && (
                      <Field label={t('breakRowMinutes')}>
                        <input
                          type="number"
                          min={1}
                          max={rowMinutes ?? undefined}
                          value={bp.flexibleMinutes ?? ''}
                          onChange={(e) => setBreak(i, { flexibleMinutes: e.target.value })}
                          className={`${inputCls} w-24`}
                          aria-label={t('breakRowMinutes')}
                        />
                      </Field>
                    )}
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
                    // r277 — and `flexibleMinutes` ONLY when the row is offered one AND a figure is typed,
                    // so a break row that predates this release still posts the exact shape it always did.
                    ...(rowAllowance(bp) != null ? { flexibleMinutes: rowAllowance(bp) } : {}),
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
            {/* The Fixed tick is DISABLED on a Semi Flexi shift and once the shift-level allowance is on, so
                the hint beside it must stop telling the operator to untick a control they cannot touch —
                and must say WHY it is decided for them. */}
            <span className="text-xs text-muted-foreground">
              {semiFlexi || flexOn ? t('breakFixedLockedHint') : t('breakFixedHint')}
              {/* r277 — said next to the boxes it is about, and only while any row is actually offered one. */}
              {breaks.some((bp) => rowTakesAllowance(bp)) ? ` ${t('breakRowMinutesHint')}` : ''}
            </span>
          </span>
        </div>

        {/* ── 6340aecb · THE FLEXIBLE BREAK (request points 11 + 12, migration 0457) ─────────────────
            NOT a cosmetic switch: with it on, the allowance is what comes off a day's clocking (and what
            the shift's scheduled hours are struck from), instead of the overlap between the punch and the
            windows above. The windows stay — the reporter's point 12 is that the allowance applies EVEN
            WHEN a Break Start / Break End is configured. Off is the default and off is byte-identical to
            every shift that exists today. */}
        <fieldset className="rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium text-foreground">{t('flexibleBreakLegend')}</legend>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
            <input
              type="checkbox"
              name="flexibleBreakEnabled"
              checked={flexOn}
              onChange={(e) => toggleFlex(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {t('flexibleBreakUse')}
          </label>
          {flexOn && (
            <span className="mt-2 block max-w-xs">
              <Field label={t('flexibleBreakMinutes')} required requiredAriaLabel={t('requiredField')}>
                <input
                  name="flexibleBreakMinutes"
                  type="number"
                  min={1}
                  max={1440}
                  required
                  value={flexMin}
                  onChange={(e) => setFlexMin(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </span>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">{t('flexibleBreakHint')}</p>
        </fieldset>

        {/* What the day will actually be worth, stated rather than left to be inferred from four boxes. */}
        <p className="text-xs text-muted-foreground">
          {semiFlexi
            ? t('breakDeductionSemiHint')
            : t('breakDeductionSummary', { deducted: hm(breakSum), net: hm(net) })}
        </p>
      </Card>
    </>
  );
}
