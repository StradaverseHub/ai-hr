/** UNMOUNTED source adapter. Shared custody owns top-level commit, confirmation POST and retry ledger.
 * No model tools, provider requests, SMTP, arbitrary delivery or second action store live here. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {domainEvent} from '../../db/schema';
import {currentProviderSession} from '../../lib/identity/provider';
import {notificationPreferenceCategories} from '../../lib/notification-email-model';
import {OwnNotificationPreferencesIntent,OwnNotificationPreferencesReview,OwnNotificationPreferencesReceipt} from '../../lib/assistant-actions/own-notification-preferences-contract';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {readOwnNotificationEmailPreferenceSourceTx,saveNotificationEmailPreferencesTx,type EmailConsentIdentity} from '../notification-email';

const fail=():never=>{throw Error('Notification preferences could not be confirmed.');};
const serverIdentityBrand=Symbol('server-notification-identity');
export type OwnNotificationServerIdentity=Readonly<{[serverIdentityBrand]:true}>;
const identities=new WeakMap<OwnNotificationServerIdentity,{identity:EmailConsentIdentity|null;issued:number}>();
/** Call outside the business transaction for EACH prepare/confirm/reopen HTTP request. The opaque
 * capability cannot be reconstructed from model output, JSON, posted identity or encrypted custody. */
export async function resolveOwnNotificationServerIdentity():Promise<OwnNotificationServerIdentity>{
 const provider=await currentProviderSession().catch(()=>null);
 const identity:EmailConsentIdentity|null=provider?.emailVerified===true&&provider.issuer&&provider.subject&&provider.email
  ?{issuer:provider.issuer,subject:provider.subject,email:provider.email,emailVerified:true}:null;
 const capability=Object.freeze({[serverIdentityBrand]:true as const});identities.set(capability,{identity,issued:Date.now()});return capability;
}
function identityOf(capability:OwnNotificationServerIdentity){
 const proof=identities.get(capability);if(!proof||Date.now()<proof.issued||Date.now()-proof.issued>60_000)return fail();return proof.identity?{...proof.identity}:null;
}
function digest(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
async function guard(tx:Tx,supplied:SessionContext){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};await assertAiPrincipalTx(tx,ctx);
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'notifications');
 await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;
}
async function source(tx:Tx,ctx:SessionContext,intent:OwnNotificationPreferencesIntent,capability:OwnNotificationServerIdentity){
 const identity=identityOf(capability),state=await readOwnNotificationEmailPreferenceSourceTx(tx,ctx,intent.employmentId);
 // Even retained consent is rechecked against the actual current calling login. Missing provider
 // proof permits withdrawal only; it never manufactures fresh consent or trusts a posted address.
 if(intent.enabledCategories.length){
  if(!identity?.emailVerified||!identity.email)return fail();
  const [bound]=await tx.execute<{allowed:boolean}>(sql`select app.notification_email_consent_identity(${identity.issuer},${identity.subject},${intent.employmentId}::uuid,${identity.email}) as allowed`);
  if(bound?.allowed!==true)return fail();
 }
 return {state,identity,sourceDigest:digest({version:1,tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,intent,state,identity})};
}
function review(intent:OwnNotificationPreferencesIntent,current:Awaited<ReturnType<typeof source>>){
 return OwnNotificationPreferencesReview.parse({version:1,kind:'own_notification_preferences',employmentId:intent.employmentId,
  before:notificationPreferenceCategories.map(category=>{const row=current.state.preferences.find(p=>p.category===category);return {category,enabled:row?.enabled??false,locale:row?.emailLocale??null};}),
  after:{enabledCategories:intent.enabledCategories,locale:intent.locale},reviewDigest:current.sourceDigest});
}
/** The encrypted shared review must retain the EXACT normalized intent; returned card contains no
 * email, provider subject, private watermark, policy internals or source row versions. */
export async function prepareOwnNotificationPreferencesTx(tx:Tx,ctx:SessionContext,input:unknown,capability:OwnNotificationServerIdentity){
 const intent=OwnNotificationPreferencesIntent.parse(input),fresh=await guard(tx,ctx);return review(intent,await source(tx,fresh,intent,capability));
}
/** Caller must own shared custody and roll back the WHOLE transaction on any refusal/failure.
 * A stale/duplicate uncustodied call refuses; only shared completed custody may replay its receipt. */
export async function confirmOwnNotificationPreferencesTx(tx:Tx,ctx:SessionContext,input:unknown,expectedDigest:string,capability:OwnNotificationServerIdentity){
 const intent=OwnNotificationPreferencesIntent.parse(input),fresh=await guard(tx,ctx),current=await source(tx,fresh,intent,capability);
 if(typeof expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedDigest)||current.sourceDigest!==expectedDigest)return fail();
 const effect=await saveNotificationEmailPreferencesTx(tx,fresh,intent.employmentId,intent.enabledCategories,intent.locale,current.identity);
 const after=await source(tx,fresh,intent,capability);
 return OwnNotificationPreferencesReceipt.parse({version:1,kind:'own_notification_preferences',employmentId:effect.employmentId,eventId:effect.eventId,
  resultDigest:after.sourceDigest,enabledCategories:intent.enabledCategories,locale:intent.locale});
}
/** Reopening never reapplies consent. It reconciles the exact own native event AND current state.
 * A later legitimate edit means this completion cannot be represented as the current preference. */
