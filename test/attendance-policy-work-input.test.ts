/** Pure source geometry only, not real-capture, approval, Payroll or application acceptance. */
import {describe,expect,it} from 'vitest';
import {attendancePolicySchedulePlacement,type PolicySchedulePlacementInput} from '../core/attendance-policy-schedule';
import {attendancePolicyWorkInput} from '../packs/attendance/policy-work-input';
import {attendancePolicyClockMillisecondEvidence} from '../lib/attendance-policy-clocks';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import type {AttendancePolicyExecutionContext} from '../core/attendance';
const policy=():AttendanceGroupPolicy=>({version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:10,earlyGraceMinutes:15,skipLatenessIfIncomplete:true},
 overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:true,offsetLateness:true,approval:'auto',autoMethod:'actual',rounding:{mode:'none',step:null},
 days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:null}])) as AttendanceGroupPolicy['overtime']['days']}});
const schedule=():PolicySchedulePlacementInput=>({start:'09:00',end:'18:00',crossesMidnight:false,dailyCutoffMinutes:null,durationOnly:false,flexiDuration:false,dayType:'workday',
 breakMinutes:60,breakPeriods:[{start:'13:00',end:'14:00'}],flexibleBreakMinutes:null,otWindows:null,includeGraceInLateness:false,includeGraceInEarlyOut:false});
function context(s=schedule(),p=policy()):Extract<AttendancePolicyExecutionContext,{state:'policy'}>{return {
 state:'policy',employmentId:'00000000-0000-4000-8000-000000000001',date:'2026-10-23',companyId:'00000000-0000-4000-8000-000000000002',timeZone:'Asia/Kuala_Lumpur',
 selected:{id:'00000000-0000-4000-8000-000000000003',companyId:'00000000-0000-4000-8000-000000000002',ruleId:'00000000-0000-4000-8000-000000000004',ordinal:1,effectiveFrom:'2026-10-23',policy:p,activation:{actorUserId:'00000000-0000-4000-8000-000000000005',recordedAt:'2026-10-22T00:00:00.000Z',reason:'Fictional policy source'}},
 resolvedClock:p.clock,schedule:{...s,breakPeriods:s.breakPeriods?.map(row=>({...row}))??null,source:'default-shift',shiftId:null,ruleId:'00000000-0000-4000-8000-000000000004',normalMinutes:480},calendar:[],placement:attendancePolicySchedulePlacement(s,p)};}
const clocks=(pairs:[number,number][],p=policy())=>attendancePolicyClockMillisecondEvidence(pairs.flatMap(([a,b],index)=>[
 {id:`in_${index}`,atMilliseconds:a*60000,direction:'in' as const},{id:`out_${index}`,atMilliseconds:b*60000,direction:'out' as const}]),p.clock,4320);
