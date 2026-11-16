/** Contract's existing decision and signing owners supply metadata to Home, Today, the bell and My Tasks. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import type {PackTaskItem} from '../lib/assigned-work';
export function pendingContractSharedTasks(ctx:SessionContext,scopeIds:string[]|undefined):Promise<PackTaskItem[]>{
 if(scopeIds)z.array(z.uuid()).max(500).parse(scopeIds);
 return withScopedLifecycleTenant(ctx,async tx=>{const [row]=await tx.execute<{tasks:PackTaskItem[]}>(sql`select app.contract_shared_task_metadata(${scopeIds?`{${scopeIds.join(',')}}`:null}::uuid[]) as tasks`);return row.tasks.map(task=>({...task,createdAt:new Date(task.createdAt).toISOString()}));});
}
