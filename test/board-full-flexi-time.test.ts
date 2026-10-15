import {describe,expect,it} from 'vitest';
import {fullFlexiIntervals,fullFlexiBreakMinutes} from '../lib/full-flexi-time';
import {normalizeShiftColor,shiftChipClass,shiftChipStyle} from '../lib/shift-visual';
import {exceptionRevisionOn} from '../lib/schedule-exception';
import {otMinutesFromWindows} from '../core/shift-ot-window';
const punches=(times:string[])=>times.map((p,i)=>({punchAt:p,direction:i%2?'out' as const:'in' as const}));
describe('Full Flexi recorded intervals',()=>{
 it('counts closed intervals rather than the first-to-last elapsed span',()=>{
  const pair=fullFlexiIntervals(punches(['09:00','12:00','13:00','18:00']),'09:00',null);
  expect(pair.complete).toBe(true);expect(pair.intervals.reduce((n,p)=>n+p.outAbs-p.inAbs,0)).toBe(480);
  expect(fullFlexiBreakMinutes(pair.intervals,[{start:'12:00',end:'13:00'}],60,null)).toBe(0);
 });
 it('deducts flexible allowances once and never deducts paid breaks',()=>{
  const {intervals}=fullFlexiIntervals(punches(['09:00','12:00','12:30','18:00']),'09:00',null);
  expect(fullFlexiBreakMinutes(intervals,[{start:'12:00',end:'13:00',flexible:true,flexibleMinutes:30}],30,null)).toBe(30);
  expect(fullFlexiBreakMinutes(intervals,[{start:'12:00',end:'13:00',paid:true}],0,null)).toBe(0);
 });
 it('an open or malformed session cannot become completed work',()=>{
  for(const list of [punches(['09:00','12:00','13:00']),[{punchAt:'09:00',direction:'in' as const},{punchAt:'10:00',direction:'in' as const},{punchAt:'18:00',direction:'out' as const}]])expect(fullFlexiIntervals(list,'09:00',null)).toMatchObject({complete:false,intervals:[],checkOutAt:null});
 });
 it('identical duplicated punches cannot inflate worked minutes',()=>{
  const list=punches(['09:00','17:00']);expect(fullFlexiIntervals([...list,...list],'09:00',null).intervals).toEqual([{inAbs:540,outAbs:1020}]);
 });
 it('preserves an overnight first-in anchor across several intervals',()=>{
  const result=fullFlexiIntervals(punches(['22:00','23:00','01:00','06:00']),'22:00',null);
  expect(result.complete).toBe(true);expect(result.intervals.reduce((n,p)=>n+p.outAbs-p.inAbs,0)).toBe(360);
 });
 it('applies each OT window threshold once to aggregate recorded overlap',()=>{
  const intervals=[{inAbs:17*60,outAbs:17*60+30},{inAbs:18*60,outAbs:18*60+30}];
  expect(otMinutesFromWindows([{startTime:'17:00',endTime:'19:00',minMinutes:60,adjustAfterMinutes:60,adjustDeltaMinutes:-15}],{inAbs:1020,outAbs:1110},540,intervals).total).toBe(45);
 });
});
describe('validated colour and dated exception decisions',()=>{
 it('canonicalizes HEX and retains tokens/null; refuses CSS and URL inputs',()=>{
  expect(normalizeShiftColor('#abcd09')).toBe('#ABCD09');expect(normalizeShiftColor('red')).toBe('red');expect(normalizeShiftColor(' ')).toBeNull();
  for(const bad of ['#abc','red;display:none','url(x)','#000000ff'])expect(()=>normalizeShiftColor(bad)).toThrow();
  expect(shiftChipClass('unknown')).toBeNull();
 });
 it('uses a legible derived foreground for light and dark backgrounds',()=>{
  expect(shiftChipStyle('#000000')?.color).toBe('#FFFFFF');expect(shiftChipStyle('#FFFFFF')?.color).toBe('#000000');expect(shiftChipStyle('red')).toBeUndefined();
 });
 it('has Off before activation, On from activation, and Off from deactivation',()=>{
  const rows=[{id:'on',effectiveFrom:'2020-01-02',enabled:true},{id:'off',effectiveFrom:'2020-01-04',enabled:false}];
  expect(exceptionRevisionOn(rows,'2020-01-01')).toBeNull();expect(exceptionRevisionOn(rows,'2020-01-02')?.enabled).toBe(true);expect(exceptionRevisionOn(rows,'2020-01-04')?.enabled).toBe(false);
 });
});
