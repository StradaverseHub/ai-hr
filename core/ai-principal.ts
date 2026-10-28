/** Shared fresh calling-login prerequisite. This proves no module, subject, data disclosure or
 * effect authority. Canonical owners must still authorize minimal fields and protect dependencies. */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { AiGatewayError } from '../lib/ai/types';
import { lockAccessConfigurationTx } from './access-configuration-lock';
/** False is an actual identity/snapshot refusal. SQL failures propagate and require rollback;
 * accounting may skip a private projection on false without pretending an aborted query succeeded. */
export async function isAiPrincipalCurrentTx(tx:Tx,supplied:SessionContext):Promise<boolean>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 if(!ctx.userId||ctx.entitlementsExempt!==undefined||ctx.statutoryOverride!==undefined)return false;
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
 const roles=ctx.roles??Array.from(new Set(grants.map(g=>g.role)));
 const [carrier]=await tx.execute<{matches:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid
    and app.current_user_id()=${ctx.userId}::uuid and current_setting('transaction_isolation')='read committed' as matches`);
 if(carrier?.matches!==true)return false;
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.app_user u
  where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid
   and u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id()
   and u.archived_at is null and not app.login_blocked(u.id)
   and u.person_id is not distinct from ${ctx.personId??null}::uuid
   and current_setting('transaction_isolation')='read committed'
   and current_setting('app.roles',true)=${roles.join(',')}
   and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb
   and app.principal_snapshot_current()) as allowed`);
 return row?.allowed===true;
}
export async function assertAiPrincipalTx(tx:Tx,supplied:SessionContext):Promise<void>{
 try{if(await isAiPrincipalCurrentTx(tx,supplied))return;}catch{/* Never continue the caller Tx after a storage failure. */}
 throw new AiGatewayError('Current AI calling authority could not be confirmed.');
}
