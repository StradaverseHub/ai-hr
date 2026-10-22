/** Source serialization only; these facts cannot authorize an approval, final effect or money. */
import {describe,expect,it} from 'vitest';
import {attendancePolicyApprovalInput,type PolicyApprovalSourceRow} from '../packs/attendance/policy-approval-input';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import type {ResolvedAttendanceGroupPolicy} from '../core/attendance-group-policy';
const id='00000000-0000-4000-8000-000000000001';
function policy():ResolvedAttendanceGroupPolicy{return {id,companyId:id,ruleId:id,ordinal:1,effectiveFrom:'2026-10-23',activation:{epoch:1,actorUserId:id,recordedAt:'2026-10-22T00:00:00.000Z',reason:'Fictional future policy'},policy:{version:1,
 clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:true},
 overtime:{enabled:true,beforeShift:false,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:false,offsetLateness:false,approval:'manual',autoMethod:'actual',rounding:{mode:'none',step:null},
 days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(day=>[day,{minimumMinutes:0,maximumMinutes:null,patternVersionId:null}])) as AttendanceGroupPolicy['overtime']['days']}}};}
function row():PolicyApprovalSourceRow{return {id,createdAt:new Date('2026-10-22T01:00:00.001Z'),status:'approved',requestedOtMinutes:120,approvedOtMinutes:90,otApprovalMethod:'smaller_of',
 decidedByEmploymentId:id,decidedAt:new Date('2026-10-22T02:00:00.002Z'),appliedAt:new Date('2026-10-23T12:00:00.003Z'),cancelledAt:null,plannedStartTime:'18:00:00',plannedEndTime:'20:00:00'};}
describe('canonical policy application source facts',()=>{
 it('retains exact real timestamp strings and distinct enabling-user/deciding-employment fields',()=>{
  const p=policy(),r=row(),before=structuredClone({p,r}),result=attendancePolicyApprovalInput(p,[r]);
  expect(result).toMatchObject({authority:'sourceOnly',activation:p.activation,requests:[{id,createdAt:'2026-10-22T01:00:00.001Z',decidedAt:'2026-10-22T02:00:00.002Z',appliedAt:'2026-10-23T12:00:00.003Z',decidedByEmploymentId:id}]});
  expect({p,r}).toEqual(before);expect(Object.hasOwn(result,'transferable')).toBe(false);
 });
 it('does not promote legacy display labels or scalar approval to an approved physical interval',()=>{
  const result=attendancePolicyApprovalInput(policy(),[row()]);
  expect(result.requests[0]).toMatchObject({requestedMinutes:120,approvedMinutes:90,method:'smaller_of',plannedWindow:{authority:'auditOnly',startLabel:'18:00:00',endLabel:'20:00:00'}});
  expect(Object.hasOwn(result.requests[0],'intervals')).toBe(false);
 });
 it('keeps exact decision, landing and cancellation instants visible to freshness independently',()=>{
  const p=policy(),r=row(),before=JSON.stringify(attendancePolicyApprovalInput(p,[r]));
  for(const field of ['createdAt','decidedAt','appliedAt','cancelledAt'] as const){
   const changed={...r,[field]:new Date('2026-10-23T14:00:00.999Z')};
   expect(JSON.stringify(attendancePolicyApprovalInput(p,[changed]))).not.toBe(before);
  }
 });
 it('retains pending and rejected state and never turns Auto configuration into a synthetic approved request',()=>{
  const p=policy();p.policy.overtime.approval='auto';p.policy.overtime.autoMethod='intersect';
  for(const status of ['pending','rejected'] as const){
   const r={...row(),status,approvedOtMinutes:null,decidedAt:null,appliedAt:null};
   expect(attendancePolicyApprovalInput(p,[r])).toMatchObject({authority:'sourceOnly',mode:'auto',autoMethod:'intersect',requests:[{status,approvedMinutes:null,decidedAt:null,appliedAt:null}]});
  }
  expect(attendancePolicyApprovalInput(p,[]).requests).toEqual([]);
 });
 it('keeps the canonical application-history bound',()=>{
  expect(()=>attendancePolicyApprovalInput(policy(),Array.from({length:501},()=>row()))).toThrow('bounded');
 });
});
