/** Fresh administrative operation admission. Existing self/approval courses keep their own owners. */
import {sql} from 'drizzle-orm';
import {withTenant,type Tx,type SessionContext} from '../db/client';
export type ModuleAction='view'|'add'|'edit'|'delete';
export type AdministrativeActionDomain='claims'|'leave'|'attendance'|'claims_configuration'|'leave_configuration'|'attendance_configuration';
export class ModuleActionError extends Error{constructor(){super('Module action is unavailable.');this.name='ModuleActionError';}}
export async function assertModuleActionTx(tx:Tx,domain:AdministrativeActionDomain,operation:ModuleAction,companyId:string|null=null){
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 const [result]=await tx.execute<{allowed:boolean}>(sql`select app.module_action_allowed(${domain},${operation},${companyId}::uuid) as allowed`);
 if(!result?.allowed)throw new ModuleActionError();
}

/** Explicit maintenance purpose; metadata/employee calculation readers keep their independent owner. */
export async function assertModuleFunctionTx(tx:Tx,key:string,operation:ModuleAction,companyId:string|null=null){
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 const [result]=await tx.execute<{allowed:boolean}>(sql`select app.module_function_allowed(${key},${operation},${companyId}::uuid) as allowed`);
 if(!result?.allowed)throw new ModuleActionError();
}
export function assertModuleFunction(ctx:SessionContext,key:string,operation:ModuleAction,companyId:string|null=null){
 return withTenant(ctx,tx=>assertModuleFunctionTx(tx,key,operation,companyId));
}

/** Read-only purpose flags; no configuration lock or mutation admission. */
export function moduleFunctionAccess(ctx:SessionContext,key:string,operation:ModuleAction,companyId:string|null=null):Promise<boolean>{
 return withTenant(ctx,async tx=>{
  const [result]=await tx.execute<{allowed:boolean}>(sql`select app.module_function_allowed(${key},${operation},${companyId}::uuid) as allowed`);
  return result?.allowed===true;
 });
}
