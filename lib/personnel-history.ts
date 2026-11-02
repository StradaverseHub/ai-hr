import {INFORMATION_FIELDS, type InformationField} from './information-correction';

/** Display order only: canonical movement replay remains chronological. */
export function latestPersonnelHistory<T extends {id:string;effectiveDate:string;recordedAt?:string|null;sortSequence?:number}>(rows:readonly T[]):T[]{
 return [...rows].sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate)||(b.recordedAt??'').localeCompare(a.recordedAt??'')||(b.sortSequence??0)-(a.sortSequence??0)||a.id.localeCompare(b.id));
}
type Event={id:string;eventType:string;sequence:number;payload:unknown};
type Row={id:string;kind:string;sequence:number;groupId:string|null;reversed:unknown;scheduled:boolean;appliedAt:unknown};
export type InformationHistoryCorrection={eventId:string;fields:InformationField[];values:Partial<Record<InformationField,string|null>>;needsReview:boolean};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const groupOf=(event:Event)=>object(object(event.payload).movement).groupId;
function sets(event:Event,field:InformationField){
 const p=object(event.payload),before=object(p.before),after=object(p.after);
 if(event.eventType==='employment.hired')return true;
 if(field==='companyId'&&['employment.company.transferred','employment.company.transfer.reverted'].includes(event.eventType))return before.companyId!==after.companyId;
 if(field==='gradeId'&&event.eventType==='employment.grade.changed')return p.before!==p.after;
 if(field==='employmentType'&&event.eventType==='employment.assignment.changed')return before.employmentType!==after.employmentType;
 return (field==='hiredOn'||field==='joinDate')&&event.eventType==='employment.info.updated'&&Array.isArray(p.fields)&&p.fields.includes(field);
}
/** Corrections amend a fact's existing display lineage, not the immutable ledger or payroll as-of facts.
 * A later explicit writer bounds each field separately. Untagged/unresolvable writers are reviewable,
 * never silently assigned to a different movement. Both manual and imported correction events use this.
 */
export function personnelInformationCorrections(events:readonly Event[],rows:readonly Row[]):Map<string,InformationHistoryCorrection[]>{
 const result=new Map<string,InformationHistoryCorrection[]>(),ordered=[...events].sort((a,b)=>a.sequence-b.sequence);
 const owner=(event:Event)=>rows.find(row=>row.id===event.id||row.groupId&&row.groupId===groupOf(event));
 const span=(row:Row)=>Math.max(row.sequence,...ordered.filter(event=>row.groupId&&groupOf(event)===row.groupId).map(event=>event.sequence));
 for(const correction of ordered.filter(event=>event.eventType==='employment.information.corrected')){
  const p=object(correction.payload),after=object(p.after),fields=Array.isArray(p.fields)?p.fields:[];
  for(const field of INFORMATION_FIELDS){
   if(!fields.includes(field)||!(typeof after[field]==='string'||after[field]===null))continue;
   const writers=ordered.filter(event=>sets(event,field));
   const source=writers.filter(event=>event.sequence<correction.sequence).at(-1);
   const sourceRow=source?owner(source):rows.find(row=>row.kind==='hired');
   if(!sourceRow||sourceRow.reversed||(sourceRow.scheduled&&!sourceRow.appliedAt)){
    const marker=rows.find(row=>row.kind==='hired')??rows[0];
    if(marker){const list=result.get(marker.id)??[];list.push({eventId:correction.id,fields:[field],values:{},needsReview:true});result.set(marker.id,list);}continue;
   }
   const from=source?source.sequence:0,next=writers.find(event=>event.sequence>from&&event.sequence!==source?.sequence),until=next?.sequence??Infinity;
   for(const row of rows){
    if(row.reversed||(row.scheduled&&!row.appliedAt)||span(row)<from||span(row)>=until)continue;
    const list=result.get(row.id)??[];
    let item=list.find(item=>item.eventId===correction.id&&!item.needsReview);
    if(!item){item={eventId:correction.id,fields:[],values:{},needsReview:false};list.push(item);}
    item.fields.push(field);item.values[field]=after[field] as string|null;result.set(row.id,list);
   }
  }
 }
 return result;
}
