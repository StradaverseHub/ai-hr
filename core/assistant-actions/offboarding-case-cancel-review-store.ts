/** Same encrypted ledger/engine factory; dedicated owners mount its registered singleton. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {NATIVE_OUTCOME_ACTIONS,type NativeOutcomeAction} from '../../lib/ai/module-native-outcomes';
import {createReviewCustody} from './generic-review-custody';
import {OwnLeaveSealedReview} from './own-leave-content';
import {OffboardingCaseCancel as C} from '../../lib/assistant-actions/offboarding-case-cancel-contract';
import {withOffboardingCaseCancelIntervalTx,prepareOffboardingCaseCancelSourceTx,confirmOffboardingCaseCancelSourceTx,reconcileOffboardingCaseCancelSourceTx,offboardingCaseCancelUnavailable as fail,type OffboardingCaseCancelSource} from './offboarding-case-cancel-source';
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.guid().nullable(),companyId:z.guid(),caseId:z.guid(),casePersonId:z.guid().nullable()}).strict();
const digest=z.string().regex(/^[a-f0-9]{64}$/).nullable();
const Metadata=z.object({actionId:z.guid(),action:z.literal(C.action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest,reviewedDigest:digest,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(v=>(v.metadata.state==='completed')===(v.eventId!==null)&&(v.metadata.state==='awaiting_confirmation')===(v.sealed!==null&&v.metadata.intentDigest!==null&&v.metadata.reviewedDigest!==null));
type S=z.infer<typeof Stored>;type P=Awaited<ReturnType<typeof prepareOffboardingCaseCancelSourceTx>>;type N=Awaited<ReturnType<typeof confirmOffboardingCaseCancelSourceTx>>;
export function createOffboardingCaseCancelReviews(){
 // Runtime registry membership is mandatory; no cast/borrowed action can make an unregistered
 // action executable. Dedicated owners share the registered singleton below.
 const action=z.custom<NativeOutcomeAction>(v=>typeof v==='string'&&Object.hasOwn(NATIVE_OUTCOME_ACTIONS,v)).parse(C.action);
 return createReviewCustody<z.infer<typeof C.Human>,z.infer<typeof Binding>,S,OffboardingCaseCancelSource,P,N,z.infer<typeof C.Prepared>,z.infer<typeof C.Completed>,z.infer<typeof C.Retired>,z.infer<typeof C.Index>>({
 action,tier:'confirm',human:C.Human,metadata:Metadata,stored:Stored,confirmation:C.Confirmation,retirement:C.Retirement,retired:C.Retired,index:C.Index,indexKind:'offboarding_case_cancel_review_index',
 async withInterval(tx,ctx,nomination,work){let caseId:string;if(nomination.human)caseId=nomination.human.caseId;else{const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_offboarding_case_cancel_review_subject(${nomination.actionId}::uuid) as subject`);caseId=z.object({caseId:z.guid()}).strict().parse(row?.subject).caseId;}return withOffboardingCaseCancelIntervalTx(tx,ctx,caseId,work);},
 binding:(ctx,s)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:s.employmentId,companyId:s.companyId,caseId:s.caseId,casePersonId:s.casePersonId}),
 assertSubjectBinding:(b,s)=>{for(const key of ['caseId','casePersonId','employmentId','companyId'] as const)if(b[key]!==s[key])return fail();},
 assertHumanBinding:(b,h)=>{if(b.caseId!==h.caseId)return fail();},
 prepareNative:(tx,ctx,h)=>prepareOffboardingCaseCancelSourceTx(tx,ctx,h),confirmNative:(tx,ctx,b)=>confirmOffboardingCaseCancelSourceTx(tx,ctx,b.content,b.nativeReviewedDigest),
 pending:(r,b,current)=>C.Prepared.parse({action:C.action,contractVersion:1,actionId:r.metadata.actionId,reviewedDigest:r.metadata.reviewedDigest,createdAt:r.metadata.createdAt,expiresAt:r.metadata.expiresAt,content:b.content,review:current.review}),
 async completed(tx,ctx,r){if(!r.eventId)return fail();const receipt=await reconcileOffboardingCaseCancelSourceTx(tx,ctx,r.metadata.actionId);if(receipt.caseId!==r.metadata.binding.caseId||receipt.eventId!==r.eventId)return fail();return C.Completed.parse({action:C.action,contractVersion:1,actionId:r.metadata.actionId,state:'completed',receipt});},
 event:r=>r.eventId,nativeEvent:n=>n.eventId,assertCompletion:(r,n)=>{if(r.eventId!==n.eventId||r.metadata.binding.caseId!==n.caseId)return fail();},
 targets:s=>[{kind:'lifecycle_case',id:s.caseId},...(s.employmentId?[{kind:'employment' as const,id:s.employmentId}]:[]),...(s.casePersonId?[{kind:'person' as const,id:s.casePersonId}]:[])],
 async prepareRow(tx,m,sealed,_s,_h,current){const b=m.binding;const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_offboarding_case_cancel_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.caseId}::uuid,${b.casePersonId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${current.review.after.cancelReason},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_offboarding_case_cancel_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,n){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_offboarding_case_cancel_review_complete(${id}::uuid,${expected},${n.caseId}::uuid,${n.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_offboarding_case_cancel_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_offboarding_case_cancel_reviews_index()`));},unavailable:fail,
 });
}

/** Registered atomically with the dedicated HTTP/page/outcome owners after source clearance. */
export const offboardingCaseCancelReviews=createOffboardingCaseCancelReviews();
