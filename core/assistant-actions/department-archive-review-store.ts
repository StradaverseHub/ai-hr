/** Catalogue binding on the SAME encrypted ledger and shared lifecycle. No employment alias. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../../db/client';
import {createReviewCustody} from './generic-review-custody';
import {OwnLeaveSealedReview} from './own-leave-content';
import * as C from '../../lib/assistant-actions/department-archive-contract';
import {withAgentActionGuard} from './agent-action-guard';
import {lockDepartmentArchiveSourceTx,prepareDepartmentArchiveTx,confirmDepartmentArchiveTx,departmentArchiveUnavailable as fail} from './department-archive-source';
const action=C.DEPARTMENT_ARCHIVE_ACTION,digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),companyId:z.guid(),departmentId:z.guid(),archived:z.boolean()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(r=>(r.metadata.state==='awaiting_confirmation')===(r.sealed!==null&&r.metadata.intentDigest!==null&&r.metadata.reviewedDigest!==null)&&(r.metadata.state==='completed')===(r.eventId!==null)&&(r.metadata.state==='awaiting_confirmation'||r.sealed===null&&r.metadata.intentDigest===null&&r.metadata.reviewedDigest===null));
type Subject={departmentId:string;companyId:string};
export const departmentArchiveReviews=createReviewCustody<z.infer<typeof C.DepartmentArchiveHuman>,z.infer<typeof Binding>,z.infer<typeof Stored>,Subject,Awaited<ReturnType<typeof prepareDepartmentArchiveTx>>,Awaited<ReturnType<typeof confirmDepartmentArchiveTx>>,z.infer<typeof C.DepartmentArchivePrepared>,z.infer<typeof C.DepartmentArchiveCompleted>,z.infer<typeof C.DepartmentArchiveRetired>,z.infer<typeof C.DepartmentArchiveIndex>>({
 action,tier:'approve',human:C.DepartmentArchiveHuman,metadata:Metadata,stored:Stored,confirmation:C.DepartmentArchiveEnvelopeConfirmation,retirement:C.DepartmentArchiveRetirement,retired:C.DepartmentArchiveRetired,index:C.DepartmentArchiveIndex,indexKind:'department_archive_review_index',
 async withInterval(tx,ctx,nomination,work){const fresh=await withAgentActionGuard(tx,ctx,action,'approve');let pick:Subject|undefined;
  if(!nomination.human){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_department_archive_command('subject',${nomination.actionId}::uuid) as subject`);pick=z.object({departmentId:z.guid(),companyId:z.guid()}).strict().parse(row?.subject);}
  const current=await lockDepartmentArchiveSourceTx(tx,fresh,nomination.human?.departmentId??pick!.departmentId);if(pick&&pick.companyId!==current.companyId)return fail();return work(fresh,{departmentId:current.departmentId,companyId:current.companyId});
 },
 binding:(ctx,s,h)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,companyId:s.companyId,departmentId:s.departmentId,archived:h.archived}),
 assertSubjectBinding:(b,s)=>{if(b.departmentId!==s.departmentId||b.companyId!==s.companyId)return fail();},assertHumanBinding:(b,h)=>{if(b.departmentId!==h.departmentId||b.archived!==h.archived)return fail();},
 prepareNative:prepareDepartmentArchiveTx,confirmNative:(tx,ctx,body)=>confirmDepartmentArchiveTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(r,b,n)=>C.DepartmentArchivePrepared.parse({action,contractVersion:1,actionId:r.metadata.actionId,reviewedDigest:r.metadata.reviewedDigest,createdAt:r.metadata.createdAt,expiresAt:r.metadata.expiresAt,content:b.content,review:n.review,consequence:'catalogue_archive_state_only_no_assignment_or_access_change'}),
 async completed(tx,_ctx,r){if(!r.eventId)return fail();const b=r.metadata.binding,[row]=await tx.execute<{receipt:unknown}>(sql`select app.department_archive_grid_receipt(${b.departmentId}::uuid,${r.eventId}::uuid,${b.archived}) as receipt`);return C.DepartmentArchiveCompleted.parse({action,contractVersion:1,actionId:r.metadata.actionId,state:'completed',receipt:C.DepartmentArchiveReceipt.parse(row?.receipt)});},
 event:r=>r.eventId,nativeEvent:n=>n.eventId,assertCompletion:(r,n)=>{if(r.eventId!==n.eventId||r.metadata.binding.departmentId!==n.departmentId||r.metadata.binding.companyId!==n.companyId||r.metadata.binding.archived!==n.archived)return fail();},targets:()=>[],
 async prepareRow(tx,m,sealed){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_department_archive_command('prepare',${m.actionId}::uuid,${b.personId}::uuid,${b.departmentId}::uuid,${b.companyId}::uuid,${b.archived},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_department_archive_command('read',${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,n){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_department_archive_command('complete',${id}::uuid,NULL,NULL,NULL,NULL,NULL,${expected},NULL,NULL,NULL,${n.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_department_archive_command('discard',${id}::uuid) as review`);return row?.review;},
 async indexRows(tx){const [row]=await tx.execute<{rows:unknown}>(sql`select app.assistant_department_archive_command('index') as rows`);return z.array(z.unknown()).parse(row?.rows);},unavailable:fail,
});
export async function readDepartmentArchiveChoices(supplied:SessionContext,selection:unknown={query:''}){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,async tx=>{
 const fresh=await withAgentActionGuard(tx,ctx,action,'approve'),pick=C.DepartmentArchiveSelection.parse(selection),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const rows=await tx.execute<{departmentId:string;companyId:string;companyName:string;name:string;archived:boolean;inUse:boolean}>(sql`select p.id as "departmentId",p.company_id as "companyId",c.legal_name as "companyName",p.name,p.archived_at is not null as archived,exists(select 1 from assignment a where a.tenant_id=p.tenant_id and a.department_id=p.id and a.superseded_at is null) as "inUse" from department p join company c on c.id=p.company_id and c.tenant_id=p.tenant_id where p.tenant_id=${fresh.tenantId}::uuid and app.is_admin() and app.is_admin_for(p.company_id) and not p.is_global and not exists(select 1 from label_company_assignment a where a.tenant_id=p.tenant_id and a.label_kind='department' and a.label_id=p.id and a.company_id<>p.company_id) and p.name ilike ${pattern} order by p.name,p.id limit 26`);
 let departments=Array.from(rows).slice(0,25),truncated=rows.length>25;if(pick.departmentId&&!departments.some(p=>p.departmentId===pick.departmentId)){return C.DepartmentArchiveChoices.parse({kind:'unavailable'});}return C.DepartmentArchiveChoices.parse({kind:'choices',departments,truncated});
 });}catch{return {kind:'unavailable' as const};}}

/** Native boolean witness for the Organisation shortcut; no catalogue labels or ciphertext. */
export async function departmentArchiveEntryAvailable(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};return withTenant(ctx,async tx=>{const [row]=await tx.execute<{available:boolean}>(sql`select app.department_archive_entry_available() as available`);return row?.available===true;});}
