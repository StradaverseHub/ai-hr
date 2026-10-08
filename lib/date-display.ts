import { timeInKualaLumpur, todayInKualaLumpur } from './hr-date';

/**
 * r422 (board 7e784380) — the ONE display format for a date on the Personnel employee profile:
 * DD-MMM-YYYY, e.g. "31-Jan-2026".
 *
 * DISPLAY ONLY. Nothing here is a parser for storage, a comparison or a form value: the stored date, every
 * calculation and every `<input type="date">` value stay ISO yyyy-mm-dd. A caller that needs to compare or
 * post a date keeps the ISO string and calls this only where the date is drawn as text.
 *
 * Rules, each pinned by test/r422-date-display.test.ts:
 *  - ENGLISH month abbreviations always, whatever the UI language (the reporter's choice: one format for
 *    every reader). A fixed table, not Intl, so no locale data or ICU build can change it.
 *  - A yyyy-mm-dd string is a CALENDAR DATE and is never put through `new Date()`: `new Date('2026-01-31')`
 *    is UTC midnight, which a host west of UTC prints as 30 Jan. The parts are read off the string.
 *  - A full timestamp (a Date, or an ISO string with a time) names an INSTANT; its date is the Kuala Lumpur
 *    calendar day of that instant (lib/hr-date.ts), the same clock SQL `current_date` uses.
 *  - Blank, null or undefined → "—" (the profile's existing empty mark).
 *  - Anything else that is not a recognisable date is returned UNCHANGED, so a surprising value is shown as
 *    it is rather than hidden or invented.
 */
export const DMY_EMPTY = '—';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** An ISO instant: a date, a `T` or space, then at least hh:mm. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "31-Jan-2026" from a yyyy-mm-dd that names a real day, else null. Pure string arithmetic. */
function dmyFromIsoDay(iso: string): string | null {
  const m = ISO_DAY.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${m[3]}-${MONTHS[month - 1]}-${m[1]}`;
}

function instantOf(value: Date | string): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (!ISO_INSTANT.test(value)) return null;
  const d = new Date(value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A date as DD-MMM-YYYY. Accepts a yyyy-mm-dd calendar date, a Date or an ISO timestamp (its Kuala Lumpur
 * calendar day), null/blank (→ "—"). Malformed input comes back unchanged.
 */
export function formatDmy(value: string | Date | null | undefined): string {
  if (value == null) return DMY_EMPTY;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return DMY_EMPTY;
    const day = dmyFromIsoDay(s);
    if (day) return day;
    const at = instantOf(s);
    return at ? (dmyFromIsoDay(todayInKualaLumpur(at)) ?? value) : value;
  }
  const at = instantOf(value);
  return at ? (dmyFromIsoDay(todayInKualaLumpur(at)) ?? DMY_EMPTY) : DMY_EMPTY;
}

/**
 * An instant as "31-Jan-2026 14:05" — date AND time both read on the Kuala Lumpur clock, so the two halves
 * can never name different days. A bare yyyy-mm-dd has no time and is drawn as formatDmy draws it.
 */
export function formatDmyTime(value: string | Date | null | undefined): string {
  if (value == null) return DMY_EMPTY;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return DMY_EMPTY;
    if (ISO_DAY.test(s)) return formatDmy(s);
  }
  const at = instantOf(typeof value === 'string' ? value.trim() : value);
  if (!at) return typeof value === 'string' ? value : DMY_EMPTY;
  const day = dmyFromIsoDay(todayInKualaLumpur(at));
  return day ? `${day} ${timeInKualaLumpur(at)}` : String(value);
}

/**
 * Every calendar date written INSIDE a sentence or a "before → after" pair, redrawn as DD-MMM-YYYY. A
 * yyyy-mm-dd that names no real day (2026-02-30) is left as written, and so is one that is the date half of
 * a timestamp (2026-01-31T…), whose day depends on a clock this function does not read.
 */
export function formatDmyInText(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b(?![T ]\d{2}:)/g, (iso) => dmyFromIsoDay(iso) ?? iso);
}
