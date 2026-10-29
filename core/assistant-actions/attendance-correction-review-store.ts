import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {captureNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
/** Human-reviewed own Attendance correction custody; models never invent clocks/work or approve OT. */
import {createHash,randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {assertAiPrincipalTx} from '../ai-principal';
import {PrivateReviewNonce,newPrivateReviewNonce,privateReviewCommitment} from './private-review-commitment';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
import {OwnLeaveSealedReview} from './own-leave-content';
import {OwnAttendanceCorrectionIntent as Human,OwnAttendanceCorrectionReview} from '../../lib/assistant-actions/own-attendance-correction-contract';
import {ATTENDANCE_CORRECTION_REVIEW_ACTION as action,AttendanceCorrectionReviewPrepare,AttendanceCorrectionReviewConfirmation,AttendanceCorrectionReviewRetirement,AttendanceCorrectionPreparedReview,AttendanceCorrectionCompletedReview,AttendanceCorrectionRetiredReview,AttendanceCorrectionReviewIndex} from '../../lib/assistant-actions/attendance-correction-review-contract';
import {assertOwnAttendanceCorrectionActorTx,withOwnAttendanceCorrectionIntervalTx,prepareOwnAttendanceCorrectionTx,confirmOwnAttendanceCorrectionTx,reopenOwnAttendanceCorrectionEventTx} from './own-attendance-correction-source';
export class AttendanceCorrectionReviewUnavailable extends Error{constructor(){super('That attendance review needs another look. Please reopen your correction.');this.name='AttendanceCorrectionReviewUnavailable';}}
const fail=():never=>{throw new AttendanceCorrectionReviewUnavailable();},hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),digest=z.string().regex(/^[a-f0-9]{64}$/);
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid(),employmentId:z.guid(),companyId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),requestId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.requestId!==null&&value.eventId!==null)
 &&((value.requestId===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;type NativePrepared=z.infer<typeof OwnAttendanceCorrectionReview>;
// Capture human content ONCE. Re-derive the outward native review only after its private source
// digest matches, rather than retaining another copy of canonical/derived entitlement values.
const Body=z.object({reviewNonce:PrivateReviewNonce,intent:Human,nativeReviewedDigest:digest}).strict();type Body=z.infer<typeof Body>;
function identity(m:Meta){if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);}
const reviewed=(binding:z.infer<typeof Binding>,body:Body)=>privateReviewCommitment([1,action,binding],body);
function checked(m:Meta,value:unknown){const body=Body.parse(value);if(body.intent.employmentId!==m.binding.employmentId||hash(body.intent)!==m.intentDigest||reviewed(m.binding,body)!==m.reviewedDigest)return fail();return body;}
function seal(m:Meta,body:Body){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(m),text=JSON.stringify(checked(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}finally{dek?.fill(0);}}
function unseal(stored:Stored){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(stored.metadata),sealed=OwnLeaveSealedReview.parse(stored.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();return checked(stored.metadata,JSON.parse(text));}finally{dek?.fill(0);}}
async function read(tx:Tx,query:SQL){const [row]=await tx.execute<{review:unknown}>(query);return Stored.parse(row?.review);}
function bound(stored:Stored,ctx:SessionContext,id:string,source:{employmentId:string;companyId:string}){const m=stored.metadata;if(m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==ctx.personId||m.binding.employmentId!==source.employmentId||m.binding.companyId!==source.companyId)return fail();}
function pending(stored:Stored,current:NativePrepared){const {reviewDigest:_,...review}=current;void _;const m=stored.metadata;return {kind:'prepared' as const,review:AttendanceCorrectionPreparedReview.parse({action,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,review})};}
function retired(stored:Stored){return{kind:'retired' as const,receipt:AttendanceCorrectionRetiredReview.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:stored.metadata.state})};}
async function completed(tx:Tx,ctx:SessionContext,stored:Stored){if(stored.metadata.state!=='completed'||!stored.requestId||!stored.eventId)return fail();const receipt=await reopenOwnAttendanceCorrectionEventTx(tx,ctx,{employmentId:stored.metadata.binding.employmentId,eventId:stored.eventId});if(receipt.correctionId!==stored.requestId)return fail();return {kind:'completed' as const,receipt:AttendanceCorrectionCompletedReview.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt})};}
async function subject(tx:Tx,id:string){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_attendance_review_subject(${id}::uuid) as subject`);return z.object({employmentId:z.guid(),correctionId:z.guid().nullable()}).strict().parse(row?.subject);}
async function peek(tx:Tx,id:string){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_attendance_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);}
function sameSnapshot(before:Stored,after:Stored){if(JSON.stringify(before)!==JSON.stringify(after))return fail();}

export async function prepareAttendanceCorrectionReview(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,'attendance.correction.request','confirm');const ctx=capture(supplied),parsed=AttendanceCorrectionReviewPrepare.safeParse(input);if(!parsed.success)return fail();const human=parsed.data.intent;try{return await withTenant(ctx,tx=>withOwnAttendanceCorrectionIntervalTx(tx,ctx,{employmentId:human.employmentId,correctionId:null},async(fresh,source)=>{
 // The actual full native preparation owns conditional policy/day/Payroll locks before INSERT custody.
 const native=await prepareOwnAttendanceCorrectionTx(tx,fresh,human),body=Body.parse({reviewNonce:newPrivateReviewNonce(),intent:human,nativeReviewedDigest:native.reviewDigest}),binding=Binding.parse({tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId,employmentId:source.employmentId,companyId:source.companyId}),now=new Date(),m=Metadata.parse({actionId:randomUUID(),action,contractVersion:1,binding,intentDigest:hash(body.intent),reviewedDigest:reviewed(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()}),sealed=seal(m,body);
 const stored=await read(tx,sql`select app.assistant_attendance_review_prepare(${m.actionId}::uuid,${binding.personId}::uuid,${binding.employmentId}::uuid,${binding.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);bound(stored,fresh,m.actionId,source);unseal(stored);return pending(stored,native);
 }));}catch{return fail();}}
