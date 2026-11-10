/** Shared fresh calling-login prerequisite. This proves no module, subject, data disclosure or
 * effect authority. Canonical owners must still authorize minimal fields and protect dependencies. */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { AiGatewayError } from '../lib/ai/types';
import { accessLockModeHeldTx,lockAccessConfigurationWriteTx,lockAccessConfigurationReadTx } from './access-configuration-lock';
/** False is an actual identity/snapshot refusal. SQL failures propagate and require rollback;
 * accounting may skip a private projection on false without pretending an aborted query succeeded. */
export function isAiPrincipalCurrentTx(tx:Tx,supplied:SessionContext):Promise<boolean>{
 return readAiPrincipalTx(tx,supplied,'read committed');
}
/** False denies a presentation identity; storage errors still propagate as failures. */
export function isAiPresentationPrincipalCurrentTx(tx:Tx,supplied:SessionContext):Promise<boolean>{
 return readAiPrincipalTx(tx,supplied,'repeatable read');
}
async function readAiPrincipalTx(tx:Tx,supplied:SessionContext,isolation:'read committed'|'repeatable read',requireExclusive=false):Promise<boolean>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 if(!ctx.userId||ctx.entitlementsExempt!==undefined||ctx.statutoryOverride!==undefined)return false;
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
 const roles=ctx.roles??Array.from(new Set(grants.map(g=>g.role)));
 if(isolation==='read committed'){
  const [carrier]=await tx.execute<{matches:boolean;read_only:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid
     and app.current_user_id()=${ctx.userId}::uuid and current_setting('transaction_isolation')='read committed' as matches,
     current_setting('transaction_read_only')='on' as read_only`);
  if(carrier?.matches!==true)return false;
  // Only read-only carriers whose callers do not require exclusive Access may share the barrier. A write
  // carrier that already holds the shared lock is an ordinary writer under the reader/writer lock: it never
  // takes the exclusive lock later, so joining shared here cannot strand it waiting to upgrade.
  const shared=!requireExclusive&&(carrier.read_only===true||await accessLockModeHeldTx(tx,ctx.tenantId)==='S');
  await (shared?lockAccessConfigurationReadTx:lockAccessConfigurationWriteTx)(tx,ctx.tenantId);
 }
 const requiredMode=isolation==='read committed'
  ? sql`current_setting('transaction_isolation')='read committed'`
  : sql`current_setting('transaction_isolation')='repeatable read' and current_setting('transaction_read_only')='on'`;
 const [row]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.app_user u
  where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid
   and u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id()
   and u.archived_at is null and not app.login_blocked(u.id)
   and u.person_id is not distinct from ${ctx.personId??null}::uuid
   and ${requiredMode}
   and current_setting('app.roles',true)=${roles.join(',')}
   and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb
   and app.principal_snapshot_current()) as allowed`);
 return row?.allowed===true;
}
export async function assertAiPrincipalTx(tx:Tx,supplied:SessionContext):Promise<void>{
 try{if(await isAiPrincipalCurrentTx(tx,supplied))return;}catch{/* Never continue the caller Tx after a storage failure. */}
 throw new AiGatewayError('Current AI calling authority could not be confirmed.');
}

/** A command must take exclusive Access before reading principal facts, even on a read-only
 * carrier. Otherwise two commands may each hold shared Access while waiting to upgrade. */
export async function assertAiCommandPrincipalTx(tx:Tx,supplied:SessionContext):Promise<void>{
 try{if(await readAiPrincipalTx(tx,supplied,'read committed',true))return;}catch{/* Never continue the caller Tx after a storage failure. */}
 throw new AiGatewayError('Current AI calling authority could not be confirmed.');
}

/** Presentation reads may use one enforced read-only snapshot. This proof must not
 * be used for a provider call or effect, which needs the current Access barrier. */
export async function assertAiPresentationPrincipalTx(tx:Tx,supplied:SessionContext):Promise<void>{
 try{if(await readAiPrincipalTx(tx,supplied,'repeatable read'))return;}catch{/* Refuse an unavailable snapshot. */}
 throw new AiGatewayError('Current AI calling authority could not be confirmed.');
}