describe('canonical policy schedule and work source projection',()=>{
 it('sums actual closed pairs, never the lunch or inter-session envelope',()=>{
  const c=context(),r=attendancePolicyWorkInput(c,clocks([[480,780],[840,1200]]));
  expect(r).toEqual({state:'known',authority:'sourceOnly',periodMinutes:4320,workedIntervals:[{from:480,to:780},{from:840,to:1200}],
   eligibleActualIntervals:[{from:480,to:540},{from:1080,to:1200}],unpaidIntervals:[{from:780,to:840}],lateOffsetIntervals:[],lateMinutes:0,earlyOutMinutes:0});
 });
 it('retains the measured grace-excluding lateness interval for the single downstream offset',()=>{
  const c=context(),r=attendancePolicyWorkInput(c,clocks([[570,1200]]));
  expect(r).toMatchObject({state:'known',lateMinutes:20,lateOffsetIntervals:[{from:550,to:570}],eligibleActualIntervals:[{from:1080,to:1200}]});
  const including=context({...schedule(),includeGraceInLateness:true});
  expect(attendancePolicyWorkInput(including,clocks([[570,1200]]))).toMatchObject({lateMinutes:30,lateOffsetIntervals:[{from:540,to:570}]});
  expect(attendancePolicyWorkInput(c,clocks([[550,1065]]))).toMatchObject({lateMinutes:0,earlyOutMinutes:0,lateOffsetIntervals:[]});
 });
 it('uses explicit shift grace supplied by the canonical resolver and preserves early-out grace semantics',()=>{
  const c=context();c.resolvedClock={...c.resolvedClock,lateGraceMinutes:3,earlyGraceMinutes:4};
  expect(attendancePolicyWorkInput(c,clocks([[545,1070]]))).toMatchObject({state:'known',lateMinutes:2,earlyOutMinutes:6});
  c.placement=attendancePolicySchedulePlacement({...schedule(),includeGraceInEarlyOut:true},policy());
  expect(attendancePolicyWorkInput(c,clocks([[545,1070]]))).toMatchObject({earlyOutMinutes:10});
 });
 it('keeps unpaid positions once, paid breaks separate, and selected before/after switches independent',()=>{
  const s={...schedule(),breakPeriods:[...schedule().breakPeriods!,{start:'10:30',end:'10:45',paid:true}]};const p=policy();p.overtime.beforeShift=false;
  expect(attendancePolicyWorkInput(context(s,p),clocks([[480,1200]],p))).toMatchObject({state:'known',eligibleActualIntervals:[{from:1080,to:1200}],unpaidIntervals:[{from:780,to:840}]});
  p.overtime.afterShift=false;expect(attendancePolicyWorkInput(context(s,p),clocks([[480,1200]],p))).toMatchObject({eligibleActualIntervals:[]});
 });
 it('uses the same cross-midnight shift and explicit-cutoff break placement',()=>{
  const s={...schedule(),start:'22:00',end:'06:00',crossesMidnight:true,dailyCutoffMinutes:120,breakMinutes:30,breakPeriods:[{start:'01:00',end:'01:30'}]};
  expect(attendancePolicySchedulePlacement(s,policy())).toMatchObject({state:'known',scheduled:{from:1320,to:1800},unpaidWindows:[{from:1500,to:1530}],eligibilityWindows:[{from:0,to:1320},{from:1800,to:4320}]});
 });
 it('preserves non-workday eligibility and leaves fixed-clock penalties unavailable',()=>{
  const s={...schedule(),dayType:'holiday' as const};
  expect(attendancePolicyWorkInput(context(s),clocks([[600,720]]))).toMatchObject({state:'known',eligibleActualIntervals:[{from:600,to:720}],lateMinutes:null,earlyOutMinutes:null});
  const p=policy();p.overtime.enabled=false;expect(attendancePolicyWorkInput(context(s,p),clocks([[600,720]],p))).toMatchObject({eligibleActualIntervals:[]});
 });
 it('refuses scalar, flexible and count-adjusted windows instead of inventing their positions',()=>{
  for(const s of [{...schedule(),breakPeriods:null},{...schedule(),flexibleBreakMinutes:60},{...schedule(),breakPeriods:[{start:'13:00',end:'14:00',flexible:true,flexibleMinutes:60}]}])
   expect(attendancePolicySchedulePlacement(s,policy())).toMatchObject({state:'unavailable',reason:'unpositionedBreak'});
  expect(attendancePolicySchedulePlacement({...schedule(),otWindows:[{startTime:'18:00',endTime:'20:00',maxMinutes:30}]},policy()))
   .toMatchObject({state:'unavailable',reason:'windowCountAttributionRequired'});
  expect(attendancePolicySchedulePlacement({...schedule(),durationOnly:true},policy())).toMatchObject({state:'unavailable',reason:'durationOwner'});
 });
 it('intersects with actual declared shift windows using their existing owner',()=>{
  const s={...schedule(),otWindows:[{startTime:'18:30',endTime:'21:00'}]};
  expect(attendancePolicyWorkInput(context(s),clocks([[480,1200]]))).toMatchObject({state:'known',eligibleActualIntervals:[{from:1110,to:1200}]});
 });
 it('refuses incomplete and close clock evidence without inventing worked coverage or approval',()=>{
  const c=context(),p=policy();p.clock.minimumIntervalMinutes=1;
  const close=attendancePolicyClockMillisecondEvidence([{id:'a',atMilliseconds:540*60000,direction:'in'},{id:'b',atMilliseconds:540*60000+59950,direction:'out'}],p.clock,4320);
  expect(attendancePolicyWorkInput(c,close)).toEqual({state:'unavailable',authority:'sourceOnly',reason:'incompleteClockEvidence'});
  expect(attendancePolicyWorkInput(c,undefined)).toMatchObject({state:'unavailable',reason:'clockEvidenceUnavailable'});
  expect(attendancePolicyWorkInput(undefined,clocks([[480,1200]]))).toMatchObject({state:'unavailable',reason:'scheduleUnavailable'});
 });
});
