/** Purpose-bound configuration authority. Ordinary reference pickers retain their native owner. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
export type ConfigurationOperation='view'|'add'|'edit'|'delete';
export async function organisationAccessTx(tx:Tx,operation:ConfigurationOperation,companyId:string|null,functionKey='organization'){
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.organisation_settings_function_allowed(${functionKey},${operation},${companyId}::uuid) as allowed`);
 return row?.allowed===true;
}
export function organisationAccess(ctx:SessionContext,operation:ConfigurationOperation,companyId:string|null,functionKey='organization'){return withTenant(ctx,tx=>organisationAccessTx(tx,operation,companyId,functionKey));}
export async function settingsAccessTx(tx:Tx,operation:ConfigurationOperation,functionKey?:string){
 const [row]=await tx.execute<{allowed:boolean}>(functionKey?sql`select app.organisation_settings_function_allowed(${functionKey},${operation},NULL) as allowed`:sql`select app.settings_action_allowed(${operation}) as allowed`);return row?.allowed===true;
}
export function settingsAccess(ctx:SessionContext,operation:ConfigurationOperation,functionKey?:string){return withTenant(ctx,tx=>settingsAccessTx(tx,operation,functionKey));}
export async function organisationViewCompanies(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await tx.execute<{id:string}>(sql`select id from public.company where tenant_id=${ctx.tenantId}::uuid and app.organisation_settings_function_allowed('organization','view',id)`);return rows.map(row=>row.id);
});}

export type SettingsActionAccess={view:boolean;add:boolean;edit:boolean;delete:boolean};
/** One server projection of the canonical owner; no client-supplied permission flags authorize a write. */
export function settingsActionAccess(ctx:SessionContext,functionKey:string):Promise<SettingsActionAccess>{
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<SettingsActionAccess>(sql`select
   app.organisation_settings_function_allowed(${functionKey},'view',NULL) as view,
   app.organisation_settings_function_allowed(${functionKey},'add',NULL) as add,
   app.organisation_settings_function_allowed(${functionKey},'edit',NULL) as edit,
   app.organisation_settings_function_allowed(${functionKey},'delete',NULL) as delete`);
  return row??{view:false,add:false,edit:false,delete:false};
 });
}
