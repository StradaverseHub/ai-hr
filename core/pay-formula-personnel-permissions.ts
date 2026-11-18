/** Batch equivalent of the granular payroll permission owner for formula catalogues. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {decidePayrollPermission,type PayrollPermissionKey} from '../lib/payroll-permissions';

export async function personnelFormulaPermissionsTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[],keys:readonly PayrollPermissionKey[]){
 const result=new Map(keys.map(key=>[key,new Set<string>()]));
 if(!ctx.userId||!companyIds.length||!keys.length)return result;
 // A Drizzle-interpolated JS array is a tuple; singleton scopes still need a typed PostgreSQL array.
 const scope=sql`ARRAY[${sql.join([...new Set(companyIds)].map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
 const permissionKeys=sql`ARRAY[${sql.join([...new Set(keys)].map(key=>sql`${key}::text`),sql`, `)}]::text[]`;
 const candidates=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
 const roles=await tx.execute<{companyId:string;roles:string[]}>(sql`
  select c.id as "companyId",array_agg(distinct candidate.role order by candidate.role) as roles
  from company c cross join jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb) candidate(role text,"companyId" uuid)
  where c.tenant_id=${ctx.tenantId}::uuid and c.id=any(${scope})
   and exists(select 1 from app_user u where u.id=${ctx.userId}::uuid and u.id=app.current_user_id()
    and u.tenant_id=c.tenant_id and u.tenant_id=app.current_tenant_id() and u.archived_at is null
    and not app.login_blocked(u.id) and app.principal_snapshot_current())
   and (candidate."companyId" is null or candidate."companyId"=c.id or app.is_company_descendant(c.id,candidate."companyId"))
   and app.has_role_for(candidate.role,c.id) group by c.id order by c.id`);
 const grants=await tx.execute<{key:PayrollPermissionKey;role:string;allowed:boolean;companyId:string|null}>(sql`
  select permission_key as key,role,allowed,company_id as "companyId" from payroll_permission_grant
  where tenant_id=${ctx.tenantId}::uuid and permission_key=any(${permissionKeys})
   and (company_id is null or company_id=any(${scope}))`);
 for(const company of roles)for(const key of keys){
  const overrides=grants.filter(row=>row.key===key&&(row.companyId===null||row.companyId===company.companyId))
   .map(row=>({role:row.role,allowed:row.allowed,companyScoped:row.companyId!==null}));
  if(decidePayrollPermission({key,callerRoles:company.roles,overrides}))result.get(key)!.add(company.companyId);
 }
 return result;
}
