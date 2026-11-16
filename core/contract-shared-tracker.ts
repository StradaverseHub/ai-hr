/** The tracker starts from Personnel employments, including periods without a case. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import type {ContractFlowFlag,ContractFlowStage} from '../lib/contract-case-flow';
import {ContractManagementError} from '../lib/contract-management-model';
import {pgSqlState} from '../lib/db-error';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';

export type ContractTrackerRow={
 id:string;employmentId:string;caseId:string|null;caseNumber:string|null;companyId:string;
 employeeName:string;employeeCode:string|null;company:string;businessGroup:string;department:string;position:string;manager:string;
 startOn:string|null;endOn:string|null;contractNumber:number|null;sourceRevision:string|null;
 stage:ContractFlowStage|null;legacyState:string|null;sharedRevision:number|null;flags:ContractFlowFlag[];lastActivityAt:string|null;
 payChanges:boolean;payConfirmed:boolean;previousPayPending:boolean;payPendingCaseId:string|null;canOpen:boolean;sourceIssue:'verify_period'|'legacy_in_progress'|'period_changed'|null;
};
export type ContractTrackerQuery={search?:string;companyId?:string|null;status?:'all'|'attention'|'decision'|'progress'|'closed';limit?:number;offset?:number};
export async function contractSharedTracker(ctx:SessionContext,raw:ContractTrackerQuery={}){
 const input=z.object({search:z.string().max(100).default(''),companyId:z.uuid().nullable().default(null),status:z.enum(['all','attention','decision','progress','closed']).default('all'),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).max(100000).default(0)}).strict().parse(raw);
 return withScopedLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [result]=await tx.execute<{page:{rows:ContractTrackerRow[];total:number}}>(sql`select app.contract_shared_tracker(${input.search},${input.companyId}::uuid,${input.status},${input.limit},${input.offset}) as page`);
  const [choices]=await tx.execute<{value:{companies:{id:string;name:string}[];businessGroups:{id:string;name:string}[]}}>(sql`select app.contract_shared_tracker_choices() as value`);
  const page=result?.page??{rows:[],total:0};
  return {...page,...(choices?.value??{companies:[],businessGroups:[]}),hasMore:input.offset+page.rows.length<page.total,limit:input.limit,offset:input.offset};
 });
}
export async function openContractSharedPeriod(ctx:SessionContext,raw:{employmentId:string;sourceRevision:string}){
 const input=z.object({employmentId:z.uuid(),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{result:{caseId:string;legacy:boolean;eventId?:string;jobId?:string}}>(sql`select app.contract_shared_period_open(${input.employmentId}::uuid,${input.sourceRevision}) as result`);
  return row.result;
 });}catch(error){
  const state=pgSqlState(error);
  if(state==='42501')throw new ContractManagementError('forbidden','You cannot start a case for this employment.');
  if(state==='40001')throw new ContractManagementError('conflict','The Personnel contract period changed. Reload the tracker.');
  if(state==='22023')throw new ContractManagementError('invalid','Verify the contract number and dates in Personnel Management before opening a case.');
  throw error;
 }
}
