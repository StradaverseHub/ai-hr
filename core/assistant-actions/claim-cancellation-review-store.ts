/** ADR-0151 wave 1: own claim cancellation in the ONE prepared-action store, through the generic SQL review
 * functions of migration 0670 and its dedicated TypeScript custody adapter. Same custody as every other own review: sealed human content, digest-bound
 * human confirmation, the effect and its receipt in one transaction, completed retries never repeat. */
import {createHash,randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {PrivateReviewNonce,newPrivateReviewNonce,privateReviewCommitment} from './private-review-commitment';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {assertAiPrincipalTx} from '../ai-principal';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
import {OwnLeaveSealedReview} from './own-leave-content';
import {captureNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
import {OWN_CLAIM_CANCELLATION_ACTION as action,OwnClaimCancellationHumanContent as Human,ClaimCancellationReviewPrepare,ClaimCancellationReviewConfirmation,ClaimCancellationReviewRetirement,ClaimCancellationPreparedReview,ClaimCancellationCompletedReview,ClaimCancellationRetiredReview,ClaimCancellationReviewIndex,type OwnClaimCancellationPreparedSource} from '../../lib/assistant-actions/own-claim-cancellation-contract';
import {withOwnClaimCancellationSubjectTx,prepareOwnClaimCancellationSourceTx,confirmOwnClaimCancellationSourceTx,reconcileOwnClaimCancellationSourceTx,readOwnClaimCancellationChoicesTx} from './own-claim-cancellation-source';
export class ClaimCancellationReviewUnavailable extends Error{constructor(){super('That claim cancellation review needs a fresh look. Please reopen it and try again.');this.name='ClaimCancellationReviewUnavailable';}}
const fail=():never=>{throw new ClaimCancellationReviewUnavailable();},hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),digest=z.string().regex(/^[a-f0-9]{64}$/);
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid(),employmentId:z.guid(),companyId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),subjectKind:z.literal('claim_request'),subjectId:z.guid(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
const Body=z.object({reviewNonce:PrivateReviewNonce,content:Human,nativeReviewedDigest:digest}).strict();type Body=z.infer<typeof Body>;
function identity(m:Meta){if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);}
const reviewed=(binding:z.infer<typeof Binding>,body:Body)=>privateReviewCommitment([1,action,binding],body);
function checked(m:Meta,value:unknown){const body=Body.parse(value);if(body.content.employmentId!==m.binding.employmentId||hash(body.content)!==m.intentDigest||reviewed(m.binding,body)!==m.reviewedDigest)return fail();return body;}
function seal(m:Meta,body:Body){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(m),text=JSON.stringify(checked(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}catch{return fail();}finally{dek?.fill(0);}}
function unseal(stored:Stored){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(stored.metadata),sealed=OwnLeaveSealedReview.parse(stored.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();return checked(stored.metadata,JSON.parse(text));}catch{return fail();}finally{dek?.fill(0);}}
async function read(tx:Tx,query:SQL){const [row]=await tx.execute<{review:unknown}>(query);return Stored.parse(row?.review);}
function bound(stored:Stored,ctx:SessionContext,id:string,own:{claimId:string;employmentId:string;companyId:string}){const m=stored.metadata;if(m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==ctx.personId||m.binding.employmentId!==own.employmentId||m.binding.companyId!==own.companyId||stored.subjectId!==own.claimId)return fail();}
function pending(stored:Stored,body:Body,current:OwnClaimCancellationPreparedSource){if(current.reviewedDigest!==body.nativeReviewedDigest||JSON.stringify(current.content)!==JSON.stringify(body.content))return fail();const m=stored.metadata;return{kind:'prepared' as const,review:ClaimCancellationPreparedReview.parse({action,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,content:body.content,review:current.review,consequence:current.consequence})};}
function retired(stored:Stored){return{kind:'retired' as const,receipt:ClaimCancellationRetiredReview.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:stored.metadata.state})};}
async function completed(tx:Tx,ctx:SessionContext,stored:Stored){if(stored.metadata.state!=='completed'||!stored.eventId)return fail();const receipt=await reconcileOwnClaimCancellationSourceTx(tx,ctx,{claimId:stored.subjectId,eventId:stored.eventId,employmentId:stored.metadata.binding.employmentId});return{kind:'completed' as const,receipt:ClaimCancellationCompletedReview.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt})};}
async function subject(tx:Tx,id:string){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_generic_review_subject(${id}::uuid,${action}) as subject`);return z.object({employmentId:z.guid(),subjectId:z.guid()}).strict().parse(row?.subject);}

export async function readClaimCancellationChoices(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,tx=>readOwnClaimCancellationChoicesTx(tx,ctx));}catch{return{kind:'unavailable' as const};}}
export async function prepareClaimCancellationReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=ClaimCancellationReviewPrepare.safeParse(input);if(!parsed.success)return fail();const human=parsed.data;try{return await withTenant(ctx,tx=>withOwnClaimCancellationSubjectTx(tx,ctx,human.claimId,async(fresh,own)=>{
 if(own.employmentId!==human.employmentId)return fail();
 const native=await prepareOwnClaimCancellationSourceTx(tx,fresh,human),body=Body.parse({reviewNonce:newPrivateReviewNonce(),content:native.content,nativeReviewedDigest:native.reviewedDigest}),binding=Binding.parse({tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId,employmentId:own.employmentId,companyId:own.companyId});
 const now=new Date(),m=Metadata.parse({actionId:randomUUID(),action,contractVersion:1,binding,intentDigest:hash(body.content),reviewedDigest:reviewed(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()}),sealed=seal(m,body);
 const stored=await read(tx,sql`select app.assistant_generic_review_prepare(${action},${m.actionId}::uuid,${binding.personId}::uuid,${binding.employmentId}::uuid,${binding.companyId}::uuid,${own.claimId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);bound(stored,fresh,m.actionId,own);return pending(stored,unseal(stored),native);
 }));}catch{return fail();}}
