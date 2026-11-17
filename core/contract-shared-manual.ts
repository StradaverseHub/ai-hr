/** Case operators select an actual live manual workflow; the existing sealed kernel runs its pinned steps. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {pgSqlState} from '../lib/db-error';
import {ContractManagementError} from '../lib/contract-management-model';
export type ContractSharedManualWorkflow={id:string;revision:number;name:string;description:string};
function failure(error:unknown):never{
 const code=pgSqlState(error);
 if(code==='42501')throw new ContractManagementError('forbidden','You cannot start workflows for this Contract case.');
 if(code==='40001')throw new ContractManagementError('conflict','The case or workflow changed. Reload before starting.');
 if(code==='22023')throw new ContractManagementError('invalid','Choose a current live workflow that is started by hand.');
 throw error;
}
export async function contractSharedManualWorkflows(ctx:SessionContext,caseId:string):Promise<ContractSharedManualWorkflow[]>{
 z.uuid().parse(caseId);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  const [row]=await tx.execute<{workflows:ContractSharedManualWorkflow[]}>(sql`select app.contract_shared_manual_workflows(${caseId}::uuid) as workflows`);return row.workflows;
 });}catch(error){return failure(error);}
}
export async function startContractSharedManualWorkflow(ctx:SessionContext,raw:{caseId:string;revision:number;workflowId:string;workflowRevision:number;requestId:string}):Promise<{eventId:string;jobId:string}>{
 const input=z.object({caseId:z.uuid(),revision:z.number().int().positive(),workflowId:z.uuid(),workflowRevision:z.number().int().positive(),requestId:z.uuid()}).strict().parse(raw);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{result:{eventId:string;jobId:string}}>(sql`select app.contract_shared_manual_start(${input.caseId}::uuid,${input.revision},${input.workflowId}::uuid,${input.workflowRevision},${input.requestId}::uuid) as result`);return row.result;
 });}catch(error){return failure(error);}
}
