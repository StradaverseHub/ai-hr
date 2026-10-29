/** Trusted offline-clock deployment assembly. No cache, default, network work or independent commit transaction.
 * Facts and their one owner: the actor allowlist, mode, window, permit count, admission budget and photo retention are
 * this deployment's; apiOrigin, app target and Play settings are the actor's existing clock rollout entry's
 * (AIHR_MOBILE_CLOCK_POLICY); offline-enabled, policy and sites are the snapshot's. Keyless (owner decision D16,
 * 29 October 2026): there is no context-signing key, issuer registry or rotation to configure; the issued record is the
 * authority. AI_CONFIG_SECRET storage is still required because claims and their photos are stored encrypted. */
import 'server-only';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityKey,mobileOfflineContext} from '../db/schema';
import {MobileOfflineRolloutPolicy,OFFLINE_ROLLOUT_LIMITS} from '../lib/mobile-offline-rollout-policy';
import type {AppleClockDeployment,AndroidClockDeployment} from '../lib/mobile-clock-rollout-policy';
import type {OfflineClockContextData,OfflineClockContextTarget} from '../lib/mobile-offline-context';
import {IntegrityConfigurationUnavailable} from '../lib/mobile-api/integrity-configuration';
import {isSecretStorable} from '../lib/ai/crypto';
import {assertModuleEnabled} from './entitlements';
import {withAttendanceTenant} from './module-gate';
import {isMobileIntegrityStorageReady} from './mobile-enrollment-rollout';
import {mobileClockRolloutEntry,ClockPolicyUnavailableError} from './mobile-clock-policy';
type Platform='ios'|'android';
type KeyRow=typeof mobileIntegrityKey.$inferSelect;
const unavailable=()=>new IntegrityConfigurationUnavailable('configuration_unavailable');
/** New issuance refused because the deployment is draining (mode 'drain'), including one that began active. */
export class OfflineIssuanceDrainingError extends Error{constructor(){super('Offline issuance draining');this.name='OfflineIssuanceDrainingError';}}
export type MobileOfflineDeployment={platform:Platform;mode:'active'|'drain';apiOrigin:string;target:z.infer<typeof OfflineClockContextTarget>;
 clock:z.infer<typeof AppleClockDeployment>|z.infer<typeof AndroidClockDeployment>;
 windowMs:number;permitCount:number;maximumIssuesPerHour:number;photoRetentionMs:number};
/** Synchronous env read, repeated by every request and commit guard. null = not configured for this actor/company/platform. */
function configured(platform:Platform,ctx:SessionContext,companyId:string):MobileOfflineDeployment|null{
 const raw=process.env.AIHR_MOBILE_OFFLINE_POLICY;
 if(!raw)return null;
 if(Buffer.byteLength(raw,'utf8')>OFFLINE_ROLLOUT_LIMITS.policyBytes)throw unavailable();
 let input:unknown;try{input=JSON.parse(raw);}catch{throw unavailable();}
 const parsed=MobileOfflineRolloutPolicy.safeParse(input);if(!parsed.success)throw unavailable();
 const policy=parsed.data,userId=ctx.userId;
 if(!userId||!policy.entries.some(entry=>entry.tenantId===ctx.tenantId&&entry.companyId===companyId&&entry.actorIds.includes(userId)))return null;
 // The actor must ALSO be in the existing signed-clock rollout for this platform; that entry owns origin/target/Play.
 let entry:ReturnType<typeof mobileClockRolloutEntry>;try{entry=mobileClockRolloutEntry(ctx,companyId);}catch(error){if(error instanceof ClockPolicyUnavailableError)throw unavailable();throw error;}
 const platforms=entry?.platforms;
 let clock:MobileOfflineDeployment['clock'],apiOrigin:string,target:MobileOfflineDeployment['target'];
 if(platform==='ios'){const c=platforms?.ios;if(!c)return null;clock=c;apiOrigin=c.configuration.apiOrigin;target={platform:'ios',appId:c.configuration.target.appId,environment:c.configuration.target.environment};}
 else{const c=platforms?.android;if(!c)return null;clock=c;apiOrigin=c.configuration.settings.apiOrigin;target={platform:'android',appId:c.configuration.settings.target.packageName,environment:null};}
 return {platform,mode:policy.mode,apiOrigin,target,clock,
  windowMs:policy.windowMs,permitCount:policy.permitCount,maximumIssuesPerHour:policy.maximumIssuesPerHour,photoRetentionMs:policy.photoRetentionMs};
}
const sameTarget=(a:MobileOfflineDeployment['target'],b:MobileOfflineDeployment['target'])=>a.platform===b.platform&&a.appId===b.appId&&a.environment===b.environment;
/** Every fact a new issuance records or is admitted by. Recovery and claims compare narrower sets. */
const issueFingerprint=(d:MobileOfflineDeployment)=>JSON.stringify([d.mode,d.apiOrigin,d.target,d.clock,d.windowMs,d.permitCount,d.maximumIssuesPerHour]);
const claimFingerprint=(d:MobileOfflineDeployment)=>JSON.stringify([d.apiOrigin,d.target,d.clock,d.photoRetentionMs]);
export const isMobileOfflineDeploymentPresent=()=>Boolean(process.env.AIHR_MOBILE_OFFLINE_POLICY);
/** The company settings card's "available on this server" answer: an ACTIVE deployment policy that lists this tenant
 * and company for at least one actor. Absent, malformed, oversized or draining is not available. Display only: it
 * checks no clock rollout, registered key or storage, and issuance and claims keep their own checks. */
