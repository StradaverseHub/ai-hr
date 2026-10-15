import type { SessionContext } from '@/db/client';
import { leaveInquiryBalancePairs, type LeaveInquiryContext } from '@/packs/leave/service';
import type { InquiryQuery } from '@/lib/leave-inquiry-query';
import { employeeBalanceRows, type EmployeeBalanceRow } from './rows';

/** Screen and export share the exact page membership and canonical row presentation. */
export async function inquiryBalancePage(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, locale: string, window: { limit: number; offset: number } = query.pq) {
  const page = await leaveInquiryBalancePairs(ctx, scope, query, locale, window);
  const byEmployee = new Map<string, string[]>();
  for (const pair of page.rows) {
    const ids = byEmployee.get(pair.employee.employmentId) ?? [];
    ids.push(pair.leaveTypeId); byEmployee.set(pair.employee.employmentId, ids);
  }
  const hydrated = new Map<string, EmployeeBalanceRow>();
  // Sequential employees bound connection pressure; each read retains the Leave owner's pool context.
  for (const [employmentId, requestedTypeIds] of byEmployee) {
    for (const row of await employeeBalanceRows(ctx, employmentId, query.asOf, locale, {}, { requestedTypeIds })) hydrated.set(`${employmentId}|${row.leaveTypeId}`, row);
  }
  const rows = page.rows.map(pair => {
    const row = hydrated.get(`${pair.employee.employmentId}|${pair.leaveTypeId}`);
    if (!row) throw new Error('Leave inquiry membership changed. Retry the request.');
    return { ...row, employee: pair.employee };
  });
  return { rows, total: page.total };
}
