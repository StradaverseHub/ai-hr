/** WP9: login-bound pay catalogue creation through the generic OWN compatibility protocol.
 * Existing SQL rows, binding order, sealed bodies and native creation verification remain unchanged. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REVIEWED_PAY_COMPONENT_ACTION as action,ReviewedPayComponentHumanContent as PayComponentHumanContent} from '../../lib/assistant-actions/reviewed-pay-component-contract';
import {PayComponentReviewConfirmation,PayComponentReviewRetirement,PayComponentPreparedReview,PayComponentCompletedReview,PayComponentRetiredReview,PayComponentReviewIndex} from '../../lib/assistant-actions/pay-component-review-contract';
import {withReviewedPayComponentIntervalTx,prepareReviewedPayComponentSourceTx,confirmReviewedPayComponentSourceTx,reconcileReviewedPayComponentSourceTx} from './reviewed-pay-component-source';
export class PayComponentReviewUnavailable extends Error{constructor(){super('That pay-code review needs another look. Please reopen Payroll Setup.');this.name='PayComponentReviewUnavailable';}}
const fail=():never=>{throw new PayComponentReviewUnavailable();};
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.null()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),componentId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.componentId!==null&&value.eventId!==null)
 &&((value.componentId===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
export const payComponentReviews=createGenericOwnCompatibilityStore<
 z.infer<typeof PayComponentHumanContent>,z.infer<typeof Binding>,Stored,null,
 Awaited<ReturnType<typeof prepareReviewedPayComponentSourceTx>>,Awaited<ReturnType<typeof confirmReviewedPayComponentSourceTx>>,
 z.infer<typeof PayComponentPreparedReview>,z.infer<typeof PayComponentCompletedReview>,z.infer<typeof PayComponentRetiredReview>,z.infer<typeof PayComponentReviewIndex>
>({
 action,tier:'approve',human:PayComponentHumanContent,metadata:Metadata,stored:Stored,
 confirmation:PayComponentReviewConfirmation,retirement:PayComponentReviewRetirement,retired:PayComponentRetiredReview,index:PayComponentReviewIndex,indexKind:'pay_component_review_index',
 async withInterval(tx,ctx,_nomination,work){return withReviewedPayComponentIntervalTx(tx,ctx,fresh=>work(fresh,null));},
 binding:(ctx)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:null}),
 assertSubjectBinding:()=>{},assertHumanBinding:()=>{},
 prepareNative:(tx,ctx,human)=>prepareReviewedPayComponentSourceTx(tx,ctx,human),
 confirmNative:(tx,ctx,body)=>confirmReviewedPayComponentSourceTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(row,body,current)=>{const review=PayComponentPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review,consequence:'catalogue_created_no_employee_assignment_or_payroll_run'});if(Buffer.byteLength(JSON.stringify(review))>65536)return fail();return review;},
 async completed(tx,ctx,row){if(!row.componentId||!row.eventId)return fail();const receipt=await reconcileReviewedPayComponentSourceTx(tx,ctx,{componentId:row.componentId,createdEventId:row.eventId});return PayComponentCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.createdEventId,
 assertCompletion:(row,native)=>{if(row.componentId!==native.componentId||row.eventId!==native.createdEventId)return fail();},targets:()=>[],
 async prepareRow(tx,m,sealed){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_pay_component_review_prepare(${m.actionId}::uuid,${m.binding.personId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_pay_component_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_pay_component_review_complete(${id}::uuid,${expected},${native.componentId}::uuid,${native.createdEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_pay_component_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_pay_component_reviews_index()`));},unavailable:fail,
});
export const preparePayComponentReview=payComponentReviews.prepare;
export const confirmPayComponentReview=payComponentReviews.confirm;
export const reopenPayComponentReview=payComponentReviews.reopen;
export const discardPayComponentReview=payComponentReviews.discard;
export const listPayComponentReviews=payComponentReviews.list;
export const readCompletedPayComponentOutcomeTx=payComponentReviews.readCompletedOutcomeTx;
