import {describe,expect,it} from 'vitest';
import {attendancePolicyIntervalMinutes,intersectAttendancePolicyIntervals,offsetAttendancePolicyIntervals,
 splitAttendancePolicyIntervalsAtMidnight,subtractAttendancePolicyIntervals,unionAttendancePolicyIntervals} from '../lib/attendance-policy-intervals';
const interval=(from:number,to:number)=>({from,to});
describe('evidenced Attendance policy interval arithmetic',()=>{
 it('unions overlap, duplicates and touching windows without changing input evidence',()=>{
  const input=[interval(600,660),interval(540,620),interval(540,620),interval(660,700)],before=JSON.stringify(input);
  expect(unionAttendancePolicyIntervals(input,1440)).toEqual([interval(540,700)]);
  expect(attendancePolicyIntervalMinutes(input,1440)).toBe(160);
  expect(JSON.stringify(input)).toBe(before);
 });
 it('does not confuse equally long disjoint actual/planned windows with an intersection',()=>{
  const actual=[interval(1020,1140)],planned=[interval(420,540)];
  expect(attendancePolicyIntervalMinutes(actual,1440)).toBe(120);
  expect(attendancePolicyIntervalMinutes(planned,1440)).toBe(120);
  expect(intersectAttendancePolicyIntervals(actual,planned,1440)).toEqual([]);
 });
 it('counts overlapping approval windows once and preserves actual gaps',()=>{
  expect(intersectAttendancePolicyIntervals([interval(540,720),interval(780,1080)],
   [interval(600,810),interval(780,900),interval(780,900)],1440)).toEqual([interval(600,720),interval(780,900)]);
  expect(intersectAttendancePolicyIntervals([interval(540,600)],[interval(600,660)],1440)).toEqual([]);
 });
 it('removes overlapping evidenced break windows once, including exclusions spanning multiple sessions',()=>{
  const actual=[interval(540,720),interval(780,1080)];
  expect(subtractAttendancePolicyIntervals(actual,[interval(600,690),interval(660,810)],1440))
   .toEqual([interval(540,600),interval(810,1080)]);
  expect(subtractAttendancePolicyIntervals(actual,[interval(0,1440)],1440)).toEqual([]);
  expect(subtractAttendancePolicyIntervals(actual,[],1440)).toEqual(actual);
 });
 it('allocates one measured lateness offset from the earliest remaining eligible work, never into removed breaks',()=>{
  const remaining=subtractAttendancePolicyIntervals([interval(480,720)],[interval(540,600)],1440);
  const result=offsetAttendancePolicyIntervals(remaining,90,1440);
  expect(result).toEqual({intervals:[interval(630,720)],removedMinutes:90});
  expect(attendancePolicyIntervalMinutes(remaining,1440)).toBe(result.removedMinutes+attendancePolicyIntervalMinutes(result.intervals,1440));
  expect(offsetAttendancePolicyIntervals(remaining,400,1440)).toEqual({intervals:[],removedMinutes:180});
  expect(offsetAttendancePolicyIntervals(remaining,0,1440)).toEqual({intervals:remaining,removedMinutes:0});
 });
 it('partitions cross-midnight evidence without duplicating the boundary or total source duration',()=>{
  const result=splitAttendancePolicyIntervalsAtMidnight([interval(1380,1500),interval(2820,3000)],4320);
  expect(result).toEqual([
   {dayOffset:0,from:1380,to:1440,sourceFrom:1380,sourceTo:1440},
   {dayOffset:1,from:0,to:60,sourceFrom:1440,sourceTo:1500},
   {dayOffset:1,from:1380,to:1440,sourceFrom:2820,sourceTo:2880},
   {dayOffset:2,from:0,to:120,sourceFrom:2880,sourceTo:3000},
  ]);
  expect(result.reduce((sum,row)=>sum+row.to-row.from,0)).toBe(300);
  expect(splitAttendancePolicyIntervalsAtMidnight([interval(1440,1500)],2880))
   .toEqual([{dayOffset:1,from:0,to:60,sourceFrom:1440,sourceTo:1500}]);
 });
 it('handles known-empty inputs and refuses malformed or unbounded evidence',()=>{
  expect(unionAttendancePolicyIntervals([],1440)).toEqual([]);
  expect(intersectAttendancePolicyIntervals([],[],1440)).toEqual([]);
  for(const input of [[interval(1,1)],[interval(-1,5)],[interval(0,1441)],[interval(0.5,1)]])
   expect(()=>unionAttendancePolicyIntervals(input,1440)).toThrow();
  expect(()=>unionAttendancePolicyIntervals(Array.from({length:4321},()=>interval(0,1)),1440)).toThrow();
  expect(()=>offsetAttendancePolicyIntervals([],null as never,1440)).toThrow();
  expect(()=>splitAttendancePolicyIntervalsAtMidnight([],4321)).toThrow();
 });
});
