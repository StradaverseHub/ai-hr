import { isIsoDate, isMonthParam } from '@/lib/roster-month';
import { isMyRosterView, myRosterHref, resolveMyRosterWindow, type MyRosterWindow } from './view';

export type AttendanceCalendarReturn = { calendar?: string; calendarView?: string; calendarMonth?: string; calendarDate?: string };
export const CALENDAR_RETURN_FIELDS = ['calendar', 'calendarView', 'calendarMonth', 'calendarDate'] as const;
const isCalendarDate = (value: string | undefined): value is string =>
  typeof value === 'string' && isIsoDate(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;

/** Only local, typed calendar coordinates survive a detail form or a hand-edited bookmark. */
export function calendarReturnParams(input: AttendanceCalendarReturn): Record<string, string> {
  if (input.calendar !== '1') return {};
  return {
    calendar: '1',
    ...(isMyRosterView(input.calendarView) ? { calendarView: input.calendarView } : {}),
    ...(isMonthParam(input.calendarMonth) ? { calendarMonth: input.calendarMonth! } : {}),
    ...(isCalendarDate(input.calendarDate) ? { calendarDate: input.calendarDate } : {}),
  };
}

export function attendanceCalendarDetailHref(date: string, window: MyRosterWindow) {
  return `/attendance/my-records/${encodeURIComponent(date)}?${new URLSearchParams({
    calendar: '1', calendarView: window.view, calendarMonth: window.month, calendarDate: window.focus ?? date,
  })}`;
}

export function attendanceCalendarBackHref(input: AttendanceCalendarReturn, date: string) {
  const safe = calendarReturnParams(input);
  const window = resolveMyRosterWindow({ view: safe.calendarView, month: safe.calendarMonth ?? date.slice(0, 7), date: safe.calendarDate ?? date, today: date });
  const href = myRosterHref(window);
  // Month and week views retain the selected date as well as their original window.
  return `${href}${window.view === 'day' ? '' : `&selected=${encodeURIComponent(date)}`}`;
}
