import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import type {ProbationReconciliationView} from '../lib/probation-reconciliation';

/** A read never queues work. SQL owns authority, reason aggregation, count, order and pagination. */
export function probationPersonnelDiscrepancies(ctx:SessionContext,filters:{companyId?:string;offset?:number;limit?:number}={}):Promise<ProbationReconciliationView>{
 if(filters.companyId&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(filters.companyId))throw new Error('Choose a valid company.');
 const offset=Number.isSafeInteger(filters.offset)?Math.max(0,filters.offset!):0;
 const limit=Number.isSafeInteger(filters.limit)?Math.min(100,Math.max(1,filters.limit!)):25;
 return withScopedLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const[row]=await tx.execute<{data:ProbationReconciliationView}>(sql`select app.probation_reconciliation_view(${filters.companyId??null}::uuid,${offset},${limit}) as data`);
  return row.data;
 });
}
