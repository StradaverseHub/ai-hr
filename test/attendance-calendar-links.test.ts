import { describe, expect, it } from 'vitest';
import { attendanceCalendarBackHref, attendanceCalendarDetailHref, calendarReturnParams,resolveAttendanceCalendarState } from '../app/(app)/attendance/my-roster/attendance-links';
import { resolveMyRosterWindow } from '../app/(app)/attendance/my-roster/view';

const today = '2026-03-18';
describe('personal calendar detail and return navigation', () => {
  it.each(['day','week','month'] as const)('round-trips the %s view and selected date', view => {
    const window = resolveMyRosterWindow({ view, month:'2026-03', date:today, today });
    const href = attendanceCalendarDetailHref(today,window);
    const params = Object.fromEntries(new URL(href,'https://local.invalid').searchParams);
    const back = new URL(attendanceCalendarBackHref(params,today),'https://local.invalid');
    expect(back.pathname).toBe('/attendance/my-roster');
    expect(back.searchParams.get('view')).toBe(view);
    expect(back.searchParams.get(view==='month'?'month':'date')).toBe(view==='month'?'2026-03':view==='week'?'2026-03-16':today);
    if(view!=='day')expect(back.searchParams.get('selected')).toBe(today);
  });
  it('retains an explicit own-employment coordinate across list, calendar detail and back navigation',()=>{
    const employmentId='00000000-0000-4000-8000-000000000011';
    const state=resolveAttendanceCalendarState({employmentId,tab:'list',from:today,to:today},today);
    const detail=new URL(attendanceCalendarDetailHref(today,state.window,state),'https://local.invalid');
    expect(detail.searchParams.get('employmentId')).toBe(employmentId);
    const back=new URL(attendanceCalendarBackHref(Object.fromEntries(detail.searchParams),today),'https://local.invalid');
    expect(back.searchParams.get('employmentId')).toBe(employmentId);
    expect(back.searchParams.get('tab')).toBe('list');
  });
  it('ignores foreign destinations, invalid dates, arbitrary views and employee selectors', () => {
    const hostile={calendar:'1',calendarView:'https://untrusted.invalid',calendarMonth:'2026-99',calendarDate:'2026-02-30',employmentId:'someone-else',returnTo:'https://untrusted.invalid'};
    expect(calendarReturnParams(hostile)).toEqual({calendar:'1'});
    const back = new URL(attendanceCalendarBackHref(hostile,today),'https://local.invalid');
    expect(back.pathname).toBe('/attendance/my-roster');
    expect(Object.fromEntries(back.searchParams)).toMatchObject({tab:'calendar',view:'month',month:'2026-03',selected:today});
    expect(back.searchParams.has('employmentId')).toBe(false);
  });
  it.each(['2026-13-01', '2026-00-10', '2026-01-32', '2026-02-30', '2026-02-29'])('ignores impossible date %s without throwing', date => {
    expect(calendarReturnParams({calendar:'1', calendarDate:date})).toEqual({calendar:'1'});
    for (const view of ['day','week'] as const) {
      expect(resolveMyRosterWindow({view,date,today})).toEqual(resolveMyRosterWindow({view,today}));
    }
  });
  it('maps an older daily bookmark to the same personal calendar month',()=>{
    expect(Object.fromEntries(new URL(attendanceCalendarBackHref({},today),'https://local.invalid').searchParams)).toMatchObject({tab:'calendar',view:'month',month:'2026-03',selected:today});
  });
});
