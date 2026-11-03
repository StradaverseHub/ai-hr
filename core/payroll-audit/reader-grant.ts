/** AI v2 Phase 2 hardening (4 November 2026) — whether a login holds a current read-only auditor grant, and for which
 * companies (migration 2006, payroll_audit_reader: the auditor reads their own grants under their own policy). A leaf
 * with no service imports, so the page guard (lib/authz.ts requireAdminOrAuditReader) stays light. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';

/** The companies the caller holds a current auditor grant for, by name where the caller may read it. */
export async function auditReaderCompaniesTx(tx:Tx,ctx:SessionContext):Promise<{id:string;name:string}[]>{
 if(!ctx.userId||ctx.agent)return [];
 const rows=Array.from(await tx.execute(sql`select distinct r.company_id,c.legal_name from public.payroll_audit_reader r left join public.company c on c.id=r.company_id
  where r.tenant_id=${ctx.tenantId}::uuid and r.app_user_id=${ctx.userId}::uuid and r.revoked_at is null order by c.legal_name nulls last,r.company_id`) as unknown as
  {company_id:string;legal_name:string|null}[]);
 return rows.map(row=>({id:String(row.company_id),name:row.legal_name==null?String(row.company_id):String(row.legal_name)}));
}

/** Whether the signed-in login holds any current auditor grant. A failed read is no grant. */
export async function hasAuditReaderGrant(ctx:SessionContext|null|undefined):Promise<boolean>{
 if(!ctx?.userId||ctx.agent||!ctx.tenantId)return false;
 return withTenant(ctx,async tx=>(await auditReaderCompaniesTx(tx,ctx)).length>0).catch(()=>false);
}