export async function reopenOwnNotificationPreferencesTx(tx:Tx,ctx:SessionContext,value:unknown,capability:OwnNotificationServerIdentity){
 const receipt=OwnNotificationPreferencesReceipt.parse(value),fresh=await guard(tx,ctx);
 const intent=OwnNotificationPreferencesIntent.parse({version:1,employmentId:receipt.employmentId,enabledCategories:receipt.enabledCategories,locale:receipt.locale,consent:'selected_categories_only'});
 const current=await source(tx,fresh,intent,capability);
 const [event]=await tx.select({actorType:domainEvent.actorType,actorId:domainEvent.actorId,aggregateType:domainEvent.aggregateType,aggregateId:domainEvent.aggregateId,
  type:domainEvent.eventType,subject:domainEvent.subjectEmploymentId,payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.id,receipt.eventId),eq(domainEvent.tenantId,fresh.tenantId)));
 const payload=OwnNotificationPreferencesReview.shape.after.safeParse(event?.payload);
 if(!event||!payload.success||event.actorType!=='user'||event.actorId!==fresh.userId||event.aggregateType!=='employment'||event.aggregateId!==intent.employmentId||event.subject!==intent.employmentId||event.type!=='notification-email.consent-changed'||
  digest(payload.data)!==digest({enabledCategories:intent.enabledCategories,locale:intent.locale})||current.sourceDigest!==receipt.resultDigest)return fail();
 return receipt;
}

/** Terminal custody retains only these native references. This proves that the exact caller's
 * historical effect exists AND current permitted preference values match; it does not claim this
 * is the latest event, an unchanged xmin, or continuity of an erased private identity digest.
 * Ordinary workflow consent stores user+watermark only. Reports additionally persist the actual
 * issuer/subject/address binding, all of which must still match the fresh verified server identity. */
export async function reopenOwnNotificationPreferencesEventTx(tx:Tx,ctx:SessionContext,value:unknown,capability:OwnNotificationServerIdentity){
 const reference=OwnNotificationPreferencesReceipt.pick({employmentId:true,eventId:true}).strict().parse(value),fresh=await guard(tx,ctx);
 const [event]=await tx.select({payload:domainEvent.payload}).from(domainEvent).where(and(
  eq(domainEvent.id,reference.eventId),eq(domainEvent.tenantId,fresh.tenantId),eq(domainEvent.actorType,'user'),eq(domainEvent.actorId,fresh.userId!),
  eq(domainEvent.aggregateType,'employment'),eq(domainEvent.aggregateId,reference.employmentId),eq(domainEvent.subjectEmploymentId,reference.employmentId),eq(domainEvent.eventType,'notification-email.consent-changed')));
 const payload=OwnNotificationPreferencesReview.shape.after.safeParse(event?.payload);if(!event||!payload.success)return fail();
 const intent=OwnNotificationPreferencesIntent.parse({version:1,employmentId:reference.employmentId,...payload.data,consent:'selected_categories_only'});
 const current=await source(tx,fresh,intent,capability),rows=current.state.preferences;
 if(rows.length!==notificationPreferenceCategories.length)return fail();
 const enabled=new Set(intent.enabledCategories);
 for(const category of notificationPreferenceCategories){
  const row=rows.find(p=>p.category===category),selected=enabled.has(category);
  if(!row||row.enabled!==selected||row.emailLocale!==intent.locale)return fail();
  if(selected){
   if(row.emailConsentUserId!==fresh.userId||row.emailAfterSequence===null||!Number.isSafeInteger(row.emailAfterSequence)||row.emailAfterSequence<0)return fail();
   if(category==='employee_master_reports'){
    const identity=current.identity,addressHash=identity?.email?createHash('sha256').update(identity.email.toLowerCase()).digest('hex'):null;
    if(!identity||!addressHash||row.reportConsentIssuer!==identity.issuer||row.reportConsentSubject!==identity.subject||row.reportConsentAddressHash!==addressHash||!row.reportConsentVerifiedAt||!Number.isFinite(row.reportConsentVerifiedAt.getTime()))return fail();
   }
  }else if(row.emailConsentUserId!==null||row.emailAfterSequence!==null||category==='employee_master_reports'&&(row.reportConsentIssuer!==null||row.reportConsentSubject!==null||row.reportConsentAddressHash!==null||row.reportConsentVerifiedAt!==null))return fail();
 }
 return {version:1 as const,kind:'own_notification_preferences' as const,proof:'historical_event_current_values' as const,
  employmentId:reference.employmentId,eventId:reference.eventId,enabledCategories:intent.enabledCategories,locale:intent.locale};
}
