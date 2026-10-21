import {describe,expect,it} from 'vitest';
import {holidayCalendarWindows,type HolidayCalendarPeriod} from '../core/holiday-calendar-read';
const period=(id:string,from:string,to:string|null,state='Selangor'):HolidayCalendarPeriod=>({id,employmentId:'employment',validFrom:from,validTo:to,kind:'state',workState:state,holidayGroupId:null});
describe('dated holiday calendar half-open boundaries',()=>{
 it('partitions adjacent calendars without sharing or losing the transition day',()=>{
  const a=period('a','2026-01-02','2026-01-05'),b=period('b','2026-01-05',null,'Johor');
  expect(holidayCalendarWindows('2026-01-01','2026-01-07',[a,b])).toEqual([
    {from:'2026-01-01',to:'2026-01-01',calendar:null},
    {from:'2026-01-02',to:'2026-01-04',calendar:a},
    {from:'2026-01-05',to:'2026-01-07',calendar:b},
  ]);
 });
 it('retains legacy fallback in a gap and respects a one-day inclusive request',()=>{
  const a=period('a','2026-01-02','2026-01-03'),b=period('b','2026-01-05','2026-01-06');
  expect(holidayCalendarWindows('2026-01-03','2026-01-05',[a,b])).toEqual([
    {from:'2026-01-03',to:'2026-01-04',calendar:null},{from:'2026-01-05',to:'2026-01-05',calendar:b},
  ]);
  expect(holidayCalendarWindows('2026-01-02','2026-01-02',[a])).toEqual([{from:'2026-01-02',to:'2026-01-02',calendar:a}]);
  expect(holidayCalendarWindows('2026-01-05','2026-01-04',[])).toEqual([]);
 });
});