/** Peek is encrypted own-custody nomination only, not permission to execute. Fresh own actor and
 * source-prefix ownership precede decryption; actual native preparation then precedes custody NOWAIT.
 * Exact row/body/state reread refuses concurrent discard/rebind/drift before any native effect. */
async function existing(supplied:SessionContext,id:string,expected:string|undefined,confirm:boolean){const ctx=capture(supplied);return withTenant(ctx,async tx=>{const actor=await assertOwnAttendanceCorrectionActorTx(tx,ctx),nomination=await subject(tx,id);return withOwnAttendanceCorrectionIntervalTx(tx,actor,nomination,async(fresh,source)=>{
 const initial=await peek(tx,id),before=initial.review;bound(before,fresh,id,source);if(before.requestId!==nomination.correctionId)return fail();
 if(before.metadata.state!=='awaiting_confirmation'||initial.pendingExpired){const stored=await read(tx,sql`select app.assistant_attendance_review_read(${id}::uuid) as review`);bound(stored,fresh,id,source);if(initial.pendingExpired){if(stored.metadata.state!=='expired')return fail();return retired(stored);}sameSnapshot(before,stored);return stored.metadata.state==='completed'?completed(tx,fresh,stored):retired(stored);}
 if(confirm&&before.metadata.reviewedDigest!==expected)return fail();const body=unseal(before),native=await prepareOwnAttendanceCorrectionTx(tx,fresh,body.intent);if(native.reviewDigest!==body.nativeReviewedDigest)return fail();
 const stored=await read(tx,sql`select app.assistant_attendance_review_read(${id}::uuid) as review`);bound(stored,fresh,id,source);sameSnapshot(before,stored);if(!confirm)return pending(stored,native);
 const receipt=await confirmOwnAttendanceCorrectionTx(tx,fresh,body.intent,body.nativeReviewedDigest);await captureNativeOutcomeTargetsTx(tx,fresh,{action:action,sourceId:id,eventId:receipt.eventId,targets:[{kind:'employment',id:source.employmentId}]});
 const done=await read(tx,sql`select app.assistant_attendance_review_complete(${id}::uuid,${expected},${receipt.correctionId}::uuid,${receipt.eventId}::uuid) as review`);bound(done,fresh,id,source);if(done.requestId!==receipt.correctionId||done.eventId!==receipt.eventId)return fail();return completed(tx,fresh,done);
 });});}
export async function confirmAttendanceCorrectionReview(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,'attendance.correction.request','confirm');const ctx=capture(supplied),parsed=AttendanceCorrectionReviewConfirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await existing(ctx,p.actionId,p.reviewedDigest,true);}catch{return fail();}}
export async function reopenAttendanceCorrectionReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=z.guid().safeParse(input);if(!parsed.success)return fail();try{return await existing(ctx,parsed.data,undefined,false);}catch{return fail();}}
/** Login-only metadata and retirement remain available without digest/content/source grants. */
export async function discardAttendanceCorrectionReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=AttendanceCorrectionReviewRetirement.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_attendance_review_discard(${p.actionId}::uuid) as receipt`);return{kind:'retired' as const,receipt:AttendanceCorrectionRetiredReview.parse(row?.receipt)};});}catch{return fail();}}
export async function listAttendanceCorrectionReviews(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const rows=await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_attendance_reviews_index()`);return AttendanceCorrectionReviewIndex.parse({kind:'attendance_correction_review_index',reviews:Array.from(rows)});});}catch{return fail();}}

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export async function readCompletedAttendanceCorrectionOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown){
 const ctx=capture(supplied),id=z.guid().parse(value);await boundNativeOutcomeTransactionTx(tx);
 const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${'attendance.correction.request'},${id}::uuid) as completed`);
 if(terminal?.completed!==true)return fail();
 const actor=await assertOwnAttendanceCorrectionActorTx(tx,ctx),nomination=await subject(tx,id);return withOwnAttendanceCorrectionIntervalTx(tx,actor,nomination,async(fresh,source)=>{const stored=await read(tx,sql`select app.assistant_attendance_review_read(${id}::uuid) as review`);bound(stored,fresh,id,source);if(stored.requestId!==nomination.correctionId)return fail();const completion=await completed(tx,fresh,stored);return{completion,eventId:z.guid().parse(stored.eventId)};});
}
