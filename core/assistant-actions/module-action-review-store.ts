import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {withAgentActionGuard} from './agent-action-guard';
import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {captureNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
/** Human-reviewed shared custody extension. One existing physical review/body lifecycle; no second
 * execution ledger, model effect, provider, browser endpoint or client-supplied source receipt.
 * All commands own a top-level transaction and expose bounded errors only after whole rollback. */
import {createHash,randomUUID} from 'node:crypto';
import {and,eq,sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {PrivateReviewNonce,newPrivateReviewNonce,privateReviewCommitment} from './private-review-commitment';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {employment} from '../../db/schema';
import {lockLeaveDependenciesTx,lockLeaveDependencyReadConfigurationTx,lockLeaveDependencyConfigurationTx} from '../../packs/leave/service';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
import {ModuleActionPrepare,ModuleActionConfirmation,ModuleActionRetirementRequest,ModuleActionPreparedReview,ModuleActionCompletedReceipt,ModuleActionRetiredReceipt,ModuleActionReviewIndexResult,MODULE_NOTIFICATION_ACTION} from '../../lib/assistant-actions/module-action-review-contract';
import {OwnNotificationPreferencesIntent,OwnNotificationPreferencesReview} from '../../lib/assistant-actions/own-notification-preferences-contract';
import {OwnLeaveSealedReview} from './own-leave-content';
import {prepareOwnNotificationPreferencesTx,confirmOwnNotificationPreferencesTx,reopenOwnNotificationPreferencesEventTx,type OwnNotificationServerIdentity} from './own-notification-preferences-source';
export class ModuleActionReviewUnavailable extends Error{constructor(){super('This saved review is taking a little detour. Please reopen it and try again.');this.name='ModuleActionReviewUnavailable';}}
const fail=():never=>{throw new ModuleActionReviewUnavailable();};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid(),employmentId:z.guid(),companyId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),binding:Binding,
 intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;type Meta=z.infer<typeof Metadata>;
const Body=z.object({reviewNonce:PrivateReviewNonce,intent:OwnNotificationPreferencesIntent,review:OwnNotificationPreferencesReview}).strict();
/** ADR-0131: every own-review list and privacy-only discard below binds the same login, tenant AND person
 * (assertAiPrincipalTx, then the person-bound legacy index/retire SQL). A stale or relinked session and
 * another person's review both end in the same generic refusal, which confirms nothing. */
function capture(ctx:SessionContext):SessionContext{return {...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};}
async function guard(tx:Tx,ctx:SessionContext,module:'notifications'|'ess'|'claims'|'performance'='notifications'){await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,module);await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}

type NotificationHuman=z.infer<typeof OwnNotificationPreferencesIntent>;
type NotificationView={reviewNonce:z.infer<typeof PrivateReviewNonce>;content:NotificationHuman;nativeReviewedDigest:string;review:z.infer<typeof OwnNotificationPreferencesReview>};
type NotificationSource={employmentId:string;companyId?:string};
function notificationView(value:unknown):NotificationView{const body=Body.parse(value);if(body.intent.employmentId!==body.review.employmentId)return fail();return{reviewNonce:body.reviewNonce,content:body.intent,nativeReviewedDigest:body.review.reviewDigest,review:body.review};}
function notificationStore(cap?:OwnNotificationServerIdentity){
 const capability=()=>cap??fail();
 return createGenericOwnCompatibilityStore<NotificationHuman,z.infer<typeof Binding>,Stored,NotificationSource,{content:NotificationHuman;reviewedDigest:string;review:z.infer<typeof OwnNotificationPreferencesReview>},Awaited<ReturnType<typeof confirmOwnNotificationPreferencesTx>>,z.infer<typeof ModuleActionPreparedReview>,z.infer<typeof ModuleActionCompletedReceipt>,z.infer<typeof ModuleActionRetiredReceipt>,z.infer<typeof ModuleActionReviewIndexResult>>({
 action:MODULE_NOTIFICATION_ACTION,tier:'confirm',human:OwnNotificationPreferencesIntent,metadata:Metadata,stored:Stored,confirmation:ModuleActionConfirmation,retirement:ModuleActionRetirementRequest,retired:ModuleActionRetiredReceipt,index:ModuleActionReviewIndexResult,indexKind:'module_review_index',
 body:{read:notificationView,write:view=>{const body=view as NotificationView;return Body.parse({reviewNonce:body.reviewNonce,intent:body.content,review:body.review});},create:(native,reviewNonce)=>({reviewNonce,content:native.content,nativeReviewedDigest:native.reviewedDigest,review:native.review}),assertCurrent:()=>{}},
 async withInterval(tx,ctx,nomination,work){const fresh=await withAgentActionGuard(tx,ctx,MODULE_NOTIFICATION_ACTION);await lockLeaveDependencyReadConfigurationTx(tx,fresh.tenantId);if(!fresh.personId)return fail();
  if(nomination.human){const id=nomination.human.employmentId,nominate=()=>tx.select({id:employment.id,companyId:employment.companyId}).from(employment).where(and(eq(employment.id,id),eq(employment.tenantId,fresh.tenantId),eq(employment.personId,fresh.personId!))).limit(1);const [before]=await nominate();if(!before)return fail();await lockLeaveDependenciesTx(tx,fresh.tenantId,[before.id]);const [own]=await nominate();if(!own||own.id!==before.id||own.companyId!==before.companyId)return fail();return work(fresh,{employmentId:own.id,companyId:own.companyId});}
  const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_module_action_review_subject(${z.guid().parse(nomination.actionId)}::uuid,${MODULE_NOTIFICATION_ACTION}) as subject`),id=z.guid().parse(row?.subject);await lockLeaveDependenciesTx(tx,fresh.tenantId,[id]);return work(fresh,{employmentId:id});
 },
 binding:(ctx,own)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,employmentId:own.employmentId,companyId:own.companyId}),assertSubjectBinding:(binding,own)=>{if(binding.employmentId!==own.employmentId||(own.companyId&&binding.companyId!==own.companyId))return fail();},assertHumanBinding:(binding,human)=>{if(binding.employmentId!==human.employmentId)return fail();},
 async prepareNative(tx,ctx,human){const review=await prepareOwnNotificationPreferencesTx(tx,ctx,human,capability());return{content:human,reviewedDigest:review.reviewDigest,review};},
 async reopenNative(_tx,_ctx,view){const body=view as NotificationView;return{content:body.content,reviewedDigest:body.nativeReviewedDigest,review:body.review};},
 confirmNative:(tx,ctx,body)=>confirmOwnNotificationPreferencesTx(tx,ctx,body.content,body.nativeReviewedDigest,capability()),
 pending:(row,view)=>{const body=view as NotificationView,m=row.metadata;return ModuleActionPreparedReview.parse({action:MODULE_NOTIFICATION_ACTION,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,review:{version:body.review.version,kind:body.review.kind,employmentId:body.review.employmentId,before:body.review.before.map(item=>({category:item.category,enabled:item.enabled,locale:item.locale})),after:{enabledCategories:body.review.after.enabledCategories.slice(),locale:body.review.after.locale}}});},
 async completed(tx,ctx,row){if(!row.eventId)return fail();const actual=await reopenOwnNotificationPreferencesEventTx(tx,ctx,{employmentId:row.metadata.binding.employmentId,eventId:row.eventId},capability());if(actual.proof!=='historical_event_current_values'||actual.version!==1||actual.kind!=='own_notification_preferences')return fail();return ModuleActionCompletedReceipt.parse({action:MODULE_NOTIFICATION_ACTION,contractVersion:1,actionId:row.metadata.actionId,state:'completed',sourceEventId:actual.eventId,employmentId:actual.employmentId,enabledCategories:actual.enabledCategories,locale:actual.locale,semantics:'recorded_effect_current_values'});},
 event:row=>row.eventId,nativeEvent:native=>native.eventId,assertCompletion:(row,native)=>{if(row.eventId!==native.eventId)return fail();},targets:source=>[{kind:'employment',id:source.employmentId}],
 async prepareRow(tx,m,sealed){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_prepare(${MODULE_NOTIFICATION_ACTION},${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_read(${id}::uuid,${MODULE_NOTIFICATION_ACTION}) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_complete(${id}::uuid,${MODULE_NOTIFICATION_ACTION},${expected},${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_legacy_review_retire(${id}::uuid,${MODULE_NOTIFICATION_ACTION}) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_legacy_reviews_index(${MODULE_NOTIFICATION_ACTION})`));},unavailable:fail,
 });
}
export async function prepareModuleActionReview(ctx:SessionContext,input:unknown,cap:OwnNotificationServerIdentity){assertHumanReviewedActionTier(ctx,MODULE_NOTIFICATION_ACTION,'confirm');const parsed=ModuleActionPrepare.safeParse(input);if(!parsed.success)return fail();return notificationStore(cap).prepare(ctx,parsed.data.intent);}
export const confirmModuleActionReview=(ctx:SessionContext,input:unknown,cap:OwnNotificationServerIdentity)=>notificationStore(cap).confirm(ctx,input);
export const reopenModuleActionReview=(ctx:SessionContext,input:unknown,cap:OwnNotificationServerIdentity)=>notificationStore(cap).reopen(ctx,input);
export const discardModuleActionReview=(ctx:SessionContext,input:unknown)=>notificationStore().discard(ctx,input);
export const listModuleActionReviews=(ctx:SessionContext)=>notificationStore().list(ctx);