export async function confirmClaimCancellationReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=ClaimCancellationReviewConfirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{
 const nominee=await subject(tx,p.actionId);return withOwnClaimCancellationSubjectTx(tx,ctx,nominee.subjectId,async(fresh,own)=>{
 const stored=await read(tx,sql`select app.assistant_generic_review_read(${p.actionId}::uuid,${action}) as review`);bound(stored,fresh,p.actionId,own);if(stored.metadata.state==='completed')return completed(tx,fresh,stored);if(stored.metadata.state!=='awaiting_confirmation')return retired(stored);if(stored.metadata.reviewedDigest!==p.reviewedDigest)return fail();
 const body=unseal(stored),native=await confirmOwnClaimCancellationSourceTx(tx,fresh,body.content,body.nativeReviewedDigest);
 await captureNativeOutcomeTargetsTx(tx,fresh,{action,sourceId:p.actionId,eventId:native.cancelledEventId,targets:[{kind:'employment',id:own.employmentId}]});
 const done=await read(tx,sql`select app.assistant_generic_review_complete(${p.actionId}::uuid,${action},${p.reviewedDigest},${native.cancelledEventId}::uuid) as review`);bound(done,fresh,p.actionId,own);if(done.eventId!==native.cancelledEventId)return fail();return completed(tx,fresh,done);
 });});}catch{return fail();}}
export async function reopenClaimCancellationReview(supplied:SessionContext,value:unknown){const ctx=capture(supplied),parsed=z.guid().safeParse(value);if(!parsed.success)return fail();const id=parsed.data;try{return await withTenant(ctx,async tx=>{
 const nominee=await subject(tx,id);return withOwnClaimCancellationSubjectTx(tx,ctx,nominee.subjectId,async(fresh,own)=>{
 const stored=await read(tx,sql`select app.assistant_generic_review_read(${id}::uuid,${action}) as review`);bound(stored,fresh,id,own);if(stored.metadata.state==='awaiting_confirmation'){const body=unseal(stored),native=await prepareOwnClaimCancellationSourceTx(tx,fresh,body.content);return pending(stored,body,native);}return stored.metadata.state==='completed'?completed(tx,fresh,stored):retired(stored);
 });});}catch{return fail();}}
/** Login-only retirement: needs no review digest, grant or decryption. */
export async function discardClaimCancellationReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=ClaimCancellationReviewRetirement.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const stored=await read(tx,sql`select app.assistant_generic_review_read(${p.actionId}::uuid,${action},true) as review`);if(stored.metadata.actionId!==p.actionId||stored.metadata.binding.userId!==ctx.userId)return fail();return retired(stored);});}catch{return fail();}}
export async function listClaimCancellationReviews(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const rows=await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_generic_reviews_index(${action})`);return ClaimCancellationReviewIndex.parse({kind:'claim_cancellation_review_index',reviews:rows});});}catch{return fail();}}

/** Completed-only evidence adapter for outcome linking. Same caller Tx/authority; no pending decryption,
 * preparation or confirmation. Any refusal requires caller rollback. */
export async function readCompletedClaimCancellationOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown){
 const ctx=capture(supplied),id=z.guid().parse(value);await boundNativeOutcomeTransactionTx(tx);
 const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${action},${id}::uuid) as completed`);
 if(terminal?.completed!==true)return fail();
 const nominee=await subject(tx,id);return withOwnClaimCancellationSubjectTx(tx,ctx,nominee.subjectId,async(fresh,own)=>{const stored=await read(tx,sql`select app.assistant_generic_review_read(${id}::uuid,${action}) as review`);bound(stored,fresh,id,own);const completion=await completed(tx,fresh,stored);return{completion,eventId:z.guid().parse(stored.eventId)};});
}
