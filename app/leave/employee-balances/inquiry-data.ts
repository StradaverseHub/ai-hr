import type { SessionContext, Tx } from '@/db/client';
import { leaveInquirySnapshotForContext, leaveInquiryBalancePairsTx, type LeaveInquiryContext } from '@/packs/leave/service';
import type { InquiryQuery } from '@/lib/leave-inquiry-query';
import { employeeBalanceRows, type EmployeeBalanceRow } from './rows';

/** Screen and export share the exact page membership and canonical row presentation. */
type InquiryBalancePage={rows:(EmployeeBalanceRow&{employee:LeaveInquiryContext['employees'][number]})[];total:number};
export async function inquiryBalancePage(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, locale: string, window: { limit: number; offset: number } = query.pq, tx?: Tx):Promise<InquiryBalancePage> {
  query=structuredClone(query);window={...window};
  const hydrationContext=structuredClone(ctx);
  if(!tx)return leaveInquirySnapshotForContext(ctx,scope,query,(owned,current)=>inquiryBalancePage(ctx,current,query,locale,window,owned));
  const page = await leaveInquiryBalancePairsTx(tx, ctx, scope, query, locale, window);
  const byEmployee = new Map<string, string[]>();
  for (const pair of page.rows) {
    const ids = byEmployee.get(pair.employee.employmentId) ?? [];
    ids.push(pair.leaveTypeId); byEmployee.set(pair.employee.employmentId, ids);
  }
  const hydrated = new Map<string, EmployeeBalanceRow>();
  // Sequential employees bound connection pressure; each read retains the Leave owner's pool context.
  for (const [employmentId, requestedTypeIds] of byEmployee) {
    for (const row of await employeeBalanceRows(hydrationContext, employmentId, query.asOf, locale, {}, { requestedTypeIds, tx })) hydrated.set(`${employmentId}|${row.leaveTypeId}`, row);
  }
  const rows = page.rows.map(pair => {
    const row = hydrated.get(`${pair.employee.employmentId}|${pair.leaveTypeId}`);
    if (!row) throw new Error('Leave inquiry membership changed. Retry the request.');
    return { ...row, employee: pair.employee };
  });
  return { rows, total: page.total };
}
