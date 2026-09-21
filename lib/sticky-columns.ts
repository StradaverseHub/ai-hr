/**
 * f728826a — WHERE A FROZEN COLUMN SITS, COMPUTED ONCE FROM HOW WIDE IT IS.
 *
 * THE FAULT THIS EXISTS TO MAKE UNREPRESENTABLE. The Attendance Breakdown table froze three identity
 * columns with hardcoded offsets — `left-0`, `left-[7rem]`, `left-[19rem]` — and set NO width on any of
 * them. `7 + 12 = 19` was true only if the first two columns really were 7rem and 12rem wide, and
 * nothing made them so: each was as wide as its contents happened to be. A longer-than-assumed employee
 * name therefore pushed the real edge past the assumed one and the frozen columns painted on top of one
 * another — which is precisely what the reporter saw while scrolling sideways.
 *
 * A comment asserting 7 + 12 = 19 is what failed. So the offset is no longer typed at all: it is the
 * running sum of the widths declared before it, and the SAME number is applied as the column's width.
 * The two cannot disagree because there is only one of them.
 *
 * WHY INLINE STYLE AND NOT A TAILWIND CLASS. Tailwind generates classes by scanning source text, so a
 * computed `left-[${n}rem]` yields a class that was never generated and silently does nothing. These
 * offsets are arithmetic, so they are applied as style. The widths are pinned three ways — `width`,
 * `minWidth` and `maxWidth` — because a `width` alone is advisory on an auto-layout table: the browser
 * may grow a cell to fit content, and growing one is the fault itself.
 */
export type StickyColumn = {
  /** Identifies the column in a test's failure message; not rendered. */
  readonly key: string;
  /** Declared width in rem. This is the ONLY place a number is written. */
  readonly rem: number;
};

export type PlacedStickyColumn = StickyColumn & {
  readonly left: number;
  readonly style: {
    readonly left: string;
    readonly width: string;
    readonly minWidth: string;
    readonly maxWidth: string;
  };
};

/**
 * Places each column at the running total of the widths before it. Order IS the layout: the array is
 * the left-to-right order the columns are rendered in, and a caller that reorders the cells without
 * reordering this array gets the wrong offsets — so callers index this array rather than re-listing.
 */
export function placeStickyColumns(cols: readonly StickyColumn[]): PlacedStickyColumn[] {
  let left = 0;
  return cols.map((c) => {
    const placed: PlacedStickyColumn = {
      ...c,
      left,
      style: {
        left: `${left}rem`,
        width: `${c.rem}rem`,
        minWidth: `${c.rem}rem`,
        maxWidth: `${c.rem}rem`,
      },
    };
    left += c.rem;
    return placed;
  });
}

/** Total frozen width — what the scrolling remainder begins after. */
export const stickyWidth = (cols: readonly StickyColumn[]) => cols.reduce((n, c) => n + c.rem, 0);
