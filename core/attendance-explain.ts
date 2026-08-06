/**
 * 7c834696 POINT 3 — read one day's stored trace and turn it into the steps a panel renders.
 *
 * PURE, AND DELIBERATELY INCAPABLE OF RECOMPUTING — the same contract core/pcb-explain.ts states for
 * payslips, for the same reason. Everything here is read out of the trace or added up from figures that
 * came out of it. Nothing consults a shift, a roster or a rule. If this module could reach a rule it
 * could disagree with the number it claims to explain, and a panel that contradicts the figure beside it
 * is worse than no panel.
 *
 * NO PROSE, NO FORMATTING. Steps carry a `key` and numeric `args`; the caller renders them through
 * next-intl. Minute values stay MINUTES — the screen decides whether that is "1h 30m" or "90", and it
 * already has `fmtMin`/`fmtShort` for exactly that. A module that returned "1h 30m late" would be
 * monolingual in a six-locale product and would hard-code one screen's formatting into core/.
 */
import {
  isAttendanceTrace,
  type AttendanceTraceV1,
  type DeductionTrace,
} from './attendance-trace';

/** One line of working. `key` is an i18n key under `attendance.explain`; `args` are its placeholders. */
export type ExplainStep = { key: string; args?: Record<string, number | string | boolean> };

export type ExplainSection = {
  /** The figure this section explains, in minutes. Null ⇒ the concept does not apply to this day. */
  minutes: number | null;
  steps: ExplainStep[];
};

export type AttendanceExplanation =
  | {
      /**
       * No working was recorded — the row predates 7c834696 point 3, or nothing has re-derived it since,
       * or the trace is a version this build does not understand. The panel MUST say so; a silent empty
       * panel reads as "there was nothing to it", which is a different and false claim.
       */
      kind: 'unavailable';
      reason: 'no-trace' | 'unknown-version';
    }
  | {
      kind: 'explained';
      /** Context every section shares: which schedule was resolved, and the punches as recorded. */
      schedule: AttendanceTraceV1['schedule'];
      punch: AttendanceTraceV1['punch'];
      lateness: ExplainSection;
      earlyOut: ExplainSection;
      overtime: ExplainSection;
    };

/** Deduction working, shared by lateness and early-out — the two are mirror images. */
function deductionSteps(d: DeductionTrace | null, measured: number): ExplainStep[] {
  if (!d) return [];
  // "Your rule does not deduct" and "your rule deducts, and this day earned none" are different answers
  // to the same question, and every rule in the product ships with deductions OFF. Saying only "0" here
  // would answer the wrong one.
  if (!d.applies) return [{ key: 'deductionOff' }];
  if (d.everyMinutes == null || d.deductPerBlock == null || d.everyMinutes <= 0) {
    return [{ key: 'deductionUnset' }];
  }
  return [
    { key: 'deductionRule', args: { every: d.everyMinutes, deduct: d.deductPerBlock } },
    // Whole blocks only — 25 minutes under "every 15" is ONE block, not one and two-thirds. Showing the
    // division is what makes the floor visible instead of looking like an arithmetic error.
    { key: 'deductionBlocks', args: { measured, every: d.everyMinutes, blocks: d.blocks } },
    { key: 'deductionResult', args: { minutes: d.minutes } },
  ];
}

