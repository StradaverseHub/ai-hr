/**
 * The Leave Calendar header's ONE segmented-control family (feedback ed76f6b0).
 *
 * My/Team (AbsenceViewSwitch) and Week/Month (CalendarRangeSwitch) must read as the same designed
 * unit as the date navigation next to them (TimelineNav: h-7 / size-7, rounded-lg, hover:bg-accent,
 * active:scale-95, ease-snappy). These constants pin that family in one place:
 *  - the GROUP is exactly h-7 tall (28px — the nav's metric), rounded-lg like the nav buttons;
 *  - the segment buttons stretch to the group's inner height and carry the nav's hover/press feel;
 *  - the selected segment lifts onto bg-card with a soft shadow (the existing pill grammar).
 *
 * Pure class strings, no React, no DB — safe to import from any client component. Both switches
 * import from HERE (drift-guarded in test/leave-calendar-week-month.test.ts) so the two controls
 * can never diverge in height, rounding, spacing, or hover feel again.
 */

/** The segmented group container: h-7 total (the TimelineNav metric), nav-matching border + rounding. */
export const SEGMENTED_GROUP =
  'inline-flex h-7 items-stretch gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5';

/** Every segment button: stretches to the group's inner height; the nav's snappy hover/press feel. */
export const SEGMENTED_BTN =
  'inline-flex items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition duration-150 ease-snappy active:scale-95';

/** The selected segment: lifted card surface. */
export const SEGMENTED_BTN_ACTIVE = 'bg-card text-foreground shadow-sm';

/** An unselected segment: muted, with the nav's accent hover. */
export const SEGMENTED_BTN_INACTIVE = 'text-muted-foreground hover:bg-accent hover:text-foreground';
