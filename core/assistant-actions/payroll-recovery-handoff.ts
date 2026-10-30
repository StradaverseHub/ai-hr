import 'server-only';
import type {SessionContext} from '@/db/client';
import {isAdmin,canManagePayroll} from '@/lib/authz-model';
import {isModuleEnabled,settingEnabledOrDefault} from '@/core/entitlements';
import {listBatches} from '@/packs/payroll/service';
import {todayInKualaLumpur} from '@/lib/hr-date';

/** Navigation only. Native pages/services own the reason, confirmation, company permission,
 * downstream warnings and every effect. A link is never an execution capability or receipt. */
export async function readPayrollRecoveryHandoffs(ctx:SessionContext){
 if(!ctx.userId||!canManagePayroll(ctx)||!isModuleEnabled(ctx,'payroll'))return [];
 const reset=isAdmin(ctx)&&settingEnabledOrDefault(ctx,'payroll.reset_enabled');
 const reopen=settingEnabledOrDefault(ctx,'payroll.unlock_enabled');
 if(!reset&&!reopen)return [];
 const period=todayInKualaLumpur().slice(0,7);
 const batches=await listBatches(ctx,undefined,period);
 return batches.filter(row=>canManagePayroll(ctx,row.companyId)&&!row.historyImportAttemptId&&
  (row.status==='processed'&&reset||row.status==='closed'&&reopen)).slice(0,25).map(row=>({
   batchId:row.id,company:row.company,payPeriod:row.payPeriod,cycle:row.payrollCycleName,
   operation:row.status==='processed'?'reset' as const:'reopen' as const,
   href:row.status==='processed'?`/payroll/${row.id}/reset`:`/payroll/${row.id}`,
 }));
}
