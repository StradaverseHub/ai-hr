/** Catalogue binding on the SAME encrypted ledger and shared lifecycle. No employment alias. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../../db/client';
import {createReviewCustody} from './generic-review-custody';
import {OwnLeaveSealedReview} from './own-leave-content';
import * as C from '../../lib/assistant-actions/position-archive-contract';
import {withAgentActionGuard} from './agent-action-guard';
import {lockPositionArchiveSourceTx,preparePositionArchiveTx,confirmPositionArchiveTx,positionArchiveUnavailable as fail} from './position-archive-source';
const action=C.POSITION_ARCHIVE_ACTION,digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),companyId:z.guid(),positionId:z.guid(),archived:z.boolean()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(r=>(r.metadata.state==='awaiting_confirmation')===(r.sealed!==null&&r.metadata.intentDigest!==null&&r.metadata.reviewedDigest!==null)&&(r.metadata.state==='completed')===(r.eventId!==null)&&(r.metadata.state==='awaiting_confirmation'||r.sealed===null&&r.metadata.intentDigest===null&&r.metadata.reviewedDigest===null));
type Subject={positionId:string;companyId:string};
export const positionArchiveReviews=createReviewCustody<z.infer<typeof C.PositionArchiveHuman>,z.infer<typeof Binding>,z.infer<typeof Stored>,Subject,Awaited<ReturnType<typeof preparePositionArchiveTx>>,Awaited<ReturnType<typeof confirmPositionArchiveTx>>,z.infer<typeof C.PositionArchivePrepared>,z.infer<typeof C.PositionArchiveCompleted>,z.infer<typeof C.PositionArchiveRetired>,z.infer<typeof C.PositionArchiveIndex>>({
 action,tier:'approve',human:C.PositionArchiveHuman,metadata:Metadata,stored:Stored,confirmation:C.PositionArchiveEnvelopeConfirmation,retirement:C.PositionArchiveRetirement,retired:C.PositionArchiveRetired,index:C.PositionArchiveIndex,indexKind:'position_archive_review_index',
 async withInterval(tx,ctx,nomination,work){const fresh=await withAgentActionGuard(tx,ctx,action,'approve');let pick:Subject|undefined;
  if(!nomination.human){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_position_archive_command('subject',${nomination.actionId}::uuid) as subject`);pick=z.object({positionId:z.guid(),companyId:z.guid()}).strict().parse(row?.subject);}
  const current=await lockPositionArchiveSourceTx(tx,fresh,nomination.human?.positionId??pick!.positionId);if(pick&&pick.companyId!==current.companyId)return fail();return work(fresh,{positionId:current.positionId,companyId:current.companyId});
 },
 binding:(ctx,s,h)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,companyId:s.companyId,positionId:s.positionId,archived:h.archived}),
 assertSubjectBinding:(b,s)=>{if(b.positionId!==s.positionId||b.companyId!==s.companyId)return fail();},assertHumanBinding:(b,h)=>{if(b.positionId!==h.positionId||b.archived!==h.archived)return fail();},
 prepareNative:preparePositionArchiveTx,confirmNative:(tx,ctx,body)=>confirmPositionArchiveTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(r,b,n)=>C.PositionArchivePrepared.parse({action,contractVersion:1,actionId:r.metadata.actionId,reviewedDigest:r.metadata.reviewedDigest,createdAt:r.metadata.createdAt,expiresAt:r.metadata.expiresAt,content:b.content,review:n.review,consequence:'catalogue_archive_state_only_no_assignment_or_access_change'}),
 async completed(tx,_ctx,r){if(!r.eventId)return fail();const b=r.metadata.binding,[row]=await tx.execute<{receipt:unknown}>(sql`select app.position_archive_grid_receipt(${b.positionId}::uuid,${r.eventId}::uuid,${b.archived}) as receipt`);return C.PositionArchiveCompleted.parse({action,contractVersion:1,actionId:r.metadata.actionId,state:'completed',receipt:C.PositionArchiveReceipt.parse(row?.receipt)});},
 event:r=>r.eventId,nativeEvent:n=>n.eventId,assertCompletion:(r,n)=>{if(r.eventId!==n.eventId||r.metadata.binding.positionId!==n.positionId||r.metadata.binding.companyId!==n.companyId||r.metadata.binding.archived!==n.archived)return fail();},targets:()=>[],
 async prepareRow(tx,m,sealed){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_position_archive_command('prepare',${m.actionId}::uuid,${b.personId}::uuid,${b.positionId}::uuid,${b.companyId}::uuid,${b.archived},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_position_archive_command('read',${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,n){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_position_archive_command('complete',${id}::uuid,NULL,NULL,NULL,NULL,NULL,${expected},NULL,NULL,NULL,${n.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_position_archive_command('discard',${id}::uuid) as review`);return row?.review;},
 async indexRows(tx){const [row]=await tx.execute<{rows:unknown}>(sql`select app.assistant_position_archive_command('index') as rows`);return z.array(z.unknown()).parse(row?.rows);},unavailable:fail,
});
export async function readPositionArchiveChoices(supplied:SessionContext,selection:unknown={query:''}){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,async tx=>{
 const fresh=await withAgentActionGuard(tx,ctx,action,'approve'),pick=C.PositionArchiveSelection.parse(selection),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const rows=await tx.execute<{positionId:string;companyId:string;companyName:string;title:string;archived:boolean;inUse:boolean}>(sql`select p.id as "positionId",p.company_id as "companyId",c.legal_name as "companyName",p.title,p.archived_at is not null as archived,exists(select 1 from assignment a where a.tenant_id=p.tenant_id and a.position_id=p.id and a.superseded_at is null) as "inUse" from position p join company c on c.id=p.company_id and c.tenant_id=p.tenant_id where p.tenant_id=${fresh.tenantId}::uuid and app.is_admin() and app.is_admin_for(p.company_id) and not p.is_global and not exists(select 1 from label_company_assignment a where a.tenant_id=p.tenant_id and a.label_kind='position' and a.label_id=p.id and a.company_id<>p.company_id) and p.title ilike ${pattern} order by p.title,p.id limit 26`);
 let positions=Array.from(rows).slice(0,25),truncated=rows.length>25;if(pick.positionId&&!positions.some(p=>p.positionId===pick.positionId)){return C.PositionArchiveChoices.parse({kind:'unavailable'});}return C.PositionArchiveChoices.parse({kind:'choices',positions,truncated});
 });}catch{return {kind:'unavailable' as const};}}

/** Native boolean witness for the Organisation shortcut; no catalogue labels or ciphertext. */
export async function positionArchiveEntryAvailable(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};return withTenant(ctx,async tx=>{const [row]=await tx.execute<{available:boolean}>(sql`select app.position_archive_entry_available() as available`);return row?.available===true;});}
