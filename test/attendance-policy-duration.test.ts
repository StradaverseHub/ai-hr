import {describe,expect,it} from 'vitest';
import {finalizePolicyOvertimeDuration} from '../core/attendance-calc';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
const policy=():AttendanceGroupPolicy['overtime']=>({enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:false,offsetLateness:false,approval:'manual',autoMethod:'actual',rounding:{mode:'none',step:null},days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:'00000000-0000-4000-8000-000000000001'}])) as AttendanceGroupPolicy['overtime']['days']});
const calculate=(p:AttendanceGroupPolicy['overtime'],minutes:number|null,bound:number|null=null)=>finalizePolicyOvertimeDuration({policy:p,dayClass:'normal',approvedEligibleMinutes:minutes,preApprovedLimitMinutes:bound,periodMinutes:1440});
describe('dated policy duration finalization',()=>{
 it('keeps unknown separate from zero and does not approve an incomplete duration',()=>{
  expect(calculate(policy(),null)).toEqual({status:'unavailable',reason:'durationUnknown'});
  expect(calculate(policy(),0)).toEqual({status:'known',minutes:0,steps:[]});
 });
 it('tests the minimum before rounding and preserves an exact threshold',()=>{
  const p=policy();p.days.normal.minimumMinutes=30;p.rounding={mode:'up',step:30};
  expect(calculate(p,29)).toEqual({status:'known',minutes:0,steps:[{kind:'belowMinimum',before:29,after:0}]});
  expect(calculate(p,30)).toMatchObject({status:'known',minutes:30});
 });
 it.each([['down',37,30],['up',37,40],['nearest',34,30],['nearest',35,40],['nearest',0,0]] as const)('rounds %s at a single total: %i → %i',(mode,raw,expected)=>{
  const p=policy();p.rounding={mode,step:10};expect(calculate(p,raw)).toMatchObject({status:'known',minutes:expected});
 });
 it('caps before and after rounding and retains the pre-approved ceiling',()=>{
  const p=policy();p.days.normal.maximumMinutes=44;p.rounding={mode:'up',step:30};
  expect(calculate(p,50,40)).toEqual({status:'known',minutes:40,steps:[{kind:'preApprovedLimit',before:50,after:40},{kind:'rounding',before:40,after:60},{kind:'maximum',before:60,after:44},{kind:'preApprovedLimit',before:44,after:40}]});
  expect(calculate(p,100)).toEqual({status:'known',minutes:44,steps:[{kind:'maximum',before:100,after:44},{kind:'rounding',before:44,after:60},{kind:'maximum',before:60,after:44}]});
 });
 it('keeps the five thresholds distinct and does not mutate disabled configuration',()=>{
  const p=policy();for(const [index,key] of ATTENDANCE_POLICY_DAY_CLASSES.entries())p.days[key].maximumMinutes=index*10;
  for(const [index,dayClass] of ATTENDANCE_POLICY_DAY_CLASSES.entries())expect(finalizePolicyOvertimeDuration({policy:p,dayClass,approvedEligibleMinutes:100,preApprovedLimitMinutes:null,periodMinutes:1440})).toMatchObject({status:'known',minutes:index*10});
  p.enabled=false;const before=JSON.stringify(p);expect(calculate(p,100)).toEqual({status:'known',minutes:0,steps:[{kind:'disabled',before:100,after:0}]});expect(JSON.stringify(p)).toBe(before);
 });
 it('rejects invalid counts, period bounds and thresholds',()=>{
  for(const minutes of [-1,0.5,Infinity,1441])expect(()=>calculate(policy(),minutes)).toThrow();
  const p=policy();p.days.normal.minimumMinutes=50;p.days.normal.maximumMinutes=40;expect(()=>calculate(p,100)).toThrow();
 });
});
