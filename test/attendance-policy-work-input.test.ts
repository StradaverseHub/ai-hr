/** Pure source geometry only, not real-capture, approval, Payroll or application acceptance. */
import {describe,expect,it} from 'vitest';
import {attendancePolicyClockPlacement,attendancePolicyWorkPlacement,attendancePolicySchedulePlacement,type PolicySchedulePlacementInput} from '../core/attendance-policy-schedule';
import {attendancePolicyRawWorkedMinutes,attendancePolicyNetWorkedMinutes,attendancePolicyWorkInput} from '../packs/attendance/policy-work-input';
import {attendancePolicyClockMeasurements} from '../packs/attendance/policy-clock-measurements';
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
 selected:{id:'00000000-0000-4000-8000-000000000003',companyId:'00000000-0000-4000-8000-000000000002',ruleId:'00000000-0000-4000-8000-000000000004',ordinal:1,effectiveFrom:'2026-10-23',policy:p,activation:{epoch:1,actorUserId:'00000000-0000-4000-8000-000000000005',recordedAt:'2026-10-22T00:00:00.000Z',reason:'Fictional policy source'}},
 resolvedClock:p.clock,schedule:{...s,breakPeriods:s.breakPeriods?.map(row=>({...row}))??null,source:'default-shift',shiftId:null,ruleId:'00000000-0000-4000-8000-000000000004',normalMinutes:480},calendar:[],clockPlacement:attendancePolicyClockPlacement(s),workPlacement:attendancePolicyWorkPlacement(s),placement:attendancePolicySchedulePlacement(s,p)};}
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

