import { describe, expect, it } from 'vitest';
import { attendanceCalendarBackHref, attendanceCalendarDetailHref, attendanceCalendarHref, calendarReturnParams, resolveAttendanceCalendarState } from '../app/(app)/attendance/my-roster/attendance-links';
import { resolveMyAttendanceRange } from '../app/(app)/attendance/my-records/range';
const today='2026-10-22';
const query=(href:string)=>Object.fromEntries(new URL(href,'http://localhost').searchParams);
describe('personal calendar and list coordinates',()=>{
  it('defaults to calendar and first enters list on the currently visible interval',()=>{
    const original=resolveAttendanceCalendarState({},today);
    expect(original.tab).toBe('calendar');
    const november=resolveAttendanceCalendarState({...query(attendanceCalendarHref(original)),month:'2026-11'},today);
    expect(november.from).toBe('2026-11-01');
    expect(november.to).toBe('2026-11-30');
    const list=resolveAttendanceCalendarState(query(attendanceCalendarHref({...november,tab:'list'})),today);
    expect(list.listSaved).toBe(true);
    expect(list.from).toBe('2026-11-01');
  });
  it('retains an explicit custom list and page across calendar visits and daily correction round trips',()=>{
    const list=resolveAttendanceCalendarState({tab:'list',from:'2026-07-01',to:'2026-09-30',page:'2',size:'50',month:'2026-10',selected:today},today);
    const calendar=resolveAttendanceCalendarState(query(attendanceCalendarHref({...list,tab:'calendar'})),today);
    expect(calendar).toMatchObject({from:'2026-07-01',to:'2026-09-30',page:'2',size:'50'});
    const detail=attendanceCalendarDetailHref('2026-08-06',list.window,list);
    const fields=calendarReturnParams(query(detail));
    const back=query(attendanceCalendarBackHref(fields,'2026-08-06'));
    expect(back).toMatchObject({tab:'list',from:'2026-07-01',to:'2026-09-30',page:'2',size:'50',month:'2026-10',selected:today});
  });
  it('anchors a legacy list range without inventing an employment selection',()=>{
    const state=resolveAttendanceCalendarState({tab:'list',from:'2026-02-01',to:'2026-02-28',page:'1'},today);
    expect(state.window.month).toBe('2026-02');
    const href=attendanceCalendarBackHref({calendar:'1',calendarTab:'https://evil.test',calendarMonth:'../bad',calendarFrom:'2026-02-30',calendarPage:'-1',calendarSize:'9000'},today);
    expect(href).not.toMatch(/evil|bad|2026-02-30|employmentId|9000/);
  });
  it('refuses real-date, inverted and over-limit list ranges',()=>{
    expect(resolveMyAttendanceRange({from:'2026-02-30'},today,400).refusal).toBe('invalid');
    expect(resolveMyAttendanceRange({from:'2026-10-23',to:today},today,400).refusal).toBe('inverted');
    expect(resolveMyAttendanceRange({from:'2024-01-01',to:today},today,400).refusal).toBe('too_long');
  });
});
