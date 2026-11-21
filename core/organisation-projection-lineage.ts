/** Passive native Org projection evidence; no DML or permission owner. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {assignment,domainEvent} from '../db/schema';
import {liveIncarnationOf} from './hire-correction';
import {assignmentProjectionImage,ASSIGNMENT_PROJECTION_IMAGE_KEYS as imageKeys,type AssignmentProjectionImage as Image} from '../lib/assignment-projection-image';

type ProjectionEvent={id:string;eventType:string;aggregateId:string;payload:unknown};
export class OrganisationProjectionLineageError extends Error{
 constructor(){super('Personnel must reconcile the recorded organisation projection before this movement can be replayed. No Personnel or Payroll changes were applied.');}
}
function readProjectionImage(value:unknown):Image{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new OrganisationProjectionLineageError();
 const row=value as Record<string,unknown>;
 if(Object.keys(row).length!==imageKeys.length||imageKeys.some(key=>!Object.hasOwn(row,key)||(row[key]!==null&&typeof row[key]!=='string')))throw new OrganisationProjectionLineageError();
 return Object.fromEntries(imageKeys.map(key=>[key,row[key]])) as Image;
}
const identical=(a:Image,b:Image)=>imageKeys.every(key=>a[key]===b[key]);
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Called only inside the existing ordinary Maintain/protected Contract inverse owner. It follows
 * actual immutable projection IDs, never matches a row approximately by dates or placement values.
 * A split or old ID-less projection is deliberately non-replayable until People Ops reconciles it.
 */
export async function resolveOrganisationProjectionAssignmentTx(tx:Tx,tenantId:string,employmentId:string,originalId:string,events:readonly ProjectionEvent[],corrections:unknown[]):Promise<string>{
 const projections=events.filter(event=>event.eventType==='employment.organisation.projected');
 if(!projections.length)return liveIncarnationOf(originalId,corrections);
 const bySource=new Map<string,ProjectionEvent[]>();
 for(const event of projections){const group=bySource.get(event.aggregateId)??[];group.push(event);bySource.set(event.aggregateId,group);}
 let current=liveIncarnationOf(originalId,corrections);
 const seen=new Set<string>();
 // Each successful hop consumes a distinct immutable projection edge; one final iteration checks
 // the terminal ID. There is no new arbitrary business-history limit.
 for(let depth=0;depth<=projections.length;depth++){
  if(seen.has(current))throw new OrganisationProjectionLineageError();
  seen.add(current);
  const matching=bySource.get(current)??[];
  if(!matching.length)return current;
  if(matching.length!==1)throw new OrganisationProjectionLineageError();
  const event=matching[0],p=event.payload as Record<string,unknown>|null;
  const [recorded]=await tx.select({id:domainEvent.id,sequence:domainEvent.sequence}).from(domainEvent).where(and(eq(domainEvent.id,event.id),eq(domainEvent.tenantId,tenantId),eq(domainEvent.subjectEmploymentId,employmentId),eq(domainEvent.aggregateId,current),eq(domainEvent.eventType,'employment.organisation.projected'),sql`${domainEvent.payload}=${JSON.stringify(event.payload)}::text::jsonb`));
  if(!recorded)throw new OrganisationProjectionLineageError();
  const proof=p?.projection as Record<string,unknown>|null;
  if(!p||!proof||proof.version!==1||p.sourceAssignmentId!==current||typeof p.mappingVersionId!=='string'||!uuid.test(p.mappingVersionId)||typeof p.effectiveOn!=='string'||typeof proof.companyId!=='string'||!uuid.test(proof.companyId)||typeof proof.mappingReceiptId!=='string'||!uuid.test(proof.mappingReceiptId)||!proof.mappingTags||typeof proof.mappingTags!=='object'||Array.isArray(proof.mappingTags)||!Array.isArray(proof.replacements)||proof.replacements.length!==1)throw new OrganisationProjectionLineageError();
  const before=readProjectionImage(proof.source),after=readProjectionImage(proof.replacements[0]);
  if(before.id!==current||typeof after.id!=='string'||!uuid.test(after.id)||after.id===current||before.tenantId!==tenantId||after.tenantId!==tenantId||before.employmentId!==employmentId||after.employmentId!==employmentId
   ||before.validFrom!==after.validFrom||before.validTo!==after.validTo
   ||(before.companyId!==null&&before.companyId!==proof.companyId)||p.effectiveOn!==after.validFrom||p.validTo!==after.validTo
   ||p.businessUnitId!==after.businessUnitId||p.beforeBusinessUnitId!==before.businessUnitId
   ||imageKeys.some(key=>!['id','businessUnitId','createdAt','recordedAt'].includes(key)&&before[key]!==after[key]))throw new OrganisationProjectionLineageError();
  const rows=await tx.select().from(assignment).where(and(eq(assignment.tenantId,tenantId),eq(assignment.employmentId,employmentId),inArray(assignment.id,[current,after.id!])));
  const source=rows.find(row=>row.id===current),replacement=rows.find(row=>row.id===after.id);
  if(rows.length!==2||!source?.supersededAt||!replacement||!identical(assignmentProjectionImage(source),before)||!identical(assignmentProjectionImage(replacement),after))throw new OrganisationProjectionLineageError();
  const [mapping]=await tx.execute<{verified:boolean}>(sql`select exists(
   select 1 from public.domain_event receipt
   where receipt.id=${proof.mappingReceiptId}::uuid and receipt.tenant_id=${tenantId}::uuid and receipt.subject_employment_id=${employmentId}::uuid
   and receipt.aggregate_id=${employmentId}::uuid and receipt.event_type='employment.organisation-tagged' and receipt.sequence<${recorded.sequence}
   and receipt.payload->>'companyId'=${proof.companyId} and receipt.payload->>'effectiveOn'=${p.effectiveOn}
   and receipt.payload->>'mappingVersionId'=${p.mappingVersionId}
   and receipt.payload->'after'=${JSON.stringify(proof.mappingTags)}::text::jsonb
   and receipt.payload->'after'->>'status'='ready'
   and receipt.payload->'after'->>'businessUnitId' is not distinct from ${after.businessUnitId}
   and receipt.payload->'after'->>'mappingVersionId'=${p.mappingVersionId}
   ) as verified`);
  if(mapping?.verified!==true)throw new OrganisationProjectionLineageError();
  current=liveIncarnationOf(after.id!,corrections);
 }
 throw new OrganisationProjectionLineageError();
}
