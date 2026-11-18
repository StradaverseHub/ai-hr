/** Shared Contract readers. One bounded list statement; no Access write lock or per-company requests. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import type {ContractFlow,ContractCasePermission,ContractFlowStage} from '../lib/contract-case-flow';
import type {ContractSource} from './contract-management';
import {ContractManagementError} from '../lib/contract-management-model';

export type ContractSharedSummary={
 id:string;caseNumber:string;companyId:string;employmentId:string;employeeName:string;employeeCode:string|null;
 company:string;businessGroup:string;department:string;startOn:string|null;endOn:string|null;contractNumber:number|null;
 stage:ContractFlowStage|null;legacyState:string;sharedRevision:number|null;flags:ContractFlow['flags'];lastActivityAt:string|null;
 payChanges:boolean;payConfirmed:boolean;
};
export type ContractSharedContext={
 id:string;caseNumber:string;companyId:string;employmentId:string;permissions:ContractCasePermission[];
 source:Omit<ContractSource,'salaryCents'|'allowanceCents'|'allowanceComponentId'>&{contractNumber:number|null;periodRevision:string|null;departmentId:string|null;jobTitle:string|null;businessUnitId:string|null;salaryCents?:string|null;allowanceCents?:string|null;allowanceComponentId?:string|null;nativeIntakeRequired?:boolean};
 sourceCurrent:boolean;flow:ContractFlow|null;legacyState:string;sourceConflict:string|null;cutoverAvailable:boolean;
};
export async function contractSharedPage(ctx:SessionContext,raw:{search?:string;limit?:number;offset?:number}={}){
 const input=z.object({search:z.string().max(100).default(''),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).max(100000).default(0)}).strict().parse(raw);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [result]=await tx.execute<{page:{rows:ContractSharedSummary[]}}>(sql`select app.contract_shared_page(${input.search},${input.limit},${input.offset}) as page`);
  const rows=result?.page.rows??[];
  return {rows:rows.slice(0,input.limit),hasMore:rows.length>input.limit,limit:input.limit,offset:input.offset};
 });
}
/** Runtime boundary: retained fallback routing is private even when native JSON has extra keys. */
export function publicContractFlow(flow:ContractFlow&{fallbacks?:unknown}):ContractFlow{
 const {fallbacks:retainedFallbacks,...visible}=flow;void retainedFallbacks;return visible;
}
export async function contractSharedContextTx(tx:Tx,id:string):Promise<ContractSharedContext>{
 z.uuid().parse(id);
 const [row]=await tx.execute<{context:(Omit<ContractSharedContext,'flow'>&{flow:(ContractFlow&{fallbacks?:unknown})|null})|null}>(sql`select app.contract_shared_context(${id}::uuid) as context`);
 if(!row?.context)throw new ContractManagementError('forbidden','This Contract case is unavailable.');
 if(row.context.flow)return {...row.context,flow:publicContractFlow(row.context.flow)};
 return row.context;
}
export function contractSharedContext(ctx:SessionContext,id:string){return withScopedLifecycleTenant(ctx,tx=>contractSharedContextTx(tx,id));}
export function contractSharedParticipants(ctx:SessionContext,id:string){
 z.uuid().parse(id);
 return withScopedLifecycleTenant(ctx,async tx=>{
  await contractSharedContextTx(tx,id);
  const [row]=await tx.execute<{participants:{id:string;name:string;role:'employee'|'directSuperior'}[]}>(sql`select app.contract_shared_participants(${id}::uuid) as participants`);
  return row.participants;
 });
}
