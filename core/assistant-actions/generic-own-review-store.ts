import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
/** ADR-0151 wave 1: one custody implementation for every generic OWN action kind of migration 0670. Each kind
 * supplies a source adapter (subject interval, prepare, confirm, reconcile) and its contract schemas; this
 * owner keeps the sealed body, the digest-bound human confirmation, the effect-plus-receipt transaction, and
 * the completed-never-repeats rule identical for all of them. */
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
import type {NativeOutcomeAction} from '../../lib/ai/module-native-outcomes';

export type GenericOwnSubject=Readonly<{subjectId:string;employmentId:string;companyId:string}>;
type Schema<T>=z.ZodType<T>;
/** A compatibility repository preserves an installed kind's SQL/verifier and row format. It normalizes
 * only custody metadata; native authority, canonical locks and effects remain in source adapters. */
export type OwnReviewMetadata=Readonly<{actionId:string;action:string;contractVersion:1;binding:{tenantId:string;userId:string;personId:string;employmentId:string;companyId:string};intentDigest:string|null;reviewedDigest:string|null;state:'awaiting_confirmation'|'completed'|'discarded'|'expired'|'refused';createdAt:string;expiresAt:string}>;
export type OwnReviewPersistence=Readonly<{
 assertActor(tx:Tx,ctx:SessionContext):Promise<SessionContext>;
 subject(tx:Tx,id:string):Promise<{employmentId:string;subjectId:string}>;
 read(tx:Tx,id:string):Promise<unknown>;
 prepare(tx:Tx,metadata:OwnReviewMetadata,sealed:z.infer<typeof OwnLeaveSealedReview>):Promise<unknown>;
 complete(tx:Tx,id:string,digest:string,native:{eventId:string;nativeRequestId?:string}):Promise<unknown>;
 discard(tx:Tx,id:string):Promise<unknown>;
 index(tx:Tx):Promise<unknown>;
}>;
/** What a kind must provide. Every callback runs inside the caller's top-level transaction; any throw must
 * roll the whole command back. `confirm` performs the native effect and returns its committed event. */
