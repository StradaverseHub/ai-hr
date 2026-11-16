/** Shaped case workspace; all slices share one authorized native read. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {contractSharedContextTx} from './contract-shared-read';
import {terminationReasonCatalogueTx} from './termination-reason-catalog';
export type ContractCaseWorkspace={
 approvals:{id:string;decisionRevision:number;createdAt:string;status:'pending'|'approved'|'rejected'|'cancelled';workflowName:string;stepId:string}[];
 letters:{id:string;decisionRevision:number;name:string;state:'routing'|'released'|'withdrawn';generatedOn:string;releasedAt:string|null;templateVersion:number;valuesFixed:boolean;returned:boolean}[];
 runs:{id:string;name:string;revision:number;trigger:string;status:'running'|'waiting'|'done'|'skipped'|'failed';cursor:number;waitingFor:string|null;startedAt:string;updatedAt:string;steps:{id:string;type:string;name:string}[];log:{at:string;kind:string;stepId:string|null;type:string|null}[]}[];
};
export function contractSharedWorkspace(ctx:SessionContext,caseId:string){
 z.uuid().parse(caseId);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const view=await contractSharedContextTx(tx,caseId);
  const [row]=await tx.execute<{workspace:ContractCaseWorkspace}>(sql`select app.contract_shared_workspace(${caseId}::uuid) as workspace`);
  const reasons=view.permissions.includes('decide')||view.permissions.includes('decline')?(await terminationReasonCatalogueTx(tx,ctx.tenantId)).filter(r=>r.active).map(({code,label,category})=>({code,label,category})):[];
  return {view,...row.workspace,reasons};
 });
}