describe('independent clock boundary and break ownership',()=>{
 it('keeps fixed-shift scalar/whole allowance raw counts without inventing unpaid OT positions',()=>{
  const fixed={...schedule(),breakPeriods:null},proof=clocks([[570,1050]]),c=context(fixed);
  expect(attendancePolicyRawWorkedMinutes(c,proof)).toBe(420);
  expect(attendancePolicyRawWorkedMinutes(context({...fixed,flexibleBreakMinutes:30}),proof)).toBe(450);
  expect(attendancePolicyRawWorkedMinutes(c,clocks([[570,720]]))).toBe(150);
  expect(attendancePolicyClockMeasurements(c,proof)).toMatchObject({lateIn:{state:'known',minutes:20},earlyOut:{state:'known',minutes:15}});
  expect(attendancePolicyWorkInput(c,proof)).toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
  expect(attendancePolicyRawWorkedMinutes({...c,workPlacement:{state:'unavailable',authority:'sourceOnly',reason:'scheduleBoundaryUnavailable'}},proof)).toBeNull();
 });
 it('uses Semi Flexi anchors for raw break overlap/counts without fixed penalties or fixed-window OT',()=>{
  const semi={...schedule(),flexiDuration:true},proof=clocks([[570,1050]]),c=context(semi);
  expect(c.clockPlacement).toMatchObject({state:'known',fixedClock:false});
  expect(attendancePolicyClockMeasurements(c,proof)).toMatchObject({state:'measured',lateIn:{state:'notApplicable'},earlyOut:{state:'notApplicable'}});
  expect(attendancePolicyRawWorkedMinutes(c,proof)).toBe(420);
  expect(attendancePolicyRawWorkedMinutes(context({...semi,flexibleBreakMinutes:30}),proof)).toBe(450);
  expect(attendancePolicyRawWorkedMinutes(context({...semi,breakPeriods:null}),proof)).toBe(420);
  expect(attendancePolicyRawWorkedMinutes(context({...semi,breakPeriods:null}),clocks([[570,720]]))).toBe(150);
  expect(attendancePolicyRawWorkedMinutes(context({...semi,breakPeriods:[{start:'13:00',end:'14:00',flexible:true,flexibleMinutes:30}]}),proof)).toBeNull();
  expect(attendancePolicyRawWorkedMinutes({...c,workPlacement:{state:'unavailable',authority:'sourceOnly',reason:'scheduleBoundaryUnavailable'}},proof)).toBeNull();
  expect(c.placement).toMatchObject({state:'unavailable',reason:'durationOwner'});
  expect(attendancePolicyWorkInput(c,proof)).toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
 });
 it('preserves Full Flexi raw duration and its existing break allowances without fixed-clock penalties or OT placement',()=>{
  const full={...schedule(),start:null,end:null,durationOnly:true,flexiDuration:true,breakPeriods:null};
  const proof=clocks([[540,720],[780,1080]]),c=context(full);
  expect(attendancePolicyRawWorkedMinutes(c,proof)).toBe(420);
  expect(attendancePolicyRawWorkedMinutes(context({...full,breakPeriods:[{start:'12:00',end:'13:00'}]}),proof)).toBe(480);
  expect(attendancePolicyRawWorkedMinutes(context({...full,flexibleBreakMinutes:30}),proof)).toBe(450);
  expect(attendancePolicyRawWorkedMinutes(c,clocks([[540,720]]))).toBe(180);
  expect(attendancePolicyRawWorkedMinutes(c,clocks([[1320,1800]]))).toBe(420);
  expect(attendancePolicyWorkInput(c,proof)).toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
  expect(attendancePolicyClockMeasurements(c,proof)).toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
  const open=attendancePolicyClockMillisecondEvidence([{id:'open',atMilliseconds:540*60000,direction:'in'}],c.resolvedClock,4320);
  expect(attendancePolicyRawWorkedMinutes(c,open)).toBeNull();
 });
 it('retains proved raw net work when an OT window still requires count attribution',()=>{
  const s={...schedule(),otWindows:[{startTime:'18:00',endTime:'21:00',maxMinutes:30}]},c=context(s),proof=clocks([[480,1200]]);
  expect(c.placement).toMatchObject({state:'unavailable',reason:'windowCountAttributionRequired'});
  expect(attendancePolicyWorkInput(c,proof)).toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
  expect(attendancePolicyRawWorkedMinutes(c,proof)).toBe(660);
  expect(attendancePolicyRawWorkedMinutes(context({...s,breakPeriods:null}),proof)).toBe(660);
  expect(attendancePolicyRawWorkedMinutes({...c,workPlacement:{state:'unavailable',authority:'sourceOnly',reason:'unpositionedBreak'},placement:context().placement},proof)).toBeNull();
 });
 it('counts net physical work from closed pairs, subtracting only overlapping unpaid time once',()=>{
  const c=context(),proof=clocks([[480,780],[840,1200]]),w=attendancePolicyWorkInput(c,proof);
  expect(attendancePolicyNetWorkedMinutes(w)).toBe(660);
  expect(attendancePolicyNetWorkedMinutes(attendancePolicyWorkInput(c,clocks([[480,720],[840,1200]])))).toBe(600);
  const envelope=attendancePolicyWorkInput(c,clocks([[480,1200]]));
  expect(attendancePolicyNetWorkedMinutes(envelope)).toBe(660);
  const partial=attendancePolicyWorkInput(c,clocks([[750,810]]));
  expect(attendancePolicyNetWorkedMinutes(partial)).toBe(30);
  expect(attendancePolicyNetWorkedMinutes(undefined)).toBeNull();
  expect(attendancePolicyNetWorkedMinutes(attendancePolicyWorkInput(context({...schedule(),breakPeriods:null}),proof))).toBeNull();
 });
 it('measures proved lateness without inventing scalar or flexible break placement',()=>{
  for(const s of [{...schedule(),breakPeriods:null},{...schedule(),flexibleBreakMinutes:60}]){
   const c=context(s),proof=clocks([[570,1050]]);
   expect(attendancePolicyClockMeasurements(c,proof)).toMatchObject({state:'measured',lateIn:{state:'known',minutes:20},earlyOut:{state:'known',minutes:15}});
   expect(attendancePolicyWorkInput(c,proof)).toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
  }
 });
 it('does not fall back past an explicitly unavailable boundary or guess a duration-only start',()=>{
  const c=context();c.clockPlacement={state:'unavailable',authority:'sourceOnly',reason:'scheduleBoundaryUnavailable'};
  expect(attendancePolicyClockMeasurements(c,clocks([[570,1050]]))).toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
  expect(attendancePolicyClockMeasurements(context({...schedule(),durationOnly:true}),clocks([[570,1050]])))
   .toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
 });
});

