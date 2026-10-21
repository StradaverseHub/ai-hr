import {describe,expect,it} from 'vitest';
import {calendarWindowDates} from '../lib/calendar-window';
import {homeCalendarGrid,homeCalendarMonth,validateHomeCalendar,type EmployeeHomeCalendar} from '../lib/employee-home-calendar';

describe('own calendar civil dates and bounded payloads',()=>{
 it('uses complete Monday or Sunday weeks across month/year and leap-day boundaries',()=>{
  expect(homeCalendarMonth('2024-02')).toEqual({from:'2024-02-01',to:'2024-02-29'});
  const monday=homeCalendarGrid('2024-12',1),sunday=homeCalendarGrid('2024-12',0);
  expect(monday[0]).toBe('2024-11-25');expect(monday).toContain('2025-01-05');expect(monday).toHaveLength(42);
  expect(sunday[0]).toBe('2024-12-01');expect(sunday).toHaveLength(35);
  expect(homeCalendarGrid('2024-02',1)).toContain('2024-02-29');
 });
 it('refuses normalized invalid dates, inverted/unbounded ranges and invalid month/week inputs',()=>{
  for(const [from,to] of [['2026-02-31','2026-03-01'],['2026-01-02','2026-01-01'],['2026-01-01','2026-03-04']])expect(()=>calendarWindowDates(from,to)).toThrow();
  for(const month of ['2026-13','2026-00','26-01','2026-1','2026-02-01'])expect(()=>homeCalendarMonth(month)).toThrow();
  expect(()=>homeCalendarGrid('2026-01',7)).toThrow();
 });
 it('rejects stale subjects/months, missing dates, impossible current dates and unsupported statuses',()=>{
  const valid:EmployeeHomeCalendar={version:1,employmentId:'own',month:'2024-02',today:'2024-02-29',weekStartsOn:1,payrollEnabled:false,
   days:homeCalendarGrid('2024-02',1).map(date=>({date,canRequestLeave:false,entries:[]}))};
  expect(validateHomeCalendar(valid,'own','2024-02')).toBe(valid);
  const bad=[{...valid,employmentId:'foreign'},{...valid,month:'2024-03'},{...valid,today:'2024-02-31'},
   {...valid,days:valid.days.slice(1)}, {...valid,days:valid.days.map((day,index)=>index?day:{...day,entries:[{kind:'payday',date:day.date}]})}];
  for(const value of bad)expect(()=>validateHomeCalendar(value as EmployeeHomeCalendar,'own','2024-02')).toThrow();
 });
});
