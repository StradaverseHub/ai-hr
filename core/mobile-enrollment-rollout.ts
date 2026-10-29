/** Trusted deployment assembly. Environment changes never rewrite an existing enrollment context. */
import 'server-only';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {MobileEnrollmentRolloutPolicy} from '../lib/mobile-enrollment-rollout-policy';
import {IntegrityConfigurationUnavailable} from '../lib/mobile-api/integrity-configuration';
import {isSecretStorable} from '../lib/ai/crypto';
import {assertModuleEnabled} from './entitlements';
import {withAttendanceTenant} from './module-gate';
import {ownIntegrityEnrollmentCompany,ownIntegrityEnrollmentCompanyTx} from './mobile-integrity-key';
type Platform='ios'|'android';
const unavailable=()=>new IntegrityConfigurationUnavailable('configuration_unavailable');
/** Readiness detects missing/partial prerequisites; migration semantic/release checks remain required.
 * Read only system catalog metadata, under the ordinary application role; never migration credentials. */
export async function isMobileIntegrityStorageReady(ctx:SessionContext,platform:Platform){
 return withAttendanceTenant(ctx,async tx=>{
  const [row]=await tx.execute(sql`
   SELECT
    EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.mobile_integrity_key') AND relrowsecurity AND relforcerowsecurity) AND
    EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.mobile_integrity_challenge') AND relrowsecurity AND relforcerowsecurity) AND
    to_regclass('public.mobile_integrity_installation') IS NOT NULL AND
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mobile_integrity_key') AND tgname='mobile_integrity_key_immutable' AND tgenabled='O') AND
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mobile_integrity_challenge') AND tgname='mobile_integrity_challenge_immutable' AND tgenabled='O') AND
    has_table_privilege(current_user,to_regclass('public.mobile_integrity_key'),'SELECT') AND
    has_table_privilege(current_user,to_regclass('public.mobile_integrity_key'),'INSERT') AND
    has_function_privilege(current_user,to_regprocedure('app.mobile_integrity_installation_id()'),'EXECUTE') AS ready,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mobile_integrity_key') AND conname='mobile_integrity_key_platform_evidence_check' AND convalidated) AND
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.mobile_integrity_key') AND attname='environment' AND NOT attnotnull AND NOT attisdropped) AS android_ready
  `);
  return row?.ready===true&&(platform==='ios'||row.android_ready===true);
 });
}
/** Called only after HTTP subject authorization; repeats ownership for direct service consumers.
 * The allowlist must explicitly name tenant, proven company, actor and platform. No wildcard/default.
 * No cache: disabling/removing an entry is observed by the next request, including completion. */
function configured(platform:Platform,ctx:SessionContext,companyId:string){
 const raw=process.env.AIHR_MOBILE_ENROLLMENT_POLICY;
 if(!raw)return null;
 if(Buffer.byteLength(raw,'utf8')>262144)throw unavailable();
 let input:unknown;try{input=JSON.parse(raw);}catch{throw unavailable();}
 const parsed=MobileEnrollmentRolloutPolicy.safeParse(input);if(!parsed.success)throw unavailable();
 const entry=parsed.data.entries.find(value=>value.tenantId===ctx.tenantId&&value.companyId===companyId&&value.actorIds.includes(ctx.userId!)&&value.settings.target.platform===platform);
 return entry?.settings??null;
}
export async function readMobileEnrollmentConfiguration(platform:Platform,ctx:SessionContext,employmentId:string,signal:AbortSignal){
 if(signal.aborted)throw unavailable();
 const companyId=await ownIntegrityEnrollmentCompany(ctx,employmentId);if(signal.aborted)throw unavailable();
 if(!companyId)return null;
 assertModuleEnabled(ctx,'attendance',companyId);
 const settings=configured(platform,ctx,companyId);if(!settings)return null;
 if(!isSecretStorable()||!await isMobileIntegrityStorageReady(ctx,platform)||signal.aborted)throw unavailable();
 return settings;
}
/** Recheck the allowlist and exact original target after vendor work, inside the consumption/custody
 * transaction and actor lock. Never open a second pooled transaction while holding those locks. */
export async function assertMobileEnrollmentCommit(tx:Tx,ctx:SessionContext,employmentId:string,settings:unknown){
 const companyId=await ownIntegrityEnrollmentCompanyTx(tx,ctx,employmentId);if(!companyId)throw unavailable();
 assertModuleEnabled(ctx,'attendance',companyId);
 const platform=(settings as {target?:{platform?:unknown}})?.target?.platform;
 if(platform!=='ios'&&platform!=='android')throw unavailable();
 const current=configured(platform,ctx,companyId);
 if(!current)throw new IntegrityConfigurationUnavailable('not_configured');
 if(!isSecretStorable()||JSON.stringify(current)!==JSON.stringify(settings))throw unavailable();
}
