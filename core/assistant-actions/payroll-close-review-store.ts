import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {captureNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
/** UNMOUNTED Payroll CLOSE custody. Human confirmation owns one canonical close; no model money/approval/payment. */
import {createHash,randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {assertAiPrincipalTx} from '../ai-principal';
import {PrivateReviewNonce,newPrivateReviewNonce,privateReviewCommitment} from './private-review-commitment';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REVIEWED_PAYROLL_CLOSE_ACTION as action,ReviewedPayrollCloseHumanContent as Human,ReviewedPayrollClosePreparedSource} from '../../lib/assistant-actions/reviewed-payroll-close-contract';
import {PayrollCloseReviewPrepare,PayrollCloseReviewConfirmation,PayrollCloseReviewRetirement,PayrollClosePreparedReview,PayrollCloseCompletedReview,PayrollCloseRetiredReview,PayrollCloseReviewIndex} from '../../lib/assistant-actions/payroll-close-review-contract';
import {assertReviewedPayrollCloseActorTx,withReviewedPayrollCloseSourceIntervalTx,prepareReviewedPayrollCloseSourceTx,confirmReviewedPayrollCloseSourceTx,reconcileReviewedPayrollCloseSourceTx} from './reviewed-payroll-close-source';
export class PayrollCloseReviewUnavailable extends Error{constructor(){super('That Payroll close needs another look. Please reopen the reviewed run.');this.name='PayrollCloseReviewUnavailable';}}
const fail=():never=>{throw new PayrollCloseReviewUnavailable();},hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),digest=z.string().regex(/^[a-f0-9]{64}$/);
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),batchId:z.guid(),payPeriodId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;type NativePrepared=z.infer<typeof ReviewedPayrollClosePreparedSource>;
// Capture human content ONCE. Re-derive the outward native review only after its private source
// digest matches, rather than retaining another copy of canonical/derived entitlement values.
const Body=z.object({reviewNonce:PrivateReviewNonce,content:Human,nativeReviewedDigest:digest}).strict();type Body=z.infer<typeof Body>;
function identity(m:Meta){if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);}
const reviewed=(binding:z.infer<typeof Binding>,body:Body)=>privateReviewCommitment([1,action,binding],body);
function checked(m:Meta,value:unknown){const body=Body.parse(value);if(body.content.batchId.toLowerCase()!==m.binding.batchId||hash(body.content)!==m.intentDigest||reviewed(m.binding,body)!==m.reviewedDigest)return fail();return body;}
function seal(m:Meta,body:Body){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(m),text=JSON.stringify(checked(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}finally{dek?.fill(0);}}
function unseal(stored:Stored){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(stored.metadata),sealed=OwnLeaveSealedReview.parse(stored.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();return checked(stored.metadata,JSON.parse(text));}finally{dek?.fill(0);}}
// Drizzle expands raw arrays as tuples; preserve UUID members as individually bound values.
const uuidArray=(ids:readonly string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
async function read(tx:Tx,query:SQL){const [row]=await tx.execute<{review:unknown}>(query);return Stored.parse(row?.review);}
function bound(stored:Stored,ctx:SessionContext,id:string,source:{batchId:string;companyId:string;payPeriodId:string}){const m=stored.metadata;if(m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==(ctx.personId??null)||m.binding.batchId!==source.batchId||m.binding.companyId!==source.companyId||m.binding.payPeriodId!==source.payPeriodId)return fail();}
function pending(stored:Stored,current:NativePrepared){const m=stored.metadata,body=unseal(stored);if(current.reviewedDigest!==body.nativeReviewedDigest||JSON.stringify(current.content)!==JSON.stringify(body.content))return fail();return {kind:'prepared' as const,review:PayrollClosePreparedReview.parse({action,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,content:body.content,review:current.review})};}
function retired(stored:Stored){return{kind:'retired' as const,receipt:PayrollCloseRetiredReview.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:stored.metadata.state})};}
async function completed(tx:Tx,ctx:SessionContext,stored:Stored){if(stored.metadata.state!=='completed'||!stored.eventId)return fail();const receipt=await reconcileReviewedPayrollCloseSourceTx(tx,ctx,{batchId:stored.metadata.binding.batchId,closedEventId:stored.eventId});if(receipt.payPeriodId!==stored.metadata.binding.payPeriodId)return fail();return {kind:'completed' as const,receipt:PayrollCloseCompletedReview.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt})};}
async function subject(tx:Tx,id:string){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_payroll_close_review_subject(${id}::uuid) as subject`);return z.guid().parse(row?.subject);}
async function peek(tx:Tx,id:string){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_payroll_close_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);}
function sameSnapshot(before:Stored,after:Stored){if(JSON.stringify(before)!==JSON.stringify(after))return fail();}

export async function preparePayrollCloseReview(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,'payroll.close','approve');const ctx=capture(supplied),parsed=PayrollCloseReviewPrepare.safeParse(input);if(!parsed.success)return fail();const human=parsed.data;try{return await withTenant(ctx,tx=>withReviewedPayrollCloseSourceIntervalTx(tx,ctx,human.batchId,async(fresh,source)=>{
 const native=await prepareReviewedPayrollCloseSourceTx(tx,fresh,human),body=Body.parse({reviewNonce:newPrivateReviewNonce(),content:native.content,nativeReviewedDigest:native.reviewedDigest}),binding=Binding.parse({tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId??null,employmentId:null,companyId:source.companyId,batchId:source.batchId,payPeriodId:source.payPeriodId}),now=new Date(),m=Metadata.parse({actionId:randomUUID(),action,contractVersion:1,binding,intentDigest:hash(body.content),reviewedDigest:reviewed(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()}),sealed=seal(m,body);
 const stored=await read(tx,sql`select app.assistant_payroll_close_review_prepare(${m.actionId}::uuid,${binding.personId}::uuid,${binding.batchId}::uuid,${binding.companyId}::uuid,${binding.payPeriodId}::uuid,${uuidArray(native.erasurePersonIds)},${native.erasureSource.priorBatchId}::uuid,${uuidArray(native.erasureSource.coverageEmploymentIds)},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);bound(stored,fresh,m.actionId,source);return pending(stored,native);
 }));}catch{return fail();}}
