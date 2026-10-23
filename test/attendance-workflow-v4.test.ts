import {describe,expect,it} from 'vitest';
import {parseAttendanceV4Route,resolveAttendanceV4Route,validateAttendanceV4Workflow,attendanceV4LevelProgress,attendanceCcAddress,type AttendanceV4Route} from '../lib/attendance-workflow-v4';
import type {AttendanceV3Identity,AttendanceV3ParticipantDecision} from '../lib/attendance-workflow-v3';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const identity=(n:number):AttendanceV3Identity=>({employmentId:uuid(n),personId:uuid(n+100),userId:uuid(n+200),name:`Fictional ${n}`});
const applicant=identity(1),superior=identity(2),second=identity(3),named=identity(4);
const route=(mode:'any_one'|'all_required'|'sequential'='all_required'):AttendanceV4Route=>({routingVersion:4,stages:[{name:'Level 1',mode,sources:[{kind:'direct_manager',depth:1},{kind:'specific_employee',employmentIds:[named.employmentId]}],hrAlternative:false}],cc:[]});
const resolver={superior:async(depth:number)=>({ok:true as const,identity:depth===1?superior:second}),selectedEmployee:async(id:string)=>({ok:true as const,identity:id===applicant.employmentId?applicant:named}),hasHrAlternative:async()=>true,ccAddress:async(actor:AttendanceV3Identity)=>`fictional-${actor.employmentId.slice(-2)}@example.invalid`};
const evidence=(slot:string,actor:AttendanceV3Identity,decision:'approved'|'rejected'='approved'):AttendanceV3ParticipantDecision=>({slot,decision,actualPersonId:actor.personId,actualUserId:actor.userId});
describe('explicit v4 multiple-source approval',()=>{
 it('keeps common metadata and assignment validation at the canonical owner',()=>{
  const input={...route(),companyId:uuid(90),applicationType:'irregularity',code:'V4',name:' Fictional mixed approval ',priority:100,criteria:{departmentIds:[uuid(91),uuid(91)]},active:true};
  expect(validateAttendanceV4Workflow(input)).toMatchObject({routingVersion:4,name:'Fictional mixed approval',criteria:{departmentIds:[uuid(91)]},stages:input.stages});
  for(const patch of [{priority:-1},{companyId:'company-name'},{criteria:{invented:['one']}},{criteria:{departmentIds:['department-name']}}])expect(()=>validateAttendanceV4Workflow({...input,...patch})).toThrow();
 });
 it('freezes ordered source provenance and keeps superior depth independent of level ordinal',async()=>{
  const input=route();input.stages[0].sources=[{kind:'direct_manager',depth:2},{kind:'direct_manager',depth:1}];
  const frozen=await resolveAttendanceV4Route(input,applicant,resolver);
  expect(frozen.stages[0].approvers.map(actor=>[actor.employmentId,actor.slot,actor.sourceIndex,actor.hierarchyDepth])).toEqual([[second.employmentId,'0:0',0,2],[superior.employmentId,'0:1',1,1]]);
 });
 it('all-required accepts unfinished people in any order and advances only after everyone',async()=>{
  const level=(await resolveAttendanceV4Route(route(),applicant,resolver)).stages[0];
  const first=evidence('0:1',named);
  expect(attendanceV4LevelProgress(level,[first],0)).toEqual({complete:false,rejected:false,pendingSlots:['0:0']});
  expect(attendanceV4LevelProgress(level,[first,evidence('0:0',superior)],0).complete).toBe(true);
 });
 it('sequential refuses the same out-of-order evidence and any-one completes with the first decision',async()=>{
  const sequential=(await resolveAttendanceV4Route(route('sequential'),applicant,resolver)).stages[0];
  expect(()=>attendanceV4LevelProgress(sequential,[evidence('0:1',named)],0)).toThrow();
  const any=(await resolveAttendanceV4Route(route('any_one'),applicant,resolver)).stages[0];
  expect(attendanceV4LevelProgress(any,[evidence('0:1',named)],0)).toEqual({complete:true,rejected:false,pendingSlots:[]});
  expect(()=>attendanceV4LevelProgress(any,[evidence('0:1',named),evidence('0:0',superior)],0)).toThrow();
 });
 it('rejection is terminal and one Person or login cannot fill two slots',async()=>{
  const level=(await resolveAttendanceV4Route(route(),applicant,resolver)).stages[0];
  expect(attendanceV4LevelProgress(level,[evidence('0:1',named,'rejected')],0)).toEqual({complete:true,rejected:true,pendingSlots:[]});
  expect(()=>attendanceV4LevelProgress(level,[evidence('0:0',superior),evidence('0:1',superior)],0)).toThrow();
  await expect(resolveAttendanceV4Route(route(),applicant,{...resolver,selectedEmployee:async()=>({ok:true,identity:{...named,personId:superior.personId}})})).rejects.toMatchObject({problem:{code:'duplicate_person'}});
 });
 it('rejects an implicit HR fallback for a mixed-source group and duplicate configured employments',()=>{
  const mixed=route();mixed.stages[0].hrAlternative=true;expect(()=>parseAttendanceV4Route(mixed)).toThrow();
  const duplicated=route();duplicated.stages[0].sources.push({kind:'specific_employee',employmentIds:[named.employmentId]});expect(()=>parseAttendanceV4Route(duplicated)).toThrow();
  expect(()=>parseAttendanceV4Route({...route(),stages:[]})).toThrow();
  expect(()=>parseAttendanceV4Route({...route(),unknown:true})).toThrow();
 });
});
describe('CC is a separate notification-only recipient set',()=>{
 it('merges the same custom and internal destination without adding an approver',async()=>{
  const input=route(),address=await resolver.ccAddress(named);
  input.cc=[{kind:'custom_email',addresses:[address.toUpperCase(),address]},{kind:'specific_employee',employmentIds:[named.employmentId]}];
  const frozen=await resolveAttendanceV4Route(input,applicant,resolver);
  expect(frozen.cc).toHaveLength(1);expect(frozen.cc[0]).toMatchObject({kind:'employee',address,userId:named.userId});expect(frozen.stages[0].approvers).toHaveLength(2);
 });
 it('refuses header injection, display-name syntax and unresolved or substituted employee recipients',async()=>{
  for(const address of ['x@example.invalid\r\nBcc:victim@example.invalid','Name <x@example.invalid>','x@example.invalid,y@example.invalid',''])expect(()=>attendanceCcAddress(address)).toThrow();
  const input=route();input.cc=[{kind:'specific_employee',employmentIds:[named.employmentId]}];
  await expect(resolveAttendanceV4Route(input,applicant,{...resolver,ccAddress:async()=>null})).rejects.toMatchObject({code:'unavailableCc'});
  input.cc=[{kind:'specific_employee',employmentIds:[uuid(5)]}];
  await expect(resolveAttendanceV4Route(input,applicant,{...resolver,selectedEmployee:async(id)=>({ok:true,identity:id===named.employmentId?named:superior})})).rejects.toMatchObject({code:'unavailableCc'});
 });
});
