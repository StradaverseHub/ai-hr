import {describe,expect,it} from 'vitest';
import {deriveAttendancePolicyDurationProposal,deriveAttendancePolicyClockDurationProposal,type PolicyDurationProposalInput,type PolicyClockDurationProposalInput} from '../packs/attendance/policy-duration';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy,type AttendancePolicyDayClass} from '../lib/attendance-group-policy';
import type {PolicyCalendarProof} from '../lib/attendance-policy-calendar';
import {attendancePolicyCountAttribution,attendancePolicyStoredPartCount} from '../packs/attendance/policy-count-attribution';
const companyId='00000000-0000-4000-8000-000000000001';
const sourceDate='2024-02-29',nextDate='2024-03-01';
const calendar=(date=sourceDate,dayClass:AttendancePolicyDayClass='normal'):PolicyCalendarProof=>({state:'known',date,companyId,dayClass,
 moneyDay:dayClass==='normal'||dayClass==='off'?'workday':dayClass==='rest'?'rest_day':'holiday',references:['fictional-calendar:'+date+':'+dayClass]});
function fixture():PolicyDurationProposalInput{
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:false},
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:false,offsetLateness:false,approval:'auto',autoMethod:'actual',rounding:{mode:'none',step:null},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:companyId}])) as AttendanceGroupPolicy['overtime']['days']}};
 return {sourceDate,companyId,periodMinutes:2880,policy,workedIntervals:[{from:540,to:1140}],eligibleActualIntervals:[{from:1080,to:1140}],eligiblePlannedIntervals:null,
  unpaidIntervals:[],lateOffsetIntervals:null,calendar:[calendar()],method:'actual',approval:'policyAuto',allocationByClass:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,'earliest'])) as PolicyDurationProposalInput['allocationByClass']};
}
function calculated(input:PolicyDurationProposalInput){const value=deriveAttendancePolicyDurationProposal(input);expect(value.status).toBe('calculated');if(value.status!=='calculated')throw Error('Expected evidenced arithmetic');return value;}
describe('shared dated-policy duration proposal',()=>{
 it('removes a union of breaks once and excludes the same measured minutes from the late offset',()=>{
  const f=fixture();f.policy.overtime.offsetLateness=true;f.workedIntervals=[{from:600,to:1140}];f.eligibleActualIntervals=[{from:1080,to:1140}];
  f.unpaidIntervals=[{from:540,to:550},{from:1080,to:1090},{from:1085,to:1095}];f.lateOffsetIntervals=[{from:540,to:570},{from:550,to:570}];
  const before=structuredClone(f),result=calculated(f);
  // 60 actual eligible − 15 unioned break − (30 measured late − 10 already unpaid) = 25.
  expect(result).toMatchObject({authority:'proposalOnly',lateOffsetMinutes:20,payableMinutes:25,intervalBasis:'actual',classes:[{eligibleMinutes:25,payableMinutes:25}]});
  expect(result.parts[0].intervals).toEqual([{from:1115,to:1140}]);expect(f).toEqual(before);
  expect(result.selectionSteps).toEqual([{kind:'breaks',basis:'actual',before:60,after:45},
   {kind:'lateOffset',before:45,after:25,requested:20,applied:20},{kind:'method',method:'actual',before:25,after:25}]);
 });
 it('finalizes Manual approved positions once after the same actual break and late selection',()=>{
  const f=fixture();f.policy.overtime.approval='manual';f.approval='approved';f.policy.overtime.offsetLateness=true;
  f.unpaidIntervals=[{from:1080,to:1090}];f.lateOffsetIntervals=[{from:540,to:550}];
  f.manualApprovedIntervals=[{from:1110,to:1140}];f.policy.overtime.rounding={mode:'up',step:30};
  f.policy.overtime.days.normal.maximumMinutes=25;
  const result=calculated(f);
  expect(result).toMatchObject({payableMinutes:25,parts:[{intervals:[{from:1110,to:1140}],allocatedPayableMinutes:25}],
   classes:[{eligibleMinutes:30,payableMinutes:25,unplacedPayableMinutes:0}]});
  expect(result.selectionSteps.at(-1)).toEqual({kind:'manualCount',before:40,after:30});
  expect(()=>deriveAttendancePolicyDurationProposal({...f,manualApprovedIntervals:[{from:1090,to:1140}]})).toThrow('complete eligible captured coverage');
 });
 it('intersects real positions rather than accepting the smaller of equal disjoint totals',()=>{
  const f=fixture();f.method='intersect';f.policy.overtime.autoMethod='intersect';f.eligiblePlannedIntervals=[{from:1140,to:1200}];
  expect(calculated(f).payableMinutes).toBe(0);
  f.eligiblePlannedIntervals=[{from:1110,to:1170},{from:1120,to:1180}];
  const result=calculated(f);expect(result.payableMinutes).toBe(30);expect(result.parts[0].intervals).toEqual([{from:1110,to:1140}]);
 });
 it.each(ATTENDANCE_POLICY_DAY_CLASSES.flatMap(dayClass=>
  (['actual','preApproved','intersect'] as const).flatMap(method=>
   (['overlapping','disjoint'] as const).map(geometry=>({dayClass,method,geometry})))))
 ('keeps $method positions across midnight for $dayClass with $geometry plans',({dayClass,method,geometry})=>{
  const f=fixture();f.policy.overtime.splitAtMidnight=true;f.method=method;f.policy.overtime.autoMethod=method;
  f.workedIntervals=[{from:1420,to:1460}];f.eligibleActualIntervals=[{from:1420,to:1460}];
  f.eligiblePlannedIntervals=geometry==='overlapping'?[{from:1430,to:1470}]:[{from:1460,to:1500}];
  f.calendar=[calendar(sourceDate,dayClass),calendar(nextDate,dayClass)];
  const before=structuredClone(f),result=calculated(f);
  const expected=method==='actual'?[{from:1420,to:1440},{from:1440,to:1460}]
   :method==='preApproved'?geometry==='overlapping'?[{from:1430,to:1440},{from:1440,to:1470}]:[{from:1460,to:1500}]
   :geometry==='overlapping'?[{from:1430,to:1440},{from:1440,to:1460}]:[];
  expect(result.parts.flatMap(part=>part.allocations)).toEqual(expected);
  expect(result.payableMinutes).toBe(method==='intersect'?(geometry==='overlapping'?30:0):40);
  expect(result.parts.every(part=>part.dayClass===dayClass)).toBe(true);
  expect(result.parts.map(part=>part.date)).toEqual(expected.map(span=>span.from<1440?sourceDate:nextDate));
  expect(result.intervalBasis).toBe(method==='preApproved'?'approvedPlan':'actual');
  expect(f).toEqual(before);
 });
 it('applies one actual lateness offset before intersecting the approved window',()=>{
  const f=fixture();f.policy.overtime.offsetLateness=true;f.method='intersect';f.policy.overtime.autoMethod='intersect';
  f.lateOffsetIntervals=[{from:500,to:515}];f.eligiblePlannedIntervals=[{from:1110,to:1170}];
  const result=calculated(f);expect(result.lateOffsetMinutes).toBe(15);expect(result.payableMinutes).toBe(30);
  expect(result.parts[0].intervals).toEqual([{from:1110,to:1140}]);
 });
 it('requires an established worked day and evidenced plan for Pre-Approved, keeping planned coverage distinct from actual work',()=>{
  const f=fixture();f.method='preApproved';f.policy.overtime.autoMethod='preApproved';f.eligibleActualIntervals=[];f.workedIntervals=[];
  expect(deriveAttendancePolicyDurationProposal(f)).toMatchObject({status:'unavailable',reason:'workedEvidenceUnavailable'});
  f.workedIntervals=[{from:540,to:600}];f.eligibleActualIntervals=[];
  expect(deriveAttendancePolicyDurationProposal(f)).toMatchObject({status:'unavailable',reason:'plannedEvidenceUnavailable'});
  f.eligiblePlannedIntervals=[{from:1080,to:1200}];
  expect(calculated(f)).toMatchObject({intervalBasis:'approvedPlan',payableMinutes:120,parts:[{minutes:120}]});
 });
 it('does not turn missing or pending approval into a synthetic Auto result and retains the manual frozen method',()=>{
  for(const approval of ['approved','pending','rejected','unknown'] as const)expect(deriveAttendancePolicyDurationProposal({...fixture(),approval})).toMatchObject({status:'unavailable',reason:'approvalUnavailable'});
  const f=fixture();f.policy.overtime.approval='manual';f.policy.overtime.autoMethod='preApproved';f.approval='approved';
  expect(calculated(f).payableMinutes).toBe(60);
  f.approval='policyAuto';expect(deriveAttendancePolicyDurationProposal(f)).toMatchObject({status:'unavailable',reason:'approvalUnavailable'});
 });
 it('keeps unknown clocks, eligibility and required lateness separate from a known empty interval set',()=>{
  expect(deriveAttendancePolicyDurationProposal({...fixture(),workedIntervals:null})).toMatchObject({status:'unavailable',reason:'workedEvidenceUnavailable'});
  expect(deriveAttendancePolicyDurationProposal({...fixture(),eligibleActualIntervals:null})).toMatchObject({status:'unavailable',reason:'eligibleEvidenceUnavailable'});
  const f=fixture();f.policy.overtime.offsetLateness=true;expect(deriveAttendancePolicyDurationProposal(f)).toMatchObject({status:'unavailable',reason:'lateEvidenceUnavailable'});
  f.lateOffsetIntervals=[];f.eligibleActualIntervals=[];expect(calculated(f).payableMinutes).toBe(0);
 });
 it('rounds once for a classification spanning midnight instead of independently per date or interval',()=>{
  const f=fixture();f.policy.overtime.splitAtMidnight=true;f.policy.overtime.rounding={mode:'up',step:30};
  f.workedIntervals=[{from:1420,to:1460}];f.eligibleActualIntervals=[{from:1420,to:1460}];f.calendar=[calendar(),calendar(nextDate)];
  const result=calculated(f);expect(result.payableMinutes).toBe(60);expect(result.parts.map(part=>part.minutes)).toEqual([20,20]);
  expect(result.classes).toMatchObject([{eligibleMinutes:40,payableMinutes:60,unplacedPayableMinutes:20,steps:[{kind:'rounding',before:40,after:60}]}]);
  expect(result.parts.reduce((sum,part)=>sum+part.allocatedPayableMinutes,0)).toBe(40);
 });
 it.each(['earliest','latest'] as const)('attributes one rounded class remainder to its %s existing dated source without extending work',direction=>{
  const f=fixture();f.policy.overtime.splitAtMidnight=true;f.policy.overtime.rounding={mode:'up',step:30};
  f.workedIntervals=[{from:1420,to:1460}];f.eligibleActualIntervals=f.workedIntervals;
  f.calendar=[calendar(),calendar(nextDate)];f.allocationByClass.normal=direction;
  const before=structuredClone(f),result=calculated(f),sequence=direction==='earliest'?0:1;
  expect(result.classes[0].roundingCountAttribution).toEqual({kind:'roundingCount',minutes:20,direction,
   partSequence:sequence,calendarDate:sequence===0?sourceDate:nextDate,dayClass:'normal',
   anchor:sequence===0?{from:1420,to:1440}:{from:1440,to:1460}});
  expect(result.parts.flatMap(part=>part.allocations)).toEqual([{from:1420,to:1440},{from:1440,to:1460}]);
  expect(result.parts.reduce((n,part)=>n+part.allocatedPayableMinutes,0)).toBe(40);
  expect(result.payableMinutes).toBe(60);expect(f).toEqual(before);
  const attributed=attendancePolicyCountAttribution(result);
  expect(attributed).toMatchObject({state:'known',physicalMinutes:40,roundedMinutes:20,minutes:60});
  if(attributed.state!=='known')throw Error('Expected explicit count attribution');
  expect(attributed.parts.map(part=>part.minutes)).toEqual(direction==='earliest'?[40,20]:[20,40]);
  const owner=attributed.parts[sequence],stored={sequence,calendarDate:owner.calendarDate,dayClass:owner.dayClass,
   allocatedPayableMinutes:owner.physicalMinutes,durationEvidence:{allocatedIntervals:result.parts[sequence].allocations,
    roundingCountAttributions:owner.roundingCountAttributions,attributedPayableMinutes:owner.minutes}};
  expect(attendancePolicyStoredPartCount(stored)).toBe(40);
  expect(attendancePolicyStoredPartCount({...stored,calendarDate:'2024-03-02'})).toBeNull();
  expect(attendancePolicyStoredPartCount({...stored,durationEvidence:{...stored.durationEvidence,attributedPayableMinutes:41}})).toBeNull();
  expect(attendancePolicyStoredPartCount({...stored,durationEvidence:{allocatedIntervals:[],attributedPayableMinutes:40}})).toBeNull();

  const changed=structuredClone(result);changed.classes[0].roundingCountAttribution!.calendarDate='2024-03-02';
  expect(attendancePolicyCountAttribution(changed).state).toBe('unavailable');
  const missing=structuredClone(result);delete missing.classes[0].roundingCountAttribution;
  expect(attendancePolicyCountAttribution(missing).state).toBe('unavailable');
 });
 it('keeps Nearest rounding count on its own class and respects the final maximum',()=>{
  const f=fixture();f.policy.overtime.splitAtMidnight=true;f.policy.overtime.rounding={mode:'nearest',step:30};
  f.workedIntervals=[{from:1420,to:1456}];f.eligibleActualIntervals=f.workedIntervals;
  f.calendar=[calendar(),calendar(nextDate,'rest')];
  const result=calculated(f);
  expect(result.classes.map(row=>({dayClass:row.dayClass,payable:row.payableMinutes,extra:row.roundingCountAttribution?.minutes})))
   .toEqual([{dayClass:'normal',payable:30,extra:10},{dayClass:'rest',payable:30,extra:14}]);
  expect(result.classes.map(row=>row.roundingCountAttribution?.calendarDate)).toEqual([sourceDate,nextDate]);
  f.policy.overtime.days.rest.maximumMinutes=20;
  const capped=calculated(f);expect(capped.classes[1]).toMatchObject({payableMinutes:20,roundingCountAttribution:{minutes:4}});
 });
 it('does not create a rounded source claim for downward rounding, a maximum reduction or a below-minimum result',()=>{
  const f=fixture();f.policy.overtime.rounding={mode:'nearest',step:30};f.eligibleActualIntervals=[{from:1080,to:1120}];
  expect(calculated(f).classes[0].roundingCountAttribution).toBeUndefined();
  f.policy.overtime.rounding={mode:'up',step:30};f.policy.overtime.days.normal.maximumMinutes=20;
  expect(calculated(f).classes[0].roundingCountAttribution).toBeUndefined();
  f.policy.overtime.days.normal.minimumMinutes=21;f.policy.overtime.days.normal.maximumMinutes=30;
  f.eligibleActualIntervals=[{from:1080,to:1100}];
  expect(calculated(f).classes[0]).toMatchObject({payableMinutes:0});
  expect(calculated(f).classes[0].roundingCountAttribution).toBeUndefined();
 });
 it('never extends a physical clock span to disguise rounded payable count',()=>{
  const f=fixture();f.policy.overtime.rounding={mode:'up',step:15};f.eligibleActualIntervals=[{from:1080,to:1117}];
  const result=calculated(f);expect(result.payableMinutes).toBe(45);expect(result.classes[0].unplacedPayableMinutes).toBe(8);
  expect(result.parts[0].allocations).toEqual([{from:1080,to:1117}]);expect(result.parts[0].allocatedPayableMinutes).toBe(37);
  expect(Object.hasOwn(result,'transferable')).toBe(false);
 });
 it('keeps selected versions\' count-allocation policies explicit and places a reduced count only within proved coverage',()=>{
  const f=fixture();f.policy.overtime.days.normal.maximumMinutes=20;
  expect(calculated(f).parts[0].allocations).toEqual([{from:1080,to:1100}]);
  f.allocationByClass.normal='latest';expect(calculated(f).parts[0].allocations).toEqual([{from:1120,to:1140}]);
  f.allocationByClass.normal='' as never;expect(()=>deriveAttendancePolicyDurationProposal(f)).toThrow('explicit count allocation');
 });
 it('retains minimum, maximum and approved-plan ceilings around rounding',()=>{
  const f=fixture();f.method='intersect';f.policy.overtime.autoMethod='intersect';f.eligiblePlannedIntervals=[{from:1080,to:1124}];
  f.policy.overtime.days.normal.maximumMinutes=44;f.policy.overtime.rounding={mode:'up',step:30};
  const result=calculated(f);expect(result.payableMinutes).toBe(44);expect(result.classes[0].unplacedPayableMinutes).toBe(0);
  f.policy.overtime.days.normal.minimumMinutes=30;f.eligiblePlannedIntervals=[{from:1080,to:1109}];expect(calculated(f).payableMinutes).toBe(0);
 });
 it('refuses the entire overnight proposal when any required dated calendar proof is unavailable',()=>{
  const f=fixture();f.policy.overtime.splitAtMidnight=true;f.workedIntervals=[{from:1430,to:1450}];f.eligibleActualIntervals=f.workedIntervals;
  expect(deriveAttendancePolicyDurationProposal(f)).toMatchObject({status:'unavailable',date:nextDate,reason:'calendarUnavailable'});
  f.calendar=[calendar(),{state:'unknown',date:nextDate,reason:'holidayDesignationUnavailable'}];
  expect(deriveAttendancePolicyDurationProposal(f)).toMatchObject({status:'unavailable',reason:'holidayDesignationUnavailable'});
 });
 it('refuses a rounded aggregate above the canonical parent period without silently dropping a date',()=>{
  const f=fixture();f.periodMinutes=1450;f.policy.overtime.splitAtMidnight=true;f.policy.overtime.rounding={mode:'up',step:60};
  f.workedIntervals=[{from:30,to:1450}];f.eligibleActualIntervals=f.workedIntervals;f.calendar=[calendar(),calendar(nextDate,'rest')];
  expect(deriveAttendancePolicyDurationProposal(f)).toEqual({status:'unavailable',reason:'durationLimitExceeded',authority:'proposalOnly'});
 });
 it('rejects claimed actual eligibility outside actual worked coverage and preserves disabled saved settings',()=>{
  const f=fixture();f.eligibleActualIntervals=[{from:530,to:600}];expect(()=>deriveAttendancePolicyDurationProposal(f)).toThrow('worked coverage');
  f.eligibleActualIntervals=[];f.policy.overtime.enabled=false;const before=structuredClone(f);
  expect(calculated(f).payableMinutes).toBe(0);expect(f).toEqual(before);
 });
});

