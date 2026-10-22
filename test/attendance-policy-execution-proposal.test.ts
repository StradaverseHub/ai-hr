import {describe,expect,it} from 'vitest';
import type {AttendancePolicyExecutionContext} from '../core/attendance';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {attendancePolicySchedulePlacement} from '../core/attendance-policy-schedule';
import {attendancePolicyExecutionProposal as propose} from '../packs/attendance/policy-execution-proposal';
import type {PolicyWorkInput} from '../packs/attendance/policy-work-input';
import type {PolicyFormulaInput} from '../packs/attendance/policy-formula-input';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';

const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const date='2026-10-23',next='2026-10-24';
function fixture(){
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:true},
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:true,offsetLateness:false,approval:'auto',autoMethod:'actual',rounding:{mode:'up',step:30},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:id(4)}])) as AttendanceGroupPolicy['overtime']['days']}};
 const placement=attendancePolicySchedulePlacement({start:'09:00',end:'18:00',crossesMidnight:false,dailyCutoffMinutes:null,durationOnly:false,flexiDuration:false,dayType:'workday',
  breakMinutes:0,breakPeriods:null,flexibleBreakMinutes:null,otWindows:null,includeGraceInLateness:false,includeGraceInEarlyOut:false},policy);
 const context:Extract<AttendancePolicyExecutionContext,{state:'policy'}>={state:'policy',employmentId:id(6),date,companyId:id(1),timeZone:'Asia/Kuala_Lumpur',
  selected:{id:id(3),companyId:id(1),ruleId:id(2),ordinal:1,effectiveFrom:date,policy,
   activation:{epoch:1,actorUserId:id(5),recordedAt:'2026-10-22T00:00:00.000Z',reason:'Fictional prepared source composition'}},resolvedClock:policy.clock,
  schedule:{source:'default-shift',shiftId:null,ruleId:id(2),start:'09:00',end:'18:00',crossesMidnight:false,dailyCutoffMinutes:null,durationOnly:false,flexiDuration:false,normalMinutes:540,breakMinutes:0,breakPeriods:null,flexibleBreakMinutes:null},placement,
  calendar:[date,next].map(date=>({state:'known',date,companyId:id(1),dayClass:'normal',moneyDay:'workday',references:['fictional-calendar:'+date]}))};
 const work:Extract<PolicyWorkInput,{state:'known'}>={state:'known',authority:'sourceOnly',periodMinutes:4320,workedIntervals:[{from:1320,to:1500}],
  eligibleActualIntervals:[{from:1420,to:1460}],unpaidIntervals:[],lateOffsetIntervals:[],lateMinutes:0,earlyOutMinutes:0};
 // The arithmetic source only reads the actual selected definition's count direction. It never
 // executes this starting definition or claims it is activated/payment-ready.
 const definition=prepareOvertimeStarter('ot15','day','earliest');
 const formulas:Extract<PolicyFormulaInput,{state:'known'}>={state:'known',authority:'sourceOnly',references:[date,next].map(date=>({state:'known',date,
  dayClass:'normal',moneyDay:'workday',versionId:id(4),definition,definitionDigest:'a'.repeat(64),activeState:{id:id(7),sequence:1,effectiveFrom:'2026-10-22'},earningReferences:[]}))};
 return {context,work,formulas};
}
describe('canonical source composition into the shared policy duration proposal',()=>{
 it('uses the selected formula direction and rounds once across two dates without minting extra clock coverage',()=>{
  const f=fixture(),before=structuredClone(f),result=propose(f.context,f.work,f.formulas);
  expect(result).toMatchObject({state:'proposed',authority:'proposalOnly',policyRevisionId:id(3),duration:{status:'calculated',payableMinutes:60,
   classes:[{eligibleMinutes:40,payableMinutes:60,unplacedPayableMinutes:20}],parts:[{date,allocatedPayableMinutes:20,allocations:[{from:1420,to:1440}]},{date:next,allocatedPayableMinutes:20,allocations:[{from:1440,to:1460}]}]},
   formulaParts:[{date,versionId:id(4)},{date:next,versionId:id(4)}]});
  expect(Object.hasOwn(result,'transferable')).toBe(false);expect(f).toEqual(before);
 });
 it('uses the central latest count choice across the complete class instead of a per-date cap',()=>{
  const f=fixture();f.context.selected.policy.overtime.days.normal.maximumMinutes=10;
  for(const ref of f.formulas.references)if(ref.state==='known')ref.definition.durationAllocation='latest';
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'proposed',duration:{payableMinutes:10,
   parts:[{allocatedPayableMinutes:0,allocations:[]},{allocatedPayableMinutes:10,allocations:[{from:1450,to:1460}]}]}});
 });
 it('never upgrades an existing approval audit or scalar plan into the missing final-effect receipt',()=>{
  const f=fixture();f.context.selected.policy.overtime.approval='manual';
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'approvalReceiptRequired'});
  f.context.selected.policy.overtime.approval='auto';
  for(const method of ['preApproved','intersect'] as const){f.context.selected.policy.overtime.autoMethod=method;
   expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'plannedProofRequired'});}
 });
 it('refuses missing activation, incomplete work and a mismatched configured formula',()=>{
  const f=fixture();f.context.selected.activation.epoch=0;
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'activationUnavailable'});
  f.context.selected.activation.epoch=1;
  expect(propose(f.context,undefined,f.formulas)).toMatchObject({state:'unavailable',reason:'workUnavailable'});
  const ref=f.formulas.references[0];if(ref.state!=='known')throw Error('Expected prepared reference');ref.versionId=id(9);
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'formulaBindingMismatch'});
 });
 it('requires every used date reference and the entire calendar instead of silently accepting a partial overnight result',()=>{
  const f=fixture();f.formulas.references.pop();
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'formulaUnavailable'});
  f.context.calendar[1]={state:'unknown',date:next,reason:'holidayDesignationUnavailable'};
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'proposed',duration:{status:'unavailable',date:next,reason:'holidayDesignationUnavailable'},formulaParts:[]});
 });
 it('does not require an unused calendar/formula date, and never defaults a missing used class direction',()=>{
  const f=fixture();f.context.selected.policy.overtime.splitAtMidnight=false;
  f.formulas.references[1]={date:next,state:'unavailable',reason:'formulaInactive'};
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'proposed',duration:{status:'calculated',payableMinutes:60},formulaParts:[{date}]});
  f.formulas.references[0]={date,state:'unavailable',reason:'formulaInactive'};
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'proposed',duration:{status:'unavailable',reason:'formulaAllocationUnavailable'},formulaParts:[]});
 });
});
