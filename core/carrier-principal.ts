import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
/** Ordinary USER-carrier proof shared by native kernel owners (payroll period, statutory source); moved
 * unchanged from the payroll period owner so both use ONE rule. True only when: this transaction's login
 * is the context's user in its tenant, unarchived and not login-blocked; a SUPPLIED personId is that
 * login's person (an absent personId asserts nothing and is not required); the transaction carries
 * exactly this context's roles and grants; and every claimed role and grant is actually held now
 * (app.principal_snapshot_current, 0576), so a stale or forged role string is refused. A null-user carrier
 * is false here; each caller states its own SYSTEM semantics. Statutory/bootstrap markers grant nothing.
 * AI source owners keep the stricter isAiPrincipalCurrentTx. Join the tenant Access owner first. */
export async function isCarrierPrincipalCurrentTx(tx:Tx,ctx:SessionContext):Promise<boolean>{
 if(!ctx.userId)return false;
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})),roles=ctx.roles??[...new Set(grants.map(g=>g.role))];
 const [row]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.app_user u
  where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.id=app.current_user_id()
   and u.tenant_id=app.current_tenant_id() and u.archived_at is null and not app.login_blocked(u.id)
   and (${ctx.personId??null}::uuid is null or u.person_id=${ctx.personId??null}::uuid)
   and current_setting('transaction_isolation')='read committed' and app.principal_snapshot_current()
   and current_setting('app.roles',true)=${roles.join(',')} and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb) as allowed`);
 return row?.allowed===true;
}
