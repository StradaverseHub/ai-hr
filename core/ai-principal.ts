/** Shared fresh calling-login prerequisite. This proves no module, subject, data disclosure or
 * effect authority. Canonical owners must still authorize minimal fields and protect dependencies. */
import { sql, type SQL } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { AiGatewayError } from '../lib/ai/types';
import { accessLockModeHeldTx,inAccessDisplayRead,lockAccessConfigurationWriteTx,lockAccessConfigurationReadTx } from './access-configuration-lock';
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
  const shared=!requireExclusive&&(carrier.read_only===true||inAccessDisplayRead()||await accessLockModeHeldTx(tx,ctx.tenantId)==='S');
  await (shared?lockAccessConfigurationReadTx:lockAccessConfigurationWriteTx)(tx,ctx.tenantId);
 }
 const [row]=await tx.execute<{allowed:boolean}>(principalProofStatement(aiPrincipalProofSql(ctx,ctx.userId,grants,roles,isolation)));
 return row?.allowed===true;
}
const principalProofStatement=(proof:SQL)=>sql`select ${proof} as allowed`;
function aiPrincipalProofSql(ctx:SessionContext,userId:string,grants:readonly {role:string;companyId:string|null}[],roles:readonly string[],isolation:'read committed'|'repeatable read'){
 const requiredMode=isolation==='read committed'
  ? sql`current_setting('transaction_isolation')='read committed'`
  : sql`current_setting('transaction_isolation')='repeatable read' and current_setting('transaction_read_only')='on'`;
 return sql`exists(select 1 from public.app_user u
  where u.id=${userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid
   and u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id()
   and u.archived_at is null and not app.login_blocked(u.id)
   and u.person_id is not distinct from ${ctx.personId??null}::uuid
   and ${requiredMode}
   and current_setting('app.roles',true)=${roles.join(',')}
   and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb
   and app.principal_snapshot_current())`;
}
/** isAiPresentationPrincipalCurrentTx's own proof as an SQL boolean for a bundled read in the same repeatable-read
 * read-only snapshot (core/pre-salary/before-payroll-bundle.ts), or null where that proof answers false without reading. */
export function aiPresentationPrincipalSql(supplied:SessionContext){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 if(!ctx.userId||ctx.entitlementsExempt!==undefined||ctx.statutoryOverride!==undefined)return null;
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
 const roles=ctx.roles??Array.from(new Set(grants.map(g=>g.role)));
 return aiPrincipalProofSql(ctx,ctx.userId,grants,roles,'repeatable read');
}
/** The exact statement isAiPresentationPrincipalCurrentTx sends, or null where it answers false without one (a request
 * preamble answers it ahead in the same snapshot, docs/adr/2026-11-10-home-request-read-scope.md decision 12). */
export function aiPresentationPrincipalStatementSql(supplied:SessionContext){
 const proof=aiPresentationPrincipalSql(supplied);
 return proof?principalProofStatement(proof):null;
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
