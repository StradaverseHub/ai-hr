/** WP9: Payroll reset uses generic OWN custody; the payroll pack still owns every reset fact. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx,SessionContext} from '../../db/client';
import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {PayrollReset as C} from '../../lib/assistant-actions/reviewed-payroll-reset-contract';
const action=C.action,Human=C.Human;
const PayrollResetReviewPrepare=C.Human,PayrollResetReviewConfirmation=C.Confirmation,PayrollResetReviewRetirement=C.Retirement,PayrollResetPreparedReview=C.Prepared,PayrollResetCompletedReview=C.Completed,PayrollResetRetiredReview=C.Retired,PayrollResetReviewIndex=C.Index;
import {assertReviewedPayrollResetActorTx,withReviewedPayrollResetSourceIntervalTx,prepareReviewedPayrollResetSourceTx,confirmReviewedPayrollResetSourceTx,reconcileReviewedPayrollResetSourceTx} from './reviewed-payroll-reset-source';
export class PayrollResetReviewUnavailable extends Error{constructor(){super('That Payroll reset needs another look. Please recover the same review.');this.name='PayrollResetReviewUnavailable';}}
const fail=():never=>{throw new PayrollResetReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),batchId:z.guid(),payPeriodId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;

type Source={batchId:string;companyId:string;payPeriodId:string;payPeriod:string};
type NativePrepared=Awaited<ReturnType<typeof prepareReviewedPayrollResetSourceTx>>;
const uuidArray=(ids:readonly string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
async function confirmNative(tx:Tx,ctx:SessionContext,body:{content:z.infer<typeof Human>;nativeReviewedDigest:string},source:Source,current?:NativePrepared){
 if(!current)return fail();const receipt=await confirmReviewedPayrollResetSourceTx(tx,ctx,body.content,body.nativeReviewedDigest);if(receipt.receipt.batchId!==source.batchId||receipt.receipt.payPeriodId!==source.payPeriodId)return fail();
 return{receipt:receipt.receipt,targetEmployees:receipt.targetEmployees,targetPeople:receipt.targetPeople};
}
export const payrollResetReviews=createGenericOwnCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,NativePrepared,Awaited<ReturnType<typeof confirmNative>>,
 z.infer<typeof PayrollResetPreparedReview>,z.infer<typeof PayrollResetCompletedReview>,z.infer<typeof PayrollResetRetiredReview>,z.infer<typeof PayrollResetReviewIndex>
>({
 action,tier:'approve',human:PayrollResetReviewPrepare,metadata:Metadata,stored:Stored,
 confirmation:PayrollResetReviewConfirmation,retirement:PayrollResetReviewRetirement,retired:PayrollResetRetiredReview,index:PayrollResetReviewIndex,indexKind:'payroll_reset_review_index',
 async withInterval(tx,ctx,nomination,work){let batchId:string,actor=ctx;if(nomination.human)batchId=nomination.human.batchId;else{actor=await assertReviewedPayrollResetActorTx(tx,ctx);const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_payroll_reset_review_subject(${z.guid().parse(nomination.actionId)}::uuid) as subject`);batchId=z.guid().parse(row?.subject);}return withReviewedPayrollResetSourceIntervalTx(tx,actor,batchId,async(fresh,source)=>{
 const [previous]=await tx.execute<{value:string|null}>(sql`select current_setting('app.payroll_reset_review_id',true) as value`);
 await tx.execute(sql`select set_config('app.payroll_reset_review_id',${nomination.human?'':z.guid().parse(nomination.actionId)},true)`);
 try{return await work(fresh,source);}finally{await tx.execute(sql`select set_config('app.payroll_reset_review_id',${previous?.value??''},true)`);}
 });},
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:source.companyId,batchId:source.batchId,payPeriodId:source.payPeriodId}),
 assertSubjectBinding:(binding,source)=>{if(binding.batchId!==source.batchId||binding.companyId!==source.companyId||binding.payPeriodId!==source.payPeriodId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.batchId.toLowerCase()!==binding.batchId)return fail();},
 prepareNative:(tx,ctx,human)=>prepareReviewedPayrollResetSourceTx(tx,ctx,human),confirmNative,
 pending:(row,body,current)=>PayrollResetPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review}),
 async completed(tx,ctx,row){if(!row.eventId)return fail();const receipt=await reconcileReviewedPayrollResetSourceTx(tx,ctx,{batchId:row.metadata.binding.batchId,resetEventId:row.eventId});if(receipt.payPeriodId!==row.metadata.binding.payPeriodId)return fail();return PayrollResetCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.receipt.resetEventId,assertCompletion:(row,native)=>{if(row.eventId!==native.receipt.resetEventId)return fail();},
 targets:(_source,native)=>[...native.targetPeople.map(id=>({kind:'person' as const,id})),...native.targetEmployees.map(id=>({kind:'employment' as const,id}))],
 async prepareRow(tx,m,sealed,_source,_human,native){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_reset_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.batchId}::uuid,${b.companyId}::uuid,${b.payPeriodId}::uuid,${uuidArray(native.erasurePersonIds)},NULL::uuid,ARRAY[]::uuid[],${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext},${native.sourceDigest}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_payroll_reset_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_reset_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_reset_review_complete(${id}::uuid,${expected},${native.receipt.resetEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_payroll_reset_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_payroll_reset_reviews_index()`));},unavailable:fail,
});
export const preparePayrollResetReview=payrollResetReviews.prepare;
export const confirmPayrollResetReview=payrollResetReviews.confirm;
export const reopenPayrollResetReview=payrollResetReviews.reopen;
export const discardPayrollResetReview=payrollResetReviews.discard;
export const listPayrollResetReviews=payrollResetReviews.list;
export const readCompletedPayrollResetOutcomeTx=payrollResetReviews.readCompletedOutcomeTx;

import {withTenant} from '../../db/client';
import {reviewedPayrollResetChoiceMetadataTx} from '../../packs/payroll/service';
export async function readPayrollResetChoices(ctx:SessionContext){try{return await withTenant(ctx,async tx=>{const fresh=await assertReviewedPayrollResetActorTx(tx,ctx);return C.Choices.parse({kind:'choices',batches:await reviewedPayrollResetChoiceMetadataTx(tx,fresh)});});}catch{return{kind:'unavailable' as const};}}