describe('closed clock evidence into the shared duration proposal',()=>{
 const raw=(id:string,minute:number,direction:'in'|'out',extraSeconds=0)=>({id,atSeconds:minute*60+extraSeconds,direction});
 function input():PolicyClockDurationProposalInput{
  // Deliberately retain the fixture's conflicting envelope fields in the spread. The capture entry
  // point must derive its own coverage and cannot use them to fill the Auto lunch gap.
  const rest=fixture();
  return {...rest,clocks:[raw('a',540,'in'),raw('b',720,'out'),raw('c',780,'in'),raw('d',1140,'out')],actualEligibilityWindows:[{from:540,to:1140}],calendar:[calendar(sourceDate,'rest')]};
 }
 it('lets Auto count actual closed pairs while explicit First In Last Out counts its boundary envelope',()=>{
  const f=input(),before=structuredClone(f),auto=deriveAttendancePolicyClockDurationProposal(f);
  expect(auto.clockEvidence?.complete).toBe(true);expect(auto.duration).toMatchObject({status:'calculated',payableMinutes:540});
  f.policy.clock.pairing='firstInLastOut';const outer=deriveAttendancePolicyClockDurationProposal(f);
  expect(outer.duration).toMatchObject({status:'calculated',payableMinutes:600});
  expect(before.clocks).toEqual(f.clocks);expect(outer.authority).toBe('proposalOnly');
 });
 it('prevents too-close boundary seconds from reaching duration finalization',()=>{
  const f=input();f.policy.clock.minimumIntervalMinutes=1;f.clocks=[raw('a',540,'in',1),raw('b',541,'out')];
  const rejected=deriveAttendancePolicyClockDurationProposal(f);
  expect(rejected.clockEvidence?.flags).toEqual([{kind:'close',clockIds:['a','b']}]);
  expect(rejected.duration).toEqual({status:'unavailable',reason:'workedEvidenceUnavailable',authority:'proposalOnly'});
  f.clocks=[raw('a',540,'in',1),raw('b',541,'out',1)];
  expect(deriveAttendancePolicyClockDurationProposal(f).duration).toMatchObject({status:'calculated',payableMinutes:1});
 });
 it('does not let an enabled unclocked setting attest its own missing worked evidence',()=>{
  const f=input();f.policy.overtime.allowBackdatedWithoutClock=true;f.clocks=null;
  expect(deriveAttendancePolicyClockDurationProposal(f)).toEqual({authority:'proposalOnly',clockEvidence:null,duration:{status:'unavailable',reason:'workedEvidenceUnavailable',authority:'proposalOnly'}});
 });
 it('keeps missing eligibility distinct from a known empty window and intersects windows with proved work',()=>{
  const f=input();f.actualEligibilityWindows=null;
  expect(deriveAttendancePolicyClockDurationProposal(f).duration).toMatchObject({status:'unavailable',reason:'eligibleEvidenceUnavailable'});
  f.actualEligibilityWindows=[];expect(deriveAttendancePolicyClockDurationProposal(f).duration).toMatchObject({status:'calculated',payableMinutes:0});
  f.actualEligibilityWindows=[{from:720,to:780}];expect(deriveAttendancePolicyClockDurationProposal(f).duration).toMatchObject({status:'calculated',payableMinutes:0});
 });
 it('retains unmatched output evidence for review without making it a worked interval',()=>{
  const f=input();f.clocks=[raw('out-only',600,'out')];const result=deriveAttendancePolicyClockDurationProposal(f);
  expect(result.clockEvidence).toMatchObject({complete:false,checkInSecond:null,checkOutSecond:36000,minuteIntervals:[]});
  expect(result.duration).toMatchObject({status:'unavailable',reason:'workedEvidenceUnavailable'});
 });
 it('keeps explicit overnight second evidence and both actual-date calendar parts under one proposal',()=>{
  const f=input();f.policy.overtime.splitAtMidnight=true;f.clocks=[{id:'a',atSeconds:86399,direction:'in'},{id:'b',atSeconds:86461,direction:'out'}];
  f.actualEligibilityWindows=[{from:1439,to:1441}];f.calendar=[calendar(),calendar(nextDate,'rest')];
  const result=deriveAttendancePolicyClockDurationProposal(f);
  expect(result.clockEvidence?.intervals).toEqual([{inSecond:86399,outSecond:86461}]);
  expect(result.duration).toMatchObject({status:'calculated',payableMinutes:2,parts:[{date:sourceDate,minutes:1},{date:nextDate,minutes:1}]});
 });
});
