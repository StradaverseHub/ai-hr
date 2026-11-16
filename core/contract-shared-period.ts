/** A View-only reader can inspect a native fixed-term period without creating a case or raising events. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import type {ContractSharedContext} from './contract-shared-read';
import {ContractManagementError} from '../lib/contract-management-model';
export type ContractSharedPeriodContext={
 employmentId:string;companyId:string;source:Omit<ContractSharedContext['source'],'startOn'|'endOn'>&{startOn:string|null;endOn:string|null};permissions:ContractSharedContext['permissions'];
 sourceRevision:string;sourceIssue:'verify_period'|'period_changed'|null;canOpen:boolean;existingCaseId:string|null;
};
export function contractSharedPeriodContext(ctx:SessionContext,employmentId:string):Promise<ContractSharedPeriodContext>{
 z.uuid().parse(employmentId);
 return withScopedLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [row]=await tx.execute<{value:ContractSharedPeriodContext|null}>(sql`select app.contract_shared_period_context(${employmentId}::uuid) as value`);
  if(!row?.value)throw new ContractManagementError('forbidden','This Contract period is unavailable.');
  return row.value;
 });
}
