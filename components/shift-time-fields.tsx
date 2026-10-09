'use client';

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { SectionCard } from '@/components/ui/section-card';
import { StackedBody, StackedHead, StackedRow, StackedTable, StackedTd, StackedTh } from '@/components/ui/stacked-table';
import { StatusWord } from '@/components/ui/status-word';
// r429 (f6819e19) — THE ONE PLACE A BREAK ROW IS CHECKED, shared with core/roster.ts (the leaf module has
// no imports, which is what makes it importable from this client island at all — the same reason
// core/week-pattern.ts could be before it).
import { breakRowIssues, breakRowMinutes, type BreakRowIssue } from '@/core/shift-break-rules';

// cf21e554 stage 1 — `paid` is the reference Break tab's "Paid?" tick. Optional, and ABSENT MEANS UNPAID,
// so a shift saved before this release round-trips byte-identically (see BreakPeriod in db/schema.ts).
//
// r429 (f6819e19) · D4 — `flexible` is now the ONE way to make a break flexible (the whole-shift switch and
// the inverted "Fixed" tick are both gone from this screen). Ticking it opens `flexibleMinutes`, prefilled
// with the row's own length; blank keeps meaning "deducted exactly as today" (BreakPeriod in db/schema.ts).
type BreakRow = { start: string; end: string; paid?: boolean; flexible?: boolean; flexibleMinutes?: string };

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
/** minutes → a clock time on the shift's own day, for the derived Semi-Flexi half-day readout. */
const clock = (mins: number) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

export type ShiftFormType = 'normal' | 'semi_flexi' | 'full_flexi';

/**
 * r429 (f6819e19) — THE SHIFT PAGE, REDESIGNED: Working Time and Breaks, as their own numbered r427
 * sections (components/ui/section-card.tsx). Shift Information (name, label, colour, the read-only
 * Schedule Group line) is app/admin/attendance/shift-form.tsx's own server-rendered section; the closed
 * "Overtime and pay" panel is there too. This island owns Working Time and Breaks because the shift type
 * decides which boxes Working Time asks for and the break rows feed the live normal-hours readout, so the
 * two sections share state.
 *
 * GONE FROM THIS SCREEN (D1/D2/D4 of the approved plan): the Mon–Sun working-day row (now set on the
 * Schedule Group's own page), the Schedule Group picker (ditto — changed from "Shifts allowed" there), the
 * whole-shift Flexible switch and the inverted "Fixed" tick (replaced by ONE "Flexible" tick per row). NONE
 * of the four is rendered by this file any more, and none of the four is posted by
 * app/admin/attendance/shift-actions.ts — core/roster.ts preserves whatever was already stored.
 *
 * THE ONE SURVIVOR: a shift migration 0519 could not convert onto its break rows exactly keeps deducting
 * its whole-shift allowance until the operator explicitly ticks "Stop using it" (`flexLocked` below) —
 * never silently, and never offered as a way to turn the switch back ON.
 */