export function isMobileOfflineDeploymentActiveForCompany(tenantId:string,companyId:string){
 const raw=process.env.AIHR_MOBILE_OFFLINE_POLICY;
 if(!raw||Buffer.byteLength(raw,'utf8')>OFFLINE_ROLLOUT_LIMITS.policyBytes)return false;
 let input:unknown;try{input=JSON.parse(raw);}catch{return false;}
 const parsed=MobileOfflineRolloutPolicy.safeParse(input);
 return parsed.success&&parsed.data.mode==='active'&&parsed.data.entries.some(entry=>entry.tenantId===tenantId&&entry.companyId===companyId);
}
const trigger=(table:string,name:string)=>sql`EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(${'public.'+table}::text) AND tgname=${name}::text AND tgenabled='O')`;
const forced=(table:string)=>sql`EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(${'public.'+table}::text) AND relrowsecurity AND relforcerowsecurity)`;
const granted=(table:string,privilege:string)=>sql`coalesce(has_table_privilege(current_user,to_regclass(${'public.'+table}::text),${privilege}::text),false)`;
/** Draft 0647 readiness from catalog metadata only, under the application role (enrollment precedent). It detects
 * missing or partial storage; migration semantic and release checks remain required. */
export async function mobileOfflineStorageReadyTx(tx:Tx){
 const tables=['mobile_offline_context','mobile_offline_permit','mobile_offline_claim','mobile_offline_photo'];
 const checks=[...tables.map(forced),...tables.flatMap(table=>[granted(table,'SELECT'),granted(table,'INSERT')]),
  ...['next_sequence','previous_digest','closed_at','close_reason','close_request_id'].map(column=>sql`coalesce(has_column_privilege(current_user,to_regclass('public.mobile_offline_context'),${column}::text,'UPDATE'),false)`),
  trigger('mobile_offline_permit','mobile_offline_permit_immutable'),trigger('mobile_offline_claim','mobile_offline_claim_immutable'),trigger('mobile_offline_context','mobile_offline_context_no_delete'),
  trigger('mobile_offline_context','mobile_offline_context_progress'),trigger('mobile_offline_context','mobile_offline_inventory_complete'),trigger('mobile_offline_claim','mobile_offline_claim_ordered'),
  trigger('mobile_integrity_key','mobile_offline_key_counter'),trigger('mobile_offline_claim','mobile_offline_claim_committed'),trigger('mobile_offline_permit','mobile_offline_permit_inventory'),
  trigger('mobile_offline_photo','mobile_offline_photo_immutable'),trigger('mobile_offline_photo','mobile_offline_photo_expired'),trigger('mobile_offline_claim','mobile_offline_photo_committed'),
  sql`coalesce(has_function_privilege(current_user,to_regprocedure('app.mobile_offline_key_leased(uuid,uuid)'),'EXECUTE'),false)`,
  sql`EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.attendance_clock_capture') AND attname='effective_at' AND NOT attisdropped)`,
  sql`EXISTS(SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='clock_method' AND e.enumlabel='mobile_offline')`];
 const [row]=await tx.execute(sql`SELECT ${sql.join(checks,sql` AND `)} AS ready`);
 return row?.ready===true;
}
export async function isMobileOfflineStorageReady(ctx:SessionContext){return withAttendanceTenant(ctx,tx=>mobileOfflineStorageReadyTx(tx));}
/** Call only after proving the own subject and company. Absent policy, or no allowlist/clock entry: null (not_configured).
 * Malformed/oversized policy, malformed clock rollout, unavailable claim/photo encryption storage, missing integrity or
 * 0647 storage: IntegrityConfigurationUnavailable('configuration_unavailable'). No cache: env changes are seen by the next call. */
