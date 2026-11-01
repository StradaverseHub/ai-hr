import { internalIssuer } from '../internal-auth/config';
import { randomUUID } from 'node:crypto';
import { client } from '../../db/client';
import { authTransaction, readRecord, writeRecord, deleteRecord, type AuthSql } from '../internal-auth/store';
import { opaque, digest, validOpaque } from '../internal-auth/crypto';
import { todayInKualaLumpur } from '../hr-date';
import { EntraError, issuerFor, type EntraConfig } from './model';
import { connector } from './store';
type Identity = { tenantId:string; revision:string; objectId:string; userId:string; family:string; native:boolean; expiry:number; localVersions?:{subject:string;version:string|null}[] };
export type EntraTokens = { step:'complete'; access_token:string; refresh_token?:string; expires_in:number };
async function allowed(tx: AuthSql, value:Identity) {
  for(const reference of value.localVersions||[]){
    const credential=await readRecord<{version:string}>(tx,`credential:${reference.subject}`);
    if((credential?.version??null)!==reference.version)throw new EntraError('forbidden');
  }
  const config = await connector(value.tenantId);
  if (!config?.enabled || config.revision!==value.revision || value.expiry<=Date.now()) throw new EntraError('forbidden');
  const principal = await tx.unsafe('select app_user_id,tenant_id from app.principal_by_identity($1,$2)',[issuerFor(config.directoryTenantId),value.objectId]);
  const permitted = await tx.unsafe('select app.entra_login_allowed($1::uuid,$2::uuid,$3::uuid,$4::date) allowed',[value.tenantId,value.userId,value.revision,todayInKualaLumpur()]);
  if (principal[0]?.app_user_id!==value.userId || principal[0]?.tenant_id!==value.tenantId || !permitted[0]?.allowed) throw new EntraError('forbidden');
  return {issuer:issuerFor(config.directoryTenantId),subject:value.objectId,email:'',emailVerified:false};
}
async function issue(tx:AuthSql,value:Identity):Promise<EntraTokens> {
  const access=opaque(),refresh=opaque(),expires=Math.min(value.native?900_000:8*3600_000,value.expiry-Date.now());
  await writeRecord(tx,`entra-session:${digest(access)}`,value,null,Date.now()+expires);
  if(value.native) await writeRecord(tx,`entra-refresh:${digest(refresh)}`,{...value,used:false},null,value.expiry);
  return {step:'complete',access_token:value.native?`aihr_${access}`:access,...(value.native?{refresh_token:`aihr_refresh_${refresh}`} : {}),expires_in:Math.floor(expires/1000)};
}
export async function createEntraSession(config:EntraConfig,objectId:string,native:boolean) {
  return authTransaction(`entra-login:${config.tenantId}:${objectId}`,async tx=>{
    const rows=await tx.unsafe('select app_user_id,tenant_id from app.principal_by_identity($1,$2)',[issuerFor(config.directoryTenantId),objectId]);
    if(rows[0]?.tenant_id!==config.tenantId)throw new EntraError('forbidden');
    const value:Identity={tenantId:config.tenantId,revision:config.revision,objectId,userId:rows[0].app_user_id,family:randomUUID(),native,expiry:Date.now()+8*3600_000};
    const locals=await tx.unsafe('select subject from app.entra_local_bindings($1::uuid,$2)',[value.userId,internalIssuer(config.tenantId)]);
    value.localVersions=[];
    for(const local of locals){const c=await readRecord<{version:string}>(tx,`credential:${local.subject}`);value.localVersions.push({subject:local.subject,version:c?.version??null});}
    await allowed(tx,value);
    await writeRecord(tx,`entra-family:${value.family}`,value,null,value.expiry);
    await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,$3::jsonb)",[value.tenantId,value.userId,JSON.stringify({provider:'entra'})]);
    return issue(tx,value);
  });
}
export async function readEntraSession(token:string|undefined,native=false) {
  const raw=native&&token?.startsWith('aihr_')?token.slice(5):native?'':token;
  if(!validOpaque(raw))return null;
  const value=await readRecord<Identity>(client,`entra-session:${digest(raw!)}`);
  if(!value||value.native!==native||!await readRecord(client,`entra-family:${value.family}`))return null;
  try{return await allowed(client,value);}catch(e){if(e instanceof EntraError)return null;throw e;}
}
export async function rotateEntraRefresh(token:string):Promise<EntraTokens|null> {
  const raw=token.startsWith('aihr_refresh_')?token.slice(13):'';
  if(!validOpaque(raw))return null;
  const key=`entra-refresh:${digest(raw)}`,initial=await readRecord<Identity&{used:boolean}>(client,key);
  if(!initial)return null;
  const result=await authTransaction(`entra-family:${initial.family}`,async tx=>{
    const value=await readRecord<Identity&{used:boolean}>(tx,key,true);
    if(!value||!value.native)throw new EntraError('forbidden');
    if(value.used){await deleteRecord(tx,`entra-family:${value.family}`);return null;}
    await allowed(tx,value);
    if(!await readRecord(tx,`entra-family:${value.family}`))throw new EntraError('forbidden');
    await writeRecord(tx,key,{...value,used:true},null,value.expiry);
    return issue(tx,value);
  });
  if(!result)throw new EntraError('forbidden');
  return result;
}
export async function revokeEntraSession(token:string|undefined,native=false,refresh?:string) {
  const raw=native&&token?.startsWith('aihr_')?token.slice(5):native?'':token;
  let value=validOpaque(raw)?await readRecord<Identity>(client,`entra-session:${digest(raw!)}`):null;
  if(!value&&refresh?.startsWith('aihr_refresh_')&&validOpaque(refresh.slice(13)))value=await readRecord<Identity>(client,`entra-refresh:${digest(refresh.slice(13))}`);
  if(value&&value.native===native)await authTransaction(`entra-family:${value.family}`,async tx=>{await deleteRecord(tx,`entra-family:${value!.family}`);await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-out','user',$2::uuid,$3::jsonb)",[value!.tenantId,value!.userId,JSON.stringify({provider:'entra'})]);});
}
