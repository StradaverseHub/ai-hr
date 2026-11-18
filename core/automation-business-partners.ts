/** Native shared business-responsibility owner. Builder access never supplies this permission. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {businessPartnerDimensionSchema,businessPartnerPersonSchema,businessPartnerWorkspaceSchema,saveBusinessPartnersSchema,type BusinessPartnerDimension,type BusinessPartnerPerson,type BusinessPartnerWorkspace} from '../lib/automation/business-partners';
import {withLifecycleTenant,withScopedLifecycleTenant} from './module-gate';
import {AutomationError} from './automation-store';

async function canManage(tx:Tx){
 const[row]=await tx.execute<{allowed:boolean}>(sql`select app.automation_business_partner_can_manage() as allowed`);
 return row?.allowed===true;
}
function workspace(value:unknown):BusinessPartnerWorkspace{
 const parsed=businessPartnerWorkspaceSchema.safeParse(value);
 if(!parsed.success)throw new AutomationError('invalid','Business Partner responsibilities are unavailable.');
 return parsed.data;
}
async function guarded<T>(run:()=>Promise<T>):Promise<T>{
 try{return await run();}catch(error){
  const state=pgSqlState(error);
  if(state==='42501')throw new AutomationError('forbidden','You cannot manage Business Partner responsibilities.');
  if(state==='40001')throw new AutomationError('conflict','Business Partner responsibilities changed. Reload before saving.');
  if(state==='22023'||state==='23514')throw new AutomationError('invalid','Check the people, scopes and reason for this change.');
  throw error;
 }
}
/** Scoped module readers may open shared groups; only the original tenant-wide owner sees this panel. */
export function automationBusinessPartnerWorkspace(ctx:SessionContext):Promise<BusinessPartnerWorkspace|null>{
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{
   if(!await canManage(tx))return null;
   const[row]=await tx.execute<{data:unknown}>(sql`select app.automation_business_partner_workspace() as data`);
   return row?.data==null?null:workspace(row.data);
  }catch(error){if(pgSqlState(error)==='42501')return null;throw error;}
 });
}
export async function saveAutomationBusinessPartners(ctx:SessionContext,raw:unknown):Promise<BusinessPartnerWorkspace>{
 const parsed=saveBusinessPartnersSchema.safeParse(raw);
 if(!parsed.success)throw new AutomationError('invalid','Check the Business Partner rules and provide a reason of 20–5,000 characters.');
 const input=parsed.data;
 return guarded(()=>withLifecycleTenant(ctx,async tx=>{
  const[row]=await tx.execute<{data:unknown}>(sql`select app.automation_business_partner_save(${input.expectedRevision},${JSON.stringify(input.rules)}::text::jsonb,${input.reason}) as data`);
  return workspace(row?.data);
 }));
}
/** One native bounded search of current verified people, under the identical tenant-wide permission. */
export async function searchAutomationBusinessPartnerPeople(ctx:SessionContext,search:string):Promise<BusinessPartnerPerson[]>{
 const query=z.string().trim().max(100).safeParse(search);
 if(!query.success)throw new AutomationError('invalid','Search using up to 100 characters.');
 return guarded(()=>withScopedLifecycleTenant(ctx,async tx=>{
  if(!await canManage(tx))throw new AutomationError('forbidden','You cannot manage Business Partner responsibilities.');
  const[row]=await tx.execute<{data:unknown}>(sql`select app.automation_business_partner_people(${query.data}) as data`);
  const people=z.array(businessPartnerPersonSchema).max(20).safeParse(row?.data);
  if(!people.success)throw new AutomationError('invalid','Business Partner people are unavailable.');
  return people.data;
 }));
}
/** Actual Business units, companies and departments; these are not the named-routing parent-company choices. */
export async function searchAutomationBusinessPartnerScopeOptions(ctx:SessionContext,dimension:BusinessPartnerDimension,search:string):Promise<BusinessPartnerPerson[]>{
 const input=z.object({dimension:businessPartnerDimensionSchema,search:z.string().trim().max(100)}).strict().safeParse({dimension,search});
 if(!input.success)throw new AutomationError('invalid','Choose a Business Partner scope and search using up to 100 characters.');
 return guarded(()=>withScopedLifecycleTenant(ctx,async tx=>{
  if(!await canManage(tx))throw new AutomationError('forbidden','You cannot manage Business Partner responsibilities.');
  const[row]=await tx.execute<{data:unknown}>(sql`select app.automation_business_partner_scope_options(${input.data.dimension},${input.data.search}) as data`);
  const options=z.array(businessPartnerPersonSchema).max(20).safeParse(row?.data);
  if(!options.success)throw new AutomationError('invalid','Business Partner scopes are unavailable.');
  return options.data;
 }));
}