export type GenericOwnReviewSpec<Human extends {employmentId:string},Review,Receipt,Prepared,Completed,Retired,Index>=Readonly<{
 action:NativeOutcomeAction&string;subjectKind:string;subjectOf(human:Human):string;
 human:Schema<Human>;consequence:string;persistence?:OwnReviewPersistence;
 prepared:Schema<Prepared>;completed:Schema<Completed>;retired:Schema<Retired>;index:Schema<Index>;indexKind:string;
 withSubject<T>(tx:Tx,ctx:SessionContext,subjectId:string,work:(fresh:SessionContext,own:GenericOwnSubject)=>Promise<T>):Promise<T>;
 prepare(tx:Tx,fresh:SessionContext,human:Human):Promise<{content?:Human;review:Review;reviewedDigest:string}>;
 confirm(tx:Tx,fresh:SessionContext,human:Human,reviewedDigest:string):Promise<{receipt:Receipt;eventId:string;nativeRequestId?:string}>;
 reconcile(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string;nativeRequestId?:string}):Promise<Receipt>;
 unavailable():never;
}>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),digest=z.string().regex(/^[a-f0-9]{64}$/);
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid(),employmentId:z.guid(),companyId:z.guid()}).strict();
const State=z.enum(['awaiting_confirmation','completed','discarded','expired','refused']);
export function createGenericOwnReviewStore<Human extends {employmentId:string},Review,Receipt,Prepared,Completed,Retired,Index>(spec:GenericOwnReviewSpec<Human,Review,Receipt,Prepared,Completed,Retired,Index>){
 const {action}=spec,fail=():never=>spec.unavailable();
 const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:State,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
 type Meta=z.infer<typeof Metadata>;
 const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),subjectKind:z.literal(spec.subjectKind),subjectId:z.guid(),eventId:z.guid().nullable(),nativeRequestId:z.guid().optional()}).strict().refine(value=>
  (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
  &&(value.metadata.state==='completed')===(value.eventId!==null)
  &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
 type Stored=z.infer<typeof Stored>;
 const Body=z.object({reviewNonce:PrivateReviewNonce,content:z.unknown(),nativeReviewedDigest:digest}).strict();
 type Body={reviewNonce:z.infer<typeof PrivateReviewNonce>;content:Human;nativeReviewedDigest:string};
 const identity=(m:Meta)=>{if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);};
 const reviewed=(binding:z.infer<typeof Binding>,body:Body)=>privateReviewCommitment([1,action,binding],body);
 const checked=(m:Meta,value:unknown):Body=>{const raw=Body.parse(value),body={...raw,content:spec.human.parse(raw.content)} as Body;if(body.content.employmentId!==m.binding.employmentId||hash(body.content)!==m.intentDigest||reviewed(m.binding,body)!==m.reviewedDigest)return fail();return body;};
 function seal(m:Meta,body:Body){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(m),text=JSON.stringify(checked(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}catch{return fail();}finally{dek?.fill(0);}}
 function unseal(stored:Stored){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(stored.metadata),sealed=OwnLeaveSealedReview.parse(stored.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();return checked(stored.metadata,JSON.parse(text));}catch{return fail();}finally{dek?.fill(0);}}
 const read=async(tx:Tx,query:SQL)=>{const [row]=await tx.execute<{review:unknown}>(query);return Stored.parse(row?.review);};
 const bound=(stored:Stored,ctx:SessionContext,id:string,own:GenericOwnSubject)=>{const m=stored.metadata;if(m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==ctx.personId||m.binding.employmentId!==own.employmentId||m.binding.companyId!==own.companyId||stored.subjectId!==own.subjectId)return fail();};
 const pending=(stored:Stored,body:Body,current:{content?:Human;review:Review;reviewedDigest:string})=>{if(current.reviewedDigest!==body.nativeReviewedDigest||(current.content!==undefined&&JSON.stringify(current.content)!==JSON.stringify(body.content)))return fail();const m=stored.metadata;return{kind:'prepared' as const,review:spec.prepared.parse({action,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,content:body.content,review:current.review,consequence:spec.consequence})};};
 const retired=(stored:Stored)=>({kind:'retired' as const,receipt:spec.retired.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:stored.metadata.state})});
 const completed=async(tx:Tx,ctx:SessionContext,stored:Stored)=>{if(stored.metadata.state!=='completed'||!stored.eventId)return fail();const receipt=await spec.reconcile(tx,ctx,{subjectId:stored.subjectId,eventId:stored.eventId,employmentId:stored.metadata.binding.employmentId,nativeRequestId:stored.nativeRequestId});return{kind:'completed' as const,receipt:spec.completed.parse({action,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt})};};
 const subject=async(tx:Tx,id:string,ctx:SessionContext)=>{if(spec.persistence){await spec.persistence.assertActor(tx,ctx);return spec.persistence.subject(tx,id);}const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_generic_review_subject(${id}::uuid,${action}) as subject`);return z.object({employmentId:z.guid(),subjectId:z.guid()}).strict().parse(row?.subject);};
 const readRow=(tx:Tx,id:string,discard=false)=>spec.persistence?spec.persistence.read(tx,id).then(row=>Stored.parse(row)):read(tx,discard?sql`select app.assistant_generic_review_read(${id}::uuid,${action},true) as review`:sql`select app.assistant_generic_review_read(${id}::uuid,${action}) as review`);
 return Object.freeze({
  async prepare(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,action,'confirm');const ctx=capture(supplied),parsed=spec.human.safeParse(input);if(!parsed.success)return fail();const human=parsed.data;try{return await withTenant(ctx,tx=>spec.withSubject(tx,ctx,spec.subjectOf(human),async(fresh,own)=>{
   if(own.employmentId!==human.employmentId)return fail();
   const native=await spec.prepare(tx,fresh,human),body:Body={reviewNonce:newPrivateReviewNonce(),content:human,nativeReviewedDigest:native.reviewedDigest},binding=Binding.parse({tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId,employmentId:own.employmentId,companyId:own.companyId});
   const now=new Date(),m=Metadata.parse({actionId:randomUUID(),action,contractVersion:1,binding,intentDigest:hash(body.content),reviewedDigest:reviewed(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()}),sealed=seal(m,body);
   const stored=spec.persistence?Stored.parse(await spec.persistence.prepare(tx,m,sealed)):await read(tx,sql`select app.assistant_generic_review_prepare(${action},${m.actionId}::uuid,${binding.personId}::uuid,${binding.employmentId}::uuid,${binding.companyId}::uuid,${own.subjectId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);bound(stored,fresh,m.actionId,own);return pending(stored,unseal(stored),native);
  }));}catch{return fail();}},
  async confirm(supplied:SessionContext,input:{actionId:string;reviewedDigest:string}){assertHumanReviewedActionTier(supplied,action,'confirm');const ctx=capture(supplied),p={actionId:z.guid().parse(input.actionId),reviewedDigest:digest.parse(input.reviewedDigest)};try{return await withTenant(ctx,async tx=>{
   const nominee=await subject(tx,p.actionId,ctx);return spec.withSubject(tx,ctx,nominee.subjectId,async(fresh,own)=>{
    const stored=await readRow(tx,p.actionId);bound(stored,fresh,p.actionId,own);if(stored.metadata.state==='completed')return completed(tx,fresh,stored);if(stored.metadata.state!=='awaiting_confirmation')return retired(stored);if(stored.metadata.reviewedDigest!==p.reviewedDigest)return fail();
    const body=unseal(stored),native=await spec.confirm(tx,fresh,body.content,body.nativeReviewedDigest);
    await captureNativeOutcomeTargetsTx(tx,fresh,{action,sourceId:p.actionId,eventId:native.eventId,targets:[{kind:'employment',id:own.employmentId}]});
    const done=spec.persistence?Stored.parse(await spec.persistence.complete(tx,p.actionId,p.reviewedDigest,native)):await read(tx,sql`select app.assistant_generic_review_complete(${p.actionId}::uuid,${action},${p.reviewedDigest},${native.eventId}::uuid) as review`);bound(done,fresh,p.actionId,own);if(done.eventId!==native.eventId||done.nativeRequestId!==native.nativeRequestId)return fail();return completed(tx,fresh,done);
   });});}catch{return fail();}},
  async reopen(supplied:SessionContext,value:unknown){const ctx=capture(supplied),parsed=z.guid().safeParse(value);if(!parsed.success)return fail();const id=parsed.data;try{return await withTenant(ctx,async tx=>{
   const nominee=await subject(tx,id,ctx);return spec.withSubject(tx,ctx,nominee.subjectId,async(fresh,own)=>{
    const stored=await readRow(tx,id);bound(stored,fresh,id,own);if(stored.metadata.state==='awaiting_confirmation'){const body=unseal(stored),native=await spec.prepare(tx,fresh,body.content);return pending(stored,body,native);}return stored.metadata.state==='completed'?completed(tx,fresh,stored):retired(stored);
   });});}catch{return fail();}},
  /** Login-only retirement: needs no review digest, grant or decryption. */
  async discard(supplied:SessionContext,input:{actionId:string}){const ctx=capture(supplied),id=z.guid().safeParse(input?.actionId);if(!id.success)return fail();try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);if(spec.persistence)return{kind:'retired' as const,receipt:spec.retired.parse(await spec.persistence.discard(tx,id.data))};const stored=await readRow(tx,id.data,true);if(stored.metadata.actionId!==id.data||stored.metadata.binding.userId!==ctx.userId)return fail();return retired(stored);});}catch{return fail();}},
  async list(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);if(spec.persistence)return spec.index.parse({kind:spec.indexKind,reviews:await spec.persistence.index(tx)});const rows=await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_generic_reviews_index(${action})`);return spec.index.parse({kind:spec.indexKind,reviews:rows});});}catch{return fail();}},
  /** Completed-only evidence adapter for outcome linking. No pending decryption, preparation or confirmation. */
  async readCompletedOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown){
   const ctx=capture(supplied),id=z.guid().parse(value);await boundNativeOutcomeTransactionTx(tx);
   const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${action},${id}::uuid) as completed`);
   if(terminal?.completed!==true)return fail();
   const nominee=await subject(tx,id,ctx);return spec.withSubject(tx,ctx,nominee.subjectId,async(fresh,own)=>{const stored=await readRow(tx,id);bound(stored,fresh,id,own);const completion=await completed(tx,fresh,stored);return{completion,eventId:z.guid().parse(stored.eventId)};});
  },
 });
}
