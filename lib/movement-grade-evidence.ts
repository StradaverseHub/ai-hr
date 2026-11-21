import {originalHireDecisionPreimage} from './movement-information-evidence';

type Event={id:string;eventType:string;sequence:number;occurredAt:Date;actorId:string|null;payload:unknown};
type Row={id:string;kind:string;groupId:string|null;effectiveDate:string;status:string};
type Revision={date:string;sequence:number;gradeId:string|null;deliberate:boolean};
type Correction={sequence:number;from:string;until:string|null;gradeId:string|null;replaces:number[]};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const tag=(event:Event)=>object(object(event.payload).movement);
const grade=(value:unknown):value is string|null=>value===null||typeof value==='string';
const date=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export const isGradeCorrection=(event:Pick<Event,'eventType'|'payload'>)=>event.eventType==='employment.information.corrected'&&Array.isArray(object(event.payload).fields)&&(object(event.payload).fields as unknown[]).includes('gradeId');

/** One canonical business-date grade replay. Technical inverses restore their source decision's
 * boundary; entry time is never invented as their Effective Date. Truly unattributed writes remain
 * unknown. Corrections overlay only their explicit field/period, in saved order, so an earlier-dated
 * later correction can replace an older-saved correction without erasing a deliberate later movement. */
export function movementGradeEvidence(events:readonly Event[],rows:readonly Row[],unchangedGrade:string|null){
 const ordered=[...events].sort((a,b)=>a.sequence-b.sequence),groups=new Map<string,Event[]>();
 for(const event of ordered){const key=typeof tag(event).groupId==='string'?String(tag(event).groupId):event.id;const group=groups.get(key)??[];group.push(event);groups.set(key,group);}
 const groupOf=(row:Row)=>groups.get(row.groupId??row.id)??[];
 const rowsById=new Map(rows.map(row=>[row.id,row])),owned=new Set<string>(),revisions:Revision[]=[];
 // Original-hire company scope can clear an unusable grade without recording a grade period.
 // Its explicit review marker is not permission to project today's blank over old payroll dates.
 let unknown=ordered.some(event=>event.eventType==='employment.information.corrected'&&typeof object(event.payload).clearedGradeId==='string');
 for(const row of rows)for(const event of groupOf(row)){
  if(event.eventType!=='employment.grade.changed')continue;
  owned.add(event.id);
  const after=object(event.payload).after;
  if(!grade(after)||!date(row.effectiveDate)){unknown=true;continue;}
  if(row.status==='applied')revisions.push({date:row.effectiveDate,sequence:event.sequence,gradeId:after,deliberate:true});
 }
 const inverseIndex=new Map<string,{id:string;events:Event[];grade:Event}[]>();
 const inverseKey=(actor:string|null,time:number,before:unknown,after:unknown)=>JSON.stringify([actor,time,before,after]);
 for(const [id,group] of groups){
  const inverse=group.filter(event=>event.eventType==='employment.grade.changed');
  if(inverse.length!==1||owned.has(inverse[0].id)||group.some(event=>tag(event).secondary!==true||event.actorId!==inverse[0].actorId||event.occurredAt.getTime()!==inverse[0].occurredAt.getTime()))continue;
  const payload=object(inverse[0].payload),key=inverseKey(inverse[0].actorId,inverse[0].occurredAt.getTime(),payload.before,payload.after),same=inverseIndex.get(key)??[];
  same.push({id,events:group,grade:inverse[0]});inverseIndex.set(key,same);
 }
 const hireCorrections=ordered.filter(event=>event.eventType==='employment.information.corrected'&&object(event.payload).source==='original-hire');
 // Old writers did not persist the inverse group on the reversal marker. Admit that legacy pattern
 // only with one unowned, secondary-only group from this exact actor/transaction timestamp and an
 // independently verified inverse delta. Multiple candidates stay unknown, rather than guessed.
 for(const marker of ordered.filter(event=>event.eventType==='employment.movement.reversed')){
  const payload=object(marker.payload),source=typeof payload.movementId==='string'?rowsById.get(payload.movementId):undefined;
  if(!source||source.status!=='reversed'||!date(source.effectiveDate))continue;
  const originals=groupOf(source).filter(event=>event.eventType==='employment.grade.changed');
  if(originals.length!==1)continue;
  const original=object(originals[0].payload);
  const corrected=originalHireDecisionPreimage(hireCorrections.filter(event=>event.sequence<marker.sequence),source.effectiveDate);
  const restored=Object.hasOwn(corrected,'gradeId')?corrected.gradeId:original.before;
  if(!grade(original.after)||!grade(restored))continue;
  const explicit=typeof payload.reversalGroupId==='string'?payload.reversalGroupId:null;
  const candidates=(inverseIndex.get(inverseKey(marker.actorId,marker.occurredAt.getTime(),original.after,restored))??[]).filter(group=>
   (!explicit||group.id===explicit)&&!owned.has(group.grade.id)&&group.events.every(event=>event.sequence<marker.sequence&&event.sequence>originals[0].sequence));
  if(candidates.length!==1)continue;
  const inverse=candidates[0].grade;
  owned.add(inverse.id);revisions.push({date:source.effectiveDate,sequence:inverse.sequence,gradeId:restored,deliberate:false});
 }
 const native=ordered.filter(event=>event.eventType==='employment.grade.changed');
 if(native.some(event=>!owned.has(event.id)))unknown=true;
 const corrections:Correction[]=[];
 for(const event of ordered.filter(isGradeCorrection)){
  const payload=object(event.payload),after=object(payload.after),rawUntil=object(payload.until).gradeId;
  if(!Object.hasOwn(after,'gradeId')||!grade(after.gradeId)||!date(payload.effectiveOn)||(rawUntil!==undefined&&rawUntil!==null&&!date(rawUntil))){unknown=true;continue;}
  const until=typeof rawUntil==='string'?rawUntil:null;
  if(until!==null&&until<payload.effectiveOn){unknown=true;continue;}
  corrections.push({sequence:event.sequence,from:payload.effectiveOn,until,gradeId:after.gradeId,replaces:Array.isArray(payload.replacedCorrectionSequences)?payload.replacedCorrectionSequences.filter((value):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value<event.sequence):[]});
 }
 const changes=ordered.filter(event=>event.eventType==='employment.grade.changed'||isGradeCorrection(event));
 const first=changes[0],preimage=first?(first.eventType==='employment.grade.changed'?object(first.payload).before:object(object(first.payload).before).gradeId):unchangedGrade;
 const baselineKnown=grade(preimage),baseline:string|null=grade(preimage)?preimage:null;
 revisions.sort((a,b)=>a.date.localeCompare(b.date)||a.sequence-b.sequence);
 const deliberate=revisions.filter(revision=>revision.deliberate);
 for(const correction of corrections){
  const boundary=deliberate.find(revision=>revision.date>correction.from||revision.date===correction.from&&revision.sequence>correction.sequence)?.date;
  if(boundary&&(correction.until===null||boundary<correction.until))correction.until=boundary;
 }
 return {at(asOf:string):{gradeId:string|null;gradeKnown:boolean}{
  if(!date(asOf)||unknown)return {gradeId:null,gradeKnown:false};
  let value=baseline,known=baselineKnown;
  for(const revision of revisions)if(revision.date<=asOf){value=revision.gradeId;known=true;}
  const replaced=new Set(corrections.filter(correction=>correction.from<=asOf).flatMap(correction=>correction.replaces));
  // Newer saved corrections override older saved corrections in their overlapping business span.
  // An explicit future deliberate grade decision remains the field's owner from its date onward.
  for(const correction of corrections){
   if(replaced.has(correction.sequence)||correction.from>asOf||correction.until!==null&&asOf>=correction.until)continue;
   value=correction.gradeId;known=true;
  }
  return {gradeId:known?value:null,gradeKnown:known};
 }};
}
