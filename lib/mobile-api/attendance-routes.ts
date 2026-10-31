/**
 * Request parsing shared by the M12 v2 attendance routes (app/api/mobile/v2/attendance/**). Every rule here is about
 * the SHAPE of a request (one value per key, a real calendar date, a bounded window); none is an attendance rule.
 */
import { MobileBadRequest } from './handler';
import { ATTENDANCE_WINDOW_MAX_DAYS } from './v2/attendance';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86_400_000;

export const isCalendarDay = (v: string) => ISO.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** The single value of `key`, or undefined; a repeated key is a 400 (never "the first one wins"). */
export function oneParam(url: URL, key: string): string | undefined {
  const all = url.searchParams.getAll(key);
  if (all.length > 1) throw new MobileBadRequest(`Repeated ${key}`);
  return all[0] ?? undefined;
}

/**
 * `?from&to` — both or neither. Neither ⇒ the calendar month `today` falls in. A window is at most
 * ATTENDANCE_WINDOW_MAX_DAYS calendar days, both ends included; a longer, inverted or malformed one is REFUSED
 * (400), never truncated (the r367 lesson, app/(app)/attendance/my-records/range.ts).
 */
export function attendanceWindowOf(url: URL, today: string): { from: string; to: string } {
  const from = oneParam(url, 'from'), to = oneParam(url, 'to');
  if (from === undefined && to === undefined) {
    const [y, m] = today.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from: `${today.slice(0, 7)}-01`, to: last };
  }
  if (from === undefined || to === undefined || !isCalendarDay(from) || !isCalendarDay(to) || from > to) throw new MobileBadRequest('Invalid window');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > ATTENDANCE_WINDOW_MAX_DAYS) throw new MobileBadRequest('Window too long');
  return { from, to };
}

/** `?date=` — required, a real calendar date. */
export function attendanceDateOf(url: URL): string {
  const date = oneParam(url, 'date');
  if (date === undefined || !isCalendarDay(date)) throw new MobileBadRequest('Invalid date');
  return date;
}

/** `?start&end` for a claimed window — both or neither, each `HH:MM`. */
export function claimWindowOf(url: URL): { start?: string; end?: string } {
  const start = oneParam(url, 'start'), end = oneParam(url, 'end');
  if (start === undefined && end === undefined) return {};
  if (start === undefined || end === undefined || !CLOCK.test(start) || !CLOCK.test(end)) throw new MobileBadRequest('Invalid window');
  return { start, end };
}

/** The `{id}` segment after `/applications/`, a UUID or a 400 — read from the URL so every handler shares one rule. */
export function attendanceApplicationIdOf(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  const at = parts.indexOf('applications');
  const id = at < 0 ? '' : parts[at + 1] ?? '';
  if (!UUID.test(id)) throw new MobileBadRequest('Invalid application id');
  return id.toLowerCase();
}
