/**
 * Board eb01800b — WHICH RECORD starts a dated assignment version.
 *
 * A dated change that predates the assignment version in force is refused (AssignmentBeforeCurrentStartError).
 * Until this item the refusal named only a date, and the version behind it was often invisible: an
 * Information-Only Correction of Department / Position, an organisation-structure (mapping) split or an untagged
 * assignment write projects no Movement row (tagged-event projection rule 30325fc1). HR could not find it.
 *
 * This module answers, for each LIVE assignment version, what created its start date:
 *   - correction — an `employment.information.corrected` that inserted the version (its `inserted` ids, or the
 *     ADR-0163 `assignmentVersionId` of a correction saved before the dated-corrections ADR), or the version
 *     that boundary became after a re-application (`employment.information.boundary.reapplied`);
 *   - mapping    — an `employment.organisation.projected` piece that starts on a mapping date;
 *   - movement   — a tagged assignment leg or a history movement (the version starts on a Movement row's date);
 *   - untagged   — an untagged assignment write, or no recorded creator at all.
 * Every replacement chain (`assignment: [{supersededId, replacementId}]`, the same chain liveOf in
 * core/movement-history.ts follows) is followed to the live row, so a version carried forward by a later
 * correction keeps the creator of its start date.
 *
 * Read-only and set-based: one read of the employee's versions and one of the employee's events, plus one
 * name lookup. The caller owns authorization (every caller already holds the employee's view or maintain
 * authority inside its transaction); this module adds none and widens none. It imports only the schema so the
 * assignment writers in core/org.ts can use it without an import cycle.
 */
import {and,asc,eq,inArray,isNull,or} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {appUser,assignment,domainEvent,person} from '../db/schema';

/** The dated placement fields a record can change, in display order. */
export const ASSIGNMENT_RECORD_FIELDS=['companyId','employmentType','businessUnitId','departmentId','positionId'] as const;
export type AssignmentRecordField=(typeof ASSIGNMENT_RECORD_FIELDS)[number];
export type AssignmentRecordKind='correction'|'mapping'|'movement'|'untagged';
export type AssignmentRecordSource={
 versionId:string;
 kind:AssignmentRecordKind;
 /** The version's start date: the day the record takes effect. */
 effectiveDate:string;
 /** The fields the record names: a correction's recorded fields, otherwise the fields that differ from the version before it. */
 fields:AssignmentRecordField[];
 /** A correction's recorded before/after labels for those fields (empty for the other kinds). */
 values:{field:AssignmentRecordField;before:string|null;after:string|null}[];
 /** False when the version repeats the values of the version before it. */
 changesValues:boolean;
 eventId:string|null;
 sequence:number|null;
 actorId:string|null;
 actorName:string|null;
 recordedAt:string|null;
 /** The movement tag type when kind is 'movement'. */
 movementType:string|null;
};
export type AssignmentRecordVersion={id:string;validFrom:string;validTo:string|null}&Record<AssignmentRecordField,string|null>;
export type AssignmentRecordEvent={id:string;eventType:string;aggregateId:string;payload:unknown;sequence:number;occurredAt:Date;actorId:string|null};

const INFORMATION_CORRECTED='employment.information.corrected';
const BOUNDARY_REAPPLIED='employment.information.boundary.reapplied';
const ORGANISATION_PROJECTED='employment.organisation.projected';
const HISTORY_RECORDED='employment.history.recorded';
const HISTORY_REVERTED='employment.history.reverted';
const MOVEMENT_REVERSED='employment.movement.reversed';
/** The event types that create, carry or retire an assignment version's start. */
export const ASSIGNMENT_RECORD_EVENT_TYPES=[
 INFORMATION_CORRECTED,'employment.assignment.changed','assignment.transferred','assignment.entity-backfilled','employment.hire.corrected',
 HISTORY_RECORDED,HISTORY_REVERTED,'employment.history.start.aligned',BOUNDARY_REAPPLIED,ORGANISATION_PROJECTED,MOVEMENT_REVERSED,
] as const;

type Rec=Record<string,unknown>;
const obj=(value:unknown):Rec=>value&&typeof value==='object'&&!Array.isArray(value)?value as Rec:{};
const arr=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const str=(value:unknown):string|null=>typeof value==='string'&&value?value:null;
const isRecordField=(field:unknown):field is AssignmentRecordField=>typeof field==='string'&&(ASSIGNMENT_RECORD_FIELDS as readonly string[]).includes(field);
const liveSpan=(v:{validFrom:string;validTo:string|null})=>v.validTo===null||v.validTo>v.validFrom;

type Claim={kind:AssignmentRecordKind;event:AssignmentRecordEvent;fields?:AssignmentRecordField[];values?:AssignmentRecordSource['values'];movementType?:string|null};