/** Own encrypted nomination is not authority. Canonical Access/period/OT/batch ownership precedes
 * custody; actual pending preflight runs before action-row lock. Completed retry never closes again. */
async function existing(supplied:SessionContext,id:string,expected:string|undefined,confirm:boolean){const ctx=capture(supplied);return withTenant(ctx,async tx=>{const actor=await assertReviewedPayrollCloseActorTx(tx,ctx),batchId=await subject(tx,id);return withReviewedPayrollCloseSourceIntervalTx(tx,actor,batchId,async(fresh,source)=>{
 const initial=await peek(tx,id),before=initial.review;bound(before,fresh,id,source);
 if(before.metadata.state!=='awaiting_confirmation'||initial.pendingExpired){const stored=await read(tx,sql`select app.assistant_payroll_close_review_read(${id}::uuid) as review`);bound(stored,fresh,id,source);if(initial.pendingExpired){if(stored.metadata.state!=='expired')return fail();return retired(stored);}sameSnapshot(before,stored);return stored.metadata.state==='completed'?completed(tx,fresh,stored):retired(stored);}
 if(confirm&&before.metadata.reviewedDigest!==expected)return fail();const body=unseal(before),native=await prepareReviewedPayrollCloseSourceTx(tx,fresh,body.content);if(native.reviewedDigest!==body.nativeReviewedDigest)return fail();
 const stored=await read(tx,sql`select app.assistant_payroll_close_review_read(${id}::uuid) as review`);bound(stored,fresh,id,source);sameSnapshot(before,stored);if(!confirm)return pending(stored,native);
 const receipt=await confirmReviewedPayrollCloseSourceTx(tx,fresh,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest});if(receipt.batchId!==source.batchId||receipt.payPeriodId!==source.payPeriodId)return fail();
 const [privacy]=await tx.execute<{employees:string[]}>(sql`select app.native_outcome_payroll_target_employments(${source.batchId}::uuid,${native.erasureSource.priorBatchId}::uuid,${uuidArray(native.erasureSource.coverageEmploymentIds)}) as employees`);
 const targetEmployees=z.array(z.guid()).parse(privacy?.employees);
 await captureNativeOutcomeTargetsTx(tx,fresh,{action:action,sourceId:id,eventId:receipt.closedEventId,targets:[...native.erasurePersonIds.map(id=>({kind:'person' as const,id})),...targetEmployees.map(id=>({kind:'employment' as const,id}))]});
 const done=await read(tx,sql`select app.assistant_payroll_close_review_complete(${id}::uuid,${expected},${receipt.closedEventId}::uuid) as review`);bound(done,fresh,id,source);if(done.eventId!==receipt.closedEventId)return fail();return completed(tx,fresh,done);
 });});}
export async function confirmPayrollCloseReview(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,'payroll.close','approve');const ctx=capture(supplied),parsed=PayrollCloseReviewConfirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await existing(ctx,p.actionId,p.reviewedDigest,true);}catch{return fail();}}
export async function reopenPayrollCloseReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=z.guid().safeParse(input);if(!parsed.success)return fail();try{return await existing(ctx,parsed.data,undefined,false);}catch{return fail();}}
export async function discardPayrollCloseReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=PayrollCloseReviewRetirement.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_payroll_close_review_discard(${p.actionId}::uuid) as receipt`);return{kind:'retired' as const,receipt:PayrollCloseRetiredReview.parse(row?.receipt)};});}catch{return fail();}}
export async function listPayrollCloseReviews(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const rows=await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_payroll_close_reviews_index()`);return PayrollCloseReviewIndex.parse({kind:'payroll_close_review_index',reviews:Array.from(rows)});});}catch{return fail();}}

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export async function readCompletedPayrollCloseOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown){
 const ctx=capture(supplied),id=z.guid().parse(value);await boundNativeOutcomeTransactionTx(tx);
 const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${'payroll.close'},${id}::uuid) as completed`);
 if(terminal?.completed!==true)return fail();
 const actor=await assertReviewedPayrollCloseActorTx(tx,ctx),batchId=await subject(tx,id);return withReviewedPayrollCloseSourceIntervalTx(tx,actor,batchId,async(fresh,source)=>{const stored=await read(tx,sql`select app.assistant_payroll_close_review_read(${id}::uuid) as review`);bound(stored,fresh,id,source);const completion=await completed(tx,fresh,stored);return{completion,eventId:z.guid().parse(stored.eventId)};});
}
