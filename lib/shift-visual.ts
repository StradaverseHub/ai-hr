// 6340aecb — Shift Settings redesign: the per-shift COLOUR (request points 6 + 7).
//
// A CLOSED TOKEN PALETTE, not a free hex value, and the choice is deliberate. The colour is rendered as a
// filled chip on the Duty Roster, where it has to stay legible in BOTH themes; an arbitrary hex from a
// colour picker cannot promise that, and "the operator picked black-on-black" is not a bug anyone can fix
// from the settings screen. This mirrors the shape lib/leave-visual.ts already uses for exactly the same
// problem (leave_type.color, a fixed 7-token palette with a DB CHECK behind it — migration 0179) rather
// than inventing a second convention for the same idea.
//
// THE CLASSES ARE THE ONES THE ROSTER GRID ALREADY PAINTS. components/roster-grid.tsx has always tinted a
// shift cell from a six-entry rotating palette keyed on the shift's POSITION in the list; these tokens use
// the identical Tailwind vocabulary at the identical intensity, so choosing "indigo" gives a cell that
// looks exactly like today's first auto colour. A shift with NO colour keeps the rotating palette
// untouched — see components/roster-grid.tsx shiftColor().

export const SHIFT_COLORS = {
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  orange: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
  red: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300',
  purple: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-300',
  grey: 'bg-slate-200 text-slate-800 dark:bg-slate-500/20 dark:text-slate-300',
} as const satisfies Record<string, string>;

export type ShiftColorToken = keyof typeof SHIFT_COLORS;

/** The closed allow-list — exported for service validation, the settings swatches and the DB CHECK's twin. */
export const SHIFT_COLOR_TOKENS = Object.keys(SHIFT_COLORS) as ShiftColorToken[];

export function isShiftColorToken(v: string): v is ShiftColorToken {
  return Object.prototype.hasOwnProperty.call(SHIFT_COLORS, v);
}

/**
 * The chip classes for a stored colour, or NULL when the shift has none.
 *
 * Null is the whole safety property of this feature: every shift that exists today stores no colour, and
 * every caller must fall back to what it renders today rather than to a "default" colour of its own.
 */
export function shiftChipClass(color: string | null | undefined): string | null {
  if (!color) return null;
  return isShiftColorToken(color) ? SHIFT_COLORS[color] : null;
}