describe('proven policy clock boundaries on incomplete records',()=>{
 const review=(c:ReturnType<typeof context>,events:{id:string;atMilliseconds:number;direction:'in'|'out'}[])=>(
  attendancePolicyClockMeasurements(c,attendancePolicyClockMillisecondEvidence(events,c.resolvedClock,4320)));
 const event=(id:string,minute:number,direction:'in'|'out')=>({id,atMilliseconds:minute*60000,direction});
 it('suppresses lateness without inventing zero minutes or a late-offset interval when incomplete skipping is on',()=>{
  const c=context();
  expect(review(c,[event('in',570,'in')])).toMatchObject({state:'measured',authority:'sourceOnly',complete:false,requiresReview:true,
   lateIn:{state:'suppressed',reason:'incompleteClock',minutes:null},earlyOut:{state:'unavailable',reason:'incompleteClock',minutes:null},lateOffsetIntervals:null});
 });
 it('uses only a proved first In when skipping is off, and never treats an unmatched last In as a departure',()=>{
  const c=context();c.resolvedClock={...c.resolvedClock,skipLatenessIfIncomplete:false};
  expect(review(c,[event('in',570,'in'),event('out',900,'out'),event('open',960,'in')])).toMatchObject({
   complete:false,lateIn:{state:'known',minutes:20},earlyOut:{state:'unavailable',minutes:null},lateOffsetIntervals:[{from:550,to:570}]});
  expect(review(c,[event('out',900,'out')])).toMatchObject({lateIn:{state:'unavailable',reason:'missingBoundary',minutes:null},lateOffsetIntervals:null});
  expect(review(c,[event('orphan',500,'out'),event('in',570,'in'),event('out',1200,'out')]))
   .toMatchObject({lateIn:{state:'unavailable',reason:'arrivalBoundaryUnavailable',minutes:null},lateOffsetIntervals:null});
  expect(review(c,[event('orphan',570,'out'),event('in',570,'in'),event('out',1200,'out')]))
   .toMatchObject({lateIn:{state:'unavailable',reason:'arrivalBoundaryUnavailable',minutes:null},lateOffsetIntervals:null});
 });
 it('retains close/duplicate review without allowing their boundaries to establish complete work',()=>{
  const c=context();c.resolvedClock={...c.resolvedClock,minimumIntervalMinutes:5};
  const events=[event('in',570,'in'),event('out',574,'out')];
  expect(review(c,events)).toMatchObject({complete:false,requiresReview:true,lateIn:{state:'suppressed',minutes:null}});
  expect(attendancePolicyWorkInput(c,attendancePolicyClockMillisecondEvidence(events,c.resolvedClock,4320)))
   .toMatchObject({state:'unavailable',reason:'incompleteClockEvidence'});
  expect(review(c,[event('one',570,'in'),event('two',570,'in'),event('out',1200,'out')]))
   .toMatchObject({complete:false,requiresReview:true,lateIn:{state:'suppressed',minutes:null}});
 });
 it('restores measured lateness and early-out after actual complete correction evidence, using the same grace owner',()=>{
  const c=context(),events=[event('in',570,'in'),event('out',1050,'out')],before=structuredClone(c);
  expect(review(c,events)).toMatchObject({complete:true,requiresReview:false,lateIn:{state:'known',minutes:20},earlyOut:{state:'known',minutes:15},
   lateOffsetIntervals:[{from:550,to:570}]});
  expect(c).toEqual(before);
  expect(review(c,[event('in',550,'in'),event('out',1065,'out')])).toMatchObject({lateIn:{state:'known',minutes:0},earlyOut:{state:'known',minutes:0},lateOffsetIntervals:[]});
 });
 it('keeps include-grace and explicit effective shift grace while preserving non-applicable calendar penalties',()=>{
  const c=context({...schedule(),includeGraceInLateness:true,includeGraceInEarlyOut:true});
  c.resolvedClock={...c.resolvedClock,lateGraceMinutes:3,earlyGraceMinutes:4};
  expect(review(c,[event('in',545,'in'),event('out',1070,'out')])).toMatchObject({lateIn:{minutes:5},earlyOut:{minutes:10},lateOffsetIntervals:[{from:540,to:545}]});
  expect(attendancePolicyClockMeasurements(context({...schedule(),dayType:'holiday'}),clocks([[600,720]])))
   .toMatchObject({lateIn:{state:'notApplicable',minutes:null},earlyOut:{state:'notApplicable',minutes:null},lateOffsetIntervals:[]});
 });
 it('does not replace missing source or schedule ownership with a measured zero',()=>{
  expect(attendancePolicyClockMeasurements(context(),undefined)).toMatchObject({state:'unavailable',reason:'clockEvidenceUnavailable'});
  expect(attendancePolicyClockMeasurements(undefined,clocks([[570,1200]]))).toMatchObject({state:'unavailable',reason:'scheduleUnavailable'});
  expect(attendancePolicyClockMeasurements(context({...schedule(),durationOnly:true}),clocks([[570,1200]])))
   .toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
 });
});
