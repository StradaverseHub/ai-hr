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
  return isShiftColorToken(color) ? SHIFT_COLORS[color] : /^#[0-9a-f]{6}$/i.test(color) ? 'border-transparent' : null;
}

/** Canonical display colour accepts old tokens and six-digit opaque HEX only. */
export function normalizeShiftColor(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (isShiftColorToken(v)) return v;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  throw new Error('Choose a saved colour or enter a six-digit HEX colour such as #4F46E5.');
}
/** WCAG relative luminance; choose the more legible of black and white (at least 4.58:1). */
export function shiftChipStyle(color: string | null | undefined): { backgroundColor: string; color: string } | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return { backgroundColor: color, color: (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#FFFFFF' };
}
