/** UNMOUNTED shared custody extension. One existing physical review/body lifecycle; no second
 * execution ledger, model effect, provider, browser endpoint or client-supplied source receipt.
 * All commands own a top-level transaction and expose bounded errors only after whole rollback. */
import {createHash,randomUUID} from 'node:crypto';
import {and,eq,sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {employment} from '../../db/schema';
import {lockLeaveDependenciesTx,lockLeaveDependencyReadConfigurationTx} from '../../packs/leave/service';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
import {ModuleActionPrepare,ModuleActionConfirmation,ModuleActionPreparedReview,ModuleActionCompletedReceipt,ModuleActionRetiredReceipt,ModuleActionReviewIndexResult,MODULE_NOTIFICATION_ACTION} from '../../lib/assistant-actions/module-action-review-contract';
import {OwnNotificationPreferencesIntent,OwnNotificationPreferencesReview} from '../../lib/assistant-actions/own-notification-preferences-contract';
import {OwnLeaveSealedReview} from './own-leave-content';
import {prepareOwnNotificationPreferencesTx,confirmOwnNotificationPreferencesTx,reopenOwnNotificationPreferencesEventTx,type OwnNotificationServerIdentity} from './own-notification-preferences-source';
export class ModuleActionReviewUnavailable extends Error{constructor(){super('This saved review is taking a little detour. Please reopen it and try again.');this.name='ModuleActionReviewUnavailable';}}
const fail=():never=>{throw new ModuleActionReviewUnavailable();};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.uuid(),userId:z.uuid(),personId:z.uuid(),employmentId:z.uuid(),companyId:z.uuid()}).strict();
const Metadata=z.object({actionId:z.uuid(),action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),binding:Binding,
 intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.uuid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;type Meta=z.infer<typeof Metadata>;
const Body=z.object({intent:OwnNotificationPreferencesIntent,review:OwnNotificationPreferencesReview}).strict();
function capture(ctx:SessionContext):SessionContext{return {...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};}
async function guard(tx:Tx,ctx:SessionContext){await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'notifications');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}
function identity(m:Meta){if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);}
function reviewed(binding:z.infer<typeof Binding>,body:z.infer<typeof Body>){return hash([1,MODULE_NOTIFICATION_ACTION,binding,body]);}
function checked(m:Meta,value:unknown){const body=Body.parse(value);if(body.intent.employmentId!==m.binding.employmentId||body.review.employmentId!==m.binding.employmentId||hash(body.intent)!==m.intentDigest||reviewed(m.binding,body)!==m.reviewedDigest)return fail();return body;}
function seal(m:Meta,body:z.infer<typeof Body>){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(m),text=JSON.stringify(checked(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}finally{dek?.fill(0);}}
function unseal(stored:Stored){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=identity(stored.metadata),sealed=OwnLeaveSealedReview.parse(stored.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();return checked(stored.metadata,JSON.parse(text));}finally{dek?.fill(0);}}
async function read(tx:Tx,query:SQL){try{const [row]=await tx.execute<{review:unknown}>(query);return Stored.parse(row?.review);}catch{return fail();}}
function bound(stored:Stored,ctx:SessionContext,id:string,subject?:string){const m=stored.metadata;if(m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==ctx.personId||(subject&&m.binding.employmentId!==subject))return fail();}
function pending(stored:Stored){const body=unseal(stored),m=stored.metadata;return {kind:'prepared' as const,review:ModuleActionPreparedReview.parse({action:m.action,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,review:{version:body.review.version,kind:body.review.kind,employmentId:body.review.employmentId,before:body.review.before.map(row=>({category:row.category,enabled:row.enabled,locale:row.locale})),after:{enabledCategories:body.review.after.enabledCategories.slice(),locale:body.review.after.locale}}})};}
function retired(stored:Stored){return {kind:'retired' as const,receipt:ModuleActionRetiredReceipt.parse({action:stored.metadata.action,contractVersion:1,actionId:stored.metadata.actionId,state:stored.metadata.state})};}
async function completed(tx:Tx,ctx:SessionContext,stored:Stored,cap:OwnNotificationServerIdentity){if(stored.metadata.state!=='completed'||!stored.eventId)return fail();
 const actual=await reopenOwnNotificationPreferencesEventTx(tx,ctx,{employmentId:stored.metadata.binding.employmentId,eventId:stored.eventId},cap);if(actual.proof!=='historical_event_current_values'||actual.version!==1||actual.kind!=='own_notification_preferences')return fail();
 return {kind:'completed' as const,receipt:ModuleActionCompletedReceipt.parse({action:MODULE_NOTIFICATION_ACTION,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',sourceEventId:actual.eventId,employmentId:actual.employmentId,enabledCategories:actual.enabledCategories,locale:actual.locale,semantics:'recorded_effect_current_values'})};}
async function subject(tx:Tx,id:string){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_module_action_review_subject(${id}::uuid,${MODULE_NOTIFICATION_ACTION}) as subject`);return z.uuid().parse(row?.subject);}
/** Capability is resolved afresh by the eventual HTTP owner outside this transaction. It is never
 * part of the human input, encrypted body or persisted completion. No hidden identity/network call. */
export async function prepareModuleActionReview(supplied:SessionContext,input:unknown,cap:OwnNotificationServerIdentity){const ctx=capture(supplied),parsed=ModuleActionPrepare.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{
 const fresh=await guard(tx,ctx);await lockLeaveDependencyReadConfigurationTx(tx,fresh.tenantId);
 if(!fresh.personId)return fail();
 // A posted UUID nominates no resource authority. Establish the actual own-person/RLS binding
 // before taking its employee barrier, then refuse drift instead of locking a retargeted subject.
 const nominate=()=>tx.select({id:employment.id,companyId:employment.companyId}).from(employment).where(and(eq(employment.id,p.intent.employmentId),eq(employment.tenantId,fresh.tenantId),eq(employment.personId,fresh.personId!))).limit(1);
 const [nominated]=await nominate();if(!nominated)return fail();await lockLeaveDependenciesTx(tx,fresh.tenantId,[nominated.id]);
 const [own]=await nominate();if(!own||own.id!==nominated.id||own.companyId!==nominated.companyId)return fail();
 const review=await prepareOwnNotificationPreferencesTx(tx,fresh,p.intent,cap),body=Body.parse({intent:p.intent,review}),binding=Binding.parse({tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId,employmentId:p.intent.employmentId,companyId:own.companyId});
 const now=new Date(),m=Metadata.parse({actionId:randomUUID(),action:MODULE_NOTIFICATION_ACTION,contractVersion:1,binding,intentDigest:hash(body.intent),reviewedDigest:reviewed(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()}),sealed=seal(m,body);
 const stored=await read(tx,sql`select app.assistant_module_action_review_prepare(${MODULE_NOTIFICATION_ACTION},${m.actionId}::uuid,${binding.personId}::uuid,${binding.employmentId}::uuid,${binding.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);bound(stored,fresh,m.actionId,p.intent.employmentId);return pending(stored);
 });}catch{return fail();}}
export async function confirmModuleActionReview(supplied:SessionContext,input:unknown,cap:OwnNotificationServerIdentity){const ctx=capture(supplied),parsed=ModuleActionConfirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{
 const fresh=await guard(tx,ctx);await lockLeaveDependencyReadConfigurationTx(tx,fresh.tenantId);const nominated=await subject(tx,p.actionId);await lockLeaveDependenciesTx(tx,fresh.tenantId,[nominated]);
 const stored=await read(tx,sql`select app.assistant_module_action_review_read(${p.actionId}::uuid,${MODULE_NOTIFICATION_ACTION}) as review`);bound(stored,fresh,p.actionId,nominated);
 if(stored.metadata.state==='completed')return completed(tx,fresh,stored,cap);if(stored.metadata.state!=='awaiting_confirmation')return retired(stored);
 if(stored.metadata.reviewedDigest!==p.reviewedDigest)return fail();const body=unseal(stored),native=await confirmOwnNotificationPreferencesTx(tx,fresh,body.intent,body.review.reviewDigest,cap);
 const done=await read(tx,sql`select app.assistant_module_action_review_complete(${p.actionId}::uuid,${MODULE_NOTIFICATION_ACTION},${p.reviewedDigest},${native.eventId}::uuid) as review`);bound(done,fresh,p.actionId,nominated);if(done.eventId!==native.eventId)return fail();return completed(tx,fresh,done,cap);
 });}catch{return fail();}}
/** Reopen is read/reconciliation only, never an effect or automatic confirmation retry. */
export async function reopenModuleActionReview(supplied:SessionContext,actionId:unknown,cap:OwnNotificationServerIdentity){const ctx=capture(supplied),parsed=z.uuid().safeParse(actionId);if(!parsed.success)return fail();const id=parsed.data;try{return await withTenant(ctx,async tx=>{
 const fresh=await guard(tx,ctx);await lockLeaveDependencyReadConfigurationTx(tx,fresh.tenantId);const nominated=await subject(tx,id);await lockLeaveDependenciesTx(tx,fresh.tenantId,[nominated]);const stored=await read(tx,sql`select app.assistant_module_action_review_read(${id}::uuid,${MODULE_NOTIFICATION_ACTION}) as review`);bound(stored,fresh,id,nominated);return stored.metadata.state==='awaiting_confirmation'?pending(stored):stored.metadata.state==='completed'?completed(tx,fresh,stored,cap):retired(stored);
 });}catch{return fail();}}
/** Retirement has fresh actual caller/custody authority but no Assistant grant/pause requirement. */
export async function discardModuleActionReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=ModuleActionConfirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const stored=await read(tx,sql`select app.assistant_module_action_review_read(${p.actionId}::uuid,${MODULE_NOTIFICATION_ACTION},true,${p.reviewedDigest}) as review`);bound(stored,ctx,p.actionId);return retired(stored);});}catch{return fail();}}

/** Same bounded current-login index; no content, identities, digests or native effect references. */
export async function listModuleActionReviews(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const rows=await tx.execute(sql`select action,action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_module_action_reviews_index()`);return ModuleActionReviewIndexResult.parse({kind:'module_review_index',reviews:Array.from(rows)});});}catch{return fail();}}
