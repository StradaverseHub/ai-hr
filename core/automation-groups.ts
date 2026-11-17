/** Narrow shared-group owner. The existing Onboarding group identity remains canonical. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {AutomationError} from './automation-store';
import {pgSqlState} from '../lib/db-error';
export type AutomationAssignmentGroup={id:string;name:string;members:string[];limit:number};
export type AutomationGroupWorkspace={revision:number;v9Revision:number|null;groups:AutomationAssignmentGroup[];people:{id:string;name:string}[]};
const group=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),name:z.string().trim().min(1).max(200),members:z.array(z.uuid()).max(500),limit:z.number().int().min(0).max(1000)}).strict();
const schema=z.object({revision:z.number().int().positive(),v9Revision:z.number().int().positive().nullable(),groups:z.array(group).max(100),reason:z.string().trim().min(1).max(1000)}).strict();
export function automationGroupWorkspace(ctx:SessionContext):Promise<AutomationGroupWorkspace|null>{
 return withScopedLifecycleTenant(ctx,async tx=>(await tx.execute<{data:AutomationGroupWorkspace|null}>(sql`select app.automation_assignment_group_workspace() as data`))[0]?.data??null);
}
export function searchAutomationGroupPeople(ctx:SessionContext,query:string):Promise<{id:string;name:string}[]>{
 return withScopedLifecycleTenant(ctx,async tx=>[...await tx.execute<{id:string;name:string}>(sql`select id,name from app.automation_assignment_group_people(${String(query).slice(0,100)})`)]);
}
export async function saveAutomationAssignmentGroups(ctx:SessionContext,raw:unknown):Promise<AutomationGroupWorkspace>{
 const parsed=schema.safeParse(raw);
 if(!parsed.success)throw new AutomationError('invalid','Check group names, members and task limits.');
 const input=parsed.data;
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{
   await tx.execute(sql`select app.automation_assignment_groups_save(${input.revision},${input.v9Revision},${JSON.stringify(input.groups)}::jsonb,${input.reason})`);
   const [row]=await tx.execute<{data:AutomationGroupWorkspace}>(sql`select app.automation_assignment_group_workspace() as data`);
   return row.data;
  }catch(error){
   const state=pgSqlState(error);
   if(state==='42501')throw new AutomationError('forbidden','You cannot manage shared assignment groups.');
   if(state==='40001')throw new AutomationError('conflict','Groups or lifecycle settings changed. Reload before saving.');
   if(state==='22023')throw new AutomationError('invalid',error instanceof Error?error.message:'Check the assignment groups.');
   throw error;
  }
 });
}
