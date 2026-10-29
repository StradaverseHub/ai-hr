/**
 * D8 — shift reminders, the PURE part: which local reminders this phone should hold right now. No native module,
 * no network, no storage: mobile/lib/push.tsx reads the server's answers, calls this, and replaces the schedule.
 *
 * THE RULE (owner decision D8, 28 October 2026): ON by default; 15 minutes before each shift start; a forgot-to-clock-
 * out reminder 30 minutes after each shift end; only the next 7 days; refreshed whenever the app reads the roster again.
 *
 * SOURCES. Shift times come from the v2 roster (GET /api/mobile/v2/attendance/roster, core/roster.ts myRosterWindow):
 * a `shift` or `usual` day with both times. The v2 records for the same window (GET …/attendance/records) say what has
 * already happened and what the engine knows about the day:
 *   • a day whose schedule context is on_leave, holiday or rest_day gets no reminder;
 *   • a day already clocked in gets no start reminder;
 *   • a day already clocked out (its last punch is `out`) gets no forgot-out reminder;
 *   • a day that has STARTED with no clock-in gets no forgot-out reminder either (re-planned when the app sees one).
 * Without records (they could not be read) the roster alone decides.
 *
 * TIME. Every date and wall time is in the zone the server names (`timeZone`, the kernel's business-day zone), never
 * the device's; an overnight shift (`crossesMidnight`) ends on the next calendar day, as the roster reports it. A wall
 * time is converted with the platform's Intl data; a time that cannot be converted plans nothing for that day.
 */
import type { AttendanceRecordsV2, AttendanceRosterV2 } from '../../lib/mobile-api/v2/attendance';

export const REMINDER_PREFIX = 'aihr-shift:';
export const START_LEAD_MINUTES = 15;
export const FORGOT_OUT_AFTER_MINUTES = 30;
export const HORIZON_DAYS = 7;
const MINUTE = 60_000, DAY = 86_400_000;

export type ReminderKind = 'start' | 'forgotOut';
export type PlannedReminder = { id: string; kind: ReminderKind; date: string; at: number };
export type RosterAnswer = Pick<AttendanceRosterV2, 'enabled' | 'timeZone' | 'days'>;
export type RecordsAnswer = Pick<AttendanceRecordsV2, 'enabled' | 'days'>;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export function addDays(date: string, n: number): string { return isoDay(Date.parse(`${date}T00:00:00Z`) + n * DAY); }

/** The window to read: two days before to eight days after today's UTC date, so every zone's next 7 days are inside. */
export function reminderWindow(now: number): { from: string; to: string } {
  const today = isoDay(now);
  return { from: addDays(today, -2), to: addDays(today, 8) };
}

/** Wall-clock parts of `instant` in `zone`, or null when the platform cannot say. */
function wallParts(instant: number, zone: string): { y: number; mo: number; d: number; h: number; mi: number } | null {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (typeof format.formatToParts === 'function') {
    const parts = format.formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const out = { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') };
    return Object.values(out).every(Number.isFinite) ? out : null;
  }
  const m = /^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})/.exec(format.format(new Date(instant)));
  return m ? { y: Number(m[3]), mo: Number(m[1]), d: Number(m[2]), h: Number(m[4]) % 24, mi: Number(m[5]) } : null;
}

/** `date` + `HH:MM` as a wall time in `zone` → epoch milliseconds, or null (invalid input, unknown zone, a gap). */
export function zonedInstant(date: string, time: string, zone: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date), tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!dm || !tm) return null;
  const wall = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  if (!Number.isFinite(wall)) return null;
  try {
    const offsetAt = (instant: number) => {
      const p = wallParts(instant, zone);
      return p ? Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(instant / MINUTE) * MINUTE : null;
    };
    const first = offsetAt(wall);
    if (first == null) return null;
    let guess = wall - first;
    const second = offsetAt(guess);
    if (second == null) return null;
    if (second !== first) guess = wall - second;
    // A wall time that does not exist in the zone (a daylight-saving gap) never round-trips: plan nothing.
    const check = wallParts(guess, zone);
    return check && Date.UTC(check.y, check.mo - 1, check.d, check.h, check.mi) === wall ? guess : null;
  } catch { return null; }
}

type RecordDay = RecordsAnswer['days'][number];
const clockedIn = (r: RecordDay | undefined) => !!r && (r.punches.some((p) => p.direction === 'in') || r.outcome.checkIn != null);
/** The kernel orders a day's punches; the day is out when its LAST punch is `out` (or, with no punches, a stored check-out). */
const clockedOut = (r: RecordDay | undefined) => !!r && (r.punches.length > 0 ? r.punches[r.punches.length - 1].direction === 'out' : r.outcome.checkOut != null);

/** The reminders to hold now, soonest first. Pure: the same answers and `now` always give the same plan. */
export function planShiftReminders(roster: RosterAnswer | null, records: RecordsAnswer | null, now: number): PlannedReminder[] {
  if (!roster?.enabled) return [];
  const horizon = now + HORIZON_DAYS * DAY;
  const known = new Map((records?.enabled ? records.days : []).map((d) => [d.date, d] as const));
  const out: PlannedReminder[] = [];
  for (const day of roster.days) {
    if ((day.kind !== 'shift' && day.kind !== 'usual') || !day.shift?.start || !day.shift.end) continue;
    const record = known.get(day.date);
    const context = record?.schedule.context;
    if (context === 'on_leave' || context === 'holiday' || context === 'rest_day') continue;
    const start = zonedInstant(day.date, day.shift.start, roster.timeZone);
    const end = zonedInstant(day.shift.crossesMidnight ? addDays(day.date, 1) : day.date, day.shift.end, roster.timeZone);
    if (start == null || end == null || end <= start) continue;
    const startAt = start - START_LEAD_MINUTES * MINUTE, outAt = end + FORGOT_OUT_AFTER_MINUTES * MINUTE;
    if (!clockedIn(record) && startAt > now && startAt <= horizon) out.push({ id: `${REMINDER_PREFIX}start:${day.date}`, kind: 'start', date: day.date, at: startAt });
    const begunWithoutClockIn = records?.enabled === true && now >= start && !clockedIn(record);
    if (!clockedOut(record) && !begunWithoutClockIn && outAt > now && outAt <= horizon) out.push({ id: `${REMINDER_PREFIX}forgotOut:${day.date}`, kind: 'forgotOut', date: day.date, at: outAt });
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Whether a scheduled local notification is one of these reminders (the only ones the app ever cancels). */
export const isShiftReminder = (identifier: string) => identifier.startsWith(REMINDER_PREFIX);