/** Pure: the creator of every version's start (versions oldest first, zero-length rows excluded). The first version
 *  (the hire record) has no entry. Events in any order; they are read in ledger order. */
export function resolveAssignmentRecordSources(versions:readonly AssignmentRecordVersion[],events:readonly AssignmentRecordEvent[]):Map<string,AssignmentRecordSource>{
 const ordered=[...events].sort((a,b)=>a.sequence-b.sequence);
 const sorted=[...versions].filter(liveSpan).sort((a,b)=>a.validFrom.localeCompare(b.validFrom));
 const forward=new Map<string,string>();
 const link=(from:string|null,to:string|null)=>{if(from&&to&&from!==to)forward.set(from,to);};
 for(const e of ordered){
  const p=obj(e.payload);
  for(const r of arr(p.assignment)){const x=obj(r);link(str(x.supersededId),str(x.replacementId));}
  if(e.eventType===BOUNDARY_REAPPLIED)for(const r of arr(p.boundaries)){const x=obj(r);link(str(x.liftedId),str(x.insertedId));}
  if(e.eventType===ORGANISATION_PROJECTED){
   // The piece that keeps the source's start inherits the source's creator; the other pieces start on mapping dates.
   const projection=obj(p.projection),from=str(obj(projection.source).validFrom);
   const same=arr(projection.replacements).map(obj).find(r=>str(r.validFrom)===from);
   link(str(p.sourceAssignmentId)??e.aggregateId,str(same?.id));
  }
 }
 const follow=(id:string)=>{let cur=id;const seen=new Set<string>();while(forward.has(cur)&&!seen.has(cur)){seen.add(cur);cur=forward.get(cur)!;}return cur;};
 const live=new Set(sorted.map(v=>v.id));
 const claims=new Map<string,Claim>();
 const claim=(id:string|null,c:Claim)=>{if(!id)return;const to=follow(id);if(live.has(to))claims.set(to,c);};
 // Rolled-back movements and reverted history movements own no date.
 const reversed=new Set<string>();
 for(const e of ordered){const p=obj(e.payload);if(e.eventType===MOVEMENT_REVERSED&&str(p.movementId))reversed.add(str(p.movementId)!);if(e.eventType===HISTORY_REVERTED&&str(p.reversalOf))reversed.add(str(p.reversalOf)!);}
 const reversedGroups=new Set<string>();
 for(const e of ordered)if(reversed.has(e.id)){const g=str(obj(obj(e.payload).movement).groupId);if(g)reversedGroups.add(g);}
 const movementDates=new Map<string,string|null>();
 for(const e of ordered){
  const p=obj(e.payload),tag=obj(p.movement),type=str(tag.type),group=str(tag.groupId);
  if(e.eventType===INFORMATION_CORRECTED){
   const legacy=!('inserted' in p)&&!('assignment' in p);
   const created=legacy?[str(p.assignmentVersionId)]:arr(p.inserted).map(str);
   const fields=arr(p.fields).filter(isRecordField);
   const before=obj(p.beforeLabels),after=obj(p.afterLabels);
   const values=fields.map(field=>({field,before:str(before[field]),after:str(after[field])}));
   for(const id of created)claim(id,{kind:'correction',event:e,fields,values});
  }else if(e.eventType===ORGANISATION_PROJECTED){
   const projection=obj(p.projection),from=str(obj(projection.source).validFrom);
   for(const r of arr(projection.replacements).map(obj))if(str(r.validFrom)!==from)claim(str(r.id),{kind:'mapping',event:e,fields:['businessUnitId']});
  }else if(e.eventType==='employment.assignment.changed'||e.eventType==='assignment.transferred'){
   const gone=reversed.has(e.id)||(group!==null&&reversedGroups.has(group));
   claim(e.aggregateId,{kind:type&&!gone?'movement':'untagged',event:e,movementType:type});
   const date=str(p.effectiveDate);
   if(type&&!gone&&date)movementDates.set(date,type);
  }else if(e.eventType===HISTORY_RECORDED){
   const date=str(p.effectiveDate);
   if(date&&!reversed.has(e.id))movementDates.set(date,str(p.type)??str(p.kind));
  }
 }
 const out=new Map<string,AssignmentRecordSource>();
 for(let index=1;index<sorted.length;index++){
  const v=sorted[index],prev=sorted[index-1];
  const changed=ASSIGNMENT_RECORD_FIELDS.filter(f=>(v[f]??null)!==(prev[f]??null));
  const c=claims.get(v.id);
  // A correction or a mapping piece owns its own start; otherwise a Movement row on the same date owns it.
  const kind:AssignmentRecordKind=c&&(c.kind==='correction'||c.kind==='mapping')?c.kind:movementDates.has(v.validFrom)?'movement':c?.kind??'untagged';
  const fields=c&&(kind==='correction'||kind==='mapping')&&c.fields?.length?c.fields:changed;
  out.set(v.id,{
   versionId:v.id,kind,effectiveDate:v.validFrom,fields:[...fields],values:kind==='correction'?c?.values??[]:[],changesValues:changed.length>0,
   eventId:c?.event.id??null,sequence:c?.event.sequence??null,actorId:c?.event.actorId??null,actorName:null,
   recordedAt:c?c.event.occurredAt.toISOString():null,
   movementType:kind==='movement'?(c?.kind==='movement'?c.movementType??null:movementDates.get(v.validFrom)??null):null,
  });
 }
 return out;
}