export function explainAttendanceDay(raw: unknown): AttendanceExplanation {
  if (raw == null) return { kind: 'unavailable', reason: 'no-trace' };
  if (!isAttendanceTrace(raw)) return { kind: 'unavailable', reason: 'unknown-version' };
  const t = raw;

  const lateness: ExplainSection = t.lateness
    ? {
        minutes: t.lateness.minutes,
        steps: [
          { key: 'lateStart', args: { at: t.lateness.startAbs } },
          { key: 'lateGrace', args: { grace: t.lateness.graceMinutes, threshold: t.lateness.thresholdAbs } },
          { key: 'lateArrived', args: { at: t.lateness.checkInAbs } },
          t.lateness.minutes === 0
            ? { key: 'lateNone' }
            : {
                // WHERE the count starts is the rule's own switch and changes the figure, so it is a step
                // rather than a footnote: from the scheduled start, or from the end of the grace window.
                key: t.lateness.includeGrace ? 'lateFromStart' : 'lateFromGraceEnd',
                args: { minutes: t.lateness.minutes },
              },
          ...deductionSteps(t.latenessDeduction, t.lateness.minutes),
        ],
      }
    : { minutes: null, steps: [{ key: 'lateNotApplicable' }] };

  const earlyOut: ExplainSection = t.earlyOut
    ? {
        minutes: t.earlyOut.minutes,
        steps: [
          { key: 'earlyEnd', args: { at: t.earlyOut.endAbs } },
          { key: 'earlyGrace', args: { grace: t.earlyOut.graceMinutes, threshold: t.earlyOut.thresholdAbs } },
          { key: 'earlyLeft', args: { at: t.earlyOut.checkOutAbs } },
          t.earlyOut.minutes === 0
            ? { key: 'earlyNone' }
            : {
                key: t.earlyOut.includeGrace ? 'earlyFromEnd' : 'earlyFromGraceStart',
                args: { minutes: t.earlyOut.minutes },
              },
          ...deductionSteps(t.earlyOutDeduction, t.earlyOut.minutes),
        ],
      }
    : { minutes: null, steps: [{ key: 'earlyNotApplicable' }] };

  const o = t.overtime;
  const overtime: ExplainSection = o
    ? {
        minutes: o.minutes,
        steps: [
          // The break is the step HR queries most often, and the two ways it can be reached are genuinely
          // different rules — a declared window that the clocking spanned, or the legacy 6-hour cliff.
          t.schedule.breakSpanned == null
            ? { key: 'otBreakCliff', args: { minutes: t.schedule.breakMinutes } }
            : { key: 'otBreakSpanned', args: { minutes: t.schedule.breakSpanned } },
          { key: 'otWorked', args: { span: t.punch.spanMinutes ?? 0, worked: t.punch.workedMinutes ?? 0 } },
          o.basis === 'nonWorkday'
            ? { key: 'otBasisNonWorkday', args: { minutes: o.rawMinutes } }
            : o.basis === 'window'
              ? { key: 'otBasisWindow', args: { end: t.schedule.endAbs ?? 0, minutes: o.rawMinutes } }
              : {
                  key: o.normalIsOverride ? 'otBasisOverride' : 'otBasisDuration',
                  args: { normal: o.normalMinutes ?? 0, minutes: o.rawMinutes },
                },
          // Only worth a line when there ARE early minutes; otherwise it is noise on every ordinary day.
          ...(o.earlyMinutes > 0
            ? [{ key: o.earlyIncluded ? 'otEarlyIncluded' : 'otEarlyExcluded', args: { minutes: o.earlyMinutes } }]
            : []),
          ...(o.shiftRule
            ? !o.shiftRule.eligible
              ? [{ key: 'otShiftIneligible' }]
              : [
                  ...(o.shiftRule.minMinutes != null
                    ? [{ key: 'otShiftMinimum', args: { min: o.shiftRule.minMinutes, minutes: o.shiftRule.minutesAfter } }]
                    : []),
                  ...(o.shiftRule.dailyCapMinutes != null
                    ? [{ key: 'otShiftCap', args: { cap: o.shiftRule.dailyCapMinutes, minutes: o.shiftRule.minutesAfter } }]
                    : []),
                ]
            : []),
          // Only when rounding MOVED the figure. A rule with no rounding configured is byte-identical to
          // no rule, and claiming a step ran would be a small lie on an audit panel.
          ...(o.rounding?.applied
            ? [{ key: 'otRounded', args: { from: o.rounding.beforeMinutes, to: o.rounding.afterMinutes } }]
            : []),
          { key: 'otResult', args: { minutes: o.minutes } },
          // The split always sums back to `minutes` (core/attendance-calc.ts guarantees it), so the panel
          // can show the columns without a reconciling line that would only ever read "0 unaccounted".
          ...Object.entries(o.split)
            .filter(([, v]) => v > 0)
            .map(([bucket, v]) => ({ key: 'otBucket', args: { bucket, minutes: v as number } })),
        ],
      }
    : { minutes: null, steps: [{ key: 'otNotApplicable' }] };

  return { kind: 'explained', schedule: t.schedule, punch: t.punch, lateness, earlyOut, overtime };
}
