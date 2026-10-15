import {describe,expect,it} from 'vitest';
import {addHolidayDays,allocateReplacementHolidays,type OriginalHoliday,type ReplacementPolicy,type ReplacementDayKind} from '../lib/holiday-replacement';
import {todayInKualaLumpur} from '../lib/hr-date';
const base=todayInKualaLumpur(),day=(n:number)=>addHolidayDays(base,n);
const source=(id:string,n=0):OriginalHoliday=>({id,date:day(n),name:id,holidayType:'public',active:true,tentative:false});
const policy:ReplacementPolicy={id:'policy',effectiveFrom:day(-7),regime:'company_confirmed',confirmed:true,restMode:'scheduled_rest',halfEligible:false,searchDays:7};
function plan(kinds:ReplacementDayKind[],over:Partial<Parameters<typeof allocateReplacementHolidays>[0]>={}){
 const days=new Map(kinds.map((kind,n)=>[day(n),kind]));return allocateReplacementHolidays({sources:[source('original')],policies:[policy],days,reserved:new Set(),companyCountry:'MY',state:'Selangor',knownState:true,employmentFrom:day(-366),employmentTo:null,...over});
}
describe('replacement date decisions from original calendar and raw schedule',()=>{
 it('A: chooses the next normal working day',()=>expect(plan(['rest','full'])[0]).toMatchObject({status:'allocated',date:day(1)}));
 it('B: retains a following public holiday and searches beyond it',()=>expect(plan(['rest','full','full'],{sources:[source('original'),source('next holiday',1)]})[0]).toMatchObject({status:'allocated',date:day(2)}));
 it('C: retains consecutive rest days',()=>expect(plan(['rest','rest','full'])[0]).toMatchObject({status:'allocated',date:day(2)}));
 it('skips off days and disallowed half days',()=>expect(plan(['rest','off','half','full'])[0].date).toBe(day(3)));
 it('uses an explicitly eligible half day',()=>expect(plan(['rest','half','full'],{policies:[{...policy,halfEligible:true}]})[0].date).toBe(day(1)));
 it('allocates consecutive sources in stable order without collisions',()=>{
  const options={sources:[source('later',1),source('earlier')],reserved:new Set([day(2)])};
  const result=plan(['rest','rest','full','full','full'],options);
  expect(result.map(r=>[r.source.id,r.date])).toEqual([['earlier',day(3)],['later',day(4)]]);
  expect(plan(['rest','rest','full','full','full'],options)).toEqual(result);
 });
 it.each([{policies:[]},{policies:[{...policy,confirmed:false}]}])('flags missing confirmation rather than choosing a date',opts=>expect(plan(['rest','full'],opts)[0]).toMatchObject({status:'review',date:null,reason:'policy_unconfirmed'}));
 it('does not infer an unknown jurisdiction or copy EA rules to Sabah',()=>{
  expect(plan(['rest','full'],{policies:[{...policy,regime:'MY_EA_60D'}],state:'Sabah'})[0].reason).toBe('jurisdiction_unclear');
  expect(plan(['rest','full'],{policies:[{...policy,regime:'MY_EA_60D'}],knownState:false})[0].reason).toBe('jurisdiction_unclear');
 });
 it('flags an unknown schedule and exhausted search',()=>{
  expect(plan(['rest','unknown','full'])[0].reason).toBe('unknown_schedule');
  expect(plan(['rest','off','full'],{policies:[{...policy,searchDays:1}]})[0].reason).toBe('search_exhausted');
 });
 it('retains manual reservations and allows their original owner to keep the date',()=>{
  const result=plan(['rest','full','full'],{reserved:new Set([day(1)]),retained:new Map([['original',day(1)]]),existingDates:new Map([['original',day(1)]])});expect(result[0].date).toBe(day(1));
 });
 it('a manual waiver does not occupy a phantom replacement date needed by another source',()=>{
  const result=plan(['rest','rest','full','full'],{sources:[source('original'),source('later',1)],retained:new Map([['original',null]])});
  expect(result.map(r=>[r.source.id,r.status,r.date])).toEqual([['original','not_required',null],['later','allocated',day(2)]]);
 });
 it('does not allocate outside tenure or treat an off day as statutory rest',()=>{
  expect(plan(['rest','full'],{employmentTo:day(0)})[0]).toMatchObject({status:'review',date:null});
  expect(plan(['off','full'])[0]).toMatchObject({status:'not_required',date:null});
  expect(plan(['rest','full'],{employmentFrom:day(1)})).toEqual([]);
 });
 it('uses the designated last weekly rest day only when explicitly selected',()=>{
  const dow=new Date(base+'T00:00:00Z').getUTCDay()||7,monday=addHolidayDays(base,1-dow),saturday=addHolidayDays(monday,5),sunday=addHolidayDays(monday,6);
  const days=new Map<string,ReplacementDayKind>([[saturday,'rest'],[sunday,'rest'],[addHolidayDays(sunday,1),'full']]);
  const sources=[{...source('Saturday'),date:saturday},{...source('Sunday'),date:sunday}];
  const result=plan([],{sources,days,policies:[{...policy,effectiveFrom:addHolidayDays(monday,-7),regime:'MY_EA_60D',restMode:'last_weekly_rest',halfEligible:true}]});
  expect(result.map(r=>[r.source.id,r.status,r.date])).toEqual([['Saturday','not_required',null],['Sunday','allocated',addHolidayDays(sunday,1)]]);
 });
 it('crosses a year boundary without changing the original identity',()=>{
  const originalDate=base.slice(0,4)+'-12-31',next=addHolidayDays(originalDate,1),holiday={...source('year-end'),date:originalDate};
  const result=plan([],{sources:[holiday],days:new Map([[originalDate,'rest'],[next,'full']])});expect(result[0]).toMatchObject({source:{id:'year-end',date:originalDate},date:next});
 });
 it('keeps distinct same-date original identities for review instead of guessing duplicate entitlement',()=>{
  const result=plan(['rest','full','full'],{sources:[source('first gazette'),source('second gazette')]});
  expect(result).toHaveLength(2);expect(result.every(r=>r.status==='review'&&r.date===null&&r.reason==='source_collision_unclear')).toBe(true);
 });
 it('requires tentative and inactive sources to be reviewed',()=>{
  for(const value of [{tentative:true},{active:false}])expect(plan(['rest','full'],{sources:[{...source('uncertain'),...value}]})[0].reason).toBe('source_unconfirmed');
 });
});
