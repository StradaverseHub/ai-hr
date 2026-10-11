import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { keycloakConfig, keycloakSelected } from '../lib/identity/config';
import { canonicalUuid, ManualIdentityError, manualIdentityError, validateTemporaryPassword, type ManualIdentityEnrollment } from '../lib/identity/manual-model';
import { manualAccountProvider, type ManualAccountProvider } from '../lib/identity/manual-provider';
import { ROLES } from './auth';

async function authorized(ctx:SessionContext) {
  if(!keycloakSelected()||!ctx.userId)throw new ManualIdentityError('forbidden');
  const issuer=keycloakConfig().issuer;
  const allowed=await withTenant(ctx,async tx=>{
    const rows=await tx.execute(sql`select app.manual_identity_authorized(${issuer}) allowed`) as unknown as {allowed:boolean}[];
    return rows[0]?.allowed===true;
  });
  if(!allowed)throw new ManualIdentityError('forbidden');
  return issuer;
}
async function read(tx:Tx,id:string) {
  if(!canonicalUuid.test(id))throw new ManualIdentityError('invalid');
  const rows=await tx.execute(sql`select * from app.manual_identity_read(${id}::uuid,true)`) as unknown as ManualIdentityEnrollment[];
  if(!rows[0])throw new ManualIdentityError('forbidden');
  return rows[0];
}
export async function listManualIdentityEnrollments(ctx:SessionContext) {
  try {
    const issuer=await authorized(ctx);
    return await withTenant(ctx,async tx=>await tx.execute(sql`select * from app.manual_identity_list(${issuer})`) as unknown as ManualIdentityEnrollment[]);
  } catch(e) {throw manualIdentityError(e);}
}
export type CreateManualAccountInput={id:string;personId:string;username:string;email:string;role:string;companyId:string|null;password:string;ownershipAttested:boolean};

export async function createManualAccount(ctx:SessionContext,input:CreateManualAccountInput,provider?:ManualAccountProvider) {
  try {
    const issuer=await authorized(ctx);
    const username=input.username.trim().toLowerCase(),email=input.email.trim().toLowerCase();
    if(!input.ownershipAttested||!canonicalUuid.test(input.id)||!canonicalUuid.test(input.personId)||
      (input.companyId!==null&&!canonicalUuid.test(input.companyId))||!ROLES.has(input.role)||
      !/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(username)||username.startsWith('service-account-')||
      email.length>255||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)|| (input.role==='super_admin'&&input.companyId!==null))throw new ManualIdentityError('invalid');
    validateTemporaryPassword(input.password,username,email);
    // Intent and attestation commit before any provider mutation. No credential is a SQL parameter.
    await withTenant(ctx,tx=>tx.execute(sql`select * from app.manual_identity_reserve(${input.id}::uuid,${issuer},${input.personId}::uuid,${username},${email},${input.role},${input.companyId}::uuid)`));
    return await resumeManualAccount(ctx,input.id,input.password,provider);
  } catch(e) {throw manualIdentityError(e);}
}
export async function resumeManualAccount(ctx:SessionContext,id:string,password:string,provider?:ManualAccountProvider) {
  try {
    const issuer=await authorized(ctx); const identity=provider??manualAccountProvider();
    // Hold the enrollment row lock across each bounded provider stage; independent workers cannot
    // create two identities or change a password while another request enables the same account.
    await withTenant(ctx,async tx=>{
      const e=await read(tx,id); if(e.issuer!==issuer)throw new ManualIdentityError('forbidden');
      if(e.status==='cancelled')throw new ManualIdentityError('conflict');
      if(e.status!=='reserved')return;
      validateTemporaryPassword(password,e.username,e.email);
      const subject=await identity.create(e); // disabled, no password; persist the returned exact ID first
      await tx.execute(sql`select app.manual_identity_prepare(${id}::uuid,${subject})`);
    });
    await withTenant(ctx,async tx=>{
      const e=await read(tx,id); if(e.status!=='prepared')return;
      validateTemporaryPassword(password,e.username,e.email);
      await identity.setPassword(e,password);
      await tx.execute(sql`select app.manual_identity_link(${id}::uuid,${e.subject})`);
    });
    return await withTenant(ctx,async tx=>{
      const e=await read(tx,id);
      if(e.status==='active')return e.app_user_id!;
      if(e.status!=='linked')throw new ManualIdentityError('conflict');
      // The exact subject/person/grants binding committed in the preceding transaction.
      await identity.enable(e);
      await tx.execute(sql`select app.manual_identity_finish(${id}::uuid,false)`);
      return e.app_user_id!;
    });
  } catch(e) {throw manualIdentityError(e);}
}
export async function cancelManualAccount(ctx:SessionContext,id:string,provider?:ManualAccountProvider) {
  try {
    await authorized(ctx); const identity=provider??manualAccountProvider();
    await withTenant(ctx,async tx=>{
      const e=await read(tx,id);
      if(e.status==='cancelled')return;
      if(!['reserved','prepared'].includes(e.status))throw new ManualIdentityError('conflict');
      await identity.cancel(e);
      await tx.execute(sql`select app.manual_identity_finish(${id}::uuid,true)`);
    });
  } catch(e) {throw manualIdentityError(e);}
}
