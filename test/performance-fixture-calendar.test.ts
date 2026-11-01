import {expect,it} from 'vitest';
import {performanceFixtureCalendar,clockingFixtureText,MAX_IMPORT_LOOKBACK_DAYS} from '../scripts/performance/fixture-workload.mjs';
it.each([
 ['2026-10-31','2026-07','2026-06'],['2026-11-01','2026-07','2026-06'],
 ['2027-01-01','2026-09','2026-08'],['2024-03-01','2023-11','2023-10'],
])('keeps historical payroll away from all planned imports on %s',(today,historical,publication)=>{
 const calendar=performanceFixtureCalendar(today);
 expect(calendar.historicalMonth).toBe(historical);expect(calendar.publicationMonth).toBe(publication);
 const dates=Array.from({length:MAX_IMPORT_LOOKBACK_DAYS},(_,i)=>calendar.importDate(i+1));
 expect(new Set(dates).size).toBe(MAX_IMPORT_LOOKBACK_DAYS);
 for(const date of dates){expect(date<today).toBe(true);expect(date.slice(0,7)>historical).toBe(true);expect(date.slice(0,7)>publication).toBe(true);}
 expect(()=>calendar.importDate(0)).toThrow();expect(()=>calendar.importDate(91)).toThrow();expect(()=>calendar.importDate(1.5)).toThrow();
});
it('shares the exact100-line company file between native fixture admission and browser import',()=>{
 const users=Array.from({length:150},(_,index)=>({index,tenant:index<100?0:1,company:Math.floor(index/50)%2}));
 const lines=clockingFixtureText(users,0,1,'2026-10-30').split('\n');
 expect(lines).toHaveLength(100);expect(lines[0]).toBe('PERF0050,30,10,2026,08,31,IN');expect(lines[99]).toBe('PERF0099,30,10,2026,16,31,OUT');
 expect(lines.some(line=>line.startsWith('PERF0000')||line.startsWith('PERF0100'))).toBe(false);
});
