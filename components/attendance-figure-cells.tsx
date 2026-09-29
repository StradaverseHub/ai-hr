'use client';

import { useCallback, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { AttendanceExplanation, ExplainStep } from '@/core/attendance-explain';
// r365 cbfa8b0b — THE POSITIONING LEFT THIS FILE AND CAME BACK AS AN IMPORT. The `position: fixed` rect
// maths, the flip-up rule, the capture-phase scroll/resize re-place and Escape were all written here
// first; they now live in components/ui/anchored-panel.tsx so the Leave Credit request row can open the
// same panel without a second copy. Nothing about this file's behaviour changed — which is exactly what
// test/r365-anchored-panel.dom.test.tsx drives through this caller to prove.
import { AnchoredPanel, useAnchoredPanel } from '@/components/ui/anchored-panel';
/**
 * NO IMPORT FROM core/attendance-derive, DELIBERATELY, and the alternatives are both worse.
 *
 * That module is a declared pack BOUNDARY (test/attendance-pack-drift.test.ts). The facade that
 * re-exports it, packs/attendance/service.ts, says of itself: "Server-only in practice (drags in
 * db/client) — never import from client components". The client-safe entry, packs/attendance/index.ts,
 * does not export this type. And the ratchet's own message is "The allowlist only ever shrinks; do not
 * add entries" — so allowlisting a NEW file would grow the debt this guard exists to shrink.
 *
 * A client island has no business depending on the engine's types anyway: it receives numbers. So the
 * six buckets are declared here as the prop shape they are. test/attendance-explain-panel.test.ts holds
 * a TYPE-LEVEL assertion that this stays assignable to the real OtByRate — tests are never scanned by
 * the ratchet, so the check lives where it is allowed to and a divergence fails tsc, not just one file.
 */
type OtByRate = { flat: number; ot00: number; ot10: number; ot15: number; ot20: number; ot30: number };
import { fmtClock, fmtHours2, fmtShort } from './attendance-format';

/**
 * 7c834696 POINT 3 — the per-figure calculation breakdown on Attendance > Records.
 *
 * The reporter's ask: "Every lateness, early out and overtime figure gains a hover that shows how it was
 * arrived at: the shift times used, the break deducted, the raw clock in and out, the rule that applied,
 * the step-by-step working, the rounding, and the final result."
 *
 * ── WHY THIS IS A CLIENT ISLAND, AND WHY IT TAKES THE WHOLE ROW ─────────────────────────────────────
 * app/attendance/daily and app/attendance/individual are SERVER components and must stay that way: they
 * do the scoped reads. A hover needs state, so it has to be a client island — and the only thing that
 * may cross that boundary is SERIALISABLE DATA. r123 shipped a server page that handed a client component
 * two closures over the server's translator; React cannot serialise a function, so the page threw at
 * render and returned "This page couldn't load" while tsc, `next build` and the whole suite stayed green.
 * test/server-client-boundary.test.ts now scans for that shape. Every prop below is a number, a string, a
 * boolean or a plain object of those.
 *
 * It renders EIGHT `<td>`s rather than being dropped inside one, for a reason that is about payload, not
 * tidiness: the eight explainable figures on a row share ONE explanation. A per-cell island would ship
 * the same trace eight times per row, forty times a screen. A React fragment of `<td>`s is legal inside
 * `<tr>`, so one island per row costs one copy.
 *
 * ── WHY IT RENDERS `{key, args}` AND NOT SENTENCES ──────────────────────────────────────────────────
 * core/attendance-explain.ts is forbidden to produce prose (the trace is stored in six-locale product and
 * a trace of English strings would be unfixable without a backfill that cannot exist). It returns steps
 * with a `key` under `attendance.explain` and numeric `args`; this file formats the numbers and renders
 * the sentence through next-intl. The step keys are dynamic, so test/attendance-explain-panel.test.ts
 * asserts every key the reader can emit exists in all six catalogs — the i18n coverage guard only sees
 * literal keys.
 *
 * ── A ROW WITH NO TRACE SAYS SO ─────────────────────────────────────────────────────────────────────
 * Almost every attendance row in production has no trace: migration 0411 does not backfill and explains
 * why it never can. `kind:'unavailable'` therefore renders a sentence, not an empty panel — an empty
 * panel reads as "there was nothing to it", which is a different and false claim.
 */

type Section = 'lateness' | 'earlyOut' | 'overtime';

/** Which quantity an `args` entry is, so it reaches the reader in the right units. Everything not named
 *  here is MINUTES OF DURATION: that default is deliberate, because a new duration arg added to
 *  core/attendance-explain.ts should format correctly without a matching edit here, while a new INSTANT
 *  would print obviously wrong ("24h 30m" where "00:30 (+1)" belongs) and be caught immediately. */
const CLOCK_ARGS = new Set(['at', 'threshold', 'end']);
/** Plain counts — not minutes of anything. cf21e554 adds `count` (how many overtime windows the shift
 *  declares); without it the default would print "2 windows" as "2m". */
const COUNT_ARGS = new Set(['blocks', 'count']);

/** The six OT buckets to the column headings already on screen, so the panel and the columns cannot use
 *  different names for the same money. */
const BUCKET_KEY: Record<string, string> = {
  flat: 'colOtFlat',
  ot00: 'colOt00',
  ot10: 'colOt10',
  ot15: 'colOt15',
  ot20: 'colOt20',
  ot30: 'colOt30',
};

const CELL = 'px-3 py-2.5 text-right tabular-nums text-muted-foreground';
/** The affordance: a dotted underline and a help cursor say "there is working behind this number". */
const TRIGGER =
  'cursor-help rounded-sm underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 ' +
  'tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';

export type AttendanceFigureCellsProps = {
  /** Minutes, exactly as the columns beside them already receive. Null renders an em dash, never "0m". */
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  ot: OtByRate;
  /** False ⇒ no attendance row for this day at all. Nothing was computed, so there is nothing to explain
   *  and the six OT columns keep their em dash; the Status column already says why the day is empty. */
  hasRow: boolean;
  /** The stored working, read and validated on the server by core/attendance-explain.ts. Plain data. */
  explanation: AttendanceExplanation;
};

export function AttendanceFigureCells({
  lateMinutes,
  earlyOutMinutes,
  ot,
  hasRow,
  explanation,
}: AttendanceFigureCellsProps) {
  const t = useTranslations('attendance');
  const te = useTranslations('attendance.explain');
  const panelId = useId();
  // The open CELL, not the open section: all six OT columns explain the same section, so keying the panel
  // on the section alone would open six identical panels at once, stacked on one another.
  const [open, setOpen] = useState<{ cell: string; section: Section } | null>(null);

  /**
   * ⚠️ r365 — `place`, `at`, `anchor` AND THE SCROLL/RESIZE/ESCAPE EFFECT STOOD HERE, and the comment that
   * stood with them is now the header of components/ui/anchored-panel.tsx: `position: fixed` from the
   * trigger's own rect rather than `absolute`, because this table sits inside `overflow-x-auto` and a CSS
   * box that sets one overflow axis computes the other to `auto` too, so an absolute panel is clipped by
   * the scroller it is trying to escape. Every number is unchanged (360 wide, flip above 340, 6px gap),
   * and the listeners are still capture-phase for the same reason.
   */
  const hide = useCallback(() => {
    setOpen(null);
  }, []);
  const { at, anchorTo, release } = useAnchoredPanel({ open: open != null, onClose: hide });

  const show = (cell: string, section: Section) => (e: React.SyntheticEvent<HTMLElement>) => {
    anchorTo(e.currentTarget);
    setOpen({ cell, section });
  };
  const dismiss = () => {
    release();
    hide();
  };

  /** One step, rendered through next-intl with its numbers turned into the units a human reads. */
  const line = (step: ExplainStep) => {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.args ?? {})) {
      if (k === 'bucket') values[k] = t(BUCKET_KEY[String(v)] ?? 'colOvertime');
      else if (typeof v !== 'number') values[k] = String(v);
      else if (CLOCK_ARGS.has(k)) values[k] = fmtClock(v);
      else if (COUNT_ARGS.has(k)) values[k] = String(v);
      else values[k] = fmtShort(v);
    }
    return te(step.key, values);
  };

  /** Label / value pair in the context block. */
  const fact = (label: string, value: string) => (
    <div key={label} className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );

  const panel = (section: Section) => {
    const heading =
      section === 'lateness'
        ? te('headingLateness')
        : section === 'earlyOut'
          ? te('headingEarlyOut')
          : te('headingOvertime');

    if (explanation.kind === 'unavailable') {
      return (
        <>
          <p className="text-sm font-semibold text-foreground">{heading}</p>
          <p className="mt-2 text-sm font-medium text-foreground">{te('unavailable')}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {explanation.reason === 'unknown-version' ? te('unknownVersion') : te('unavailableWhy')}
          </p>
        </>
      );
    }

    const { schedule, punch } = explanation;
    const s = explanation[section];
    return (
      <>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">{heading}</p>
          <span className="text-sm font-semibold tabular-nums text-foreground">{fmtShort(s.minutes)}</span>
        </div>

        <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {te('contextHeading')}
        </p>
        <dl className="mt-1 space-y-1 text-xs">
          {fact(te('sourceLabel'), te(`source.${schedule.source}`))}
          {fact(te('dayTypeLabel'), te(`dayType.${schedule.dayType}`))}
          {fact(
            te('shiftWindow'),
            schedule.startAbs == null || schedule.endAbs == null
              ? te('shiftWindowNone')
              : `${fmtClock(schedule.startAbs)} – ${fmtClock(schedule.endAbs)}`,
          )}
          {fact(te('scheduledHours'), fmtShort(schedule.scheduledMinutes))}
          {schedule.normalMinutesOverride != null &&
            fact(te('normalHoursOverride'), fmtShort(schedule.normalMinutesOverride))}
          {fact(te('breakDeducted'), fmtShort(schedule.breakSpanned ?? schedule.breakMinutes))}
          {fact(t('colCheckIn'), fmtClock(punch.inAbs))}
          {fact(t('colCheckOut'), punch.outAbs == null ? te('notClockedOut') : fmtClock(punch.outAbs))}
          {fact(te('ruleLabel'), schedule.ruleId ? te('ruleApplied') : te('ruleNone'))}
        </dl>
        {schedule.crossesMidnight && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{te('crossesMidnight')}</p>
        )}

        <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {te('workingHeading')}
        </p>
        <ol className="mt-1 space-y-1 text-xs leading-relaxed text-foreground">
          {s.steps.map((step, i) => (
            <li key={`${step.key}-${i}`} className="flex gap-2">
              <span className="w-4 shrink-0 tabular-nums text-muted-foreground">{i + 1}.</span>
              <span>{line(step)}</span>
            </li>
          ))}
        </ol>
      </>
    );
  };

  /** A figure that carries its working: the number, plus the panel while it is open. */
  const explainable = (cell: string, section: Section, text: string) => (
    <span className="relative inline-block" onMouseEnter={show(cell, section)} onMouseLeave={dismiss}>
      <button
        type="button"
        className={TRIGGER}
        aria-expanded={open?.cell === cell}
        aria-describedby={open?.cell === cell ? panelId : undefined}
        aria-label={`${text} — ${te('openLabel')}`}
        onFocus={show(cell, section)}
        onBlur={dismiss}
        onClick={show(cell, section)}
      >
        {text}
      </button>
      {open?.cell === cell && (
        <AnchoredPanel at={at} id={panelId} role="tooltip">
          {panel(section)}
        </AnchoredPanel>
      )}
    </span>
  );

  // No attendance row ⇒ nothing was computed, so the cells stay exactly as they were: plain text, no
  // affordance, no panel. Offering "no working was recorded" against a day that has no record at all
  // would answer a question nobody asked.
  if (!hasRow) {
    return (
      <>
        <td className={CELL}>{fmtShort(lateMinutes)}</td>
        <td className={CELL}>{fmtShort(earlyOutMinutes)}</td>
        {(['flat', 'ot00', 'ot10', 'ot15', 'ot20', 'ot30'] as const).map((k) => (
          <td key={k} className={CELL}>
            —
          </td>
        ))}
      </>
    );
  }

  return (
    <>
      <td className={CELL}>{explainable('lateness', 'lateness', fmtShort(lateMinutes))}</td>
      <td className={CELL}>{explainable('earlyOut', 'earlyOut', fmtShort(earlyOutMinutes))}</td>
      {(['flat', 'ot00', 'ot10', 'ot15', 'ot20', 'ot30'] as const).map((k) => (
        <td key={k} className={CELL}>
          {explainable(`ot-${k}`, 'overtime', fmtHours2(ot[k]))}
        </td>
      ))}
    </>
  );
}
