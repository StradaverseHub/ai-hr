/** Shared lifecycle for installed own/assigned review protocols. A compatibility adapter retains its
 * existing SQL verifier, binding schema, source interval and public packets. No arbitrary executor is
 * exposed: only server-owned specs instantiate this factory. All effects stay in the top-level Tx. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import type {NativeOutcomeAction} from '../../lib/ai/module-native-outcomes';
import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {assertAiPrincipalTx} from '../ai-principal';
import {captureNativeOutcomeTargetsTx,type NativeOutcomePrivacyTarget} from '../module-native-outcome-targets';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
import {PrivateReviewNonce,newPrivateReviewNonce,privateReviewCommitment} from './private-review-commitment';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
import {OwnLeaveSealedReview} from './own-leave-content';
export type ReviewState='awaiting_confirmation'|'completed'|'discarded'|'expired'|'refused';
export type ReviewActorBinding={tenantId:string;userId:string;personId:string|null};
export type ReviewMetadata<B extends ReviewActorBinding>={actionId:string;action:string;contractVersion:1;binding:B;intentDigest:string|null;reviewedDigest:string|null;state:ReviewState;createdAt:string;expiresAt:string};
export type ReviewRow<B extends ReviewActorBinding>={metadata:ReviewMetadata<B>;sealed:z.infer<typeof OwnLeaveSealedReview>|null};
export type ReviewBody<H>={reviewNonce:z.infer<typeof PrivateReviewNonce>;content:H;nativeReviewedDigest:string};
export type ReviewCustodySpec<H,B extends ReviewActorBinding,R extends ReviewRow<B>,S,P extends {content:H;reviewedDigest:string},N,Prepared,Completed,Retired,Index>={
 action:NativeOutcomeAction;tier:'confirm'|'approve';human:z.ZodType<H>;metadata:z.ZodType<ReviewMetadata<B>>;stored:z.ZodType<R>;
 confirmation:z.ZodType<{actionId:string;reviewedDigest:string}>;retirement:z.ZodType<{actionId:string}>;
 retired:z.ZodType<Retired>;index:z.ZodType<Index>;indexKind:string;
 withInterval<T>(tx:Tx,ctx:SessionContext,nomination:{human?:H;actionId?:string},work:(fresh:SessionContext,source:S)=>Promise<T>):Promise<T>;
 binding(ctx:SessionContext,source:S):B;
 assertSubjectBinding(binding:B,source:S):void;
 assertHumanBinding(binding:B,human:H):void;
 prepareNative(tx:Tx,ctx:SessionContext,human:H,source:S):Promise<P>;
 confirmNative(tx:Tx,ctx:SessionContext,body:ReviewBody<H>,source:S):Promise<N>;
 pending(row:R,body:ReviewBody<H>,current:P):Prepared;
 completed(tx:Tx,ctx:SessionContext,row:R,source:S):Promise<Completed>;
 event(row:R):string|null;nativeEvent(native:N):string;assertCompletion(row:R,native:N):void;
 targets(source:S,native:N):readonly NativeOutcomePrivacyTarget[];
 prepareRow(tx:Tx,metadata:ReviewMetadata<B>,sealed:z.infer<typeof OwnLeaveSealedReview>,source:S,human:H):Promise<unknown>;
 readRow(tx:Tx,id:string):Promise<unknown>;completeRow(tx:Tx,id:string,expected:string,native:N):Promise<unknown>;
 discardRow(tx:Tx,id:string):Promise<unknown>;indexRows(tx:Tx):Promise<unknown>;
 unavailable():never;
};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export function createReviewCustody<H,B extends ReviewActorBinding,R extends ReviewRow<B>,S,P extends {content:H;reviewedDigest:string},N,Prepared,Completed,Retired,Index>(spec:ReviewCustodySpec<H,B,R,S,P,N,Prepared,Completed,Retired,Index>){
 const fail=():never=>spec.unavailable();
 const Body=z.object({reviewNonce:PrivateReviewNonce,content:spec.human,nativeReviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
 const identity=(m:ReviewMetadata<B>)=>{if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);};
 const commitment=(binding:B,body:ReviewBody<H>)=>privateReviewCommitment([1,spec.action,binding],body);
 const checked=(m:ReviewMetadata<B>,value:unknown)=>{const raw=Body.parse(value),body:ReviewBody<H>={reviewNonce:raw.reviewNonce,content:spec.human.parse(raw.content),nativeReviewedDigest:raw.nativeReviewedDigest};spec.assertHumanBinding(m.binding,body.content);if(hash(body.content)!==m.intentDigest||commitment(m.binding,body)!==m.reviewedDigest)return fail();return body;};
 const bound=(row:R,ctx:SessionContext,id:string,source:S)=>{const m=row.metadata;if(m.action!==spec.action||m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==(ctx.personId??null))return fail();spec.assertSubjectBinding(m.binding,source);};
 function seal(m:ReviewMetadata<B>,body:ReviewBody<H>){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(m),text=JSON.stringify(checked(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}finally{dek?.fill(0);}}
 function unseal(row:R){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(row.metadata),sealed=OwnLeaveSealedReview.parse(row.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();return checked(row.metadata,JSON.parse(text));}finally{dek?.fill(0);}}
 const read=async(tx:Tx,id:string)=>spec.stored.parse(await spec.readRow(tx,id));
 const retired=(row:R)=>({kind:'retired' as const,receipt:spec.retired.parse({action:spec.action,contractVersion:1,actionId:row.metadata.actionId,state:row.metadata.state})});
 const completed=async(tx:Tx,ctx:SessionContext,row:R,source:S)=>{if(row.metadata.state!=='completed'||!spec.event(row))return fail();return{kind:'completed' as const,receipt:await spec.completed(tx,ctx,row,source)};};
 const pending=(row:R,body:ReviewBody<H>,current:P)=>{if(current.reviewedDigest!==body.nativeReviewedDigest||JSON.stringify(current.content)!==JSON.stringify(body.content))return fail();return{kind:'prepared' as const,review:spec.pending(row,body,current)};};
 return Object.freeze({
  async prepare(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,spec.action,spec.tier);const ctx=capture(supplied),parsed=spec.human.safeParse(input);if(!parsed.success)return fail();const human=parsed.data;try{return await withTenant(ctx,tx=>spec.withInterval(tx,ctx,{human},async(fresh,source)=>{
   const native=await spec.prepareNative(tx,fresh,human,source),body:ReviewBody<H>={reviewNonce:newPrivateReviewNonce(),content:native.content,nativeReviewedDigest:native.reviewedDigest};
   const binding=spec.binding(fresh,source),now=new Date(),m=spec.metadata.parse({actionId:randomUUID(),action:spec.action,contractVersion:1,binding,intentDigest:hash(body.content),reviewedDigest:commitment(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()});
   const stored=spec.stored.parse(await spec.prepareRow(tx,m,seal(m,body),source,human));bound(stored,fresh,m.actionId,source);return pending(stored,unseal(stored),native);
  }));}catch{return fail();}},
  async confirm(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,spec.action,spec.tier);const ctx=capture(supplied),parsed=spec.confirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,tx=>spec.withInterval(tx,ctx,{actionId:p.actionId},async(fresh,source)=>{
   const stored=await read(tx,p.actionId);bound(stored,fresh,p.actionId,source);if(stored.metadata.state==='completed')return completed(tx,fresh,stored,source);if(stored.metadata.state!=='awaiting_confirmation')return retired(stored);if(stored.metadata.reviewedDigest!==p.reviewedDigest)return fail();
   const native=await spec.confirmNative(tx,fresh,unseal(stored),source);await captureNativeOutcomeTargetsTx(tx,fresh,{action:spec.action,sourceId:p.actionId,eventId:spec.nativeEvent(native),targets:spec.targets(source,native)});
   const done=spec.stored.parse(await spec.completeRow(tx,p.actionId,p.reviewedDigest,native));bound(done,fresh,p.actionId,source);spec.assertCompletion(done,native);return completed(tx,fresh,done,source);
  }));}catch{return fail();}},
  async reopen(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=z.guid().safeParse(input);if(!parsed.success)return fail();const id=parsed.data;try{return await withTenant(ctx,tx=>spec.withInterval(tx,ctx,{actionId:id},async(fresh,source)=>{
   const stored=await read(tx,id);bound(stored,fresh,id,source);if(stored.metadata.state==='awaiting_confirmation'){const body=unseal(stored);return pending(stored,body,await spec.prepareNative(tx,fresh,body.content,source));}return stored.metadata.state==='completed'?completed(tx,fresh,stored,source):retired(stored);
  }));}catch{return fail();}},
  async discard(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=spec.retirement.safeParse(input);if(!parsed.success)return fail();try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);return{kind:'retired' as const,receipt:spec.retired.parse(await spec.discardRow(tx,parsed.data.actionId))};});}catch{return fail();}},
  async list(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);return spec.index.parse({kind:spec.indexKind,reviews:await spec.indexRows(tx)});});}catch{return fail();}},
  async readCompletedOutcomeTx(tx:Tx,supplied:SessionContext,input:unknown){const ctx=capture(supplied),id=z.guid().parse(input);await boundNativeOutcomeTransactionTx(tx);const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${spec.action},${id}::uuid) as completed`);if(terminal?.completed!==true)return fail();return spec.withInterval(tx,ctx,{actionId:id},async(fresh,source)=>{const stored=await read(tx,id);bound(stored,fresh,id,source);const completion=await completed(tx,fresh,stored,source);return{completion,eventId:z.guid().parse(spec.event(stored))};});},
 });
}
