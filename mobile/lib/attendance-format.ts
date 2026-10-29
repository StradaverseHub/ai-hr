/**
 * M12 (D13) — presentation helpers shared by the native attendance screens. Formatting only: every status, figure and
 * date comes from the server (lib/mobile-api/v2/attendance.ts). A calendar date is printed as a calendar date (never
 * moved through the device's zone); an instant is printed in the zone the server named, the kernel's business-day zone.
 */
import { intlLocale, t, type MessageKey } from './i18n';
import type {
  AttendanceApplicationDisplay, AttendanceApplicationSummaryV2, AttendanceDayStatus, AttendanceException,
} from '../../lib/mobile-api/v2/attendance';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only path segment the app ever sends: a validated application UUID. */
export function attendanceApplicationPath(id: string, action?: 'withdraw'): `v2/${string}` {
  if (!UUID.test(id)) throw new Error('Invalid application reference');
  return `v2/attendance/applications/${id.toLowerCase()}${action ? `/${action}` : ''}`;
}


/** `YYYY-MM-DD` as a calendar date ("Mon, 3 Nov 2026"), the same on every device. */
export function fmtCalendarDate(iso: string, withYear = true): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(), { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) })
      .format(new Date(`${iso}T00:00:00Z`));
  } catch { return iso; }
}
/** `YYYY-MM` as "November 2026". */
export function fmtMonth(month: string): string {
  try { return new Intl.DateTimeFormat(intlLocale(), { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month}-01T00:00:00Z`)); }
  catch { return month; }
}
/** An instant in the server-named zone ("3 Nov 2026, 14:05"). */
export function fmtInstant(iso: string | null, zone: string): string {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)); }
  catch { return iso.slice(0, 16).replace('T', ' '); }
}
/**
 * A server-named IANA zone as a place people recognise ("Asia/Kuala_Lumpur" -> "Kuala Lumpur"), for "Dates and times are
 * {zone} time". Taken from the id itself: Intl zone names differ by runtime (Hermes says "Malaysia", Node "Malaysia Time").
 */
export function fmtZoneName(zone: string): string {
  const city = zone.split('/').pop()?.replace(/_/g, ' ').trim();
  return city && /^[A-Za-z][A-Za-z .'-]*$/.test(city) ? city : zone;
}
/** Minutes as "7h 30m"; null as a dash. Formatting, not arithmetic on a figure the app owns. */
export function fmtMinutes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const total = Math.round(n), h = Math.floor(Math.abs(total) / 60), m = Math.abs(total) % 60;
  return `${total < 0 ? '-' : ''}${t('attHoursMinutes', { h, m })}`;
}
/** A shift's times, "22:00–06:00 (+1)" when the server says it crosses midnight. */
export function fmtShiftTimes(start: string | null, end: string | null, crossesMidnight: boolean): string {
  if (!start || !end) return '';
  return `${start}–${end}${crossesMidnight ? ` ${t('attNextDay')}` : ''}`;
}

/** Calendar month arithmetic on `YYYY-MM` (which month to ask for next), never on a business figure. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

export const DAY_STATUS: Record<AttendanceDayStatus, MessageKey> = {
  present: 'attStatusPresent', absent: 'attStatusAbsent', exempt: 'attStatusExempt', rest: 'attStatusRest',
  off: 'attStatusOff', ph: 'attStatusPh', on_leave: 'attStatusOnLeave',
};
export const EXCEPTION: Record<AttendanceException, MessageKey> = { late: 'attExceptionLate', under: 'attExceptionUnder', odd: 'attExceptionOdd' };
export const APPLICATION_STATUS: Record<AttendanceApplicationDisplay, MessageKey> = {
  pending: 'attDisplayPending', approved: 'attDisplayApproved', rejected: 'attDisplayRejected', withdrawn: 'attDisplayWithdrawn', cancelled: 'attDisplayCancelled',
};

/** The kind the employee filed it as (the web's KIND_LABEL), or what it is when no kind was recorded. */
export function applicationKindText(a: Pick<AttendanceApplicationSummaryV2, 'requestKind' | 'application'>): string {
  switch (a.requestKind) {
    case 'short_hours': return t('attKindShort');
    case 'incomplete_entry': return t('attKindIncomplete');
    case 'absent': return t('attKindAbsent');
    case 'self_overtime': return t('attKindOvertime');
    default: return a.application === 'overtime' ? t('attKindOvertime') : a.application === 'clock_data' ? t('attKindClockData') : t('attKindCorrection');
  }
}
/** What was asked for, in one line (the web's askedFor). */
export function askedText(a: Pick<AttendanceApplicationSummaryV2, 'asked'>): string {
  const q = a.asked;
  if (q.clockEntries != null) return t('attAskedClockData', { n: q.clockEntries });
  if (q.checkIn == null && q.requestedOtMinutes != null) return t('attAskedOvertime', { hours: fmtMinutes(q.requestedOtMinutes) });
  return t('attAskedTimes', { in: q.checkIn ?? '—', out: q.checkOut ?? '—' });
}
