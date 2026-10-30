/** WP9: Payroll reopening uses generic OWN custody; the payroll pack still owns every close fact. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx,SessionContext} from '../../db/client';
import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {PayrollReopen as C} from '../../lib/assistant-actions/reviewed-payroll-reopen-contract';
const action=C.action,Human=C.Human;
const PayrollReopenReviewPrepare=C.Human,PayrollReopenReviewConfirmation=C.Confirmation,PayrollReopenReviewRetirement=C.Retirement,PayrollReopenPreparedReview=C.Prepared,PayrollReopenCompletedReview=C.Completed,PayrollReopenRetiredReview=C.Retired,PayrollReopenReviewIndex=C.Index;
import {assertReviewedPayrollReopenActorTx,withReviewedPayrollReopenSourceIntervalTx,prepareReviewedPayrollReopenSourceTx,confirmReviewedPayrollReopenSourceTx,reconcileReviewedPayrollReopenSourceTx} from './reviewed-payroll-reopen-source';
export class PayrollReopenReviewUnavailable extends Error{constructor(){super('That Payroll reopening needs another look. Please reopen the reviewed run.');this.name='PayrollReopenReviewUnavailable';}}
const fail=():never=>{throw new PayrollReopenReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),batchId:z.guid(),payPeriodId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;

type Source={batchId:string;companyId:string;payPeriodId:string;payPeriod:string};
type NativePrepared=Awaited<ReturnType<typeof prepareReviewedPayrollReopenSourceTx>>;
const uuidArray=(ids:readonly string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
async function confirmNative(tx:Tx,ctx:SessionContext,body:{content:z.infer<typeof Human>;nativeReviewedDigest:string},source:Source,current?:NativePrepared){
 if(!current)return fail();const receipt=await confirmReviewedPayrollReopenSourceTx(tx,ctx,body.content,body.nativeReviewedDigest);if(receipt.receipt.batchId!==source.batchId||receipt.receipt.payPeriodId!==source.payPeriodId)return fail();
 return{receipt:receipt.receipt,targetEmployees:receipt.targetEmployees,targetPeople:receipt.targetPeople};
}
export const payrollReopenReviews=createGenericOwnCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,NativePrepared,Awaited<ReturnType<typeof confirmNative>>,
 z.infer<typeof PayrollReopenPreparedReview>,z.infer<typeof PayrollReopenCompletedReview>,z.infer<typeof PayrollReopenRetiredReview>,z.infer<typeof PayrollReopenReviewIndex>
>({
 action,tier:'approve',human:PayrollReopenReviewPrepare,metadata:Metadata,stored:Stored,
 confirmation:PayrollReopenReviewConfirmation,retirement:PayrollReopenReviewRetirement,retired:PayrollReopenRetiredReview,index:PayrollReopenReviewIndex,indexKind:'payroll_reopen_review_index',
 async withInterval(tx,ctx,nomination,work){let batchId:string,actor=ctx;if(nomination.human)batchId=nomination.human.batchId;else{actor=await assertReviewedPayrollReopenActorTx(tx,ctx);const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_payroll_reopen_review_subject(${z.guid().parse(nomination.actionId)}::uuid) as subject`);batchId=z.guid().parse(row?.subject);}return withReviewedPayrollReopenSourceIntervalTx(tx,actor,batchId,work);},
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:source.companyId,batchId:source.batchId,payPeriodId:source.payPeriodId}),
 assertSubjectBinding:(binding,source)=>{if(binding.batchId!==source.batchId||binding.companyId!==source.companyId||binding.payPeriodId!==source.payPeriodId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.batchId.toLowerCase()!==binding.batchId)return fail();},
 prepareNative:(tx,ctx,human)=>prepareReviewedPayrollReopenSourceTx(tx,ctx,human),confirmNative,
 pending:(row,body,current)=>PayrollReopenPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review}),
 async completed(tx,ctx,row){if(!row.eventId)return fail();const receipt=await reconcileReviewedPayrollReopenSourceTx(tx,ctx,{batchId:row.metadata.binding.batchId,unlockedEventId:row.eventId});if(receipt.payPeriodId!==row.metadata.binding.payPeriodId)return fail();return PayrollReopenCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.receipt.unlockedEventId,assertCompletion:(row,native)=>{if(row.eventId!==native.receipt.unlockedEventId)return fail();},
 targets:(_source,native)=>[...native.targetPeople.map(id=>({kind:'person' as const,id})),...native.targetEmployees.map(id=>({kind:'employment' as const,id}))],
 async prepareRow(tx,m,sealed,_source,_human,native){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_reopen_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.batchId}::uuid,${b.companyId}::uuid,${b.payPeriodId}::uuid,${uuidArray(native.erasurePersonIds)},NULL::uuid,ARRAY[]::uuid[],${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_payroll_reopen_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_reopen_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_reopen_review_complete(${id}::uuid,${expected},${native.receipt.unlockedEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_payroll_reopen_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_payroll_reopen_reviews_index()`));},unavailable:fail,
});
export const preparePayrollReopenReview=payrollReopenReviews.prepare;
export const confirmPayrollReopenReview=payrollReopenReviews.confirm;
export const reopenPayrollReopenReview=payrollReopenReviews.reopen;
export const discardPayrollReopenReview=payrollReopenReviews.discard;
export const listPayrollReopenReviews=payrollReopenReviews.list;
export const readCompletedPayrollReopenOutcomeTx=payrollReopenReviews.readCompletedOutcomeTx;

import {withTenant} from '../../db/client';
import {reviewedPayrollReopenChoiceMetadataTx} from '../../packs/payroll/service';
export async function readPayrollReopenChoices(ctx:SessionContext){try{return await withTenant(ctx,async tx=>{const fresh=await assertReviewedPayrollReopenActorTx(tx,ctx);return C.Choices.parse({kind:'choices',batches:await reviewedPayrollReopenChoiceMetadataTx(tx,fresh)});});}catch{return{kind:'unavailable' as const};}}
