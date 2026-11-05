/** Workforce-purpose adapter. Existing record, financial, self-service and approval owners remain independent. */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {lockAccessConfigurationTx,lockAccessConfigurationReadTx} from './access-configuration-lock';
import {withPersonnelRead} from './personnel-read-bounds';
export type WorkforceOperation='view'|'maintain';
export class WorkforceAccessError extends Error{
 constructor(){super('Employee record or permission is unavailable.');this.name='WorkforceAccessError';}
}
/** This predicate is evaluated inside the actual Workforce query, never cached in a session. */
export function workforceEmploymentPredicate(subject:SQL,operation:WorkforceOperation='view',companyIds?:readonly string[]){
 if(companyIds?.length===0)return sql`false`;
 return sql`app.access_workforce_employment(${subject},${'workforce.'+operation})`;
}
async function lockWorkforceOperationTx(tx:Tx,ctx:SessionContext,operation:WorkforceOperation){
 if(operation==='maintain')await tx.execute(sql`select app.access_workforce_write_lock()`);
 else await lockAccessConfigurationTx(tx,ctx.tenantId);
}
export async function assertWorkforceCompanyTx(tx:Tx,ctx:SessionContext,companyId:string,operation:WorkforceOperation){
 await lockWorkforceOperationTx(tx,ctx,operation);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_company(${companyId}::uuid,${'workforce.'+operation}) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
export async function assertWorkforceEmploymentTx(tx:Tx,ctx:SessionContext,employmentId:string,operation:WorkforceOperation){
 await lockWorkforceOperationTx(tx,ctx,operation);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,${'workforce.'+operation}) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
export async function assertWorkforcePersonTx(tx:Tx,ctx:SessionContext,personId:string,operation:WorkforceOperation){
 await lockWorkforceOperationTx(tx,ctx,operation);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_person(${personId}::uuid,${'workforce.'+operation}) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
/** Scope metadata only. Actual reads/writes repeat their check under the same access lock. */
export function workforceCompanies(ctx:SessionContext,operation:WorkforceOperation='view', outerTx?:Tx){
  const run=async (tx:Tx)=>{
  await (outerTx?lockAccessConfigurationTx:lockAccessConfigurationReadTx)(tx,ctx.tenantId);
  const allowed=operation==='view'?sql`app.access_workforce_projection_company(id)`:sql`app.access_workforce_company(id,'workforce.maintain')`;
  const rows=await tx.execute<{id:string}>(sql`select id from company where tenant_id=app.current_tenant_id() and ${allowed} order by id`);
  return rows.map(row=>row.id);
 };
  return outerTx?run(outerTx):withTenant(ctx,run);
}

export function workforceEmploymentAccess(ctx:SessionContext,employmentId:string,operation:WorkforceOperation){
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,${'workforce.'+operation}) as allowed`);
  return row?.allowed===true;
 });
}

/** Availability of the implemented fixed-command lane; never a raw-row or legacy-role grant. */
export function workforceCommandAccess(ctx:SessionContext,employmentId:string){
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_command_allowed(${employmentId}::uuid) as allowed`);
  return row?.allowed===true;
 });
}

/** The shared navigation only needs to know whether any Workforce scope is visible. */
export function canOpenWorkforce(ctx:SessionContext){
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  // Dormant company access requires a claimed administrative grant. Preserve its
  // full predicate for those callers; everyone else can use the current-principal
  // capability owner after one snapshot proof, over the same RLS-visible companies.
  const [row]=await tx.execute<{allowed:boolean}>(sql`select (
   case when exists(select 1 from app.current_grants() where role in ('hr_admin','super_admin')) then
    exists(select 1 from company where tenant_id=app.current_tenant_id() and app.access_workforce_projection_company(id))
   when app.principal_snapshot_current() then
    exists(select 1 from company where tenant_id=app.current_tenant_id() and app.access_capability_allowed('workforce.view',id))
   else false end
   or app.access_workforce_unassigned('workforce.view')
  ) as allowed`);
  return row?.allowed===true;
 });
}

/** Page-scope metadata only. This does not widen the shared company switcher or other modules' scope. */
export function workforceViewScope(ctx: SessionContext, options?: { personnelList: true }) {
 const read=async (tx: Tx)=>{
  const [scope] = await tx.execute<{company_ids: string[]; unassigned: boolean}>(sql`
    select coalesce(jsonb_agg(id order by id), '[]'::jsonb) as company_ids,
      app.access_workforce_unassigned('workforce.view') as unassigned
    from company
    where tenant_id = app.current_tenant_id() and app.access_workforce_projection_company(id)
  `);
  const companyIds = scope?.company_ids ?? [];
  return {companyIds, canOpen: companyIds.length > 0 || scope?.unassigned === true};
 };
 return options?.personnelList ? withPersonnelRead(ctx, read, { sharedAccessLock: true }) : withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  return read(tx);
 });
}
