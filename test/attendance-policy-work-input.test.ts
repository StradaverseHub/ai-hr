import {attendancePolicyFinalRawAgreement} from '../packs/attendance/policy-final-raw-input';
import {attendancePolicyTraceBinding} from '../packs/attendance/policy-trace-binding';
/** Pure source geometry only, not real-capture, approval, Payroll or application acceptance. */
import {describe,expect,it} from 'vitest';
import {attendancePolicyClockPlacement,attendancePolicyWorkPlacement,attendancePolicySchedulePlacement,type PolicySchedulePlacementInput} from '../core/attendance-policy-schedule';
import {attendancePolicyUnclockedWorkComparison,attendancePolicyRawWorkedMinutes,attendancePolicyNetWorkedMinutes,attendancePolicyWorkInput} from '../packs/attendance/policy-work-input';
import {attendancePolicyClockMeasurements} from '../packs/attendance/policy-clock-measurements';
import {attendancePolicyClockMillisecondEvidence} from '../lib/attendance-policy-clocks';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import type {AttendancePolicyExecutionContext} from '../core/attendance';
import {replayAttendancePolicyRawClocks} from '../packs/attendance/policy-clock-replay';
import {attendancePolicyRawDay} from '../packs/attendance/policy-raw-day';
import type {AttendanceTraceV1} from '../core/attendance-trace';
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
  // OT placement cannot overwrite the independently proved clock-boundary configuration.
  c.placement=attendancePolicySchedulePlacement({...schedule(),includeGraceInEarlyOut:true},policy());
  expect(attendancePolicyWorkInput(c,clocks([[545,1070]]))).toMatchObject({earlyOutMinutes:6});
  const including=context({...schedule(),includeGraceInEarlyOut:true});
  including.resolvedClock={...including.resolvedClock,lateGraceMinutes:3,earlyGraceMinutes:4};
  expect(attendancePolicyWorkInput(including,clocks([[545,1070]]))).toMatchObject({earlyOutMinutes:10});
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
 it('counts mixed per-row allowances once and fixed overlap only on captured work',()=>{
  const mixed={...schedule(),breakMinutes:45,breakPeriods:[
   {start:'13:00',end:'14:00',flexible:true,flexibleMinutes:30},{start:'15:00',end:'15:15'},
   {start:'10:00',end:'10:15',paid:true}]};
  const proof=clocks([[540,720],[840,1080]]),c=context(mixed);
  expect(attendancePolicyRawWorkedMinutes(c,proof)).toBe(375);
  expect(attendancePolicyRawWorkedMinutes(c,clocks([[540,720],[960,1080]]))).toBe(270);
  expect(attendancePolicyRawWorkedMinutes(c,clocks([[540,560]]))).toBe(0);
  expect(attendancePolicyRawWorkedMinutes(context({...mixed,flexiDuration:true}),proof)).toBe(375);
  expect(attendancePolicyRawWorkedMinutes(context({...mixed,flexibleBreakMinutes:10}),proof)).toBe(410);
  expect(attendancePolicyWorkInput(c,proof)).toMatchObject({state:'unavailable',reason:'positionedScheduleUnavailable'});
  expect(c.workPlacement).toMatchObject({state:'unavailable',reason:'unpositionedBreak'});
  const open=attendancePolicyClockMillisecondEvidence([{id:'open',atMilliseconds:540*60000,direction:'in'}],c.resolvedClock,4320);
  expect(attendancePolicyRawWorkedMinutes(c,open)).toBeNull();
  const night={...mixed,start:'22:00',end:'06:00',crossesMidnight:true,dailyCutoffMinutes:120,
   breakPeriods:[{start:'23:00',end:'23:30',flexible:true,flexibleMinutes:30},{start:'01:00',end:'01:15'}]};
  expect(attendancePolicyRawWorkedMinutes(context(night),clocks([[1320,1440],[1470,1800]]))).toBe(405);
 });
 it('uses Semi Flexi anchors for raw break overlap/counts without fixed penalties or fixed-window OT',()=>{
  const semi={...schedule(),flexiDuration:true},proof=clocks([[570,1050]]),c=context(semi);
  expect(c.clockPlacement).toMatchObject({state:'known',fixedClock:false});
  expect(attendancePolicyClockMeasurements(c,proof)).toMatchObject({state:'measured',lateIn:{state:'notApplicable'},earlyOut:{state:'notApplicable'}});
  expect(attendancePolicyRawWorkedMinutes(c,proof)).toBe(420);
  expect(attendancePolicyRawWorkedMinutes(context({...semi,flexibleBreakMinutes:30}),proof)).toBe(450);
  expect(attendancePolicyRawWorkedMinutes(context({...semi,breakPeriods:null}),proof)).toBe(420);
  expect(attendancePolicyRawWorkedMinutes(context({...semi,breakPeriods:null}),clocks([[570,720]]))).toBe(150);
  expect(attendancePolicyRawWorkedMinutes(context({...semi,breakPeriods:[{start:'13:00',end:'14:00',flexible:true,flexibleMinutes:30}]}),proof)).toBe(450);
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


describe('independent captured raw clock replay',()=>{
 function recorded(pairs:[number,number][],s=schedule(),p=policy()){
  const c=context(s,p),base=Date.parse(c.date+'T00:00:00+08:00');
  const values=pairs.flatMap(([a,b],i)=>[{id:'in_'+i,direction:'in' as const,atMilliseconds:a*60000},
   {id:'out_'+i,direction:'out' as const,atMilliseconds:b*60000}]);
  const source={state:'known' as const,authority:'sourceOnly' as const,timeZone:c.timeZone,periodMilliseconds:4320*60000,
   clocks:values.map(row=>({...row,captureId:'capture_'+row.id,recordedAt:new Date(base+row.atMilliseconds).toISOString()}))};
  const proof=attendancePolicyClockMillisecondEvidence(source.clocks,c.resolvedClock,4320);
  // Minimal schedule template: the writer replaces every measured field before it is replayed.
  const template={v:1,schedule:{ruleId:c.schedule.ruleId,dayType:s.dayType,breakSpanned:null},
   punch:{inAbs:0,outAbs:null,spanMinutes:null,workedMinutes:null},lateness:null,earlyOut:null,
   latenessDeduction:null,earlyOutDeduction:null,overtime:null} as AttendanceTraceV1;
  const row=attendancePolicyRawDay({state:'policy',attendanceId:'fixture',context:c,source,clocks:proof,
   measurements:attendancePolicyClockMeasurements(c,proof),work:attendancePolicyWorkInput(c,proof)},
   {rule:{id:c.schedule.ruleId,applyDeductions:false} as Parameters<typeof attendancePolicyRawDay>[1]['rule'],template,
    dayType:s.dayType,halfDayBefore:780,fallbackIn:null,fallbackOut:null});
  return {c,source,row:{...row,dayType:s.dayType},trace:row.calcTrace!};
 }
 function rawAgreementFixture(){
  const x=recorded([[540,1080]]),id='receipt-fixture',at='2026-10-23T12:00:00.000Z';
  const request:Parameters<typeof attendancePolicyFinalRawAgreement>[1]={id,status:'approved',cancelledAt:null,
   submissionContract:{state:'recorded',correctionId:id,tenantId:'tenant-fixture',employmentId:x.c.employmentId,
    date:x.c.date,companyId:x.c.companyId,kind:'epoch',visibleEpoch:1,manualApprovalMethod:'requested',policyBinding:attendancePolicyTraceBinding(x.c),recordedAt:at},
   finalReceipt:{state:'recorded',authority:'finalWorkflowDecisionOnly',correctionId:id,workflowRequestId:'workflow-fixture',
    actorUserId:'actor-fixture',submissionEpoch:1,recordedAt:at,request:{requestedMinutes:60,approvedMinutes:60,method:'requested',
     plannedStartLabel:null,plannedEndLabel:null,checkIn:null,checkOut:null,clockChanges:null},workflow:{},
    raw:{attendanceId:'fixture',checkIn:x.row.checkInAt,checkOut:x.row.checkOutAt,workedMinutes:x.row.workedMinutes,
     lateMinutes:x.row.lateMinutes,earlyOutMinutes:x.row.earlyOutMinutes,dayType:x.row.dayType,trace:x.trace,
     punchCount:x.source.clocks.length,punches:x.source.clocks.map(clock=>({id:clock.id,clock_capture_id:clock.captureId,
      direction:clock.direction,punch_at:clock.direction==='in'?'09:00:00':'18:00:00'}))}}};
  const current={...x.row,attendanceId:'fixture',trace:x.trace};
  return {...x,request,current,read:(r=request,source=x.source)=>attendancePolicyFinalRawAgreement(x.c,r,'tenant-fixture',source,current)};
 }
 it('compares retained raw final effects to independent current capture replay without granting approval or payment',()=>{
  const x=rawAgreementFixture(),before=structuredClone(x.request),result=x.read();
  expect(result).toMatchObject({state:'known',authority:'retainedRawAgreementOnly',attendanceId:'fixture',policyRevisionId:x.c.selected.id});
  expect(result).not.toHaveProperty('transferable');expect(result).not.toHaveProperty('minutes');expect(x.request).toEqual(before);
  const changed=structuredClone(x.request);if(changed.finalReceipt.state!=='recorded')throw Error('fixture');
  changed.finalReceipt.raw=null;expect(x.read(changed)).toMatchObject({state:'unavailable',reason:'rawEffectUnavailable'});
 });
 it('keeps post-effect financial markers separate from exact retained physical raw agreement',()=>{
  const x=rawAgreementFixture();x.current.trace={...x.trace,overtimePattern:{status:'refused',reason:'sourceUnavailable'}};
  expect(x.read()).toMatchObject({state:'known',authority:'retainedRawAgreementOnly'});
  x.current.trace={...x.current.trace,punch:{...x.current.trace.punch,workedMinutes:999}};
  expect(x.read()).toMatchObject({state:'unavailable',reason:'rawEffectUnavailable'});
 });
 it('refuses changed, omitted, duplicated and equal-count replaced capture identities in retained final effects',()=>{
  const x=rawAgreementFixture();
  for(const field of ['clock_capture_id','id','direction','punch_at']){
   const changed=structuredClone(x.request);if(changed.finalReceipt.state!=='recorded'||!changed.finalReceipt.raw)throw Error('fixture');
   const punches=changed.finalReceipt.raw.punches as Record<string,unknown>[];punches[0][field]='substituted';
   expect(x.read(changed)).toMatchObject({state:'unavailable',reason:'captureSetMismatch'});
  }
  const source=structuredClone(x.source);source.clocks[1].captureId=source.clocks[0].captureId;
  expect(x.read(x.request,source)).toMatchObject({state:'unavailable',reason:'captureSetMismatch'});
  const changed=structuredClone(x.request);if(changed.finalReceipt.state!=='recorded'||!changed.finalReceipt.raw)throw Error('fixture');
  changed.finalReceipt.raw.punchCount=1;expect(x.read(changed)).toMatchObject({state:'unavailable',reason:'captureSetMismatch'});
 });
 it('refuses raw receipt substitution, cancellation, changed measurements and changed policy identity even at equal count',()=>{
  const x=rawAgreementFixture();
  for(const field of ['attendanceId','trace','workedMinutes','checkIn']){
   const changed=structuredClone(x.request);if(changed.finalReceipt.state!=='recorded'||!changed.finalReceipt.raw)throw Error('fixture');
   changed.finalReceipt.raw[field]='substituted';expect(x.read(changed)).toMatchObject({state:'unavailable',reason:'rawEffectUnavailable'});
  }
  const cancelled=structuredClone(x.request);cancelled.cancelledAt='2026-10-23T13:00:00.000Z';
  expect(x.read(cancelled)).toMatchObject({state:'unavailable',reason:'finalReceiptUnavailable'});
  x.c.selected.id='00000000-0000-4000-8000-000000000099';expect(x.read()).toMatchObject({state:'unavailable',reason:'identityUnavailable'});
 });
 it('retains an epoch-zero raw policy identity without granting financial activation',()=>{
  const c=context();c.selected.activation.epoch=0;
  expect(attendancePolicyTraceBinding(c)).toMatchObject({authority:'datedPolicyOnly',activation:{epoch:0}});
  expect(attendancePolicyWorkInput(c,clocks([[540,1080]]))).toMatchObject({state:'known'});
  c.selected.activation.epoch=-1;expect(attendancePolicyTraceBinding(c)).toBeNull();
 });
 it('retains the resolved policy identity and refuses missing or substituted bindings',()=>{
  const x=recorded([[540,1080]]);
  expect(x.trace.executionPolicy).toMatchObject({authority:'datedPolicyOnly',revisionId:x.c.selected.id,
   employmentId:x.c.employmentId,sourceDate:x.c.date,companyId:x.c.companyId,ruleId:x.c.schedule.ruleId,
   activation:{epoch:x.c.selected.activation.epoch},pairing:x.c.resolvedClock.pairing});
  const missing=structuredClone(x.trace);delete missing.executionPolicy;
  expect(replayAttendancePolicyRawClocks(x.c,x.source,missing,x.row)).toMatchObject({state:'unavailable',reason:'policyBindingUnavailable'});
  for(const field of ['revisionId','companyId','employmentId','sourceDate','ruleId'] as const){
   const changed=structuredClone(x.trace);changed.executionPolicy![field]='substituted';
   expect(replayAttendancePolicyRawClocks(x.c,x.source,changed,x.row)).toMatchObject({state:'unavailable',reason:'policyBindingUnavailable'});
  }
  const changed=structuredClone(x.trace);changed.executionPolicy!.activation.epoch++;
  expect(replayAttendancePolicyRawClocks(x.c,x.source,changed,x.row)).toMatchObject({state:'unavailable',reason:'policyBindingUnavailable'});
 });
 it('replays closed pairs rather than rejecting Auto or accepting their elapsed gap',()=>{
  const x=recorded([[540,720],[840,1080]]);
  expect(x.row.workedMinutes).toBe(420);
  expect(replayAttendancePolicyRawClocks(x.c,x.source,x.trace,x.row)).toMatchObject({state:'known',
   evidence:{minuteIntervals:[{inAbs:540,outAbs:720},{inAbs:840,outAbs:1080}]}});
  const changed=structuredClone(x.trace);changed.punch.calculationIntervals=[{inAbs:540,outAbs:1080}];changed.punch.spanMinutes=540;
  expect(replayAttendancePolicyRawClocks(x.c,x.source,changed,x.row)).toMatchObject({state:'unavailable',reason:'rawSourceMismatch'});
 });
 it('rejects altered stored counts, raw labels and penalty facts even when capture receipts exist',()=>{
  const x=recorded([[540,720],[840,1080]]);
  for(const changed of [{...x.row,workedMinutes:421},{...x.row,checkOutAt:'18:00:01'},{...x.row,underMinutes:0},{...x.row,lateMinutes:1}])
   expect(replayAttendancePolicyRawClocks(x.c,x.source,x.trace,changed)).toMatchObject({state:'unavailable',reason:'rawSourceMismatch'});
  expect(replayAttendancePolicyRawClocks(x.c,{state:'unavailable',authority:'sourceOnly',reason:'missingCapture'},x.trace,x.row))
   .toMatchObject({state:'unavailable',reason:'sourceUnavailable'});
 });
 it('refuses a missing stored day classification without inferring one from captured clocks',()=>{
  const x=recorded([[540,720],[840,1080]]);
  expect(replayAttendancePolicyRawClocks(x.c,x.source,x.trace,{...x.row,dayType:null}))
   .toMatchObject({state:'unavailable',reason:'scheduleOwnerUnavailable'});
 });
 it('retains explicit First-In/Last-Out semantics while refusing a different recorded pairing',()=>{
  const p=policy();p.clock.pairing='firstInLastOut';const x=recorded([[540,720],[840,1080]],schedule(),p);
  expect(x.row.workedMinutes).toBe(480);
  expect(replayAttendancePolicyRawClocks(x.c,x.source,x.trace,x.row)).toMatchObject({state:'known',evidence:{minuteIntervals:[{inAbs:540,outAbs:1080}]}});
  const changed=structuredClone(x.trace);changed.punch.intervalSource='closedPunchPairs';
  expect(replayAttendancePolicyRawClocks(x.c,x.source,changed,x.row)).toMatchObject({state:'unavailable',reason:'rawSourceMismatch'});
 });
 it('replays flexi raw counts without turning count-only breaks into positioned financial coverage',()=>{
  for(const s of [{...schedule(),flexiDuration:true},{...schedule(),flexibleBreakMinutes:30},
   {...schedule(),durationOnly:true,flexiDuration:true,start:null,end:null,breakPeriods:null}]){
   const x=recorded([[540,720],[840,1080]],s),review=replayAttendancePolicyRawClocks(x.c,x.source,x.trace,x.row);
   expect(review.state).toBe('known');
   if(review.state!=='known')throw Error('Expected raw clock proof');
   expect(attendancePolicyWorkInput(x.c,review.evidence).state).toBe('unavailable');
  }
 });
});

describe('unclocked HR work comparison retains its separate source basis',()=>{
 it('uses the same schedule/grace/late-offset arithmetic without making a captured clock or payable result',()=>{
  const p=policy();p.overtime.allowBackdatedWithoutClock=true;const c=context(schedule(),p),midnight=Date.parse(c.date+'T00:00:00+08:00');
  const actual={version:1 as const,completeWorkedDay:true as const,sourceDate:c.date,reason:'Fictional complete HR work testimony',
   intervals:[{fromEpochMillisecond:midnight+570*60000+555,toEpochMillisecond:midnight+1200*60000+555}]};
  const result=attendancePolicyUnclockedWorkComparison(c,actual,midnight+2*86400000);
  expect(result.state).toBe('known');if(result.state!=='known')throw Error('Expected independent attested comparison');
  expect(result.actualWork).toEqual(actual);expect(result.work.workedIntervals).toEqual([{from:570,to:1200}]);
  expect(result.measurements.lateIn).toEqual({state:'known',minutes:20});
  expect(result.work.eligibleActualIntervals).toEqual([{from:1080,to:1200}]);
  expect(result).not.toHaveProperty('captureId');expect(result).not.toHaveProperty('transferable');
  expect(result).not.toHaveProperty('payableMinutes');
 });
 it('keeps disabled policy, missing complete-day testimony, mismatched day and future work unavailable',()=>{
  const p=policy();p.overtime.allowBackdatedWithoutClock=true;const c=context(schedule(),p),midnight=Date.parse(c.date+'T00:00:00+08:00');
  const actual={version:1 as const,completeWorkedDay:true as const,sourceDate:c.date,reason:'Fictional testimony',
   intervals:[{fromEpochMillisecond:midnight+60000,toEpochMillisecond:midnight+120000}]};
  const now=midnight+86400000;
  expect(attendancePolicyUnclockedWorkComparison(c,{...actual,sourceDate:'2026-10-22'},now).state).toBe('unavailable');
  expect(attendancePolicyUnclockedWorkComparison(c,actual,midnight).state).toBe('unavailable');
  p.overtime.allowBackdatedWithoutClock=false;
  expect(attendancePolicyUnclockedWorkComparison(c,actual,now).state).toBe('unavailable');
 });
});
