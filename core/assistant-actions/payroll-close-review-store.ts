/** WP9: Payroll close uses generic OWN custody; the payroll pack still owns every close fact. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx,SessionContext} from '../../db/client';
import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REVIEWED_PAYROLL_CLOSE_ACTION as action,ReviewedPayrollCloseHumanContent as Human,ReviewedPayrollClosePreparedSource} from '../../lib/assistant-actions/reviewed-payroll-close-contract';
import {PayrollCloseReviewPrepare,PayrollCloseReviewConfirmation,PayrollCloseReviewRetirement,PayrollClosePreparedReview,PayrollCloseCompletedReview,PayrollCloseRetiredReview,PayrollCloseReviewIndex} from '../../lib/assistant-actions/payroll-close-review-contract';
import {assertReviewedPayrollCloseActorTx,withReviewedPayrollCloseSourceIntervalTx,prepareReviewedPayrollCloseSourceTx,confirmReviewedPayrollCloseSourceTx,reconcileReviewedPayrollCloseSourceTx} from './reviewed-payroll-close-source';
export class PayrollCloseReviewUnavailable extends Error{constructor(){super('That Payroll close needs another look. Please reopen the reviewed run.');this.name='PayrollCloseReviewUnavailable';}}
const fail=():never=>{throw new PayrollCloseReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),batchId:z.guid(),payPeriodId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;

type Source={batchId:string;companyId:string;payPeriodId:string;payPeriod:string};
type NativePrepared=z.infer<typeof ReviewedPayrollClosePreparedSource>;
const uuidArray=(ids:readonly string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
async function confirmNative(tx:Tx,ctx:SessionContext,body:{content:z.infer<typeof Human>;nativeReviewedDigest:string},source:Source,current?:NativePrepared){
 if(!current)return fail();const receipt=await confirmReviewedPayrollCloseSourceTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest});if(receipt.batchId!==source.batchId||receipt.payPeriodId!==source.payPeriodId)return fail();
 const [privacy]=await tx.execute<{employees:string[]}>(sql`select app.native_outcome_payroll_target_employments(${source.batchId}::uuid,${current.erasureSource.priorBatchId}::uuid,${uuidArray(current.erasureSource.coverageEmploymentIds)}) as employees`);
 return{receipt,targetEmployees:z.array(z.guid()).parse(privacy?.employees),targetPeople:current.erasurePersonIds};
}
export const payrollCloseReviews=createGenericOwnCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,NativePrepared,Awaited<ReturnType<typeof confirmNative>>,
 z.infer<typeof PayrollClosePreparedReview>,z.infer<typeof PayrollCloseCompletedReview>,z.infer<typeof PayrollCloseRetiredReview>,z.infer<typeof PayrollCloseReviewIndex>
>({
 action,tier:'approve',human:PayrollCloseReviewPrepare,metadata:Metadata,stored:Stored,
 confirmation:PayrollCloseReviewConfirmation,retirement:PayrollCloseReviewRetirement,retired:PayrollCloseRetiredReview,index:PayrollCloseReviewIndex,indexKind:'payroll_close_review_index',
 async withInterval(tx,ctx,nomination,work){let batchId:string,actor=ctx;if(nomination.human)batchId=nomination.human.batchId;else{actor=await assertReviewedPayrollCloseActorTx(tx,ctx);const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_payroll_close_review_subject(${z.guid().parse(nomination.actionId)}::uuid) as subject`);batchId=z.guid().parse(row?.subject);}return withReviewedPayrollCloseSourceIntervalTx(tx,actor,batchId,work);},
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:source.companyId,batchId:source.batchId,payPeriodId:source.payPeriodId}),
 assertSubjectBinding:(binding,source)=>{if(binding.batchId!==source.batchId||binding.companyId!==source.companyId||binding.payPeriodId!==source.payPeriodId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.batchId.toLowerCase()!==binding.batchId)return fail();},
 prepareNative:(tx,ctx,human)=>prepareReviewedPayrollCloseSourceTx(tx,ctx,human),confirmNative,
 pending:(row,body,current)=>PayrollClosePreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review}),
 async completed(tx,ctx,row){if(!row.eventId)return fail();const receipt=await reconcileReviewedPayrollCloseSourceTx(tx,ctx,{batchId:row.metadata.binding.batchId,closedEventId:row.eventId});if(receipt.payPeriodId!==row.metadata.binding.payPeriodId)return fail();return PayrollCloseCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.receipt.closedEventId,assertCompletion:(row,native)=>{if(row.eventId!==native.receipt.closedEventId)return fail();},
 targets:(_source,native)=>[...native.targetPeople.map(id=>({kind:'person' as const,id})),...native.targetEmployees.map(id=>({kind:'employment' as const,id}))],
 async prepareRow(tx,m,sealed,_source,_human,native){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_close_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.batchId}::uuid,${b.companyId}::uuid,${b.payPeriodId}::uuid,${uuidArray(native.erasurePersonIds)},${native.erasureSource.priorBatchId}::uuid,${uuidArray(native.erasureSource.coverageEmploymentIds)},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_payroll_close_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_close_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_close_review_complete(${id}::uuid,${expected},${native.receipt.closedEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_payroll_close_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_payroll_close_reviews_index()`));},unavailable:fail,
});
export const preparePayrollCloseReview=payrollCloseReviews.prepare;
export const confirmPayrollCloseReview=payrollCloseReviews.confirm;
export const reopenPayrollCloseReview=payrollCloseReviews.reopen;
export const discardPayrollCloseReview=payrollCloseReviews.discard;
export const listPayrollCloseReviews=payrollCloseReviews.list;
export const readCompletedPayrollCloseOutcomeTx=payrollCloseReviews.readCompletedOutcomeTx;
