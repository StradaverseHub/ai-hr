import { isMonthParam } from '@/lib/roster-month';
import { parsePageQuery } from '@/lib/pagination';
import { isMyRosterDate, isMyRosterView, myRosterQuery, resolveMyRosterWindow, type MyRosterWindow } from './view';

export type AttendanceCalendarQuery = {
  employmentId?:string|string[]; listSaved?: string; tab?: string; view?: string; month?: string; date?: string; selected?: string;
  from?: string; to?: string; page?: string; size?: string;
};
export type AttendanceCalendarState = {
  employmentId?:string; listSaved: boolean; tab: 'calendar' | 'list'; window: MyRosterWindow; selected: string;
  from: string; to: string; page: string; size: string;
};

/** Retained view coordinates and an optional own-employment selector; the server proves its subject. */
export function resolveAttendanceCalendarState(input: AttendanceCalendarQuery, today: string): AttendanceCalendarState {
  const anchor = isMyRosterDate(input.from) ? input.from : today;
  const window = resolveMyRosterWindow({
    view: input.view, month: input.month ?? anchor.slice(0, 7), date: input.date ?? anchor, today,
  });
  const paging = parsePageQuery(input);
  const listSaved = input.tab === 'list' || input.listSaved === '1';
  return {
    ...(typeof input.employmentId==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.employmentId)?{employmentId:input.employmentId}:{}),
    listSaved, tab: input.tab === 'list' ? 'list' : 'calendar', window,
    selected: isMyRosterDate(input.selected) && input.selected >= window.from && input.selected <= window.to ? input.selected : window.focus ?? (today >= window.from && today <= window.to ? today : window.from),
    from: listSaved && isMyRosterDate(input.from) ? input.from : window.from,
    to: listSaved && isMyRosterDate(input.to) ? input.to : window.to,
    page: String(paging.page), size: String(paging.size),
  };
}
export function attendanceCalendarQuery(state: AttendanceCalendarState): Record<string,string> {
  return { ...(state.employmentId?{employmentId:state.employmentId}:{}),listSaved:state.listSaved || state.tab === 'list' ? '1' : '0', tab:state.tab, ...myRosterQuery(state.window), selected:state.selected,
    from:state.from, to:state.to, page:state.page, size:state.size };
}
export function attendanceCalendarHref(state: AttendanceCalendarState): string {
  return `/attendance/my-roster?${new URLSearchParams(attendanceCalendarQuery(state))}`;
}

export type AttendanceCalendarReturn = {
  employmentId?:string|string[]; calendar?: string; calendarView?: string; calendarMonth?: string; calendarDate?: string;
  calendarListSaved?: string; calendarTab?: string; calendarSelected?: string; calendarFrom?: string; calendarTo?: string;
  calendarPage?: string; calendarSize?: string;
};
export const CALENDAR_RETURN_FIELDS = ['calendar','calendarListSaved','calendarView','calendarMonth','calendarDate','calendarTab','calendarSelected','calendarFrom','calendarTo','calendarPage','calendarSize'] as const;

/** Only local, typed coordinates survive a detail form or a hand-edited bookmark. */
export function calendarReturnParams(input: AttendanceCalendarReturn): Record<string,string> {
  if (input.calendar !== '1') return {};
  const paging = parsePageQuery({page:input.calendarPage,size:input.calendarSize});
  return {
    ...(typeof input.employmentId==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.employmentId)?{employmentId:input.employmentId}:{}),
    calendar:'1',
    ...(input.calendarListSaved === '1' || input.calendarListSaved === '0' ? {calendarListSaved:input.calendarListSaved} : {}),
    ...(isMyRosterView(input.calendarView) ? {calendarView:input.calendarView} : {}),
    ...(isMonthParam(input.calendarMonth) ? {calendarMonth:input.calendarMonth!} : {}),
    ...(isMyRosterDate(input.calendarDate) ? {calendarDate:input.calendarDate} : {}),
    ...(input.calendarTab === 'list' || input.calendarTab === 'calendar' ? {calendarTab:input.calendarTab} : {}),
    ...(isMyRosterDate(input.calendarSelected) ? {calendarSelected:input.calendarSelected} : {}),
    ...(isMyRosterDate(input.calendarFrom) ? {calendarFrom:input.calendarFrom} : {}),
    ...(isMyRosterDate(input.calendarTo) ? {calendarTo:input.calendarTo} : {}),
    ...(input.calendarPage !== undefined ? {calendarPage:String(paging.page)} : {}),
    ...(input.calendarSize !== undefined ? {calendarSize:String(paging.size)} : {}),
  };
}
export function attendanceCalendarDetailHref(date:string, window:MyRosterWindow, state?:AttendanceCalendarState) {
  return `/attendance/my-records/${encodeURIComponent(date)}?${new URLSearchParams(calendarReturnParams({
    employmentId:state?.employmentId,calendar:'1',calendarView:window.view,calendarMonth:window.month,calendarDate:window.focus ?? window.from,
    calendarSelected:state?.selected ?? date,
    ...(state ? {calendarListSaved:state.listSaved || state.tab === 'list' ? '1' : '0',calendarTab:state.tab,calendarFrom:state.from,calendarTo:state.to,calendarPage:state.page,calendarSize:state.size} : {}),
  }))}`;
}
export function attendanceCalendarBackHref(input:AttendanceCalendarReturn, date:string) {
  const safe=calendarReturnParams(input);
  return attendanceCalendarHref(resolveAttendanceCalendarState({
    employmentId:safe.employmentId,listSaved:safe.calendarListSaved,tab:safe.calendarTab,view:safe.calendarView,month:safe.calendarMonth ?? date.slice(0,7),
    date:safe.calendarDate ?? date,selected:safe.calendarSelected ?? date,
    from:safe.calendarFrom,to:safe.calendarTo,page:safe.calendarPage,size:safe.calendarSize,
  },date));
}