/** ESS shares the physical lifecycle above. These typed server owners remain unmounted; the
 * existing notification-only HTTP/public contracts do not acquire another action by importing it. */
import {OWN_PROFILE_CHANGE_ACTION,OwnProfileChangeHumanContent} from '../../lib/assistant-actions/own-profile-change-contract';
import {ProfileModuleActionPrepare,ProfileModuleActionConfirmation,ProfileModuleActionRetirementRequest,ProfileModuleActionPreparedReview,ProfileModuleActionCompletedReceipt,ProfileModuleActionRetiredReceipt,ProfileModuleActionReviewIndexResult} from '../../lib/assistant-actions/module-action-review-contract';
import {prepareOwnProfileChangeSourceTx,confirmOwnProfileChangeSourceTx,reconcileOwnProfileChangeSourceTx} from './own-profile-change-source';
const ProfileMetadata=Metadata.extend({action:z.literal(OWN_PROFILE_CHANGE_ACTION)});
const ProfileStored=z.object({metadata:ProfileMetadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable(),requestId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null&&value.requestId!==null)
 &&((value.eventId===null)===(value.requestId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type ProfileStored=z.infer<typeof ProfileStored>;type ProfileMeta=z.infer<typeof ProfileMetadata>;
async function completedProfile(tx:Tx,ctx:SessionContext,stored:ProfileStored){if(stored.metadata.state!=='completed'||!stored.requestId||!stored.eventId)return fail();
 // The native reference parser requires status, but never trusts it: reconciliation rereads actual
 // current source status. No proposal or old identity/source fingerprint is stored in completion.
 const current=await reconcileOwnProfileChangeSourceTx(tx,ctx,{kind:'submitted',requestId:stored.requestId,requestedEventId:stored.eventId,employmentId:stored.metadata.binding.employmentId,currentStatus:'pending',replayed:true});
 return {kind:'completed' as const,receipt:ProfileModuleActionCompletedReceipt.parse({action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',requestId:current.requestId,requestedEventId:current.requestedEventId,employmentId:current.employmentId,currentStatus:current.currentStatus,semantics:'submitted_not_approved'})};}
async function ownProfileSubject(tx:Tx,ctx:SessionContext,id:string){if(!ctx.personId)return fail();const nominate=()=>tx.select({id:employment.id,companyId:employment.companyId}).from(employment).where(and(eq(employment.id,id),eq(employment.tenantId,ctx.tenantId),eq(employment.personId,ctx.personId!))).limit(1);const [nominated]=await nominate();if(!nominated)return fail();await lockLeaveDependenciesTx(tx,ctx.tenantId,[nominated.id]);const [fresh]=await nominate();if(!fresh||fresh.id!==nominated.id||fresh.companyId!==nominated.companyId)return fail();return fresh;}

const profileReviews=createGenericOwnCompatibilityStore<z.infer<typeof OwnProfileChangeHumanContent>,z.infer<typeof Binding>,ProfileStored,NotificationSource,Awaited<ReturnType<typeof prepareOwnProfileChangeSourceTx>>,Awaited<ReturnType<typeof confirmOwnProfileChangeSourceTx>>,z.infer<typeof ProfileModuleActionPreparedReview>,z.infer<typeof ProfileModuleActionCompletedReceipt>,z.infer<typeof ProfileModuleActionRetiredReceipt>,z.infer<typeof ProfileModuleActionReviewIndexResult>>({
 action:OWN_PROFILE_CHANGE_ACTION,tier:'confirm',human:ProfileModuleActionPrepare,metadata:ProfileMetadata,stored:ProfileStored,confirmation:ProfileModuleActionConfirmation,retirement:ProfileModuleActionRetirementRequest,retired:ProfileModuleActionRetiredReceipt,index:ProfileModuleActionReviewIndexResult,indexKind:'profile_module_review_index',
 async withInterval(tx,ctx,nomination,work){const actor=await withAgentActionGuard(tx,ctx,OWN_PROFILE_CHANGE_ACTION);await lockLeaveDependencyConfigurationTx(tx,actor.tenantId);if(nomination.human){const own=await ownProfileSubject(tx,actor,nomination.human.employmentId);return work(actor,{employmentId:own.id,companyId:own.companyId});}const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_module_action_review_subject(${z.guid().parse(nomination.actionId)}::uuid,${OWN_PROFILE_CHANGE_ACTION}) as subject`),id=z.guid().parse(row?.subject);await lockLeaveDependenciesTx(tx,actor.tenantId,[id]);return work(actor,{employmentId:id});},
 binding:(ctx,own)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,employmentId:own.employmentId,companyId:own.companyId}),assertSubjectBinding:(binding,own)=>{if(binding.employmentId!==own.employmentId||(own.companyId&&binding.companyId!==own.companyId))return fail();},assertHumanBinding:(binding,human)=>{if(binding.employmentId!==human.employmentId)return fail();},
 prepareNative:(tx,ctx,human)=>prepareOwnProfileChangeSourceTx(tx,ctx,human),confirmNative:(tx,ctx,body)=>confirmOwnProfileChangeSourceTx(tx,ctx,body.content,{action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(row,body)=>ProfileModuleActionPreparedReview.parse({action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:{action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,employmentId:body.content.employmentId,proposal:structuredClone(body.content.proposal)},consequence:'request_hr_review'}),
 completed:async(tx,ctx,row)=>(await completedProfile(tx,ctx,row)).receipt,event:row=>row.eventId,nativeEvent:native=>native.requestedEventId,assertCompletion:(row,native)=>{if(row.requestId!==native.requestId||row.eventId!==native.requestedEventId)return fail();},targets:source=>[{kind:'employment',id:source.employmentId}],
 async prepareRow(tx,m,sealed){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_prepare(${OWN_PROFILE_CHANGE_ACTION},${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_read(${id}::uuid,${OWN_PROFILE_CHANGE_ACTION}) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_profile_action_review_complete(${id}::uuid,${expected},${native.requestId}::uuid,${native.requestedEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_legacy_review_retire(${id}::uuid,${OWN_PROFILE_CHANGE_ACTION}) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_legacy_reviews_index(${OWN_PROFILE_CHANGE_ACTION})`));},unavailable:fail,
});
export const prepareProfileModuleActionReview=profileReviews.prepare;
export const confirmProfileModuleActionReview=profileReviews.confirm;
export const reopenProfileModuleActionReview=profileReviews.reopen;
export const discardProfileModuleActionReview=profileReviews.discard;
export const listProfileModuleActionReviews=profileReviews.list;

/** Claims uses the same physical encrypted review lifecycle, without automatic submission. */
import {OWN_CLAIM_DRAFT_ACTION,OwnClaimDraftHumanContent} from '../../lib/assistant-actions/own-claim-contract';
import {ClaimModuleActionPrepare,ClaimModuleActionConfirmation,ClaimModuleActionRetirementRequest,ClaimModuleActionPreparedReview,ClaimModuleActionCompletedReceipt,ClaimModuleActionRetiredReceipt,ClaimModuleActionReviewIndexResult} from '../../lib/assistant-actions/module-action-review-contract';
import {prepareOwnClaimDraftSourceTx,confirmOwnClaimDraftSourceTx,reconcileOwnClaimDraftSourceTx} from './own-claim-source';
const ClaimMetadata=Metadata.extend({action:z.literal(OWN_CLAIM_DRAFT_ACTION)});
const ClaimStored=z.object({metadata:ClaimMetadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable(),draftId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null&&value.draftId!==null)
 &&((value.eventId===null)===(value.draftId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type ClaimStored=z.infer<typeof ClaimStored>;type ClaimMeta=z.infer<typeof ClaimMetadata>;
const ClaimBody=z.object({reviewNonce:PrivateReviewNonce,content:OwnClaimDraftHumanContent,nativeReviewedDigest:digest,provisionalAmount:z.string().regex(/^\d+\.\d{2}$/),provisionalQuantityKm:z.string().regex(/^-?\d+\.\d{2}$/).nullable(),provisionalTaxable:z.boolean()}).strict();
type ClaimBody=z.infer<typeof ClaimBody>;
async function completedClaim(tx:Tx,ctx:SessionContext,stored:ClaimStored){if(stored.metadata.state!=='completed'||!stored.draftId||!stored.eventId)return fail();
 // The native reference parser requires status, but never trusts it: reconciliation rereads actual
 // current source status. No proposal or old identity/source fingerprint is stored in completion.
 const current=await reconcileOwnClaimDraftSourceTx(tx,ctx,{kind:'draft_saved',draftId:stored.draftId,savedEventId:stored.eventId,employmentId:stored.metadata.binding.employmentId,currentStatus:'draft',replayed:true});
 return {kind:'completed' as const,receipt:ClaimModuleActionCompletedReceipt.parse({action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',draftId:current.draftId,savedEventId:current.savedEventId,employmentId:current.employmentId,currentStatus:current.currentStatus,semantics:'draft_saved_not_submitted_or_reimbursed'})};}
async function ownClaimSubject(tx:Tx,ctx:SessionContext,id:string){if(!ctx.personId)return fail();const nominate=()=>tx.select({id:employment.id,companyId:employment.companyId}).from(employment).where(and(eq(employment.id,id),eq(employment.tenantId,ctx.tenantId),eq(employment.personId,ctx.personId!))).limit(1);const [nominated]=await nominate();if(!nominated)return fail();await lockLeaveDependenciesTx(tx,ctx.tenantId,[nominated.id]);const [fresh]=await nominate();if(!fresh||fresh.id!==nominated.id||fresh.companyId!==nominated.companyId)return fail();return fresh;}
const claimDraftReviews=createGenericOwnCompatibilityStore<z.infer<typeof OwnClaimDraftHumanContent>,z.infer<typeof Binding>,ClaimStored,NotificationSource,Awaited<ReturnType<typeof prepareOwnClaimDraftSourceTx>>,Awaited<ReturnType<typeof confirmOwnClaimDraftSourceTx>>,z.infer<typeof ClaimModuleActionPreparedReview>,z.infer<typeof ClaimModuleActionCompletedReceipt>,z.infer<typeof ClaimModuleActionRetiredReceipt>,z.infer<typeof ClaimModuleActionReviewIndexResult>>({
 action:OWN_CLAIM_DRAFT_ACTION,tier:'confirm',human:ClaimModuleActionPrepare,metadata:ClaimMetadata,stored:ClaimStored,confirmation:ClaimModuleActionConfirmation,retirement:ClaimModuleActionRetirementRequest,retired:ClaimModuleActionRetiredReceipt,index:ClaimModuleActionReviewIndexResult,indexKind:'claim_module_review_index',
 body:{read:value=>ClaimBody.parse(value),write:view=>ClaimBody.parse(view),create:(native,reviewNonce)=>ClaimBody.parse({reviewNonce,content:native.content,nativeReviewedDigest:native.reviewedDigest,provisionalAmount:native.provisionalAmount,provisionalQuantityKm:native.provisionalQuantityKm,provisionalTaxable:native.provisionalTaxable}),assertCurrent:()=>{}},
 async withInterval(tx,ctx,nomination,work){const actor=await withAgentActionGuard(tx,ctx,OWN_CLAIM_DRAFT_ACTION);await lockLeaveDependencyReadConfigurationTx(tx,actor.tenantId);if(nomination.human){const own=await ownClaimSubject(tx,actor,nomination.human.employmentId);return work(actor,{employmentId:own.id,companyId:own.companyId});}const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_module_action_review_subject(${z.guid().parse(nomination.actionId)}::uuid,${OWN_CLAIM_DRAFT_ACTION}) as subject`),id=z.guid().parse(row?.subject);await lockLeaveDependenciesTx(tx,actor.tenantId,[id]);return work(actor,{employmentId:id});},
 binding:(ctx,own)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,employmentId:own.employmentId,companyId:own.companyId}),assertSubjectBinding:(binding,own)=>{if(binding.employmentId!==own.employmentId||(own.companyId&&binding.companyId!==own.companyId))return fail();},assertHumanBinding:(binding,human)=>{if(binding.employmentId!==human.employmentId)return fail();},
 prepareNative:(tx,ctx,human)=>prepareOwnClaimDraftSourceTx(tx,ctx,human),confirmNative:(tx,ctx,body)=>confirmOwnClaimDraftSourceTx(tx,ctx,body.content,{action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(row,view)=>{const body=ClaimBody.parse(view);return ClaimModuleActionPreparedReview.parse({action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:structuredClone(body.content),provisionalAmount:body.provisionalAmount,provisionalQuantityKm:body.provisionalQuantityKm,provisionalTaxable:body.provisionalTaxable,consequence:'draft_only_no_submission_or_reimbursement'});},
 completed:async(tx,ctx,row)=>(await completedClaim(tx,ctx,row)).receipt,event:row=>row.eventId,nativeEvent:native=>native.savedEventId,assertCompletion:(row,native)=>{if(row.draftId!==native.draftId||row.eventId!==native.savedEventId)return fail();},targets:source=>[{kind:'employment',id:source.employmentId}],
 async prepareRow(tx,m,sealed){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_prepare(${OWN_CLAIM_DRAFT_ACTION},${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_read(${id}::uuid,${OWN_CLAIM_DRAFT_ACTION}) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_claim_action_review_complete(${id}::uuid,${expected},${native.draftId}::uuid,${native.savedEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_legacy_review_retire(${id}::uuid,${OWN_CLAIM_DRAFT_ACTION}) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_legacy_reviews_index(${OWN_CLAIM_DRAFT_ACTION})`));},unavailable:fail,
});
export const prepareClaimModuleActionReview=claimDraftReviews.prepare;
export const confirmClaimModuleActionReview=claimDraftReviews.confirm;
export const reopenClaimModuleActionReview=claimDraftReviews.reopen;
export const discardClaimModuleActionReview=claimDraftReviews.discard;
export const listClaimModuleActionReviews=claimDraftReviews.list;

/** Closed two-engine Performance custody. Only these native sources are dispatched; no caller
 * supplies a service, callback, rating, arbitrary patch or native event reference. */
import {OwnReviewAcknowledgementIntent,OwnReviewAcknowledgementReview} from '../../lib/assistant-actions/own-review-acknowledgement-contract';
import {OwnOnehrPlanAcknowledgementIntent,OwnOnehrPlanAcknowledgementReview} from '../../lib/assistant-actions/own-onehr-plan-acknowledgement-contract';
import {prepareOwnReviewAcknowledgementTx,confirmOwnReviewAcknowledgementTx,reopenOwnReviewAcknowledgementEventTx} from './own-review-acknowledgement-source';
import {prepareOwnOnehrPlanAcknowledgementTx,confirmOwnOnehrPlanAcknowledgementTx,reopenOwnOnehrPlanAcknowledgementEventTx} from './own-onehr-plan-acknowledgement-source';
import {MODULE_REVIEW_ACK_ACTION,MODULE_ONEHR_ACK_ACTION,ReviewModuleActionPrepare,ReviewModuleActionConfirmation,ReviewModuleActionRetirementRequest,ReviewModuleActionPreparedReview,ReviewModuleActionCompletedReceipt,ReviewModuleActionRetiredReceipt,ReviewModuleActionReviewIndexResult,OnehrModuleActionPrepare,OnehrModuleActionConfirmation,OnehrModuleActionRetirementRequest,OnehrModuleActionPreparedReview,OnehrModuleActionCompletedReceipt,OnehrModuleActionRetiredReceipt,OnehrModuleActionReviewIndexResult} from '../../lib/assistant-actions/module-action-review-contract';
const PerformanceKind=z.enum([MODULE_REVIEW_ACK_ACTION,MODULE_ONEHR_ACK_ACTION]);type PerformanceKind=z.infer<typeof PerformanceKind>;
const PerformanceMetadata=Metadata.extend({action:PerformanceKind});type PerformanceMetadata=z.infer<typeof PerformanceMetadata>;
const PerformanceStored=z.object({metadata:PerformanceMetadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type PerformanceStored=z.infer<typeof PerformanceStored>;
const PerformanceBody=z.discriminatedUnion('engine',[
 z.object({reviewNonce:PrivateReviewNonce,engine:z.literal('standard_cycle_only'),intent:OwnReviewAcknowledgementIntent,review:OwnReviewAcknowledgementReview}).strict(),
 z.object({reviewNonce:PrivateReviewNonce,engine:z.literal('onehr_plan'),intent:OwnOnehrPlanAcknowledgementIntent,review:OwnOnehrPlanAcknowledgementReview}).strict(),
]);type PerformanceBody=z.infer<typeof PerformanceBody>;
async function completedPerformance(tx:Tx,ctx:SessionContext,stored:PerformanceStored){if(stored.metadata.state!=='completed'||!stored.eventId)return fail();const reference={employmentId:stored.metadata.binding.employmentId,eventId:stored.eventId},receipt=stored.metadata.action===MODULE_REVIEW_ACK_ACTION?await reopenOwnReviewAcknowledgementEventTx(tx,ctx,reference):await reopenOwnOnehrPlanAcknowledgementEventTx(tx,ctx,reference),value={action:stored.metadata.action,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt};return{kind:'completed' as const,receipt:stored.metadata.action===MODULE_REVIEW_ACK_ACTION?ReviewModuleActionCompletedReceipt.parse(value):OnehrModuleActionCompletedReceipt.parse(value)};}
async function performanceNomination(tx:Tx,ctx:SessionContext,kind:PerformanceKind,input:unknown){if(!ctx.personId)return fail();const query=kind===MODULE_REVIEW_ACK_ACTION?sql`select q.employment_id as "employmentId" from public.performance_review q join public.employment e on e.id=q.employment_id and e.tenant_id=q.tenant_id where q.id=${OwnReviewAcknowledgementIntent.parse(input).reviewId}::uuid and q.tenant_id=${ctx.tenantId}::uuid and e.person_id=${ctx.personId}::uuid`:sql`select q.employment_id as "employmentId" from public.performance_onehr_plan q join public.employment e on e.id=q.employment_id and e.tenant_id=q.tenant_id where q.id=${OwnOnehrPlanAcknowledgementIntent.parse(input).planId}::uuid and q.tenant_id=${ctx.tenantId}::uuid and e.person_id=${ctx.personId}::uuid`;const [row]=await tx.execute<{employmentId:string}>(query);if(!row)return fail();return ownClaimSubject(tx,ctx,row.employmentId);}
async function preparePerformanceBody(tx:Tx,ctx:SessionContext,kind:PerformanceKind,input:unknown,reviewNonce=newPrivateReviewNonce()):Promise<PerformanceBody>{return kind===MODULE_REVIEW_ACK_ACTION?PerformanceBody.parse({reviewNonce,engine:'standard_cycle_only',intent:input,review:await prepareOwnReviewAcknowledgementTx(tx,ctx,input)}):PerformanceBody.parse({reviewNonce,engine:'onehr_plan',intent:input,review:await prepareOwnOnehrPlanAcknowledgementTx(tx,ctx,input)});}

type PerformanceHuman=z.infer<typeof OwnReviewAcknowledgementIntent>|z.infer<typeof OwnOnehrPlanAcknowledgementIntent>;
type PerformanceView={reviewNonce:z.infer<typeof PrivateReviewNonce>;content:PerformanceHuman;nativeReviewedDigest:string;wire:PerformanceBody};
async function confirmPerformanceNative(tx:Tx,ctx:SessionContext,view:PerformanceView,source:NotificationSource){const body=view.wire,native=body.engine==='standard_cycle_only'?await confirmOwnReviewAcknowledgementTx(tx,ctx,body.intent,body.review.reviewDigest):await confirmOwnOnehrPlanAcknowledgementTx(tx,ctx,body.intent,body.review.reviewDigest);if(native.employmentId!==source.employmentId)return fail();return native;}
function performanceStore(kind:PerformanceKind){
 const standard=kind===MODULE_REVIEW_ACK_ACTION;
 const view=(wire:PerformanceBody):PerformanceView=>({reviewNonce:wire.reviewNonce,content:wire.intent,nativeReviewedDigest:wire.review.reviewDigest,wire});
 return createGenericOwnCompatibilityStore<PerformanceHuman,z.infer<typeof Binding>,PerformanceStored,NotificationSource,{content:PerformanceHuman;reviewedDigest:string;wire:PerformanceBody},Awaited<ReturnType<typeof confirmPerformanceNative>>,z.infer<typeof ReviewModuleActionPreparedReview>|z.infer<typeof OnehrModuleActionPreparedReview>,z.infer<typeof ReviewModuleActionCompletedReceipt>|z.infer<typeof OnehrModuleActionCompletedReceipt>,z.infer<typeof ReviewModuleActionRetiredReceipt>|z.infer<typeof OnehrModuleActionRetiredReceipt>,z.infer<typeof ReviewModuleActionReviewIndexResult>|z.infer<typeof OnehrModuleActionReviewIndexResult>>({
 action:kind,tier:'confirm',human:standard?OwnReviewAcknowledgementIntent:OwnOnehrPlanAcknowledgementIntent,metadata:PerformanceMetadata,stored:PerformanceStored,confirmation:standard?ReviewModuleActionConfirmation:OnehrModuleActionConfirmation,retirement:standard?ReviewModuleActionRetirementRequest:OnehrModuleActionRetirementRequest,retired:standard?ReviewModuleActionRetiredReceipt:OnehrModuleActionRetiredReceipt,index:standard?ReviewModuleActionReviewIndexResult:OnehrModuleActionReviewIndexResult,indexKind:standard?'review_module_review_index':'onehr_module_review_index',
 body:{read:value=>view(PerformanceBody.parse(value)),write:body=>PerformanceBody.parse((body as PerformanceView).wire),create:(native,reviewNonce)=>view(PerformanceBody.parse({...native.wire,reviewNonce})),assertCurrent:(body,current)=>{if(JSON.stringify((body as PerformanceView).wire)!==JSON.stringify({...current.wire,reviewNonce:body.reviewNonce}))return fail();}},
 async withInterval(tx,ctx,nomination,work){const actor=await withAgentActionGuard(tx,ctx,kind);await lockLeaveDependencyReadConfigurationTx(tx,actor.tenantId);if(nomination.human){const own=await performanceNomination(tx,actor,kind,nomination.human);return work(actor,{employmentId:own.id,companyId:own.companyId});}const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_module_action_review_subject(${z.guid().parse(nomination.actionId)}::uuid,${kind}) as subject`),id=z.guid().parse(row?.subject);await lockLeaveDependenciesTx(tx,actor.tenantId,[id]);return work(actor,{employmentId:id});},
 binding:(ctx,own)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,employmentId:own.employmentId,companyId:own.companyId}),assertSubjectBinding:(binding,own)=>{if(binding.employmentId!==own.employmentId||(own.companyId&&binding.companyId!==own.companyId))return fail();},assertHumanBinding:()=>{},
 assertBodyBinding:(binding,body)=>{const wire=(body as PerformanceView).wire;if(wire.review.action!==kind||wire.review.employmentId!==binding.employmentId||(wire.engine==='standard_cycle_only'?wire.intent.reviewId!==wire.review.reviewId:wire.intent.planId!==wire.review.planId))return fail();},
 async prepareNative(tx,ctx,human){const wire=await preparePerformanceBody(tx,ctx,kind,human);return{content:human,reviewedDigest:wire.review.reviewDigest,wire};},confirmNative:(tx,ctx,body,source)=>confirmPerformanceNative(tx,ctx,body as PerformanceView,source),
 pending:(row,body)=>{const{reviewDigest:privateFingerprint,...review}=(body as PerformanceView).wire.review;void privateFingerprint;const value={action:kind,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,review};return standard?ReviewModuleActionPreparedReview.parse(value):OnehrModuleActionPreparedReview.parse(value);},
 completed:async(tx,ctx,row)=>(await completedPerformance(tx,ctx,row)).receipt,event:row=>row.eventId,nativeEvent:native=>native.eventId,assertCompletion:(row,native)=>{if(row.eventId!==native.eventId)return fail();},targets:source=>[{kind:'employment',id:source.employmentId}],
 async prepareRow(tx,m,sealed){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_prepare(${kind},${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_module_action_review_read(${id}::uuid,${kind}) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_performance_action_review_complete(${id}::uuid,${kind},${expected},${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_legacy_review_retire(${id}::uuid,${kind}) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_legacy_reviews_index(${kind})`));},unavailable:fail,
 });
}
async function preparePerformanceCustody(ctx:SessionContext,input:unknown,kind:PerformanceKind){assertHumanReviewedActionTier(ctx,kind,'confirm');const parsed=(kind===MODULE_REVIEW_ACK_ACTION?ReviewModuleActionPrepare:OnehrModuleActionPrepare).safeParse(input);if(!parsed.success)return fail();return performanceStore(kind).prepare(ctx,parsed.data.intent);}
export const prepareReviewModuleActionReview=(ctx:SessionContext,value:unknown)=>preparePerformanceCustody(ctx,value,MODULE_REVIEW_ACK_ACTION);
export const confirmReviewModuleActionReview=(ctx:SessionContext,value:unknown)=>performanceStore(MODULE_REVIEW_ACK_ACTION).confirm(ctx,value);
export const reopenReviewModuleActionReview=(ctx:SessionContext,value:unknown)=>performanceStore(MODULE_REVIEW_ACK_ACTION).reopen(ctx,value);
export const discardReviewModuleActionReview=(ctx:SessionContext,value:unknown)=>performanceStore(MODULE_REVIEW_ACK_ACTION).discard(ctx,value);
export const listReviewModuleActionReviews=(ctx:SessionContext)=>performanceStore(MODULE_REVIEW_ACK_ACTION).list(ctx);
export const prepareOnehrModuleActionReview=(ctx:SessionContext,value:unknown)=>preparePerformanceCustody(ctx,value,MODULE_ONEHR_ACK_ACTION);
export const confirmOnehrModuleActionReview=(ctx:SessionContext,value:unknown)=>performanceStore(MODULE_ONEHR_ACK_ACTION).confirm(ctx,value);
export const reopenOnehrModuleActionReview=(ctx:SessionContext,value:unknown)=>performanceStore(MODULE_ONEHR_ACK_ACTION).reopen(ctx,value);
export const discardOnehrModuleActionReview=(ctx:SessionContext,value:unknown)=>performanceStore(MODULE_ONEHR_ACK_ACTION).discard(ctx,value);
export const listOnehrModuleActionReviews=(ctx:SessionContext)=>performanceStore(MODULE_ONEHR_ACK_ACTION).list(ctx);

/** Closed USER-scoped Testing extension of the SAME encrypted custody lifecycle. Standalone
 * testers have NULL person/employment/company; model input never manufactures staff identity. */
import {OwnTestingExecutionIntent,OwnTestingExecutionReview} from '../../lib/assistant-actions/own-testing-execution-contract';
import {MODULE_TESTING_EXECUTION_ACTION,TestingModuleActionPrepare,TestingModuleActionConfirmation,TestingModuleActionRetirementRequest,TestingModuleActionPreparedReview,TestingModuleActionCompletedReceipt,TestingModuleActionRetiredReceipt,TestingModuleActionReviewIndexResult} from '../../lib/assistant-actions/module-action-review-contract';
import {prepareOwnTestingExecutionTx,confirmOwnTestingExecutionTx,reopenOwnTestingExecutionEventTx,withOwnTestingExecutionIntervalTx} from './own-testing-execution-source';
const TestingBinding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.null(),executionId:z.guid()}).strict();
const TestingMetadata=Metadata.extend({action:z.literal(MODULE_TESTING_EXECUTION_ACTION),binding:TestingBinding});type TestingMeta=z.infer<typeof TestingMetadata>;
const TestingSealedReview=z.object({formatVersion:z.literal(1),kid:z.string().regex(/^[a-f0-9]{16}$/),wrappedDek:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),ciphertext:z.string().min(1).max(819200).regex(/^[a-f0-9]{16}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/)}).strict().refine(value=>value.ciphertext.split('.')[0]===value.kid);
const TestingStored=z.object({metadata:TestingMetadata,sealed:TestingSealedReview.nullable(),runId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null&&value.runId!==null)
 &&((value.runId===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type TestingStored=z.infer<typeof TestingStored>;
const TestingBody=z.object({reviewNonce:PrivateReviewNonce,intent:OwnTestingExecutionIntent,review:OwnTestingExecutionReview.omit({humanObservation:true})}).strict();type TestingBody=z.infer<typeof TestingBody>;
async function completedTesting(tx:Tx,ctx:SessionContext,stored:TestingStored){if(stored.metadata.state!=='completed'||!stored.eventId||!stored.runId)return fail();const receipt=await reopenOwnTestingExecutionEventTx(tx,ctx,{runId:stored.runId,eventId:stored.eventId});if(receipt.executionId!==stored.metadata.binding.executionId)return fail();return {kind:'completed' as const,receipt:TestingModuleActionCompletedReceipt.parse({action:MODULE_TESTING_EXECUTION_ACTION,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt})};}

type TestingHuman=z.infer<typeof OwnTestingExecutionIntent>;
type TestingView={reviewNonce:z.infer<typeof PrivateReviewNonce>;content:TestingHuman;nativeReviewedDigest:string;wire:TestingBody};
function testingView(wire:TestingBody):TestingView{return{reviewNonce:wire.reviewNonce,content:wire.intent,nativeReviewedDigest:wire.review.reviewDigest,wire};}
const testingReviews=createGenericOwnCompatibilityStore<TestingHuman,z.infer<typeof TestingBinding>,TestingStored,{executionId:string},{content:TestingHuman;reviewedDigest:string;review:z.infer<typeof OwnTestingExecutionReview>},Awaited<ReturnType<typeof confirmOwnTestingExecutionTx>>,z.infer<typeof TestingModuleActionPreparedReview>,z.infer<typeof TestingModuleActionCompletedReceipt>,z.infer<typeof TestingModuleActionRetiredReceipt>,z.infer<typeof TestingModuleActionReviewIndexResult>>({
 action:MODULE_TESTING_EXECUTION_ACTION,tier:'confirm',maxBodyBytes:600000,sealed:TestingSealedReview,human:OwnTestingExecutionIntent,metadata:TestingMetadata,stored:TestingStored,confirmation:TestingModuleActionConfirmation,retirement:TestingModuleActionRetirementRequest,retired:TestingModuleActionRetiredReceipt,index:TestingModuleActionReviewIndexResult,indexKind:'testing_module_review_index',
 body:{read:value=>testingView(TestingBody.parse(value)),write:body=>TestingBody.parse((body as TestingView).wire),create:(native,reviewNonce)=>{const{humanObservation,...review}=native.review;void humanObservation;return testingView(TestingBody.parse({reviewNonce,intent:native.content,review}));},assertCurrent:(body,current)=>{const saved=(body as TestingView).wire;if(JSON.stringify(current.review)!==JSON.stringify(OwnTestingExecutionReview.parse({...saved.review,humanObservation:saved.intent.observation})))return fail();}},
 async withInterval(tx,ctx,nomination,work){let executionId:string;if(nomination.human)executionId=nomination.human.observation.executionId;else{await assertAiPrincipalTx(tx,ctx);const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_testing_action_review_subject(${z.guid().parse(nomination.actionId)}::uuid) as subject`);executionId=z.guid().parse(row?.subject);}return withOwnTestingExecutionIntervalTx(tx,ctx,executionId,actor=>work(actor,{executionId}));},
 binding:(ctx,source)=>TestingBinding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:null,executionId:source.executionId}),assertSubjectBinding:(binding,source)=>{if(binding.executionId!==source.executionId)return fail();},assertHumanBinding:(binding,human)=>{if(binding.executionId!==human.observation.executionId)return fail();},assertBodyBinding:(binding,body)=>{if((body as TestingView).wire.review.executionId!==binding.executionId)return fail();},
 async prepareNative(tx,ctx,human){const review=await prepareOwnTestingExecutionTx(tx,ctx,human);return{content:human,reviewedDigest:review.reviewDigest,review};},confirmNative:(tx,ctx,body)=>confirmOwnTestingExecutionTx(tx,ctx,body.content,body.nativeReviewedDigest),
 pending:(row,body)=>{const wire=(body as TestingView).wire,{reviewDigest:privateSource,...review}=wire.review;void privateSource;return TestingModuleActionPreparedReview.parse({action:MODULE_TESTING_EXECUTION_ACTION,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,review:{...review,humanObservation:wire.intent.observation}});},
 completed:async(tx,ctx,row)=>(await completedTesting(tx,ctx,row)).receipt,event:row=>row.eventId,nativeEvent:native=>native.eventId,assertCompletion:(row,native)=>{if(row.runId!==native.runId||row.eventId!==native.eventId)return fail();},targets:()=>[],
 async prepareRow(tx,m,sealed){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_testing_action_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.executionId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_testing_action_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_testing_action_review_complete(${id}::uuid,${expected},${native.runId}::uuid,${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_legacy_review_retire(${id}::uuid,${MODULE_TESTING_EXECUTION_ACTION}) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_legacy_reviews_index(${MODULE_TESTING_EXECUTION_ACTION})`));},unavailable:fail,
});
export async function prepareTestingModuleActionReview(ctx:SessionContext,input:unknown){assertHumanReviewedActionTier(ctx,MODULE_TESTING_EXECUTION_ACTION,'confirm');const parsed=TestingModuleActionPrepare.safeParse(input);if(!parsed.success)return fail();return testingReviews.prepare(ctx,parsed.data.intent);}
export const confirmTestingModuleActionReview=testingReviews.confirm;
export const reopenTestingModuleActionReview=testingReviews.reopen;
export const discardTestingModuleActionReview=testingReviews.discard;
export const listTestingModuleActionReviews=testingReviews.list;

/** Existing human claim DRAFT submission in the same physical custody. This closed source cannot
 * create/upload a claim, assert fictional receipts, decide approval or compute reimbursement. */
import {OWN_CLAIM_SUBMISSION_ACTION,OwnClaimSubmissionHumanContent,OwnClaimSubmissionReview} from '../../lib/assistant-actions/own-claim-submission-contract';
import {ClaimSubmissionModuleActionPrepare,ClaimSubmissionModuleActionConfirmation,ClaimSubmissionModuleActionRetirementRequest,ClaimSubmissionModuleActionPreparedReview,ClaimSubmissionModuleActionCompletedReceipt,ClaimSubmissionModuleActionRetiredReceipt,ClaimSubmissionModuleActionReviewIndexResult} from '../../lib/assistant-actions/module-action-review-contract';
import {prepareOwnClaimSubmissionSourceTx,confirmOwnClaimSubmissionSourceTx,reconcileOwnClaimSubmissionSourceTx,withOwnClaimSubmissionIntervalTx} from './own-claim-submission-source';
const ClaimSubmissionMetadata=Metadata.extend({action:z.literal(OWN_CLAIM_SUBMISSION_ACTION)});type ClaimSubmissionMeta=z.infer<typeof ClaimSubmissionMetadata>;
const ClaimSubmissionStored=z.object({metadata:ClaimSubmissionMetadata,sealed:OwnLeaveSealedReview.nullable(),claimId:z.guid(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type ClaimSubmissionStored=z.infer<typeof ClaimSubmissionStored>;
const ClaimSubmissionBody=z.object({reviewNonce:PrivateReviewNonce,content:OwnClaimSubmissionHumanContent,review:OwnClaimSubmissionReview,nativeReviewedDigest:digest}).strict();type ClaimSubmissionBody=z.infer<typeof ClaimSubmissionBody>;
function submissionIdentity(m:ClaimSubmissionMeta){if(m.state!=='awaiting_confirmation'||!m.intentDigest||!m.reviewedDigest)return fail();return JSON.stringify([1,m.action,m.actionId,m.binding,m.intentDigest,m.reviewedDigest]);}
function submissionReviewed(binding:z.infer<typeof Binding>,body:ClaimSubmissionBody){return privateReviewCommitment([1,OWN_CLAIM_SUBMISSION_ACTION,binding],body);}
function checkedSubmission(m:ClaimSubmissionMeta,value:unknown){const body=ClaimSubmissionBody.parse(value);if(body.content.employmentId!==m.binding.employmentId||body.review.employmentId!==m.binding.employmentId||body.content.draftId!==body.review.draftId||hash(body.content)!==m.intentDigest||submissionReviewed(m.binding,body)!==m.reviewedDigest)return fail();return body;}
function sealSubmission(m:ClaimSubmissionMeta,body:ClaimSubmissionBody){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=submissionIdentity(m),text=JSON.stringify(checkedSubmission(m,body));if(Buffer.byteLength(text)>32768)return fail();dek=newDek();const kid=newKid();return OwnLeaveSealedReview.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,'assistant:module-action:key:'+id),ciphertext:sealUnderDek(dek,kid,text,'assistant:module-action:body:'+id)});}finally{dek?.fill(0);}}
function unsealSubmission(stored:ClaimSubmissionStored){let dek:Buffer|undefined;try{if(!masterKeyAvailable())return fail();const id=submissionIdentity(stored.metadata),sealed=OwnLeaveSealedReview.parse(stored.sealed);dek=unwrapDek(sealed.wrappedDek,'assistant:module-action:key:'+id);if(dek.length!==32)return fail();const text=unsealUnderDek(dek,sealed.ciphertext,'assistant:module-action:body:'+id);if(Buffer.byteLength(text)>32768)return fail();const body=checkedSubmission(stored.metadata,JSON.parse(text));if(body.content.draftId!==stored.claimId)return fail();return body;}finally{dek?.fill(0);}}
async function readSubmission(tx:Tx,query:SQL){const [row]=await tx.execute<{review:unknown}>(query);return ClaimSubmissionStored.parse(row?.review);}
function boundSubmission(stored:ClaimSubmissionStored,ctx:SessionContext,id:string,claimId?:string,employmentId?:string){const m=stored.metadata;if(m.actionId!==id||m.binding.tenantId!==ctx.tenantId||m.binding.userId!==ctx.userId||m.binding.personId!==ctx.personId||(claimId&&stored.claimId!==claimId)||(employmentId&&m.binding.employmentId!==employmentId))return fail();}
function pendingSubmission(stored:ClaimSubmissionStored){const body=unsealSubmission(stored),m=stored.metadata;return {kind:'prepared' as const,review:ClaimSubmissionModuleActionPreparedReview.parse({action:OWN_CLAIM_SUBMISSION_ACTION,contractVersion:1,actionId:m.actionId,reviewedDigest:m.reviewedDigest,createdAt:m.createdAt,expiresAt:m.expiresAt,content:body.content,review:body.review,consequence:'submitted_for_approval_not_approved_or_reimbursed'})};}
function retiredSubmission(stored:ClaimSubmissionStored){return {kind:'retired' as const,receipt:ClaimSubmissionModuleActionRetiredReceipt.parse({action:OWN_CLAIM_SUBMISSION_ACTION,contractVersion:1,actionId:stored.metadata.actionId,state:stored.metadata.state})};}
async function completedSubmission(tx:Tx,ctx:SessionContext,stored:ClaimSubmissionStored){if(stored.metadata.state!=='completed'||!stored.eventId)return fail();const receipt=await reconcileOwnClaimSubmissionSourceTx(tx,ctx,{claimId:stored.claimId,submittedEventId:stored.eventId});if(receipt.employmentId!==stored.metadata.binding.employmentId)return fail();return {kind:'completed' as const,receipt:ClaimSubmissionModuleActionCompletedReceipt.parse({action:OWN_CLAIM_SUBMISSION_ACTION,contractVersion:1,actionId:stored.metadata.actionId,state:'completed',receipt,semantics:'submitted_not_approved_or_reimbursed'})};}
async function submissionSubject(tx:Tx,id:string){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_claim_submission_review_subject(${id}::uuid) as subject`);return z.guid().parse(row?.subject);}
export async function prepareClaimSubmissionModuleActionReview(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,'claims.submit','confirm');const ctx=capture(supplied),parsed=ClaimSubmissionModuleActionPrepare.safeParse(input);if(!parsed.success)return fail();const human=parsed.data;try{return await withTenant(ctx,tx=>withOwnClaimSubmissionIntervalTx(tx,ctx,human.draftId,async(actor,own)=>{
 if(human.employmentId!==own.employmentId)return fail();const source=await prepareOwnClaimSubmissionSourceTx(tx,actor,human),body=ClaimSubmissionBody.parse({reviewNonce:newPrivateReviewNonce(),content:source.content,review:source.review,nativeReviewedDigest:source.reviewedDigest}),binding=Binding.parse({tenantId:actor.tenantId,userId:actor.userId,personId:actor.personId,employmentId:own.employmentId,companyId:own.companyId});
 const now=new Date(),m=ClaimSubmissionMetadata.parse({actionId:randomUUID(),action:OWN_CLAIM_SUBMISSION_ACTION,contractVersion:1,binding,intentDigest:hash(body.content),reviewedDigest:submissionReviewed(binding,body),state:'awaiting_confirmation',createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()}),sealed=sealSubmission(m,body);
 const stored=await readSubmission(tx,sql`select app.assistant_claim_submission_review_prepare(${m.actionId}::uuid,${binding.personId}::uuid,${binding.employmentId}::uuid,${binding.companyId}::uuid,${own.draftId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);boundSubmission(stored,actor,m.actionId,own.draftId,own.employmentId);return pendingSubmission(stored);
 }));}catch{return fail();}}
export async function confirmClaimSubmissionModuleActionReview(supplied:SessionContext,input:unknown){assertHumanReviewedActionTier(supplied,'claims.submit','confirm');const ctx=capture(supplied),parsed=ClaimSubmissionModuleActionConfirmation.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{
 await assertAiPrincipalTx(tx,ctx);const claimId=await submissionSubject(tx,p.actionId);return withOwnClaimSubmissionIntervalTx(tx,ctx,claimId,async(actor,own)=>{
 const stored=await readSubmission(tx,sql`select app.assistant_claim_submission_review_read(${p.actionId}::uuid) as review`);boundSubmission(stored,actor,p.actionId,claimId,own.employmentId);
 if(stored.metadata.state==='completed')return completedSubmission(tx,actor,stored);if(stored.metadata.state!=='awaiting_confirmation')return retiredSubmission(stored);if(stored.metadata.reviewedDigest!==p.reviewedDigest)return fail();const body=unsealSubmission(stored),native=await confirmOwnClaimSubmissionSourceTx(tx,actor,body.content,{action:OWN_CLAIM_SUBMISSION_ACTION,contractVersion:1,reviewedDigest:body.nativeReviewedDigest});
 await captureNativeOutcomeTargetsTx(tx,actor,{action:OWN_CLAIM_SUBMISSION_ACTION,sourceId:p.actionId,eventId:native.submittedEventId,targets:[{kind:'employment',id:own.employmentId}]});
 const done=await readSubmission(tx,sql`select app.assistant_claim_submission_review_complete(${p.actionId}::uuid,${p.reviewedDigest},${native.claimId}::uuid,${native.submittedEventId}::uuid) as review`);boundSubmission(done,actor,p.actionId,claimId,own.employmentId);if(done.eventId!==native.submittedEventId)return fail();return completedSubmission(tx,actor,done);
 });});}catch{return fail();}}
export async function reopenClaimSubmissionModuleActionReview(supplied:SessionContext,value:unknown){const ctx=capture(supplied),parsed=z.guid().safeParse(value);if(!parsed.success)return fail();const id=parsed.data;try{return await withTenant(ctx,async tx=>{
 await assertAiPrincipalTx(tx,ctx);const claimId=await submissionSubject(tx,id);return withOwnClaimSubmissionIntervalTx(tx,ctx,claimId,async(actor,own)=>{
 const stored=await readSubmission(tx,sql`select app.assistant_claim_submission_review_read(${id}::uuid) as review`);boundSubmission(stored,actor,id,claimId,own.employmentId);
 if(stored.metadata.state==='awaiting_confirmation'){const body=unsealSubmission(stored),fresh=await prepareOwnClaimSubmissionSourceTx(tx,actor,body.content);if(fresh.reviewedDigest!==body.nativeReviewedDigest||JSON.stringify(fresh.review)!==JSON.stringify(body.review)||JSON.stringify(fresh.content)!==JSON.stringify(body.content))return fail();return pendingSubmission(stored);}return stored.metadata.state==='completed'?completedSubmission(tx,actor,stored):retiredSubmission(stored);
 });});}catch{return fail();}}
/** Purge pending custody after module/Assistant revocation using actual login/own-person authority.
 * Person relinks still refuse; bounded login expiry and canonical erasure remain independent owners. */
export async function discardClaimSubmissionModuleActionReview(supplied:SessionContext,input:unknown){const ctx=capture(supplied),parsed=ClaimSubmissionModuleActionRetirementRequest.safeParse(input);if(!parsed.success)return fail();const p=parsed.data;try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_legacy_review_retire(${p.actionId}::uuid,${OWN_CLAIM_SUBMISSION_ACTION}) as receipt`);return{kind:'retired' as const,receipt:ClaimSubmissionModuleActionRetiredReceipt.parse(row?.receipt)};});}catch{return fail();}}
export async function listClaimSubmissionModuleActionReviews(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const rows=await tx.execute(sql`select action,action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_legacy_reviews_index(${OWN_CLAIM_SUBMISSION_ACTION})`);return ClaimSubmissionModuleActionReviewIndexResult.parse({kind:'claim_submission_module_review_index',reviews:Array.from(rows)});});}catch{return fail();}}

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export const readCompletedNotificationOutcomeTx=(tx:Tx,ctx:SessionContext,input:unknown,cap:OwnNotificationServerIdentity)=>notificationStore(cap).readCompletedOutcomeTx(tx,ctx,input);

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export const readCompletedProfileOutcomeTx=profileReviews.readCompletedOutcomeTx;

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export const readCompletedClaimDraftOutcomeTx=claimDraftReviews.readCompletedOutcomeTx;

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export const readCompletedTestingOutcomeTx=testingReviews.readCompletedOutcomeTx;

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export async function readCompletedClaimSubmissionOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown){
 const ctx=capture(supplied),id=z.guid().parse(value);await boundNativeOutcomeTransactionTx(tx);
 const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${'claims.submit'},${id}::uuid) as completed`);
 if(terminal?.completed!==true)return fail();
 await assertAiPrincipalTx(tx,ctx);const claimId=await submissionSubject(tx,id);return withOwnClaimSubmissionIntervalTx(tx,ctx,claimId,async(actor,own)=>{const stored=await readSubmission(tx,sql`select app.assistant_claim_submission_review_read(${id}::uuid) as review`);boundSubmission(stored,actor,id,claimId,own.employmentId);const completion=await completedSubmission(tx,actor,stored);return{completion,eventId:z.guid().parse(stored.eventId)};});
}

/** Completed-only evidence adapter. Same caller Tx/authority/native reconciliation; no pending
 * decryption, prepare, confirmation or nested commit. Any refusal requires caller rollback. */
export const readCompletedStandardReviewOutcomeTx=performanceStore(MODULE_REVIEW_ACK_ACTION).readCompletedOutcomeTx;
export const readCompletedOnehrPlanOutcomeTx=performanceStore(MODULE_ONEHR_ACK_ACTION).readCompletedOutcomeTx;
