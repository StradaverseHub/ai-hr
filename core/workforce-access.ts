/** Workforce-purpose adapter. Existing record, financial, self-service and approval owners remain independent. */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {lockAccessConfigurationTx,lockAccessConfigurationReadTx} from './access-configuration-lock';
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
  // A borrowed transaction may write later; never introduce a shared-to-exclusive upgrade.
  if(outerTx)await lockAccessConfigurationTx(tx,ctx.tenantId);
  else await lockAccessConfigurationReadTx(tx,ctx.tenantId);
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

/** Page-scope metadata only. This does not widen the shared company switcher or other modules' scope. */
export function workforceViewScope(ctx: SessionContext) {
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const companies=await tx.execute<{id:string}>(sql`select id from company where tenant_id=app.current_tenant_id() and app.access_workforce_projection_company(id) order by id`);
  const [unassigned]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_unassigned('workforce.view') as allowed`);
  return {companyIds:companies.map(row=>row.id),canOpen:companies.length>0||unassigned?.allowed===true};
 });
}
