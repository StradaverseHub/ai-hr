/** Shared-person protocol adapter over the one encrypted generic assigned review ledger. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../../db/client';
import type {AssignedSubject} from './generic-assigned-review-store';
import {createGenericAssignedCompatibilityStore} from './generic-assigned-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {PassportMaintenance as C,type PassportMaintenanceHuman as Human} from '../../lib/assistant-actions/passport-maintenance-contract';
import {assertPassportMaintenanceActorTx,withPassportMaintenanceIntervalTx,preparePassportMaintenanceSourceTx,confirmPassportMaintenanceSourceTx,reconcilePassportMaintenanceSourceTx,readPassportMaintenanceChoicesTx,passportMaintenanceUnavailable as fail} from './passport-maintenance-source';
const digest=z.string().regex(/^[a-f0-9]{64}$/),Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.guid(),companyId:z.guid(),subjectPersonId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(C.action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),subjectKind:z.literal('person'),subjectId:z.guid(),eventId:z.guid().nullable()}).strict().refine(value=>(value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)&&(value.metadata.state==='completed')===(value.eventId!==null)&&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
type Native=Awaited<ReturnType<typeof preparePassportMaintenanceSourceTx>>&{content:Human};
export const passportMaintenanceReviews=createGenericAssignedCompatibilityStore<Human,z.infer<typeof Binding>,Stored,AssignedSubject,Native,Awaited<ReturnType<typeof confirmPassportMaintenanceSourceTx>>,z.infer<typeof C.Prepared>,z.infer<typeof C.Completed>,z.infer<typeof C.Retired>,z.infer<typeof C.Index>>({
 action:C.action,tier:'approve',human:C.Human,metadata:Metadata,stored:Stored,confirmation:z.object({actionId:z.guid(),reviewedDigest:digest}),retirement:z.object({actionId:z.guid()}),retired:C.Retired,index:C.Index,indexKind:C.indexKind,
 async withInterval(tx,ctx,nomination,work){const actor=await assertPassportMaintenanceActorTx(tx,ctx);let employmentId:string;
  if(nomination.human)employmentId=nomination.human.employmentId;
  else{const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_passport_maintenance_review_subject(${z.guid().parse(nomination.actionId)}::uuid) as subject`);const ref=z.object({employmentId:z.guid(),personId:z.guid()}).strict().parse(row?.subject);employmentId=ref.employmentId;}
  return withPassportMaintenanceIntervalTx(tx,actor,employmentId,work);
 },
 binding:(ctx,s,human)=>{if(s.employmentId!==human.employmentId||s.subjectId!==human.subjectId)return fail();return Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:s.employmentId,companyId:s.companyId,subjectPersonId:s.subjectPersonId});},
 assertSubjectBinding:(binding,s)=>{if(binding.employmentId!==s.employmentId||binding.companyId!==s.companyId||binding.subjectPersonId!==s.subjectPersonId||binding.subjectPersonId===binding.personId)return fail();},
 assertStoredSubject:(row,s)=>{if(row.subjectId!==s.subjectPersonId)return fail();},assertHumanBinding:(binding,human)=>{if(binding.employmentId!==human.employmentId||binding.subjectPersonId!==human.subjectId)return fail();},
 async prepareNative(tx,ctx,human){return{...await preparePassportMaintenanceSourceTx(tx,ctx,human),content:human};},
 confirmNative:(tx,ctx,body)=>confirmPassportMaintenanceSourceTx(tx,ctx,body.content,body.nativeReviewedDigest),
 pending:(row,body,current)=>C.Prepared.parse({action:C.action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review,consequence:C.consequence}),
 async completed(tx,ctx,row){if(!row.eventId)return fail();return C.Completed.parse({action:C.action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt:await reconcilePassportMaintenanceSourceTx(tx,ctx,{subjectId:row.subjectId,employmentId:row.metadata.binding.employmentId,eventId:row.eventId})});},
 event:row=>row.eventId,nativeEvent:native=>native.eventId,assertCompletion:(row,native)=>{if(row.eventId!==native.eventId||row.subjectId!==native.receipt.subjectId)return fail();},targets:s=>[{kind:'employment',id:s.employmentId},{kind:'person',id:s.subjectPersonId}],
 async prepareRow(tx,m,sealed,s){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_assigned_review_prepare(${C.action},${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${b.subjectPersonId}::uuid,${s.subjectPersonId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_assigned_review_read(${id}::uuid,${C.action}) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_assigned_review_complete(${id}::uuid,${C.action},${expected},${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [raw]=await tx.execute<{review:unknown}>(sql`select app.assistant_assigned_review_read(${id}::uuid,${C.action},true) as review`),row=Stored.parse(raw?.review);if(row.metadata.actionId!==id)return fail();return C.Retired.parse({action:C.action,contractVersion:1,actionId:id,state:row.metadata.state});},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_assigned_reviews_index(${C.action})`));},unavailable:fail,
});
export async function readPassportMaintenanceChoices(supplied:SessionContext,selection?:unknown){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,tx=>readPassportMaintenanceChoicesTx(tx,ctx,selection));}catch{return{kind:'unavailable' as const};}}
