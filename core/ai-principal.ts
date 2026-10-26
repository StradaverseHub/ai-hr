/** Shared fresh calling-login prerequisite. This proves no module, subject, data disclosure or
 * effect authority. Canonical owners must still authorize minimal fields and protect dependencies. */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { AiGatewayError } from '../lib/ai/types';
import { lockAccessConfigurationTx } from './access-configuration-lock';
export async function assertAiPrincipalTx(tx:Tx,supplied:SessionContext):Promise<void>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 if(!ctx.userId||ctx.entitlementsExempt!==undefined||ctx.statutoryOverride!==undefined)throw new AiGatewayError('Current AI calling authority could not be confirmed.');
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
 const roles=ctx.roles??Array.from(new Set(grants.map(g=>g.role)));
 try{
  const [carrier]=await tx.execute<{matches:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid
    and app.current_user_id()=${ctx.userId}::uuid and current_setting('transaction_isolation')='read committed' as matches`);
  if(carrier?.matches!==true)throw Error();
 }catch{throw new AiGatewayError('Current AI calling authority could not be confirmed.');}
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 let row:{allowed:boolean}|undefined;
 try{[row]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.app_user u
  where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid
   and u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id()
   and u.archived_at is null and not app.login_blocked(u.id)
   and u.person_id is not distinct from ${ctx.personId??null}::uuid
   and current_setting('transaction_isolation')='read committed'
   and current_setting('app.roles',true)=${roles.join(',')}
   and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb
   and app.principal_snapshot_current()) as allowed`);}
 catch{throw new AiGatewayError('Current AI calling authority could not be confirmed.');}
 if(row?.allowed!==true)throw new AiGatewayError('Current AI calling authority could not be confirmed.');
}
