import {captureNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
/** Human-reviewed human catalogue CREATE custody in the same physical review/body lifecycle.
 * No model-derived rate, employee assignment or payroll execution. Completed retries never create. */
import {createHash,randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {PrivateReviewNonce,newPrivateReviewNonce,privateReviewCommitment} from './private-review-commitment';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {assertAiPrincipalTx} from '../ai-principal';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REVIEWED_PAY_COMPONENT_ACTION,ReviewedPayComponentHumanContent as PayComponentHumanContent} from '../../lib/assistant-actions/reviewed-pay-component-contract';
import {PayComponentReviewPrepare,PayComponentReviewConfirmation,PayComponentReviewRetirement,PayComponentPreparedReview,PayComponentCompletedReview,PayComponentRetiredReview,PayComponentReviewIndex} from '../../lib/assistant-actions/pay-component-review-contract';
import {withReviewedPayComponentIntervalTx,prepareReviewedPayComponentSourceTx,confirmReviewedPayComponentSourceTx,reconcileReviewedPayComponentSourceTx} from './reviewed-pay-component-source';
export class PayComponentReviewUnavailable extends Error{constructor(){super('That pay-code review needs another look. Please reopen Payroll Setup.');this.name='PayComponentReviewUnavailable';}}
const fail=():never=>{throw new PayComponentReviewUnavailable();};
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.null()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(REVIEWED_PAY_COMPONENT_ACTION),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),componentId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.componentId!==null&&value.eventId!==null)
 &&((value.componentId===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
const Body=z.object({reviewNonce:PrivateReviewNonce,content:PayComponentHumanContent,nativeReviewedDigest:digest}).strict();type Body=z.infer<typeof Body>;
function identity(m:Meta){if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);}
const reviewed=(binding:z.infer<typeof Binding>,body:Body)=>privateReviewCommitment([1,REVIEWED_PAY_COMPONENT_ACTION,binding],body);
function checked(m:Meta,value:unknown){const body=Body.parse(value);if(hash(body.content)!==m.intentDigest||reviewed(m.binding,body)!==m.reviewedDigest)return fail();return body;}
function seal(m:Meta,body:Body){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(m),text=JSON.stringify(checked(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}finally{dek?.fill(0);}}
function unseal(stored:Stored){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(stored.metadata),sealed=OwnLeaveSealedReview.parse(stored.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();return checked(stored.metadata,JSON.parse(text));}finally{dek?.fill(0);}}
async function read(tx:Tx,query:SQL){const [row]=await tx.execute<{review:unknown}>(query);return Stored.parse(row?.review);}
function bound(stored:Stored,ctx:SessionContext,id:string){const m=stored.metadata;if(m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==(ctx.personId??null))return fail();}
function pending(stored:Stored,current:Awaited<ReturnType<typeof prepareReviewedPayComponentSourceTx>>){const body=unseal(stored),m=stored.metadata;if(current.reviewedDigest!==body.nativeReviewedDigest||JSON.stringify(current.content)!==JSON.stringify(body.content))return fail();const review=PayComponentPreparedReview.parse({action:REVIEWED_PAY_COMPONENT_ACTION,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,content:body.content,review:current.review,consequence:'catalogue_created_no_employee_assignment_or_payroll_run'});if(Buffer.byteLength(JSON.stringify(review))>65536)return fail();return{kind:'prepared' as const,review};}
function retired(stored:Stored){return {kind:'retired' as const,receipt:PayComponentRetiredReview.parse({action:REVIEWED_PAY_COMPONENT_ACTION,contractVersion:1,actionId:stored.metadata.actionId,state:stored.metadata.state})};}
async function completed(tx:Tx,ctx:SessionContext,stored:Stored){if(stored.metadata.state!=='completed'||!stored.componentId||!stored.eventId)return fail();const receipt=await reconcileReviewedPayComponentSourceTx(tx,ctx,{componentId:stored.componentId,createdEventId:stored.eventId});return {kind:'completed' as const,receipt:PayComponentCompletedReview.parse({action:REVIEWED_PAY_COMPONENT_ACTION,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt})};}
export async function preparePayComponentReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=PayComponentReviewPrepare.safeParse(input);if(!parsed.success)return fail();const human=parsed.data;try{return await withTenant(ctx,tx=>withReviewedPayComponentIntervalTx(tx,ctx,async fresh=>{
 const native=await prepareReviewedPayComponentSourceTx(tx,fresh,human),body=Body.parse({reviewNonce:newPrivateReviewNonce(),content:native.content,nativeReviewedDigest:native.reviewedDigest}),binding=Binding.parse({tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId??null,employmentId:null,companyId:null});
 const now=new Date(),m=Metadata.parse({actionId:randomUUID(),action:REVIEWED_PAY_COMPONENT_ACTION,contractVersion:1,binding,intentDigest:hash(body.content),reviewedDigest:reviewed(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()}),sealed=seal(m,body);
 const stored=await read(tx,sql`select app.assistant_pay_component_review_prepare(${m.actionId}::uuid,${binding.personId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);bound(stored,fresh,m.actionId);return pending(stored,native);
 }));}catch{return fail();}}
export async function confirmPayComponentReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=PayComponentReviewConfirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,tx=>withReviewedPayComponentIntervalTx(tx,ctx,async fresh=>{
 const stored=await read(tx,sql`select app.assistant_pay_component_review_read(${p.actionId}::uuid) as review`);bound(stored,fresh,p.actionId);if(stored.metadata.state==='completed')return completed(tx,fresh,stored);if(stored.metadata.state!=='awaiting_confirmation')return retired(stored);if(stored.metadata.reviewedDigest!==p.reviewedDigest)return fail();
 const body=unseal(stored),native=await confirmReviewedPayComponentSourceTx(tx,fresh,body.content,{action:REVIEWED_PAY_COMPONENT_ACTION,contractVersion:1,reviewedDigest:body.nativeReviewedDigest});
 await captureNativeOutcomeTargetsTx(tx,fresh,{action:REVIEWED_PAY_COMPONENT_ACTION,sourceId:p.actionId,eventId:native.createdEventId,targets:[]});
 const done=await read(tx,sql`select app.assistant_pay_component_review_complete(${p.actionId}::uuid,${p.reviewedDigest},${native.componentId}::uuid,${native.createdEventId}::uuid) as review`);bound(done,fresh,p.actionId);if(done.componentId!==native.componentId||done.eventId!==native.createdEventId)return fail();return completed(tx,fresh,done);
 }));}catch{return fail();}}
export async function reopenPayComponentReview(supplied:SessionContext,value:unknown){const ctx=capture(supplied),parsed=z.guid().safeParse(value);if(!parsed.success)return fail();const id=parsed.data;try{return await withTenant(ctx,tx=>withReviewedPayComponentIntervalTx(tx,ctx,async fresh=>{
 const stored=await read(tx,sql`select app.assistant_pay_component_review_read(${id}::uuid) as review`);bound(stored,fresh,id);if(stored.metadata.state==='awaiting_confirmation'){const body=unseal(stored);return pending(stored,await prepareReviewedPayComponentSourceTx(tx,fresh,body.content));}return stored.metadata.state==='completed'?completed(tx,fresh,stored):retired(stored);
 }));}catch{return fail();}}
/** Privacy cleanup needs the actual current login, never the lost action digest or catalogue grant. */
export async function discardPayComponentReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=PayComponentReviewRetirement.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_pay_component_review_discard(${p.actionId}::uuid) as receipt`);return{kind:'retired' as const,receipt:PayComponentRetiredReview.parse(row?.receipt)};});}catch{return fail();}}
export async function listPayComponentReviews(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const rows=await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_pay_component_reviews_index()`);return PayComponentReviewIndex.parse({kind:'pay_component_review_index',reviews:Array.from(rows)});});}catch{return fail();}}

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export async function readCompletedPayComponentOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown){
 const ctx=capture(supplied),id=z.guid().parse(value);await boundNativeOutcomeTransactionTx(tx);
 const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${'typed_pay_components.create'},${id}::uuid) as completed`);
 if(terminal?.completed!==true)return fail();
 return withReviewedPayComponentIntervalTx(tx,ctx,async fresh=>{const stored=await read(tx,sql`select app.assistant_pay_component_review_read(${id}::uuid) as review`);bound(stored,fresh,id);const completion=await completed(tx,fresh,stored);return{completion,eventId:z.guid().parse(stored.eventId)};});
}
