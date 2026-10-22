/** Explicit v4 configuration. Existing v1/v2/v3 parsing and frozen routes keep their meanings. */
import {z} from 'zod';
import {attendanceLevelName,validateAttendanceWorkflow,type AttendanceWorkflowInput} from './attendance-workflow';
import {ATTENDANCE_V3_LIMITS,AttendanceLevelError,parseAttendanceV3Route,resolveAttendanceV3Route,type AttendanceV3Source,type AttendanceV3Identity,type AttendanceV3Resolver,type AttendanceV3Participant,type AttendanceV3ParticipantDecision,type AttendanceV3LevelProgress} from './attendance-workflow-v3';
export type AttendanceV4Mode='any_one'|'all_required'|'sequential';
export type AttendanceV4Level={name:string;mode:AttendanceV4Mode;sources:AttendanceV3Source[];hrAlternative:boolean};
export type AttendanceCcSource=AttendanceV3Source|{kind:'custom_email';addresses:string[]};
export type AttendanceV4Route={routingVersion:4;stages:AttendanceV4Level[];cc:AttendanceCcSource[]};
export type AttendanceV4WorkflowInput=Omit<AttendanceWorkflowInput,'routingVersion'|'stages'>&AttendanceV4Route;
export type AttendanceV4Participant=AttendanceV3Participant&{sourceIndex:number};
export type AttendanceV4FrozenLevel=Omit<AttendanceV4Level,'sources'>&{sources:AttendanceV3Source[];approvers:AttendanceV4Participant[]};
export type AttendanceCcRecipient={address:string;kind:'employee';employmentId:string;personId:string;userId:string}|{address:string;kind:'custom_email'};
export type AttendanceV4FrozenRoute={routingVersion:4;stages:AttendanceV4FrozenLevel[];cc:AttendanceCcRecipient[]};
export class AttendanceCcError extends Error {
 constructor(public readonly code:'invalidCc'|'unavailableCc'){super(code);this.name='AttendanceCcError';}
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=(levelIndex:number|null,code:'invalid_route'|'invalid_level'|'invalid_mode'|'invalid_source'|'too_many_participants'|'duplicate_employment'|'duplicate_person'|'duplicate_login'='invalid_route'):never=>{throw new AttendanceLevelError({code,levelIndex});};
/** Same plain ASCII email contract as the private notification transport, with no header syntax. */
export function attendanceCcAddress(raw:unknown):string {
 if(typeof raw!=='string'||!z.email().max(320).regex(/^[\x21-\x7e]+$/).safeParse(raw).success)throw new AttendanceCcError('invalidCc');
 return raw.toLowerCase();
}
function source(raw:unknown,levelIndex:number):AttendanceV3Source {
 try{return parseAttendanceV3Route({routingVersion:3,stages:[{name:attendanceLevelName(0),mode:'sequential',source:raw,hrAlternative:false}]}).stages[0].source;}
 catch(error){if(error instanceof AttendanceLevelError)throw new AttendanceLevelError({...error.problem,levelIndex});throw error;}
}
export function parseAttendanceV4Route(raw:unknown):AttendanceV4Route {
 if(!object(raw)||!exact(raw,['routingVersion','stages','cc'])||raw.routingVersion!==4||!Array.isArray(raw.stages)||raw.stages.length<1||raw.stages.length>ATTENDANCE_V3_LIMITS.levels)fail(null);
 const employmentIds=new Set<string>();let total=0;
 const stages=raw.stages.map((entry,index):AttendanceV4Level=>{
  if(!object(entry)||!exact(entry,['name','mode','sources','hrAlternative'])||typeof entry.name!=='string'||entry.name.length>100||typeof entry.hrAlternative!=='boolean')fail(index,'invalid_level');
  if(!['any_one','all_required','sequential'].includes(String(entry.mode)))fail(index,'invalid_mode');
  if(!Array.isArray(entry.sources)||!entry.sources.length||entry.sources.length>ATTENDANCE_V3_LIMITS.participantsPerLevel)fail(index,'invalid_source');
  const sources=entry.sources.map(value=>source(value,index));
  if(entry.hrAlternative&&(sources.length!==1||sources[0].kind!=='direct_manager'))fail(index,'invalid_source');
  let count=0;
  for(const item of sources){
   count+=item.kind==='specific_employee'?item.employmentIds.length:1;
   if(item.kind==='specific_employee')for(const id of item.employmentIds){if(employmentIds.has(id))fail(index,'duplicate_employment');employmentIds.add(id);}
  }
  total+=count;if(count>ATTENDANCE_V3_LIMITS.participantsPerLevel||total>ATTENDANCE_V3_LIMITS.participantsPerWorkflow)fail(index,'too_many_participants');
  return {name:attendanceLevelName(index),mode:entry.mode as AttendanceV4Mode,sources,hrAlternative:entry.hrAlternative};
 });
 if(!Array.isArray(raw.cc)||raw.cc.length>20)throw new AttendanceCcError('invalidCc');
 let recipients=0;
 const cc=raw.cc.map((entry):AttendanceCcSource=>{
  if(!object(entry))throw new AttendanceCcError('invalidCc');
  if(entry.kind==='custom_email'){
   if(!exact(entry,['kind','addresses'])||!Array.isArray(entry.addresses)||!entry.addresses.length||entry.addresses.length>50)throw new AttendanceCcError('invalidCc');
   const addresses=[...new Set(entry.addresses.map(attendanceCcAddress))];recipients+=addresses.length;return {kind:'custom_email',addresses};
  }
  try{const item=source(entry,0);recipients+=item.kind==='specific_employee'?item.employmentIds.length:1;return item;}catch{throw new AttendanceCcError('invalidCc');}
 });
 if(recipients>50)throw new AttendanceCcError('invalidCc');
 return {routingVersion:4,stages,cc};
}
export function validateAttendanceV4Workflow(raw:unknown):AttendanceV4WorkflowInput {
 if(!object(raw)||Object.keys(raw).some(key=>!['companyId','applicationType','routingVersion','code','name','description','priority','criteria','stages','cc','active'].includes(key)))fail(null);
 const common=validateAttendanceWorkflow({...raw,routingVersion:2,stages:[{name:'Level 1',level:{kind:'direct_manager',employmentId:null,alternates:[]}}]} as AttendanceWorkflowInput);
 return {...common,...parseAttendanceV4Route({routingVersion:4,stages:raw.stages,cc:raw.cc})};
}
export async function resolveAttendanceV4Route(raw:unknown,applicant:AttendanceV3Identity,resolver:AttendanceV3Resolver&{ccAddress:(identity:AttendanceV3Identity)=>Promise<string|null>}):Promise<AttendanceV4FrozenRoute> {
 const route=parseAttendanceV4Route(raw),seenEmployment=new Set<string>(),seenPeople=new Set<string>(),seenUsers=new Set<string>();
 const stages:AttendanceV4FrozenLevel[]=[];
 for(const [index,level] of route.stages.entries()){
  const approvers:AttendanceV4Participant[]=[];let hrAlternative=false;
  for(const [sourceIndex,item] of level.sources.entries()){
   let resolved;
   try{resolved=await resolveAttendanceV3Route({routingVersion:3,stages:[{name:level.name,mode:level.mode==='all_required'?'sequential':level.mode,source:item,hrAlternative:level.hrAlternative}]},applicant,resolver);}
   catch(error){if(error instanceof AttendanceLevelError)throw new AttendanceLevelError({...error.problem,levelIndex:index});throw error;}
   hrAlternative ||= resolved.stages[0].hrAlternative;
   for(const actor of resolved.stages[0].approvers){
    if(seenEmployment.has(actor.employmentId))fail(index,'duplicate_employment');
    if(seenPeople.has(actor.personId))fail(index,'duplicate_person');
    if(seenUsers.has(actor.userId))fail(index,'duplicate_login');
    seenEmployment.add(actor.employmentId);seenPeople.add(actor.personId);seenUsers.add(actor.userId);
    approvers.push({...actor,slot:`${index}:${approvers.length}`,sourceIndex});
   }
  }
  stages.push({...level,hrAlternative,approvers});
 }
 const cc=new Map<string,AttendanceCcRecipient>();
 const add=async(identity:AttendanceV3Identity,expectedEmployment?:string)=>{
  const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if(![identity.employmentId,identity.personId,identity.userId].every(id=>uuid.test(id))||typeof identity.name!=='string'||!identity.name.trim()||expectedEmployment&&identity.employmentId.toLowerCase()!==expectedEmployment.toLowerCase())throw new AttendanceCcError('unavailableCc');
  const raw=await resolver.ccAddress(identity);if(!raw)throw new AttendanceCcError('unavailableCc');
  const address=attendanceCcAddress(raw);cc.set(address,{kind:'employee',address,employmentId:identity.employmentId,personId:identity.personId,userId:identity.userId});
 };
 for(const item of route.cc){
  if(item.kind==='custom_email'){for(const address of item.addresses)if(!cc.has(address))cc.set(address,{kind:'custom_email',address});continue;}
  if(item.kind==='direct_manager'){
   const result=await resolver.superior(item.depth);if(!result.ok||result.identity.personId.toLowerCase()===applicant.personId.toLowerCase())throw new AttendanceCcError('unavailableCc');await add(result.identity);
  }else for(const id of item.employmentIds){
   if(id.toLowerCase()===applicant.employmentId.toLowerCase()){await add(applicant);continue;}
   const result=await resolver.selectedEmployee(id);if(!result.ok)throw new AttendanceCcError('unavailableCc');await add(result.identity,id);
  }
 }
 return {routingVersion:4,stages,cc:[...cc.values()]};
}
/** Read projection only. The immutable SQL participant owner remains the decision authority. */
export function attendanceV4LevelProgress(level:AttendanceV4FrozenLevel,evidence:readonly AttendanceV3ParticipantDecision[],index:number):AttendanceV3LevelProgress {
 const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
 const slots=level.approvers.map(actor=>actor.slot),hr=`${index}:hr`,seen=new Set<string>(),people=new Set<string>(),users=new Set<string>();let rejected=false;
 if(!slots.length&&!level.hrAlternative)throw new AttendanceLevelError({code:'invalid_evidence',levelIndex:index});
 for(const [order,record] of evidence.entries()){
  const alternative=record.slot===hr&&level.hrAlternative;
  if(!uuid.test(record.actualPersonId)||!uuid.test(record.actualUserId)||!slots.includes(record.slot)&&!alternative||seen.has(record.slot)||people.has(record.actualPersonId.toLowerCase())||users.has(record.actualUserId.toLowerCase())||rejected||!['approved','rejected'].includes(record.decision)||level.mode==='any_one'&&order>0||level.mode==='sequential'&&!alternative&&record.slot!==slots[order]||alternative&&(evidence.length!==1||slots.length>1))throw new AttendanceLevelError({code:'invalid_evidence',levelIndex:index});
  seen.add(record.slot);people.add(record.actualPersonId.toLowerCase());users.add(record.actualUserId.toLowerCase());rejected=record.decision==='rejected';
 }
 const complete=rejected||seen.has(hr)||(level.mode==='any_one'?evidence.length>0:slots.length>0&&evidence.length===slots.length),remaining=complete?[]:slots.filter(slot=>!seen.has(slot));
 return {complete,rejected,pendingSlots:complete?[]:[...(level.mode==='sequential'?remaining.slice(0,1):remaining),...(level.hrAlternative?[hr]:[])]};
}
