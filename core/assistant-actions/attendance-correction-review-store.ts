/** WP9: generic OWN attendance request custody, retaining intent-wire and native-preflight ordering. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx,SessionContext} from '../../db/client';
import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {PrivateReviewNonce} from './private-review-commitment';
import {OwnLeaveSealedReview} from './own-leave-content';
import {OwnAttendanceCorrectionIntent as Human} from '../../lib/assistant-actions/own-attendance-correction-contract';
import {ATTENDANCE_CORRECTION_REVIEW_ACTION as action,AttendanceCorrectionReviewPrepare,AttendanceCorrectionReviewConfirmation,AttendanceCorrectionReviewRetirement,AttendanceCorrectionPreparedReview,AttendanceCorrectionCompletedReview,AttendanceCorrectionRetiredReview,AttendanceCorrectionReviewIndex} from '../../lib/assistant-actions/attendance-correction-review-contract';
import {assertOwnAttendanceCorrectionActorTx,withOwnAttendanceCorrectionIntervalTx,prepareOwnAttendanceCorrectionTx,confirmOwnAttendanceCorrectionTx,reopenOwnAttendanceCorrectionEventTx} from './own-attendance-correction-source';
export class AttendanceCorrectionReviewUnavailable extends Error{constructor(){super('That attendance review needs another look. Please reopen your correction.');this.name='AttendanceCorrectionReviewUnavailable';}}
const fail=():never=>{throw new AttendanceCorrectionReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid(),employmentId:z.guid(),companyId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),requestId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.requestId!==null&&value.eventId!==null)
 &&((value.requestId===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
const Wire=z.object({reviewNonce:PrivateReviewNonce,intent:Human,nativeReviewedDigest:digest}).strict();
type Source={employmentId:string;companyId:string;correctionId:string|null};
async function nativePrepare(tx:Tx,ctx:SessionContext,human:z.infer<typeof Human>){const native=await prepareOwnAttendanceCorrectionTx(tx,ctx,human);return{content:human,reviewedDigest:native.reviewDigest,native};}
export const attendanceCorrectionReviews=createGenericOwnCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,Awaited<ReturnType<typeof nativePrepare>>,Awaited<ReturnType<typeof confirmOwnAttendanceCorrectionTx>>,
 z.infer<typeof AttendanceCorrectionPreparedReview>,z.infer<typeof AttendanceCorrectionCompletedReview>,z.infer<typeof AttendanceCorrectionRetiredReview>,z.infer<typeof AttendanceCorrectionReviewIndex>
>({
 action,tier:'confirm',human:Human,metadata:Metadata,stored:Stored,
 confirmation:AttendanceCorrectionReviewConfirmation,retirement:AttendanceCorrectionReviewRetirement,retired:AttendanceCorrectionRetiredReview,index:AttendanceCorrectionReviewIndex,indexKind:'attendance_correction_review_index',
 body:{read:value=>{const raw=Wire.parse(value);return{reviewNonce:raw.reviewNonce,content:raw.intent,nativeReviewedDigest:raw.nativeReviewedDigest};},write:body=>Wire.parse({reviewNonce:body.reviewNonce,intent:body.content,nativeReviewedDigest:body.nativeReviewedDigest}),create:(native,reviewNonce)=>({reviewNonce,content:native.content,nativeReviewedDigest:native.reviewedDigest}),assertCurrent:()=>{}},
 async withInterval(tx,ctx,nomination,work){const actor=await assertOwnAttendanceCorrectionActorTx(tx,ctx);let ref:{employmentId:string;correctionId:string|null};
  if(nomination.human)ref={employmentId:nomination.human.employmentId,correctionId:null};else{const id=z.guid().parse(nomination.actionId),[row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_attendance_review_subject(${id}::uuid) as subject`);ref=z.object({employmentId:z.guid(),correctionId:z.guid().nullable()}).strict().parse(row?.subject);}
  return withOwnAttendanceCorrectionIntervalTx(tx,actor,ref,(fresh,source)=>work(fresh,{...source,correctionId:ref.correctionId}));
 },
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,employmentId:source.employmentId,companyId:source.companyId}),
 assertSubjectBinding:(binding,source)=>{if(binding.employmentId!==source.employmentId||binding.companyId!==source.companyId)return fail();},
 assertStoredSubject:(row,source,phase)=>{if(phase!=='completed'&&row.requestId!==source.correctionId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.employmentId!==binding.employmentId)return fail();},
 prepareNative:nativePrepare,
 confirmNative:(tx,ctx,body)=>confirmOwnAttendanceCorrectionTx(tx,ctx,body.content,body.nativeReviewedDigest),
 pending:(row,_body,current)=>{const{reviewDigest,...review}=current.native;void reviewDigest;return AttendanceCorrectionPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,review});},
 async completed(tx,ctx,row){if(!row.requestId||!row.eventId)return fail();const receipt=await reopenOwnAttendanceCorrectionEventTx(tx,ctx,{employmentId:row.metadata.binding.employmentId,eventId:row.eventId});if(receipt.correctionId!==row.requestId)return fail();return AttendanceCorrectionCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.eventId,
 assertCompletion:(row,native)=>{if(row.requestId!==native.correctionId||row.eventId!==native.eventId)return fail();},targets:source=>[{kind:'employment',id:source.employmentId}],
 async prepareRow(tx,m,sealed){const b=m.binding;const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_attendance_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_attendance_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_attendance_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_attendance_review_complete(${id}::uuid,${expected},${native.correctionId}::uuid,${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_attendance_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_attendance_reviews_index()`));},unavailable:fail,
});
export async function prepareAttendanceCorrectionReview(ctx:SessionContext,input:unknown){assertHumanReviewedActionTier(ctx,action,'confirm');const parsed=AttendanceCorrectionReviewPrepare.safeParse(input);if(!parsed.success)return fail();return attendanceCorrectionReviews.prepare(ctx,parsed.data.intent);}
export const confirmAttendanceCorrectionReview=attendanceCorrectionReviews.confirm;
export const reopenAttendanceCorrectionReview=attendanceCorrectionReviews.reopen;
export const discardAttendanceCorrectionReview=attendanceCorrectionReviews.discard;
export const listAttendanceCorrectionReviews=attendanceCorrectionReviews.list;
export const readCompletedAttendanceCorrectionOutcomeTx=attendanceCorrectionReviews.readCompletedOutcomeTx;
