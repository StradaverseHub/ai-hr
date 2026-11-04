/** Security Center account actions. Each read/write re-proves complete target scope inside its transaction. */
import {randomBytes,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {isAdmin} from '../lib/authz-model';
import {internalSelected,internalIssuer} from '../lib/internal-auth/config';
import {readRecord,writeRecord,revokeCredentialsSessions,type AuthSql} from '../lib/internal-auth/record-store';
import type {Credential} from '../lib/internal-auth/credential';
import {accountAvailable,type RecoveryExemption} from '../lib/internal-auth/account-state';
import {replacePassword} from '../lib/internal-auth/password-policy';
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
async function withAccount<T>(ctx:SessionContext,userId:string,operation:(tx:Tx,auth:AuthSql,c:Credential)=>Promise<T>):Promise<T>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!internalSelected()||!ctx.userId||!isAdmin(ctx)||! /^[0-9a-f-]{36}$/i.test(userId))throw Error('forbidden');
 return withTenant(ctx,async tx=>{
  const issuer=internalIssuer(ctx.tenantId);
  const [identity]=await tx.execute(sql`select app.account_management_subject(${userId}::uuid,${issuer}) subject`) as unknown as {subject:string}[];
  if(!identity?.subject)throw Error('forbidden');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'internal-auth:'+identity.subject},0))`);
  // Re-admit after acquiring the same serialization lock as login/recovery and session refresh.
  await tx.execute(sql`select app.account_management_subject(${userId}::uuid,${issuer})`);
  const auth=authSql(tx),c=await readRecord<Credential>(auth,`credential:${identity.subject}`,true);
  if(!c||c.subject!==identity.subject||c.tenantId!==ctx.tenantId||c.issuer!==issuer)throw Error('forbidden');
  return operation(tx,auth,c);
 });
}
export type AccountSummary={username:string;email:string;status:'active'|'suspended'|'expired'|'preparing';activeUntil:string|null;mustChange:boolean;temporaryPasswordExpiresAt:number|null;exemptionUntil:number|null};
export function readManagedAccount(ctx:SessionContext,userId:string){return withAccount(ctx,userId,async(_tx,auth,c):Promise<AccountSummary>=>{
 const exemption=await readRecord<RecoveryExemption>(auth,`recovery-exemption:${c.subject}`);
 return {username:c.username,email:c.email,status:!c.enabled?'preparing':c.suspended?'suspended':!accountAvailable(c)?'expired':'active',activeUntil:c.accountActiveUntil??null,mustChange:c.mustChange,temporaryPasswordExpiresAt:c.temporaryPasswordExpiresAt??null,exemptionUntil:exemption?.expiresAt??null};
});}
export type AccountCommand=
 |{type:'suspend'|'reactivate';reason:string}
 |{type:'expiry';reason:string;activeUntil:string|null}
 |{type:'temporary-password';reason:string;password?:string;minutes:number}
 |{type:'recovery-exemption';reason:string;minutes:number}
 |{type:'reset-email';reason:string};
export async function manageAccount(ctx:SessionContext,userId:string,command:AccountCommand){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 command=structuredClone(command);
 if(!['suspend','reactivate','expiry','temporary-password','recovery-exemption','reset-email'].includes(command.type))throw Error('invalid');
 const reason=command.reason.trim();if(reason.length<5||reason.length>500)throw Error('invalid');
 const result=await withAccount(ctx,userId,async(tx,auth,c)=>{
  if(!c.enabled)throw Error('invalid'); // Provisioning/activation retains its existing owner.
  let password:string|undefined;
  const metadata:Record<string,unknown>={reason,beforeStatus:c.suspended?'suspended':accountAvailable(c)?'active':'expired'};
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
   password=command.password||`Aa9!${randomBytes(24).toString('base64url')}`;
   await replacePassword(auth,c,password);c.mustChange=true;c.temporaryPasswordUsed=false;c.temporaryPasswordExpiresAt=Date.now()+command.minutes*60_000;
   metadata.expiresAt=c.temporaryPasswordExpiresAt;
  }
  if(command.type==='recovery-exemption'){
   if(!accountAvailable(c)||!Number.isSafeInteger(command.minutes)||command.minutes<5||command.minutes>60)throw Error('invalid');
   const expiresAt=Date.now()+command.minutes*60_000;
   await writeRecord(auth,`recovery-exemption:${c.subject}`,{purpose:'password-reset',expiresAt,reason} satisfies RecoveryExemption,c.subject,expiresAt);
   metadata.purpose='password-reset';metadata.expiresAt=expiresAt;
  }
  if(command.type==='reset-email'&&(!accountAvailable(c)||!c.emailVerified))throw Error('invalid');
  // Credential-version rotation invalidates challenges and remembered factors as well as live sessions.
  c.version=randomUUID();
  await revokeCredentialsSessions(auth,c.subject);
  await writeRecord(auth,`credential:${c.subject}`,c,c.subject);
  metadata.afterStatus=c.suspended?'suspended':accountAvailable(c)?'active':'expired';
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-user',aggregateId:userId,eventType:`app-user.account-${command.type}`,actor:actorOf(ctx),payload:metadata});
  return {password,organization:c.organization,username:c.username};
 });
 let delivery:'sent'|'failed'|'skipped'|'uncertain'|undefined;
 if(command.type==='reset-email'){
  delivery='uncertain';
  try{await requestRecovery(result.organization,result.username,undefined,attempt=>attempt(),false,'en',status=>{delivery=status;});}catch{delivery='failed';}
 }
 return {password:result.password,delivery};
}

/** Batched directory projection. A denied identity has no metadata and no account action link. */
export async function readManagedAccountDirectory(ctx:SessionContext,userIds:string[]){
 if(!internalSelected()||!ctx.userId||!isAdmin(ctx))return {};
 return withTenant(ctx,async tx=>{
  const result:Record<string,Pick<AccountSummary,'username'|'status'|'activeUntil'>>={};
  const auth=authSql(tx),issuer=internalIssuer(ctx.tenantId);
  for(const id of [...new Set(userIds)].sort()){
   const [identity]=await tx.execute(sql`select app.account_management_subject(${id}::uuid,${issuer}) subject`) as unknown as {subject:string|null}[];
   if(!identity?.subject)continue;
   const c=await readRecord<Credential>(auth,`credential:${identity.subject}`);
   if(!c||c.subject!==identity.subject||c.tenantId!==ctx.tenantId||c.issuer!==issuer)continue;
   result[id]={username:c.username,status:!c.enabled?'preparing':c.suspended?'suspended':!accountAvailable(c)?'expired':'active',activeUntil:c.accountActiveUntil??null};
  }
  return result;
 });
}
export function readManagedAccountHistory(ctx:SessionContext,userId:string){
 return withAccount(ctx,userId,async tx=>{
  const rows=await tx.execute(sql`select event_type,occurred_at,actor_id,payload->>'reason' reason,payload->>'expiresAt' expires_at
   from domain_event where tenant_id=${ctx.tenantId}::uuid and aggregate_type='app-user' and aggregate_id=${userId}::uuid
   and (event_type like 'app-user.account-%' or event_type='app-user.recovery-exemption-consumed')
   order by occurred_at desc,sequence desc limit 50`);
  return rows as unknown as {event_type:string;occurred_at:Date;actor_id:string|null;reason:string|null;expires_at:string|null}[];
 });
}
