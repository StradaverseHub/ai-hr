/** Refresh outside workflow transactions; never hold an Auth lock while opening a tenant transaction. */
import {sql} from 'drizzle-orm';
import {client,withTenant,type SessionContext} from '../../db/client';
import {authTransaction} from './store';
import {internalConfig,internalIssuer} from './config';
import {AuthRecordExpiredError,decryptRecord,digest} from './crypto';
import {parseCredential,assertActiveCredential} from './credential';
import {InternalAuthError} from './errors';
import {signOrganisationAdmission} from './organisation-admission-proof';
type Binding={tenantId:string;userId:string;personId:string|null;issuer:string;subject:string;bindingCreatedAt:string};
async function refresh(ctx:SessionContext,userId:string,runId:string|null){
 const bindings=await withTenant(ctx,tx=>tx.execute<{binding:Binding}>(sql`select binding from app.organisation_admission_identity(${userId}::uuid,${runId}::uuid)`));
 for(const {binding:b} of bindings){
  if(b.tenantId!==ctx.tenantId||b.userId!==userId||b.issuer!==internalIssuer(ctx.tenantId))continue;
  const proof=await authTransaction(b.subject,async tx=>{
   const [row]=await tx.unsafe('select sealed from app.internal_auth_read($1,true)',['credential:'+b.subject]);
   if(!row)return null;
   let available=false,activeUntil:string|null=null;
   try {
    const credential=parseCredential(decryptRecord<unknown>(row.sealed,'credential:'+b.subject));
    if(credential&&credential.subject===b.subject&&credential.tenantId===b.tenantId&&credential.issuer===b.issuer){
     activeUntil=credential.accountActiveUntil??null;
     const principal=await assertActiveCredential(tx,credential);
     available=principal.app_user_id===b.userId&&principal.tenant_id===b.tenantId;
    }
   }catch(error){if(!(error instanceof InternalAuthError&&error.code==='invalidLogin')&&!(error instanceof AuthRecordExpiredError))throw error;}
   const issuedAt=Date.now();return signOrganisationAdmission({...b,credentialDigest:digest(row.sealed),available,activeUntil,issuedAt,expiresAt:issuedAt+60_000},internalConfig().key);
  });
  if(proof)await client.unsafe('select app.organisation_admission_submit($1,$2)',[proof.payload,proof.signature]);
 }
}
export async function refreshOrganisationAdmission(ctx:SessionContext,runId?:string){
 if(!ctx.userId)throw Error('Organisation account is unavailable.');
 await refresh(ctx,ctx.userId,null);
 if(!runId)return;
 const actors=await withTenant(ctx,tx=>tx.execute<{actor:string}>(sql`select actor from app.organisation_admission_run_actors(${runId}::uuid)`));
 for(const {actor} of actors)if(actor!==ctx.userId)await refresh(ctx,actor,runId);
}
