/** Internal login namespace initialization on the SAME owner transaction as customer provisioning. */
import {sql} from 'drizzle-orm';
import type {Tx} from './client';
import {appendEvent} from './events';
import {decryptRecord,encryptRecord} from '../lib/internal-auth/crypto';
import type {Organization} from '../lib/internal-auth/service';

function organizationCodes(name:string,tenantId:string):string[] {
  let base=name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48).replace(/-$/,'') || 'customer';
  if(base.length<2)base+='-customer';
  if(base==='operator')base='operator-customer';
  const id=tenantId.replaceAll('-','');
  return [base,...[8,16,32].map(length=>`${base.slice(0,62-length).replace(/-$/,'')}-${id.slice(0,length)}`)];
}

/** No credentials, identities or grants are created here; MFA activation remains the only grant path. */
export async function initializeProvisionedLoginOrganization(tx:Tx,tenantId:string,name:string):Promise<Organization> {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenantId))throw new Error('Invalid customer namespace identity.');
  const [privileged]=await tx.execute<{allowed:boolean}>(sql`select pg_has_role(current_user,pg_get_userbyid(c.relowner),'MEMBER') allowed from pg_class c where c.oid='app_internal_auth_record'::regclass`);
  if(!privileged?.allowed)throw new Error('The migration/schema owner connection is required for login organization initialization.');
  const read=async(key:string,lock=false):Promise<Organization|null>=>{
    const [row]=await tx.execute<{sealed:string}>(sql`select sealed from app.internal_auth_read(${key},${lock})`);
    return row?decryptRecord<Organization>(row.sealed,key):null;
  };
  const write=async(key:string,value:Organization)=>{
    await tx.execute(sql`select app.internal_auth_write(${key},null,${encryptRecord(value,key,null)},null)`);
  };
  const lock=async(key:string)=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('internal-auth:'||${key},0))`);
  };
  const tenantKey=`tenant:${tenantId}`,existing=await read(tenantKey);
  if(existing&&(existing.tenantId!==tenantId||typeof existing.code!=='string'||!/^[a-z0-9][a-z0-9-]{1,63}$/.test(existing.code)))throw new Error('Existing customer login organization is inconsistent.');
  for(const code of existing?[existing.code]:organizationCodes(name,tenantId)){
    const orgKey=`org:${code}`;
    // Same lock order as bootstrapInternalOwner: organization before tenant. An absent row cannot
    // be row-locked, so the advisory locks also serialize colliding normalized customer names.
    await lock(orgKey);
    const byCode=await read(orgKey,true);
    if(byCode&&byCode.tenantId!==tenantId){
      if(existing)throw new Error('Existing customer login organization belongs to another tenant.');
      continue;
    }
    if(byCode&&byCode.code!==code)throw new Error('Existing login organization reverse mapping is inconsistent.');
    await lock(tenantKey);
    const byTenant=await read(tenantKey,true);
    if(byTenant&&(byTenant.tenantId!==tenantId||byTenant.code!==code))throw new Error('Customer login organization was already assigned.');
    const organization=byTenant??byCode??{code,tenantId,name};
    if(!byCode)await write(orgKey,organization);
    if(!byTenant)await write(tenantKey,organization);
    if(!byCode||!byTenant)await appendEvent(tx,{tenantId,aggregateType:'tenant',aggregateId:tenantId,
      eventType:'tenant.internal-login-organization-initialized',actor:{type:'system'},payload:{code,via:'provision'}});
    return organization;
  }
  throw new Error('No available customer login organization code.');
}
