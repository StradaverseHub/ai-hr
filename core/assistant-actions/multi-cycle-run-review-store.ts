/** WP9: generic OWN company/month/cycle draft custody with installed peek/preflight protocol. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REVIEWED_MULTI_CYCLE_RUN_ACTION as action,ReviewedMultiCycleRunHumanContent as Human} from '../../lib/assistant-actions/reviewed-multi-cycle-run-contract';
import {MultiCycleRunReviewConfirmation,MultiCycleRunReviewRetirement,MultiCycleRunPreparedReview,MultiCycleRunCompletedReview,MultiCycleRunRetiredReview,MultiCycleRunReviewIndex} from '../../lib/assistant-actions/multi-cycle-run-review-contract';
import {assertReviewedMultiCycleRunActorTx,withReviewedMultiCycleRunSourceIntervalTx,prepareReviewedMultiCycleRunSourceTx,confirmReviewedMultiCycleRunSourceTx,reconcileReviewedMultiCycleRunSourceTx} from './reviewed-multi-cycle-run-source';
export class MultiCycleRunReviewUnavailable extends Error{constructor(){super('That Payroll draft needs another look. Please reopen the reviewed cycle.');this.name='MultiCycleRunReviewUnavailable';}}
const fail=():never=>{throw new MultiCycleRunReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),payPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),payrollCycleId:z.guid(),runType:z.enum(['off_cycle','bonus','adjustment'])}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable(),batchId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null&&value.batchId!==null)
 &&((value.eventId===null)===(value.batchId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
type Selection={companyId:string;payPeriod:string;payrollCycleId:string;runType:'off_cycle'|'bonus'|'adjustment'};
const Selection=Binding.pick({companyId:true,payPeriod:true,payrollCycleId:true,runType:true}).strict();
const uuidArray=(ids:readonly string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
export const multiCycleRunReviews=createGenericOwnCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Selection,
 Awaited<ReturnType<typeof prepareReviewedMultiCycleRunSourceTx>>,Awaited<ReturnType<typeof confirmReviewedMultiCycleRunSourceTx>>,
 z.infer<typeof MultiCycleRunPreparedReview>,z.infer<typeof MultiCycleRunCompletedReview>,z.infer<typeof MultiCycleRunRetiredReview>,z.infer<typeof MultiCycleRunReviewIndex>
>({
 action,tier:'approve',maxBodyBytes:45000,human:Human,metadata:Metadata,stored:Stored,
 confirmation:MultiCycleRunReviewConfirmation,retirement:MultiCycleRunReviewRetirement,retired:MultiCycleRunRetiredReview,index:MultiCycleRunReviewIndex,indexKind:'multi_cycle_run_review_index',
 async withInterval(tx,ctx,nomination,work){const actor=await assertReviewedMultiCycleRunActorTx(tx,ctx);let selection:Selection;
  if(nomination.human){const input=nomination.human.input;selection=Selection.parse({companyId:input.companyId,payPeriod:input.payPeriod,payrollCycleId:input.payrollCycleId,runType:input.runType});}else{const id=z.guid().parse(nomination.actionId),[row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_multi_cycle_run_review_subject(${id}::uuid) as subject`);selection=Selection.parse(row?.subject);}
  return withReviewedMultiCycleRunSourceIntervalTx(tx,actor,selection,(fresh,source)=>work(fresh,{...source,runType:selection.runType}));
 },
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,...source}),
 assertSubjectBinding:(binding,source)=>{if(binding.companyId!==source.companyId||binding.payPeriod!==source.payPeriod||binding.payrollCycleId!==source.payrollCycleId||binding.runType!==source.runType)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.input.companyId.toLowerCase()!==binding.companyId||human.input.payPeriod!==binding.payPeriod||human.input.payrollCycleId.toLowerCase()!==binding.payrollCycleId||human.input.runType!==binding.runType)return fail();},
 prepareNative:(tx,ctx,human)=>prepareReviewedMultiCycleRunSourceTx(tx,ctx,human),
 confirmNative:(tx,ctx,body)=>confirmReviewedMultiCycleRunSourceTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(row,body,current)=>MultiCycleRunPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review}),
 async completed(tx,ctx,row){if(!row.batchId||!row.eventId)return fail();const receipt=await reconcileReviewedMultiCycleRunSourceTx(tx,ctx,{batchId:row.batchId,createdEventId:row.eventId}),b=row.metadata.binding;if(receipt.companyId!==b.companyId||receipt.payPeriod!==b.payPeriod||receipt.createdPayrollCycleId!==b.payrollCycleId||receipt.runType!==b.runType)return fail();return MultiCycleRunCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.createdEventId,
 assertCompletion:(row,native)=>{const b=row.metadata.binding;if(row.batchId!==native.batchId||row.eventId!==native.createdEventId||native.companyId!==b.companyId||native.payPeriod!==b.payPeriod||native.createdPayrollCycleId!==b.payrollCycleId||native.runType!==b.runType)return fail();},
 targets:(_source,_native,current)=>{if(!current)return fail();return[...current.erasurePersonIds.map(id=>({kind:'person' as const,id})),...current.erasureEmploymentIds.map(id=>({kind:'employment' as const,id}))];},
 async prepareRow(tx,m,sealed,_source,_human,current){const b=m.binding;const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_multi_cycle_run_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.companyId}::uuid,${b.payPeriod},${b.payrollCycleId}::uuid,${b.runType},${uuidArray(current.erasureEmploymentIds)},${uuidArray(current.erasurePersonIds)},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_multi_cycle_run_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_multi_cycle_run_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_multi_cycle_run_review_complete(${id}::uuid,${expected},${native.batchId}::uuid,${native.createdEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_multi_cycle_run_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_multi_cycle_run_reviews_index()`));},unavailable:fail,
});
export const prepareMultiCycleRunReview=multiCycleRunReviews.prepare;
export const confirmMultiCycleRunReview=multiCycleRunReviews.confirm;
export const reopenMultiCycleRunReview=multiCycleRunReviews.reopen;
export const discardMultiCycleRunReview=multiCycleRunReviews.discard;
export const listMultiCycleRunReviews=multiCycleRunReviews.list;
export const readCompletedMultiCycleRunOutcomeTx=multiCycleRunReviews.readCompletedOutcomeTx;