export async function readMobileOfflineDeployment(platform:Platform,ctx:SessionContext,companyId:string){
 const deployment=configured(platform,ctx,companyId);if(!deployment)return null;
 assertModuleEnabled(ctx,'attendance',companyId);
 if(!isSecretStorable()||!await isMobileIntegrityStorageReady(ctx,platform)||!await isMobileOfflineStorageReady(ctx))throw unavailable();
 return deployment;
}
/** The company an own context was issued under: the anchor for its claim upload and close deployment lookup, so a
 * later company change still reaches the deployment that authorized it (its claims then adjudicate scope_changed). */
export async function ownOfflineContextCompany(ctx:SessionContext,contextId:string,employmentId?:string){
 const id=z.string().uuid().safeParse(contextId),selected=employmentId===undefined?null:z.string().uuid().safeParse(employmentId);
 if(!id.success||!ctx.userId||selected&&!selected.success)return null;
 // employmentId (the transport's ?employmentId= selector): a context issued under another employment reads as absent.
 const own=and(eq(mobileOfflineContext.id,id.data.toLowerCase()),eq(mobileOfflineContext.tenantId,ctx.tenantId),eq(mobileOfflineContext.actorId,ctx.userId),
  ...(selected?.success?[eq(mobileOfflineContext.employmentId,selected.data.toLowerCase())]:[]));
 return withAttendanceTenant(ctx,async tx=>{
  if(!await mobileOfflineStorageReadyTx(tx))throw unavailable();
  const [row]=await tx.select({companyId:mobileOfflineContext.companyId}).from(mobileOfflineContext).where(own).limit(1);
  return row?.companyId??null;
 });
}
/** Issuance beforeCommit, after tentative context/permit/audit/budget writes, in the issuing transaction. issue: the
 * current deployment must be active and identical in every fact it records or admits, and the context must carry exactly
 * the configured window and permit count. recover: still configured for this actor with the same origin/target, active or
 * drain; the exact recorded bytes are returned (no key exists to rotate). AI_CONFIG_SECRET storage is rechecked because a
 * context whose claims could not be stored would hold the key lease for nothing. */
export async function assertOfflineIssueCommit(_tx:Tx,ctx:SessionContext,initial:MobileOfflineDeployment,checked:{context:OfflineClockContextData;key:Readonly<KeyRow>;mode:'issue'|'recover'}){
 const c=checked.context;assertModuleEnabled(ctx,'attendance',c.scope.companyId);
 const current=configured(initial.platform,ctx,c.scope.companyId);if(!current)throw new IntegrityConfigurationUnavailable('not_configured');
 if(!isSecretStorable()||checked.key.platform!==initial.platform||c.scope.apiOrigin!==current.apiOrigin||!sameTarget(c.target,current.target))throw unavailable();
 if(checked.mode==='recover')return;
 if(checked.mode!=='issue')throw unavailable();
 if(current.mode!=='active')throw new OfflineIssuanceDrainingError();
 if(issueFingerprint(current)!==issueFingerprint(initial))throw unavailable();
 if(c.policy.windowMs!==current.windowMs||c.expiresAt!==c.issuedAt+current.windowMs||c.permits.length!==current.permitCount)throw unavailable();
}
/** Claim beforeCommit, after tentative claim/attendance writes. Deliberately NOT rechecked: company offline-enabled
 * (an offline_disabled refusal must commit to advance the stream) and deployment mode (drain keeps upload). The issued
 * record is the context's authority (D16). Removed or changed origin/target/Play/retention vetoes. */
export async function assertOfflineClaimCommit(_tx:Tx,ctx:SessionContext,initial:MobileOfflineDeployment,facts:{context:OfflineClockContextData;key:Readonly<KeyRow>}){
 const companyId=facts.context.scope.companyId;assertModuleEnabled(ctx,'attendance',companyId);
 const current=configured(initial.platform,ctx,companyId);if(!current)throw new IntegrityConfigurationUnavailable('not_configured');
 if(!isSecretStorable()||facts.key.platform!==initial.platform||claimFingerprint(current)!==claimFingerprint(initial)||facts.context.scope.apiOrigin!==current.apiOrigin)throw unavailable();
}
