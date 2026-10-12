import { describe,expect,it } from 'vitest';
import { normalizeRotation, rotationDayOn, rotationVersionOn, type RotationCycle } from '../core/week-pattern';
import { resolveRosterCell } from '../lib/roster-month';
const cycle:RotationCycle={unit:'day',length:4,effectiveFrom:'2024-01-01',anchorDate:'2024-02-28',days:[
  {kind:'full',shiftId:'morning'},{kind:'half',shiftId:'night'},{kind:'off',shiftId:null},{kind:'rest',shiftId:null}]};
describe('dated recurring schedule arithmetic',()=>{
  it('wraps through leap day, month and year boundaries in UTC',()=>{
    expect(['2024-02-28','2024-02-29','2024-03-01','2024-03-02','2024-03-03'].map(d=>rotationDayOn(cycle,d)?.kind)).toEqual(['full','half','off','rest','full']);
    expect(rotationDayOn({...cycle,anchorDate:'2024-12-30'},'2025-01-01')?.kind).toBe('off');
  });
  it('uses positive modulo before the anchor, but never before effective date',()=>{
    expect(rotationDayOn(cycle,'2024-02-27')?.kind).toBe('rest');
    expect(rotationDayOn(cycle,'2023-12-31')).toBeNull();
  });
  it('repeats weekly shifts after the complete multiweek cycle',()=>{
    const weekly:RotationCycle={...cycle,unit:'week',length:3,anchorDate:'2024-01-01',days:Array.from({length:21},(_,i)=>({kind:'full',shiftId:i<7?'a':i<14?'b':'c'}))};
    expect(['2024-01-01','2024-01-08','2024-01-15','2024-01-22'].map(d=>rotationDayOn(weekly,d)?.shiftId)).toEqual(['a','b','c','a']);
    expect(normalizeRotation(weekly,['a','b','c']).days).toHaveLength(21);
  });
  it('chooses the greatest applicable effective date without depending on query order',()=>{
    const later={...cycle,effectiveFrom:'2024-06-01',length:1,days:[{kind:'rest' as const,shiftId:null}]};
    expect(rotationVersionOn([later,cycle],'2024-05-31')).toBe(cycle);
    expect(rotationVersionOn([cycle,later],'2024-06-01')).toBe(later);
  });
  it.each([
    {length:0},{length:367},{length:1.5},{days:[{kind:'full',shiftId:'foreign'}]},
    {unit:'week',length:1,anchorDate:'2024-02-28'}, {effectiveFrom:'2024-02-30'},{effectiveFrom:'0000-01-01'},
    {length:4,days:[{kind:'off',shiftId:'morning'},...cycle.days.slice(1)]},
    {length:1,days:[{kind:'rest',shiftId:null}]},
  ])('refuses malformed or unsafe cycles %j',over=>{
    expect(()=>normalizeRotation({...cycle,...over} as RotationCycle,['morning','night'])).toThrow();
  });
  it('uses the dated inherited group and earliest-period fallback for client rotation',()=>{
    const a={...cycle,ruleId:'a'};
    const b={...cycle,ruleId:'b',days:cycle.days.map(d=>d.shiftId?{...d,shiftId:'b'}:d)};
    const usual={shiftId:'legacy',pattern:[1,2,3,4,5],rotations:[a,b],rotationPeriods:[{validFrom:'2024-02-28',ruleId:'a'},{validFrom:'2024-06-01',ruleId:'b'}]};
    expect(resolveRosterCell('2024-02-29',null,usual)).toEqual({kind:'usual',shiftId:'night'});
    expect(resolveRosterCell('2024-06-03',null,usual)).toEqual({kind:'usual',shiftId:'b'});
  });
  it('roster override wins and the client distinguishes rotation rest from off',()=>{
    const usual={shiftId:'legacy',pattern:[1,2,3,4,5],rotations:[cycle]};
    expect(resolveRosterCell('2024-02-29',null,usual)).toEqual({kind:'usual',shiftId:'night'});
    expect(resolveRosterCell('2024-03-01',null,usual)).toEqual({kind:'off'});
    expect(resolveRosterCell('2024-03-02',null,usual)).toEqual({kind:'rest'});
    expect(resolveRosterCell('2024-03-02',{kind:'shift',shiftId:'override'},usual)).toEqual({kind:'shift',shiftId:'override'});
  });
});
