import {todayInKualaLumpur} from './hr-date';
/** Evidence values are recorded facts, not today's employment master substituted into old history. */
export const MOVEMENT_INFORMATION_FIELDS=['hiredOn','joinDate','orgDivision','orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase','employmentCategory','probationValue','probationUnit','extendedProbationValue','extendedProbationUnit','noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit','noticeAfterConfirmationValue','noticeAfterConfirmationUnit','confirmationDate','extendedConfirmationDate','contractStartDate','contractEndDate','internshipEndDate','tenderResignationDate','resignationDate','lastWorkingDate'] as const;
export type MovementInformationField=typeof MOVEMENT_INFORMATION_FIELDS[number];
export type MovementInformationFact={known:boolean;value:string|null;eventId:string|null};
type Event={id:string;eventType:string;sequence:number;occurredAt:Date;payload:unknown};
const obj=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const value=(raw:unknown):string|null|undefined=>raw===null?null:typeof raw==='string'||typeof raw==='number'?String(raw):undefined;
export function movementInformationEvidence(events:readonly Event[],asOf:string,sequence:number,inclusive=true):Record<MovementInformationField,MovementInformationFact>{
 const out=Object.fromEntries(MOVEMENT_INFORMATION_FIELDS.map(field=>[field,{known:false,value:null,eventId:null}])) as Record<MovementInformationField,MovementInformationFact>;
 const candidates:{date:string;sequence:number;id:string;values:Record<string,unknown>}[]=[];
 for(const event of events){
  if(inclusive?event.sequence>sequence:event.sequence>=sequence)continue;
  const payload=obj(event.payload),movement=obj(payload.movement);
  if(event.eventType==='employment.hired'){
   const date=typeof payload.hiredOn==='string'?payload.hiredOn:todayInKualaLumpur(event.occurredAt);
   candidates.push({date,sequence:event.sequence,id:event.id,values:{...obj(payload.employmentInformation),hiredOn:payload.hiredOn}});
  }else if(event.eventType==='employment.info.updated'){
   const date=typeof movement.effectiveDate==='string'?movement.effectiveDate:
    movement.type==='groupJoinDateCorrection'?String(obj(payload.after).hiredOn??todayInKualaLumpur(event.occurredAt)):
    movement.type==='joinDateChange'?String(obj(payload.after).joinDate??todayInKualaLumpur(event.occurredAt)):todayInKualaLumpur(event.occurredAt);
   candidates.push({date,sequence:event.sequence,id:event.id,values:obj(payload.after)});
  }else if(event.eventType==='employment.information.corrected'){
   const date=typeof payload.effectiveOn==='string'?payload.effectiveOn:typeof payload.effectiveDate==='string'?payload.effectiveDate:null;
   if(!date)continue;
   const fields=Array.isArray(payload.fields)?payload.fields:[];
   const values=Object.fromEntries(Object.entries(obj(payload.after)).filter(([field])=>fields.includes(field)&&(!obj(payload.until)[field]||asOf<String(obj(payload.until)[field]))));
   candidates.push({date,sequence:event.sequence,id:event.id,values});
  }
 }
 candidates.sort((a,b)=>a.date.localeCompare(b.date)||a.sequence-b.sequence);
 for(const candidate of candidates){
  if(candidate.date>asOf)continue;
  for(const field of MOVEMENT_INFORMATION_FIELDS){
   if(!Object.hasOwn(candidate.values,field))continue;
   const recorded=value(candidate.values[field]);if(recorded===undefined)continue;
   out[field]={known:true,value:recorded,eventId:candidate.id};
  }
 }
 return out;
}