async function readRecordFactsTx(tx:Tx,tenantId:string,employmentId:string,includeVersionId?:string){
 const rows=await tx.select({id:assignment.id,validFrom:assignment.validFrom,validTo:assignment.validTo,companyId:assignment.companyId,employmentType:assignment.employmentType,
  businessUnitId:assignment.businessUnitId,departmentId:assignment.departmentId,positionId:assignment.positionId}).from(assignment)
  .where(and(eq(assignment.tenantId,tenantId),eq(assignment.employmentId,employmentId),includeVersionId?or(isNull(assignment.supersededAt),eq(assignment.id,includeVersionId)):isNull(assignment.supersededAt)))
  .orderBy(asc(assignment.validFrom),asc(assignment.createdAt));
 const versions:AssignmentRecordVersion[]=rows.filter(liveSpan).map(r=>({...r,employmentType:r.employmentType as string|null}));
 const events:AssignmentRecordEvent[]=await tx.select({id:domainEvent.id,eventType:domainEvent.eventType,aggregateId:domainEvent.aggregateId,payload:domainEvent.payload,sequence:domainEvent.sequence,occurredAt:domainEvent.occurredAt,actorId:domainEvent.actorId})
  .from(domainEvent).where(and(eq(domainEvent.tenantId,tenantId),eq(domainEvent.subjectEmploymentId,employmentId),inArray(domainEvent.eventType,[...ASSIGNMENT_RECORD_EVENT_TYPES])))
  .orderBy(asc(domainEvent.sequence));
 return {versions,events};
}
async function nameActorsTx(tx:Tx,sources:readonly AssignmentRecordSource[]){
 const ids=[...new Set(sources.map(s=>s.actorId).filter((id):id is string=>!!id))];
 if(!ids.length)return;
 const names=await tx.select({id:appUser.id,name:person.fullName}).from(appUser).innerJoin(person,eq(person.id,appUser.personId)).where(inArray(appUser.id,ids));
 const byId=new Map(names.map(n=>[n.id,n.name]));
 for(const s of sources)s.actorName=s.actorId?byId.get(s.actorId)??null:null;
}

/** Every live version (oldest first) with the creator of its start; the first version (the hire record) has none. */
export async function assignmentRecordSourcesTx(tx:Tx,tenantId:string,employmentId:string){
 const {versions,events}=await readRecordFactsTx(tx,tenantId,employmentId);
 const sources=resolveAssignmentRecordSources(versions,events);
 await nameActorsTx(tx,[...sources.values()]);
 return {versions,sources};
}

/**
 * The record a change dated `after` runs into: the named version (`versionId`, which may already be superseded
 * inside the caller's transaction), else the earliest live version starting after `after` — preferring one that is
 * not an information correction, because a correction boundary is lifted for a movement (Decision 5) and the other
 * kinds are what actually stop it. Null when the date precedes the first record (that is a hire-date question) or
 * when nothing starts after it.
 */
export async function blockingAssignmentSourceTx(tx:Tx,tenantId:string,employmentId:string,after:string,opts:{versionId?:string}={}):Promise<AssignmentRecordSource|null>{
 const {versions,events}=await readRecordFactsTx(tx,tenantId,employmentId,opts.versionId);
 const sources=resolveAssignmentRecordSources(versions,events);
 let chosen:AssignmentRecordSource|null=null;
 if(opts.versionId)chosen=sources.get(opts.versionId)??null;
 else{
  const first=[...versions].sort((a,b)=>a.validFrom.localeCompare(b.validFrom))[0];
  if(!first||after<first.validFrom)return null;
  const later=[...sources.values()].filter(s=>s.effectiveDate>after).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate));
  chosen=later.find(s=>s.kind!=='correction')??later.find(s=>s.changesValues)??later[0]??null;
 }
 if(chosen)await nameActorsTx(tx,[chosen]);
 return chosen;
}
