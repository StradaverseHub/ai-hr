/** Purpose-bound configuration authority. Ordinary reference pickers retain their native owner. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
export type ConfigurationOperation='view'|'add'|'edit'|'delete';
export async function organisationAccessTx(tx:Tx,operation:ConfigurationOperation,companyId:string|null){
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.organisation_action_allowed(${operation},${companyId}::uuid) as allowed`);
 return row?.allowed===true;
}
export function organisationAccess(ctx:SessionContext,operation:ConfigurationOperation,companyId:string|null){return withTenant(ctx,tx=>organisationAccessTx(tx,operation,companyId));}
export async function settingsAccessTx(tx:Tx,operation:ConfigurationOperation){
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.settings_action_allowed(${operation}) as allowed`);return row?.allowed===true;
}
export function settingsAccess(ctx:SessionContext,operation:ConfigurationOperation){return withTenant(ctx,tx=>settingsAccessTx(tx,operation));}
export async function organisationViewCompanies(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await tx.execute<{id:string}>(sql`select id from public.company where tenant_id=${ctx.tenantId}::uuid and app.organisation_action_allowed('view',id)`);return rows.map(row=>row.id);
});}
