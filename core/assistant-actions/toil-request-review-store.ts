import {captureNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
/** Human-reviewed own worked-date TOIL request in the SAME review/body lifecycle. No credit is granted by
 * submission, no model computes the entitlement, and completed retries never submit a new request. */
import {createHash,randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {PrivateReviewNonce,newPrivateReviewNonce,privateReviewCommitment} from './private-review-commitment';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {assertAiPrincipalTx} from '../ai-principal';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
import {OwnLeaveSealedReview} from './own-leave-content';
import {OWN_TOIL_REPLACEMENT_ACTION as action,OwnToilReplacementHumanContent as Human,OwnToilReplacementPreparedSource} from '../../lib/assistant-actions/own-toil-replacement-contract';
import {ToilRequestReviewPrepare,ToilRequestReviewConfirmation,ToilRequestReviewRetirement,ToilRequestPreparedReview,ToilRequestCompletedReview,ToilRequestRetiredReview,ToilRequestReviewIndex} from '../../lib/assistant-actions/toil-request-review-contract';
import {assertOwnToilReplacementActorTx,withOwnToilReplacementIntervalTx,prepareOwnToilReplacementSourceTx,confirmOwnToilReplacementSourceTx,reconcileOwnToilReplacementSourceTx} from './own-toil-replacement-source';
export class ToilRequestReviewUnavailable extends Error{constructor(){super('That time-in-lieu review needs a little breather. Please reopen it and try again.');this.name='ToilRequestReviewUnavailable';}}
const fail=():never=>{throw new ToilRequestReviewUnavailable();},hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),digest=z.string().regex(/^[a-f0-9]{64}$/);
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid(),employmentId:z.guid(),companyId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),requestId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.requestId!==null&&value.eventId!==null)
 &&((value.requestId===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;type NativePrepared=z.infer<typeof OwnToilReplacementPreparedSource>;
// Capture human content ONCE. Re-derive the outward native review only after its private source
// digest matches, rather than retaining another copy of canonical/derived entitlement values.
const Body=z.object({reviewNonce:PrivateReviewNonce,content:Human,nativeReviewedDigest:digest}).strict();type Body=z.infer<typeof Body>;
function identity(m:Meta){if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);}
const reviewed=(binding:z.infer<typeof Binding>,body:Body)=>privateReviewCommitment([1,action,binding],body);
function checked(m:Meta,value:unknown){const body=Body.parse(value);if(body.content.employmentId!==m.binding.employmentId||hash(body.content)!==m.intentDigest||reviewed(m.binding,body)!==m.reviewedDigest)return fail();return body;}
function seal(m:Meta,body:Body){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(m),text=JSON.stringify(checked(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}finally{dek?.fill(0);}}
function unseal(stored:Stored){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(stored.metadata),sealed=OwnLeaveSealedReview.parse(stored.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();return checked(stored.metadata,JSON.parse(text));}finally{dek?.fill(0);}}
async function read(tx:Tx,query:SQL){const [row]=await tx.execute<{review:unknown}>(query);return Stored.parse(row?.review);}
function bound(stored:Stored,ctx:SessionContext,id:string,source:{employmentId:string;companyId:string}){const m=stored.metadata;if(m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==ctx.personId||m.binding.employmentId!==source.employmentId||m.binding.companyId!==source.companyId)return fail();}
function pending(stored:Stored,body:Body,current:NativePrepared){if(current.reviewedDigest!==body.nativeReviewedDigest||JSON.stringify(current.content)!==JSON.stringify(body.content))return fail();const m=stored.metadata;return{kind:'prepared' as const,review:ToilRequestPreparedReview.parse({action,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,content:body.content,review:current.review,consequence:'request_only_no_credit_grant_or_cash'})};}
function retired(stored:Stored){return{kind:'retired' as const,receipt:ToilRequestRetiredReview.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:stored.metadata.state})};}
async function completed(tx:Tx,ctx:SessionContext,stored:Stored){if(stored.metadata.state!=='completed'||!stored.requestId||!stored.eventId)return fail();const receipt=await reconcileOwnToilReplacementSourceTx(tx,ctx,{requestId:stored.requestId,submittedEventId:stored.eventId,employmentId:stored.metadata.binding.employmentId});return{kind:'completed' as const,receipt:ToilRequestCompletedReview.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt})};}
async function subject(tx:Tx,id:string){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_toil_request_review_subject(${id}::uuid) as subject`);return z.guid().parse(row?.subject);}
export async function prepareToilRequestReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=ToilRequestReviewPrepare.safeParse(input);if(!parsed.success)return fail();const human=parsed.data;try{return await withTenant(ctx,tx=>withOwnToilReplacementIntervalTx(tx,ctx,human.employmentId,async(fresh,source)=>{
 const native=await prepareOwnToilReplacementSourceTx(tx,fresh,human),body=Body.parse({reviewNonce:newPrivateReviewNonce(),content:native.content,nativeReviewedDigest:native.reviewedDigest}),binding=Binding.parse({tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId,employmentId:source.employmentId,companyId:source.companyId});
 const now=new Date(),m=Metadata.parse({actionId:randomUUID(),action,contractVersion:1,binding,intentDigest:hash(body.content),reviewedDigest:reviewed(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()}),sealed=seal(m,body);
 const stored=await read(tx,sql`select app.assistant_toil_request_review_prepare(${m.actionId}::uuid,${binding.personId}::uuid,${binding.employmentId}::uuid,${binding.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);bound(stored,fresh,m.actionId,source);return pending(stored,unseal(stored),native);
 }));}catch{return fail();}}
