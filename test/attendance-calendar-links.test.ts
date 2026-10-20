import { describe, expect, it } from 'vitest';
import { attendanceCalendarBackHref, attendanceCalendarDetailHref, calendarReturnParams } from '../app/attendance/my-roster/attendance-links';
import { resolveMyRosterWindow } from '../app/attendance/my-roster/view';

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
  it('ignores foreign destinations, invalid dates, arbitrary views and employee selectors', () => {
    const hostile={calendar:'1',calendarView:'https://untrusted.invalid',calendarMonth:'2026-99',calendarDate:'2026-02-30',employmentId:'someone-else',returnTo:'https://untrusted.invalid'};
    expect(calendarReturnParams(hostile)).toEqual({calendar:'1'});
    expect(attendanceCalendarBackHref(hostile,today)).toBe('/attendance/my-roster?view=month&month=2026-03&selected=2026-03-18');
  });
  it('maps an older daily bookmark to the same personal calendar month',()=>{
    expect(attendanceCalendarBackHref({},today)).toBe('/attendance/my-roster?view=month&month=2026-03&selected=2026-03-18');
  });
});
