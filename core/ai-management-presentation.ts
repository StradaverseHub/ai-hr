/** Closed administrator presentation admission and active-provider metadata only.
 * No issued snapshot, command/effect authority, candidate form, Stop gate or provider call. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {AiGatewayError,type AiProvider} from '../lib/ai/types';
import {isAdmin,isGroupAdmin} from '../lib/authz-model';
import {envFallbackConfig} from '../lib/ai/registry';
import {assertAiPresentationPrincipalTx} from './ai-principal';
import {decodeStoredActiveAiProviderRow} from './ai-provider-row';

type ProviderMetadata=Readonly<{provider:AiProvider;model:string}>;
/** The actual native RR/RO/principal proof must precede every data fact in the common page Tx. */
export async function readAiManagementPresentationTx(tx:Tx,supplied:SessionContext):Promise<ProviderMetadata|null>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!isAdmin(ctx))throw new AiGatewayError('AI management presentation unavailable.');
 await assertAiPresentationPrincipalTx(tx,ctx);
 const[admin]=await tx.execute<{allowed:boolean;group_allowed:boolean}>(sql`select app.is_admin() as allowed,app.is_group_admin() as group_allowed`);
 if(admin?.allowed!==true||(isGroupAdmin(ctx)&&admin.group_allowed!==true))throw new AiGatewayError('AI management presentation unavailable.');
 // SQL/native failures propagate and abort the snapshot. Only CPU-invalid stored data is unavailable.
 const rows=await tx.execute<{provider:string;model:string;api_key_ciphertext:string;provider_options:unknown}>(sql`select provider,model,api_key_ciphertext,provider_options from app.ai_active_provider_config_v2()`);
 if(rows.length>1)throw new AiGatewayError('AI configuration authority unavailable.');
 const row=rows[0];
 if(row){
  try{const decoded=decodeStoredActiveAiProviderRow(row,ctx.tenantId);return Object.freeze({provider:decoded.provider,model:decoded.model});}
  catch{return null;}
 }
 const fallback=envFallbackConfig();return fallback?Object.freeze({provider:fallback.provider,model:fallback.model}):null;
}