export function ShiftTimeFields({
  defaultType = 'normal',
  defaultStart = '09:00',
  defaultEnd = '18:00',
  defaultBreaks,
  isScalarOnlySource = false,
  defaultBreakMinutesScalar = '0',
  defaultOverride = '',
  defaultRounding = '',
  defaultHalfDayFirstOut = '',
  defaultHalfDaySecondIn = '',
  defaultEarlyIn = '',
  defaultLateOut = '',
  defaultLateOutNextDay = false,
  defaultDailyCutoffEnabled = false,
  defaultDailyCutoffTime = '',
  flexLocked = false,
  lockedAllowanceMinutes = 0,
  lockedBreakPeriodsJson = '[]',
}: {
  /** b8aa3466 — the shift template type, now client state because it drives the field set. */
  defaultType?: ShiftFormType;
  defaultStart?: string;
  defaultEnd?: string;
  /** Seeds the break-row table. ALWAYS at least one row — a blank one when the shift has none, so the
   *  table is never empty (the plan's "a new shift opens with a blank Break 1 row"). */
  defaultBreaks: BreakRow[];
  /** r429 (f6819e19) · D5 — true for a shift whose STORED shape is scalar-only (break_minutes > 0, no
   *  break_periods rows). Shows the labelled scalar box under the table until a real row is typed. */
  isScalarOnlySource?: boolean;
  /** The stored break_minutes scalar, for the D5 box above and as the posted value while it is shown. */
  defaultBreakMinutesScalar?: string;
  /** Edit form: seed the stored normal-minutes figure (empty ⇒ none stored). */
  defaultOverride?: string;
  /** cf21e554 — the shift's Normal-Hours Rounding, so the live readout shows the SAME figure the engine
   *  will use (netScheduledMinutes rounds the net figure DOWN to a multiple of this). */
  defaultRounding?: string;
  /** b8aa3466 — the half-day cut-off (stored half_day_first_out). Normal only; Semi Flexi derives it. */
  defaultHalfDayFirstOut?: string;
  defaultHalfDaySecondIn?: string;
  /** 6340aecb — the relabelled pair (stored early_in / late_out). */
  defaultEarlyIn?: string;
  defaultLateOut?: string;
  defaultLateOutNextDay?: boolean;
  /** b8aa3466 — the daily cut-off pair (migration 0429). */
  defaultDailyCutoffEnabled?: boolean;
  defaultDailyCutoffTime?: string;
  /** r429 (f6819e19) · D4 — this shift's whole-shift Flexible break could not be converted by migration
   *  0519 and is still ON. The Breaks section shows ONLY the "Stop using it" panel until the operator
   *  opts out, at which point it behaves like any other shift. */
  flexLocked?: boolean;
  lockedAllowanceMinutes?: number;
  /** The shift's CURRENT break_periods, unchanged, resent while `flexLocked` so an edit to an unrelated
   *  field can never silently wipe them (there is no row editor on screen to repost them). */
  lockedBreakPeriodsJson?: string;
}) {
  const t = useTranslations('roster');
  const ta = useTranslations('admin.attendancePolicy');
  const [type, setType] = useState<ShiftFormType>(defaultType);
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [breaks, setBreaks] = useState<BreakRow[]>(defaultBreaks);
  const [breakMinutesScalar, setBreakMinutesScalar] = useState(defaultBreakMinutesScalar);
  const [cutoffOn, setCutoffOn] = useState(defaultDailyCutoffEnabled);
  const [cutoffAt, setCutoffAt] = useState(defaultDailyCutoffTime || '02:00');
  // r429 — once ticked, the locked panel is gone for the rest of this visit and the ordinary Breaks UI
  // takes over (seeded from `defaultBreaks`, which for a scalar-only/locked shift is the single blank row).
  const [stoppedFlex, setStoppedFlex] = useState(false);
  const showLockedPanel = flexLocked && !stoppedFlex;

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

  // end ≤ start ⇒ crosses midnight (mirrors shiftCrossesMidnight; times are HH:MM, lexicographic = chronological)
  const crosses = !!start && !!end && end <= start;
  const span = start && end ? (crosses ? toMin(end) + 1440 - toMin(start) : toMin(end) - toMin(start)) : 0;
  const shiftShape = { startTime: start || '00:00', endTime: end || '00:00', crossesMidnight: crosses };

  /** A row counts as "real" once either time is typed — the table's one blank row does not. */
  const hasRealRows = breaks.some((bp) => bp.start || bp.end);
  const showScalarBox = !showLockedPanel && isScalarOnlySource && !hasRealRows;

  // r429 (f6819e19) · D6 — every row's own problem, keyed by its position in `breaks` (the SAME array the
  // service sees, so "Break 2" here is "Break 2" in a refusal too). Blank rows and rows with no issue are
  // simply absent from the map.
  const issues = breakRowIssues(
    breaks.map((bp) => ({
      start: bp.start,
      end: bp.end,
      paid: bp.paid,
      flexible: bp.flexible,
      flexibleMinutes: bp.flexibleMinutes != null && bp.flexibleMinutes.trim() !== '' ? Number(bp.flexibleMinutes) : null,
    })),
    shiftShape,
  );
  const issueCount = issues.size;

  const issueText = (i: number, issue: BreakRowIssue): string => {
    switch (issue.code) {
      case 'half':
        return issue.missing === 'end' ? t('breakRowHalfMissingEnd', { n: i + 1 }) : t('breakRowHalfMissingStart', { n: i + 1 });
      case 'zero':
        return t('breakRowZero', { n: i + 1 });
      case 'reversed':
        return t('breakRowReversed', { n: i + 1 });
      case 'outside':
        return t('breakRowOutside', { n: i + 1, shiftStart: shiftShape.startTime.slice(0, 5), shiftEnd: shiftShape.endTime.slice(0, 5) });
      case 'overlap':
        return t('breakRowOverlap', { n: i + 1, other: issue.otherIndex + 1, otherStart: issue.otherStart.slice(0, 5), otherEnd: issue.otherEnd.slice(0, 5) });
      case 'flexibleMinutesRequired':
        return t('breakRowFlexibleRequired', { n: i + 1 });
      case 'flexibleMinutesRange':
        return t('breakRowFlexibleRange', { n: i + 1, max: issue.max });
    }
  };

  /** Only rows with NO issue, and whose own window is known, contribute a real duration to the preview. */
  const rowDuration = (bp: BreakRow): number | null => {
    if (!bp.start || !bp.end) return null;
    const check = breakRowIssues([{ start: bp.start, end: bp.end }], shiftShape);
    if (check.size > 0) return null;
    return breakRowMinutes(bp.start, bp.end);
  };
  const rowAllowance = (bp: BreakRow): number | null => {
    if (bp.paid || bp.flexible !== true) return null;
    const raw = (bp.flexibleMinutes ?? '').trim();
    const n = Math.trunc(Number(raw));
    return raw !== '' && Number.isFinite(n) && n > 0 ? n : null;
  };
  // Only the UNPAID windows come off, exactly as core/roster.ts persists break_minutes. A row with an
  // allowance contributes the allowance; any other unpaid row contributes its own (issue-free) duration.
  const windowBreakSum = showScalarBox
    ? Number(breakMinutesScalar) || 0
    : breaks
        .filter((bp) => !bp.paid)
        .reduce((acc, bp) => acc + (rowAllowance(bp) ?? rowDuration(bp) ?? 0), 0);
  const breakSum = showLockedPanel ? lockedAllowanceMinutes : windowBreakSum;
  const roundTo = Number(defaultRounding) || 0;
  const net = Math.max(0, span - breakSum);
  const auto = roundTo > 0 ? Math.floor(net / roundTo) * roundTo : net;

  // ── b8aa3466 item 4 · TOTAL NORMAL WORKING HOURS ────────────────────────────────────────────────────
  const seed = defaultOverride !== '' ? Number(defaultOverride) : hoursRequired ? null : auto;
  const [totalH, setTotalH] = useState(seed == null ? '' : String(Math.floor(seed / 60)));
  const [totalM, setTotalM] = useState(seed == null ? '' : String(seed % 60));
  const [totalTouched, setTotalTouched] = useState(defaultOverride !== '');
  const shownH = totalTouched || hoursRequired ? totalH : String(Math.floor(auto / 60));
  const shownM = totalTouched || hoursRequired ? totalM : String(auto % 60);
  const totalMinutes =
    shownH === '' && shownM === '' ? null : Math.max(0, (Number(shownH) || 0) * 60 + (Number(shownM) || 0));
  const postedOverride =
    totalMinutes == null || (!hoursRequired && totalMinutes === auto) ? '' : String(totalMinutes);

  const setTotal = (h: string, m: string) => {
    setTotalTouched(true);
    setTotalH(h);
    setTotalM(m);
  };

  const setBreak = (i: number, patch: Partial<BreakRow>) => setBreaks((prev) => prev.map((bp, j) => (j === i ? { ...bp, ...patch } : bp)));

  /** Ticking Flexible with nothing typed proposes this row's own length, so the box never starts at a
   *  figure that quietly differs from the duration shown beside it. */
  const toggleFlexible = (i: number, on: boolean) => {
    setBreak(i, {
      flexible: on,
      flexibleMinutes: on ? (breaks[i].flexibleMinutes ?? (rowDuration(breaks[i]) != null ? String(rowDuration(breaks[i])) : '')) : '',
    });
  };

  return (
    <>
      {/* ── SECTION 2 · WORKING TIME ───────────────────────────────────────────────────────────────── */}
      <SectionCard index={2} title={t('workingTimeLegend')}>
        {/* f3321963 — Shift Type. Normal + Semi-Flexi are selectable; Full-Flexi is reserved for a FUTURE
            enhancement (reporter-sanctioned), so its option stays disabled and the note below explains it. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={ta('shiftTypeLabel')}>
            <select
              name="shiftTemplateType"
              value={type}
              onChange={(e) => setType(e.target.value as ShiftFormType)}
              className={inputCls}
            >
              <option value="normal">{ta('shiftTypeNormal')}</option>
              <option value="semi_flexi">{ta('shiftTypeSemiFlexi')}</option>
              <option value="full_flexi">{ta('shiftTypeFullFlexi')}</option>
            </select>
          </Field>
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
          {/* r429 (f6819e19) — CROSS MIDNIGHT is shown, never posted: core/roster.ts derives it from
              start/end on every save (shiftCrossesMidnight), so a control that could disagree with the
              times is not offered — this one only ever reports what they already say. */}
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">{ta('crossMidnightLabel')}</span>
            <label className="inline-flex cursor-not-allowed items-center gap-1.5 text-sm text-muted-foreground">
              <input type="checkbox" checked={crosses} disabled readOnly className="h-3.5 w-3.5 accent-primary" />
              {crosses ? ta('crossMidnightAutoYes') : ta('crossMidnightAutoNo')}
            </label>
          </div>
        </div>

        {/* 3 — Total normal working hours, rounding, and the half-day pair, ONE row (the mockup's layout). */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            <input type="hidden" name="normalMinutesOverride" value={postedOverride} />
          </div>
          <Field label={ta('shiftNormalHoursRounding')}>
            <input
              name="normalHoursRoundingMinutes"
              type="number"
              min={0}
              max={1440}
              defaultValue={defaultRounding}
              className={inputCls}
            />
          </Field>
          {semiFlexi ? (
            <div className="lg:col-span-2">
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
            <Field label={t('halfDayCutoffLabel')}>
              <input name="halfDayFirstOut" type="time" defaultValue={defaultHalfDayFirstOut} className={inputCls} />
            </Field>
          )}
          <Field label={ta('shiftHalfDaySecondIn')}>
            <input name="halfDaySecondIn" type="time" defaultValue={defaultHalfDaySecondIn} className={inputCls} />
          </Field>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {hoursRequired ? t('totalNormalHoursSemiHint') : t('totalNormalHoursNormalHint')}
        </p>

        {/* 5 — CLOCKING WINDOW AND DAY CUT-OFF, grouped together because neither is a scheduling column
            (request point 8 / b8aa3466 item 7): the earliest/latest ACCEPTED clocking, and the boundary
            that decides which calendar day a punch belongs to. */}
        <div className="mt-5 border-t border-border pt-4">
          <span className="mb-2 block text-sm font-semibold text-foreground">{ta('clockingWindowCutoffLegend')}</span>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            </div>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{ta('clockingWindowCutoffNote')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('dailyCutoffHint')}</p>
        </div>
      </SectionCard>

      {/* ── SECTION 3 · BREAKS ────────────────────────────────────────────────────────────────────── */}
      <SectionCard
        index={3}
        title={t('breaksLabel')}
        aside={!showLockedPanel && !showScalarBox ? t('breakDurationAside') : undefined}
      >
        {/* r429 (f6819e19) — THE MARKER, OUTSIDE the conditional panel. Ticking "Stop using it" below
            flips `stoppedFlex`, which immediately swaps the locked panel for the ordinary Breaks editor —
            the checkbox itself is gone from the DOM the instant that happens, so what the form actually
            POSTS has to live somewhere that survives the swap. Absent (every shift, and a locked shift
            not yet opted out) ⇒ undefined ⇒ core/roster.ts preserves the stored switch. */}
        {stoppedFlex && <input type="hidden" name="stopFlexibleBreak" value="1" />}
        {showLockedPanel ? (
          // r429 (f6819e19) — THE "STOP USING IT" PANEL. This shift's whole-shift Flexible break could not
          // be converted exactly by migration 0519 (its break rows do not add up the same way, or it has
          // none). It keeps deducting its allowance — byte-identically to today — until this box is ticked
          // and the form saved; nothing here can turn the switch back ON.
          <div className={`space-y-3`}>
            <p className="text-sm text-foreground">{t('breakStopUsingAllowance', { minutes: lockedAllowanceMinutes })}</p>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
              <input
                type="checkbox"
                name="stopFlexibleBreak"
                checked={stoppedFlex}
                onChange={(e) => setStoppedFlex(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              {t('breakStopUsingTick')}
            </label>
            <p className="text-xs text-muted-foreground">{t('breakStopUsingHint')}</p>
            {/* Resent UNCHANGED so an edit to an unrelated field on this form can never silently clear
                them — there is no row editor on screen while this panel shows. */}
            <input type="hidden" name="breakMinutes" value={defaultBreakMinutesScalar} />
            <input type="hidden" name="breakPeriods" value={lockedBreakPeriodsJson} />
          </div>
        ) : (
          <>
            {issueCount > 0 && (
              <div
                role="alert"
                className="mb-3 border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive monolith:border-signal monolith:bg-transparent monolith:text-signal-text"
              >
                {t('breaksNeedFixing', { count: issueCount })}
              </div>
            )}
            <StackedTable label={t('breaksLabel')}>
              <StackedHead>
                <StackedTh>{t('breakSeqLabel')}</StackedTh>
                <StackedTh>{t('breakStart')}</StackedTh>
                <StackedTh>{t('breakEnd')}</StackedTh>
                <StackedTh>{t('breakDurationLabel')}</StackedTh>
                <StackedTh>{t('breakFlexibleLabel')}</StackedTh>
                <StackedTh>{t('breakPaid')}</StackedTh>
                <StackedTh>{t('breakActionLabel')}</StackedTh>
              </StackedHead>
              <StackedBody>
                {breaks.map((bp, i) => {
                  const duration = rowDuration(bp);
                  const issue = issues.get(i);
                  const flexOn = bp.flexible === true;
                  return (
                    <Fragment key={i}>
                    <StackedRow>
                      <StackedTd label={t('breakSeqLabel')} role="title">
                        {t('breakSeqValue', { n: i + 1 })}
                      </StackedTd>
                      <StackedTd label={t('breakStart')}>
                        <input
                          type="time"
                          value={bp.start}
                          onChange={(e) => setBreak(i, { start: e.target.value })}
                          className={inputCls}
                          aria-label={`${t('breakStart')} ${i + 1}`}
                        />
                      </StackedTd>
                      <StackedTd label={t('breakEnd')}>
                        <input
                          type="time"
                          value={bp.end}
                          onChange={(e) => setBreak(i, { end: e.target.value })}
                          className={inputCls}
                          aria-label={`${t('breakEnd')} ${i + 1}`}
                        />
                      </StackedTd>
                      <StackedTd label={t('breakDurationLabel')} className="tabular-nums">
                        {duration == null ? '—' : `${duration} min`}
                      </StackedTd>
                      <StackedTd label={t('breakFlexibleLabel')}>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={flexOn}
                              disabled={semiFlexi}
                              onChange={(e) => toggleFlexible(i, e.target.checked)}
                              className="h-3.5 w-3.5 accent-primary"
                              aria-label={t('breakFlexibleLabel')}
                            />
                            {flexOn || semiFlexi ? t('breakFlexibleYes') : t('breakFlexibleNo')}
                          </label>
                          {(flexOn || semiFlexi) && !bp.paid && (
                            <input
                              type="number"
                              min={1}
                              max={duration ?? undefined}
                              value={bp.flexibleMinutes ?? ''}
                              onChange={(e) => setBreak(i, { flexibleMinutes: e.target.value })}
                              className={`${inputCls} w-20`}
                              aria-label={t('breakRowMinutes')}
                            />
                          )}
                        </span>
                      </StackedTd>
                      <StackedTd label={t('breakPaid')}>
                        <input
                          type="checkbox"
                          checked={bp.paid ?? false}
                          onChange={(e) => setBreak(i, { paid: e.target.checked, ...(e.target.checked ? { flexible: false, flexibleMinutes: '' } : {}) })}
                          className="h-3.5 w-3.5 accent-primary"
                          aria-label={t('breakPaid')}
                        />
                      </StackedTd>
                      <StackedTd label={t('breakActionLabel')} role="aside" hideLabel>
                        <button
                          type="button"
                          onClick={() => setBreaks((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [{ start: '', end: '' }]))}
                          className="text-rose-600 hover:text-rose-700 dark:text-rose-400 monolith:underline"
                          aria-label={t('removeBreak')}
                        >
                          {t('removeBreak')}
                        </button>
                      </StackedTd>
                    </StackedRow>
                    {issue && (
                      <StackedRow className="@max-3xl:pt-0">
                        <StackedTd label="" role="full" hideLabel colSpan={7} className="pt-0 @max-3xl:pt-0">
                          <StatusWord tone="signal" className="text-xs text-destructive">
                            {issueText(i, issue)}
                          </StatusWord>
                        </StackedTd>
                      </StackedRow>
                    )}
                    </Fragment>
                  );
                })}
              </StackedBody>
            </StackedTable>
            <button
              type="button"
              onClick={() => setBreaks((prev) => [...prev, { start: '', end: '' }])}
              className="mt-3 rounded-md border border-border px-2.5 py-1 text-sm text-foreground hover:bg-muted monolith:rounded-none"
            >
              {t('addBreak')}
            </button>

            {showScalarBox && (
              <div className="mt-4 max-w-xs border-t border-border pt-4">
                <Field label={t('breakScalarOnlyLabel')}>
                  <input
                    name="breakMinutes"
                    type="number"
                    min={0}
                    value={breakMinutesScalar}
                    onChange={(e) => setBreakMinutesScalar(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('breakScalarOnlyHint', { minutes: Number(breakMinutesScalar) || 0 })}
                </p>
              </div>
            )}

            {/* Every NON-blank row posts — the hidden JSON field the service reads. Blank rows (both times
                empty) are included too (the server drops them before any index reaches a refusal; see
                app/admin/attendance/shift-actions.ts parseBreakPeriods / core/roster.ts). */}
            {!showScalarBox && (
              <input
                type="hidden"
                name="breakPeriods"
                value={JSON.stringify(
                  breaks.map((bp) => ({
                    start: bp.start,
                    end: bp.end,
                    ...(bp.paid ? { paid: true } : {}),
                    ...(bp.flexible || semiFlexi ? { flexible: true } : {}),
                    ...(rowAllowance(bp) != null && !bp.paid ? { flexibleMinutes: rowAllowance(bp) } : {}),
                  })),
                )}
              />
            )}

            <p className="mt-3 text-xs text-muted-foreground">
              {semiFlexi ? t('breakDeductionSemiHint') : t('breakDeductionSummary', { deducted: hm(breakSum), net: hm(net) })}
            </p>
            <p className="text-xs text-muted-foreground">{t('breakRowNeedsFixingNote')}</p>
          </>
        )}
      </SectionCard>
    </>
  );
}
