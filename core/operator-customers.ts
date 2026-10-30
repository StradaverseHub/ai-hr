/** Installation metadata only. The operator never assumes a customer's HR identity. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { isOperator } from '../lib/authz-model';
import { isDemoDeployment } from '../lib/demo-mode';
import { readRecord } from '../lib/internal-auth/record-store';
import { internalSelected } from '../lib/internal-auth/config';
import { client } from '../db/client';
import type { Organization } from '../lib/internal-auth/service';
import type { DeactivationBlocker } from './module-deactivation';

export type CustomerModule = {code:string;status:string;companyId:string|null};
export type CustomerChange = {id:string;module_code:string;action:string;status:string;error:string|null;created_at:string;decided_at:string|null};
export type OperatorCustomer = {
  tenant_id:string;customer_name:string;customer_status:string;request_id:string|null;admin_email:string|null;country:string|null;
  modules:CustomerModule[];changes:CustomerChange[];blockers:Record<string,DeactivationBlocker[]>;organizationCode:string|null;
};
function assertOperator(ctx:SessionContext) {
  if (!isOperator(ctx) || isDemoDeployment() || !ctx.userId) throw new Error('Only an operator can manage customers.');
}
const uuid = (value:string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Select a valid customer.');
  return value;
};
const REFUSALS: Record<string,string> = {
  OPERATOR_NAME_INVALID:'Enter a customer name between 1 and 200 characters.',
  OPERATOR_CUSTOMER_MISSING:'This customer could not be found.',
  OPERATOR_CHANGE_PENDING:'Wait for the pending module change to finish before submitting another.',
  OPERATOR_SCOPED_MODULE:'This module has company-specific access. Its contract needs an installation review before a tenant-wide change.',
  OPERATOR_STATE_CHANGED:'The module state has changed. Refresh the customer before trying again.',
  OPERATOR_DEPENDENCIES:'Enable the required modules first.',
  OPERATOR_DEPENDENTS:'Disable the dependent modules first.',
  OPERATOR_PURCHASE_REQUIRED:'Enter the purchase or agreement reference for this module.',
  OPERATOR_DISPOSITION_REQUIRED:'Record what will happen to each item of unfinished work before disabling this module.',
  OPERATOR_MODULE_INVALID:'Choose an optional module from the catalog.',
  OPERATOR_ACTION_INVALID:'Choose whether to enable or disable the module.',
};
async function readable<T>(run:()=>Promise<T>):Promise<T> {
  try {return await run();} catch(error) {
    let cause:unknown=error;
    while(cause instanceof Error){
      if(REFUSALS[cause.message])throw new Error(REFUSALS[cause.message]);
      cause=(cause as Error & {cause?:unknown}).cause;
    }
    throw error;
  }
}
export async function listOperatorCustomers(ctx:SessionContext, tenantId?:string):Promise<OperatorCustomer[]> {
  assertOperator(ctx);
  const rows = await withTenant(ctx, tx=>tx.execute<Omit<OperatorCustomer,'organizationCode'>>(sql`select * from app.operator_customer_data(${tenantId?uuid(tenantId):null}::uuid)`));
  // Organization names are display snapshots. The encrypted namespace indexes remain the login owner;
  // legacy customers created before this UI are read from that same source, never guessed from a name.
  return Promise.all(rows.map(async row=>{
    const org=internalSelected()?await readRecord<Organization>(client,`tenant:${row.tenant_id}`):null;
    return {...row,organizationCode:org?.code??null};
  }));
}
export async function renameOperatorCustomer(ctx:SessionContext,tenantId:string,name:string):Promise<void> {
  assertOperator(ctx);
  if(!name.trim()||name.trim().length>200)throw new Error(REFUSALS.OPERATOR_NAME_INVALID);
  await readable(()=>withTenant(ctx,tx=>tx.execute(sql`select app.operator_rename_customer(${uuid(tenantId)}::uuid,${name.trim()})`)));
}
export async function requestOperatorModuleChange(ctx:SessionContext,input:{tenantId:string;moduleCode:string;action:string;purchaseReference?:string;disposition?:Record<string,string>}):Promise<void> {
  assertOperator(ctx);
  if(input.disposition && (Object.keys(input.disposition).length>10 || Object.values(input.disposition).some(v=>typeof v!=='string'||v.length>1000)))throw new Error('Keep each decision under 1,000 characters.');
  await readable(()=>withTenant(ctx,tx=>tx.execute(sql`select app.operator_request_module_change(${uuid(input.tenantId)}::uuid,${input.moduleCode},${input.action},${input.purchaseReference??null},${JSON.stringify(input.disposition??null)}::jsonb)`)));
}
/** Whether this customer's people see the Feedback menu and board (0696). No setting row means on. */
export async function operatorCustomerFeedbackMenu(ctx:SessionContext,tenantId:string):Promise<boolean> {
  assertOperator(ctx);
  const [row]=await readable(()=>withTenant(ctx,tx=>tx.execute<{enabled:boolean}>(sql`select app.operator_customer_feedback_menu(${uuid(tenantId)}::uuid) as enabled`)));
  return row?.enabled!==false;
}
/** Turn the customer's Feedback menu on or off. Platform-scoped, so the customer's admins cannot override it. */
export async function setOperatorCustomerFeedbackMenu(ctx:SessionContext,tenantId:string,enabled:boolean):Promise<void> {
  assertOperator(ctx);
  await readable(()=>withTenant(ctx,tx=>tx.execute(sql`select app.operator_set_customer_feedback_menu(${uuid(tenantId)}::uuid,${enabled})`)));
}
