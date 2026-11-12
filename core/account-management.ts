/** Security Center account actions. Each read/write re-proves complete target scope inside its transaction. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {isAdmin} from '../lib/authz-model';
import {internalSelected,internalIssuer} from '../lib/internal-auth/config';
import {readRecord,writeRecord,revokeCredentialsSessions,type AuthSql} from '../lib/internal-auth/record-store';
import type {Credential} from '../lib/internal-auth/credential';
import {accountAvailable,recoveryExemptionActive,type RecoveryExemption} from '../lib/internal-auth/account-state';
import {cancelRecoveryExemption,recoveryExemptionKey,settleRecoveryExemption,validRecoveryExemptionEnd,writeRecoveryExemption} from '../lib/internal-auth/recovery-exemption';
import {replacePassword,generateTemporaryPassword} from '../lib/internal-auth/password-policy';
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import {requestRecovery} from '../lib/internal-auth/recovery';

/** Adapt parameterized canonical auth IO to the existing RLS transaction. Never interpolate values as SQL. */
function authSql(tx:Tx):AuthSql {
 return {unsafe:async(query:string,values:unknown[]=[])=>{
  const parts=query.split(/(\$\d+)/g);
  return tx.execute(sql.join(parts.map(part=>/^\$\d+$/.test(part)?sql`${values[Number(part.slice(1))-1]}`:sql.raw(part)),sql``));
 }} as unknown as AuthSql;
}
const accountCommandTypes=['suspend','reactivate','expiry','temporary-password','recovery-exemption','recovery-exemption-cancel','reset-email'] as const;
export type AccountCommandType=typeof accountCommandTypes[number];
/** Reads admit through 2106's scope proof; an action additionally needs strictly higher authority (4902). */
function admission(userId:string,issuer:string,action?:AccountCommandType){
 return action?sql`select app.account_action_subject(${userId}::uuid,${issuer},${action}) subject`
  :sql`select app.account_management_subject(${userId}::uuid,${issuer}) subject`;
}
/** The actions the database admits for this actor and target: none for self, peers and higher roles. */
async function admittedActions(tx:Tx,userId:string,issuer:string):Promise<AccountCommandType[]>{
 const [row]=await tx.execute(sql`select app.account_actions_admitted(${userId}::uuid,${issuer}) actions`) as unknown as {actions:string[]|null}[];
 return accountCommandTypes.filter(type=>row?.actions?.includes(type));
}
async function withAccount<T>(ctx:SessionContext,userId:string,operation:(tx:Tx,auth:AuthSql,c:Credential)=>Promise<T>,action?:AccountCommandType):Promise<T>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!internalSelected()||!ctx.userId||!isAdmin(ctx)||! /^[0-9a-f-]{36}$/i.test(userId))throw Error('forbidden');
 // Nobody acts on their own account here; the database refuses it too, this keeps the error early and plain.
 if(action&&userId.toLowerCase()===ctx.userId.toLowerCase())throw Error('forbidden');
 return withTenant(ctx,async tx=>{
  const issuer=internalIssuer(ctx.tenantId);
  const [identity]=await tx.execute(admission(userId,issuer,action)) as unknown as {subject:string|null}[];
  if(!identity?.subject)throw Error('forbidden');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'internal-auth:'+identity.subject},0))`);
  // Re-admit after acquiring the same serialization lock as login/recovery and session refresh.
  const [again]=await tx.execute(admission(userId,issuer,action)) as unknown as {subject:string|null}[];
  if(again?.subject!==identity.subject)throw Error('forbidden');
  const auth=authSql(tx),c=await readRecord<Credential>(auth,`credential:${identity.subject}`,true);
  if(!c||c.subject!==identity.subject||c.tenantId!==ctx.tenantId||c.issuer!==issuer)throw Error('forbidden');
  return operation(tx,auth,c);
 });
}
export type AccountSummary={name?:string|null;username:string;email:string;status:'active'|'suspended'|'expired'|'preparing';activeUntil:string|null;mustChange:boolean;temporaryPasswordExpiresAt:number|null;exemptionUntil:number|null;actions:AccountCommandType[]};
const accountStatus=(c:Credential):AccountSummary['status']=>!c.enabled?'preparing':c.suspended?'suspended':!accountAvailable(c)?'expired':'active';
/** The read settles an ended authenticator pause (deleted and audited once as expired) under the account lock. */
export function readManagedAccount(ctx:SessionContext,userId:string){return withAccount(ctx,userId,async(tx,auth,c):Promise<AccountSummary>=>{
 const exemption=await settleRecoveryExemption(auth,c);
 const [person]=await tx.execute(sql`select p.full_name from app_user au left join person p on p.id=au.person_id and p.tenant_id=au.tenant_id where au.id=${userId}::uuid and au.tenant_id=${ctx.tenantId}::uuid`) as unknown as {full_name:string|null}[];
 const actions=userId.toLowerCase()===ctx.userId?.toLowerCase()?[]:await admittedActions(tx,userId,internalIssuer(ctx.tenantId));
 return {actions,name:person?.full_name??null,username:c.username,email:c.email,status:accountStatus(c),activeUntil:c.accountActiveUntil??null,mustChange:c.mustChange,temporaryPasswordExpiresAt:c.temporaryPasswordExpiresAt??null,exemptionUntil:exemption?.expiresAt??null};
});}
/** A policy-conforming candidate for the Reset Password dialog. Nothing is stored or audited; the admin may edit it. */
export function generateManagedAccountPassword(ctx:SessionContext,userId:string){return withAccount(ctx,userId,async(_tx,auth,c)=>{
 if(!c.enabled||!accountAvailable(c))throw Error('invalid');
 return generateTemporaryPassword(auth,c);
},'temporary-password');}
export type AccountCommand=
 |{type:'suspend'|'reactivate';reason:string}
 |{type:'expiry';reason:string;activeUntil:string|null}
 |{type:'temporary-password';reason?:string;password?:string;minutes:number}
 |{type:'recovery-exemption';reason:string;expiresAt:number}
 |{type:'recovery-exemption-cancel';reason?:string}
 |{type:'reset-email';reason:string};
/** Reason is required (5-500) for every command except issuing a temporary password and switching the
 * authenticator check back on. A supplied reason keeps the same bounds. */
const OPTIONAL_REASON=new Set(['temporary-password','recovery-exemption-cancel']);
export async function manageAccount(ctx:SessionContext,userId:string,command:AccountCommand){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 command=structuredClone(command);
 if(!(accountCommandTypes as readonly string[]).includes(command.type))throw Error('invalid');
 if(command.reason!==undefined&&typeof command.reason!=='string')throw Error('invalid');
 const reason=(command.reason??'').trim();
 if((reason.length>0||!OPTIONAL_REASON.has(command.type))&&(reason.length<5||reason.length>500))throw Error('invalid');
 const result=await withAccount(ctx,userId,async(tx,auth,c)=>{
  if(!c.enabled)throw Error('invalid'); // Provisioning/activation retains its existing owner.
  let password:string|undefined;
  if(command.type==='recovery-exemption-cancel'){
   // Restoring the check changes no credential, so sessions stay. Nothing active means nothing to audit.
   const active=await cancelRecoveryExemption(auth,c);
   if(active)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-user',aggregateId:userId,eventType:'app-user.account-recovery-exemption-cancelled',actor:actorOf(ctx),payload:{...(reason?{reason}:{}),expiresAt:active.expiresAt}});
   return {password,organization:c.organization,username:c.username};
  }
  const metadata:Record<string,unknown>={...(reason?{reason}:{}),beforeStatus:c.suspended?'suspended':accountAvailable(c)?'active':'expired'};
  if(command.type==='suspend'){c.suspended=true;}
  if(command.type==='reactivate'){
   if(c.accountActiveUntil&&c.accountActiveUntil<todayInKualaLumpur())throw Error('expired');
   c.suspended=false;
  }
  if(command.type==='expiry'){
   if(command.activeUntil!==null&&!isCalendarDate(command.activeUntil))throw Error('invalid');
   metadata.before=c.accountActiveUntil??null;c.accountActiveUntil=command.activeUntil;metadata.after=command.activeUntil;
  }
  if(command.type==='temporary-password'){
   if(!accountAvailable(c)||!Number.isSafeInteger(command.minutes)||command.minutes<5||command.minutes>1440)throw Error('invalid');
   if(command.password!==undefined&&typeof command.password!=='string')throw Error('invalid');
   password=command.password||await generateTemporaryPassword(auth,c);
   await replacePassword(auth,c,password);c.mustChange=true;c.temporaryPasswordUsed=false;c.temporaryPasswordExpiresAt=Date.now()+command.minutes*60_000;
   metadata.expiresAt=c.temporaryPasswordExpiresAt;
  }
  if(command.type==='recovery-exemption'){
   // An absolute end chosen by the administrator, at most 7 days ahead. Single use; MFA stays mandatory.
   if(!accountAvailable(c)||!validRecoveryExemptionEnd(command.expiresAt))throw Error('invalid');
   await writeRecoveryExemption(auth,c,command.expiresAt,reason);
   metadata.purpose='password-reset';metadata.expiresAt=command.expiresAt;
  }
  if(command.type==='reset-email'&&(!accountAvailable(c)||!c.emailVerified))throw Error('invalid');
  // Credential-version rotation invalidates challenges and remembered factors as well as live sessions.
  c.version=randomUUID();
  await revokeCredentialsSessions(auth,c.subject);
  await writeRecord(auth,`credential:${c.subject}`,c,c.subject);
  metadata.afterStatus=c.suspended?'suspended':accountAvailable(c)?'active':'expired';
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-user',aggregateId:userId,eventType:`app-user.account-${command.type}`,actor:actorOf(ctx),payload:metadata});
  return {password,organization:c.organization,username:c.username};
 },command.type);
 let delivery:'sent'|'failed'|'skipped'|'uncertain'|undefined;
 if(command.type==='reset-email'){
  delivery='uncertain';
  try{await requestRecovery(result.organization,result.username,undefined,attempt=>attempt(),false,'en',status=>{delivery=status;});}catch{delivery='failed';}
 }
 return {password:result.password,delivery};
}

export type ManagedDirectoryAccount=Pick<AccountSummary,'username'|'status'|'activeUntil'|'exemptionUntil'|'actions'>;
/** Batched directory projection. A denied identity has no metadata and no account action link.
 * Read-only: an ended authenticator pause shows as required here and is settled by the next locked read. */
export async function readManagedAccountDirectory(ctx:SessionContext,userIds:string[]){
 if(!internalSelected()||!ctx.userId||!isAdmin(ctx))return {};
 return withTenant(ctx,async tx=>{
  const result:Record<string,ManagedDirectoryAccount>={};
  const auth=authSql(tx),issuer=internalIssuer(ctx.tenantId),now=Date.now();
  for(const id of [...new Set(userIds)].sort()){
   const [identity]=await tx.execute(sql`select app.account_management_subject(${id}::uuid,${issuer}) subject`) as unknown as {subject:string|null}[];
   if(!identity?.subject)continue;
   const c=await readRecord<Credential>(auth,`credential:${identity.subject}`);
   if(!c||c.subject!==identity.subject||c.tenantId!==ctx.tenantId||c.issuer!==issuer)continue;
   const exemption=await readRecord<RecoveryExemption>(auth,recoveryExemptionKey(c.subject));
   const actions=id.toLowerCase()===ctx.userId!.toLowerCase()?[]:await admittedActions(tx,id,issuer);
   result[id]={username:c.username,status:accountStatus(c),activeUntil:c.accountActiveUntil??null,exemptionUntil:exemption&&recoveryExemptionActive(exemption,now)?exemption.expiresAt:null,actions};
  }
  return result;
 });
}
/** Security history beyond the account-* commands. Payload fields are an allowlist (reason, expiresAt); no secret is ever read. */
const HISTORY_EVENTS=['app-user.recovery-exemption-consumed','app-user.recovery-exemption-expired','app-user.logged-in','app-user.password-reset','app-user.mfa-enrolled','app-user.password-unlocked'];
export type AccountHistoryEvent={event_type:string;occurred_at:Date|string;actor_id:string|null;actor_name:string|null;reason:string|null;expires_at:string|null};
export function readManagedAccountHistory(ctx:SessionContext,userId:string,limit=50){
 const bounded=Math.max(1,Math.min(50,Math.trunc(limit)||50));
 return withAccount(ctx,userId,async(tx,auth,c)=>{
  await settleRecoveryExemption(auth,c);
  const rows=await tx.execute(sql`select d.event_type,d.occurred_at,d.actor_id,p.full_name actor_name,d.payload->>'reason' reason,d.payload->>'expiresAt' expires_at
   from domain_event d left join app_user au on au.id=d.actor_id and au.tenant_id=d.tenant_id left join person p on p.id=au.person_id and p.tenant_id=d.tenant_id
   where d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='app-user' and d.aggregate_id=${userId}::uuid
   and (d.event_type like 'app-user.account-%' or d.event_type in (${sql.join(HISTORY_EVENTS.map(e=>sql`${e}`),sql`,`)}))
   order by d.occurred_at desc,d.sequence desc limit ${bounded}`);
  return rows as unknown as AccountHistoryEvent[];
 });
}
