/** Single owner of the administrator authenticator pause ("recovery exemption") record lifecycle.
 * Callers hold the subject's internal-auth advisory lock and persist the credential in the same transaction.
 * The record is encrypted and keyed by subject; audit payloads carry times only, never secrets or reasons. */
import {randomUUID} from 'node:crypto';
import {recoveryExemptionActive,type RecoveryExemption} from './account-state';
import {readRecord,writeRecord,deleteRecord,type AuthSql} from './record-store';
import type {Credential} from './credential';
export const recoveryExemptionKey=(subject:string)=>`recovery-exemption:${subject}`;
/** Earliest and latest pause end an administrator may choose (product promise: up to 7 days). */
export const RECOVERY_EXEMPTION_MIN_MS=5*60_000;
export const RECOVERY_EXEMPTION_MAX_MS=7*24*3600_000;
/** The sealed record outlives its pause so an ended pause is observed and audited once, then deleted. */
const RETAIN_AFTER_EXPIRY_MS=30*24*3600_000;
export type RecoveryExemptionEvent='app-user.recovery-exemption-consumed'|'app-user.recovery-exemption-expired';
async function appendExemptionEvent(tx:AuthSql,c:Pick<Credential,'issuer'|'subject'|'tenantId'>,event:RecoveryExemptionEvent,actor:'user'|'system',payload:Record<string,unknown>){
 const [principal]=await tx.unsafe('select app_user_id,tenant_id from app.principal_by_identity($1,$2)',[c.issuer,c.subject]);
 if(!principal?.app_user_id||principal.tenant_id!==c.tenantId)return;
 await tx.unsafe('select app.append_auth_event($1::uuid,\'app-user\',$2::uuid,$3,$4,$5::uuid,$6::jsonb)',
  [c.tenantId,principal.app_user_id,event,actor,actor==='user'?principal.app_user_id:null,JSON.stringify(payload)]);
}
/** Bounded absolute end, validated against the server clock. */
export function validRecoveryExemptionEnd(expiresAt:number,now=Date.now()){
 return Number.isSafeInteger(expiresAt)&&expiresAt>=now+RECOVERY_EXEMPTION_MIN_MS&&expiresAt<=now+RECOVERY_EXEMPTION_MAX_MS;
}
export async function writeRecoveryExemption(tx:AuthSql,c:Pick<Credential,'subject'>,expiresAt:number,reason:string){
 await writeRecord(tx,recoveryExemptionKey(c.subject),{purpose:'password-reset',expiresAt,reason} satisfies RecoveryExemption,c.subject,expiresAt+RETAIN_AFTER_EXPIRY_MS);
}
/** The active pause, or null. An ended pause found here is deleted and audited once as expired. */
export async function settleRecoveryExemption(tx:AuthSql,c:Pick<Credential,'issuer'|'subject'|'tenantId'>,now=Date.now()):Promise<RecoveryExemption|null>{
 const key=recoveryExemptionKey(c.subject),exemption=await readRecord<RecoveryExemption>(tx,key,true);
 if(!exemption)return null;
 if(recoveryExemptionActive(exemption,now))return exemption;
 await deleteRecord(tx,key);
 await appendExemptionEvent(tx,c,'app-user.recovery-exemption-expired','system',{expiresAt:exemption.expiresAt});
 return null;
}
/** Switch the check back on before the pause ends. Returns whether an active pause existed. */
export async function cancelRecoveryExemption(tx:AuthSql,c:Pick<Credential,'issuer'|'subject'|'tenantId'>,now=Date.now()){
 const active=await settleRecoveryExemption(tx,c,now);
 if(active)await deleteRecord(tx,recoveryExemptionKey(c.subject));
 return active;
}
/** Consume the single-use pause: retire the lost factor so the next step must enrol a fresh authenticator.
 * Rotating the version invalidates outstanding challenges, sessions and remembered devices of the old factor. */
export async function consumeRecoveryExemption(tx:AuthSql,c:Credential,exemption:RecoveryExemption,path:'temporary-password'|'password-reset'){
 c.totpSecret=null;c.lastStep=-1;c.recoveryHashes=[];c.version=randomUUID();
 await deleteRecord(tx,recoveryExemptionKey(c.subject));
 await appendExemptionEvent(tx,c,'app-user.recovery-exemption-consumed','user',{path,expiresAt:exemption.expiresAt});
}