export async function confirmToilRequestReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=ToilRequestReviewConfirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{
 const actor=await assertOwnToilReplacementActorTx(tx,ctx),employmentId=await subject(tx,p.actionId);return withOwnToilReplacementIntervalTx(tx,actor,employmentId,async(fresh,source)=>{
 const stored=await read(tx,sql`select app.assistant_toil_request_review_read(${p.actionId}::uuid) as review`);bound(stored,fresh,p.actionId,source);if(stored.metadata.state==='completed')return completed(tx,fresh,stored);if(stored.metadata.state!=='awaiting_confirmation')return retired(stored);if(stored.metadata.reviewedDigest!==p.reviewedDigest)return fail();const body=unseal(stored),native=await confirmOwnToilReplacementSourceTx(tx,fresh,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest});
 await captureNativeOutcomeTargetsTx(tx,fresh,{action:action,sourceId:p.actionId,eventId:native.submittedEventId,targets:[{kind:'employment',id:source.employmentId}]});
 const done=await read(tx,sql`select app.assistant_toil_request_review_complete(${p.actionId}::uuid,${p.reviewedDigest},${native.requestId}::uuid,${native.submittedEventId}::uuid) as review`);bound(done,fresh,p.actionId,source);if(done.requestId!==native.requestId||done.eventId!==native.submittedEventId)return fail();return completed(tx,fresh,done);
 });});}catch{return fail();}}
export async function reopenToilRequestReview(supplied:SessionContext,value:unknown){const ctx=capture(supplied),parsed=z.guid().safeParse(value);if(!parsed.success)return fail();const id=parsed.data;try{return await withTenant(ctx,async tx=>{
 const actor=await assertOwnToilReplacementActorTx(tx,ctx),employmentId=await subject(tx,id);return withOwnToilReplacementIntervalTx(tx,actor,employmentId,async(fresh,source)=>{
 const stored=await read(tx,sql`select app.assistant_toil_request_review_read(${id}::uuid) as review`);bound(stored,fresh,id,source);if(stored.metadata.state==='awaiting_confirmation'){const body=unseal(stored),native=await prepareOwnToilReplacementSourceTx(tx,fresh,body.content);return pending(stored,body,native);}return stored.metadata.state==='completed'?completed(tx,fresh,stored):retired(stored);
 });});}catch{return fail();}}
/** Login-only metadata/retirement requires no lost review digest, grant or plaintext reopening. */
export async function discardToilRequestReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=ToilRequestReviewRetirement.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_toil_request_review_discard(${p.actionId}::uuid) as receipt`);return{kind:'retired' as const,receipt:ToilRequestRetiredReview.parse(row?.receipt)};});}catch{return fail();}}
export async function listToilRequestReviews(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const rows=await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_toil_request_reviews_index()`);return ToilRequestReviewIndex.parse({kind:'toil_request_review_index',reviews:Array.from(rows)});});}catch{return fail();}}

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export async function readCompletedToilRequestOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown){
 const ctx=capture(supplied),id=z.guid().parse(value);await boundNativeOutcomeTransactionTx(tx);
 const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${'toil.replacement.request'},${id}::uuid) as completed`);
 if(terminal?.completed!==true)return fail();
 const actor=await assertOwnToilReplacementActorTx(tx,ctx),employmentId=await subject(tx,id);return withOwnToilReplacementIntervalTx(tx,actor,employmentId,async(fresh,source)=>{const stored=await read(tx,sql`select app.assistant_toil_request_review_read(${id}::uuid) as review`);bound(stored,fresh,id,source);const completion=await completed(tx,fresh,stored);return{completion,eventId:z.guid().parse(stored.eventId)};});
}
