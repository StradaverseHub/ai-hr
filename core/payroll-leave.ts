/** Payroll owns stale-run marking and closed-run follow-up; Leave owns the decision itself. */
import { eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { leaveRequest, leaveRequestDate, leaveType } from '../db/schema';
import { cutOffWindowFor, payrollScheduleFor, type PayrollPolicyConfig } from './payroll-policy-config';
import { payslipSegmentOf } from './payslip-segment';

export class LeavePayrollBusyError extends Error {
  constructor() { super('Payroll is being updated. Please retry this leave change after the payroll operation finishes.'); this.name = 'LeavePayrollBusyError'; }
}
export class LeavePayrollClosedError extends Error {
  constructor() { super('This leave change affects a closed payroll period. Closed pay must be reviewed by Payroll HR first.'); this.name = 'LeavePayrollClosedError'; }
}
type SourceAction = 'approval' | 'charged_import' | 'cancellation' | 'paid_setting';
type Coverage = {
  request_id: string; employment_id: string; batch_id: string; company_id: string;
  status: 'processed' | 'closed'; pay_period: string; policy_config: PayrollPolicyConfig | null;
  unpaid_leave_cutoff_day: number | null; coverage_from: string | null; coverage_to: string | null; segment: unknown;
  salary_cutoff_day: number | null; run_policy_config: PayrollPolicyConfig | null;
};
export type LeavePayrollHit = { requestId: string; batchId: string; employmentId: string; status: 'processed' | 'closed'; dates: string[] };
function postgresCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const value = error as { code?: string; cause?: unknown };
    if (value.code) return value.code;
    error = value.cause;
  }
}
function datesBetween(from: string, to: string) {
  const out: string[] = [];
  for (let day = Date.parse(`${from}T00:00:00Z`); day <= Date.parse(`${to}T00:00:00Z`); day += 86_400_000) out.push(new Date(day).toISOString().slice(0, 10));
  return out;
}

/** Lock all source subjects' runs in one ordered operation, including hidden/former-company coverage. */
export async function lockPayrollForLeaveChangeTx(tx: Tx, p: {
  requestIds: string[]; action: SourceAction;
  survivorStarts?: ReadonlyMap<string, readonly string[]>;
  changedDates?: ReadonlyMap<string, readonly string[]>;
  prospectivePaid?: boolean;
}): Promise<LeavePayrollHit[]> {
  const ids = [...new Set(p.requestIds)].sort();
  if (!ids.length) return [];
  const requests = await tx.select({
    id: leaveRequest.id, start: leaveRequest.startDate, end: leaveRequest.endDate,
    duration: leaveRequest.durationType, imported: leaveRequest.importedHistory,
    allowance: leaveRequest.allowanceEligible, unpaidDays: leaveRequest.unpaidDays, paid: leaveType.paid,
    charged: sql<boolean>`exists(select 1 from leave_ledger ll where ll.tenant_id=${leaveRequest.tenantId} and ll.source_request_id=${leaveRequest.id} and ll.entry_type='debit')`,
  }).from(leaveRequest).innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
    .where(inArray(leaveRequest.id, ids));
  if (requests.length !== ids.length) throw new Error('Leave requests unavailable');
  const dateRows = await tx.select({ requestId: leaveRequestDate.leaveRequestId, date: leaveRequestDate.leaveDate, status: leaveRequestDate.status })
    .from(leaveRequestDate).where(inArray(leaveRequestDate.leaveRequestId, ids));
  const approvedDates = new Map<string, string[]>();
  for (const row of dateRows) {
    if (!approvedDates.has(row.requestId)) approvedDates.set(row.requestId, []);
    if (row.status === 'approved') approvedDates.get(row.requestId)!.push(row.date);
  }
  let coverage: Coverage[];
  try {
    // A JSON array is converted on the server. Never interpolate a PostgreSQL array literal.
    coverage = await tx.execute(sql`select request_id,employment_id,batch_id,company_id,status,pay_period,policy_config,
      unpaid_leave_cutoff_day,coverage_from::text,coverage_to::text,segment,salary_cutoff_day,run_policy_config from app.leave_payroll_coverage(
      ARRAY(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid[]
    )`) as unknown as Coverage[];
  } catch (error) {
    if (postgresCode(error) === '55P03') throw new LeavePayrollBusyError();
    throw error;
  }
  const byId = new Map(requests.map(request => [request.id, request]));
  const hits: LeavePayrollHit[] = [];
  for (const row of coverage) {
    const request = byId.get(row.request_id)!;
    // This system does not re-charge an uncharged history import.
    if (request.imported && !request.charged) continue;
    if (p.action === 'paid_setting' && request.allowance === false) continue;
    const unpaid = !request.paid || request.allowance === false || Number(request.unpaidDays ?? 0) > 0 || p.prospectivePaid === false;
    const window = cutOffWindowFor('leave', row.policy_config, { unpaidLeaveCutOffDay: row.unpaid_leave_cutoff_day }, row.pay_period);
    const segment = payslipSegmentOf({ coverageFrom: row.coverage_from, coverageTo: row.coverage_to, statutory: row.segment }, row.pay_period);
    if (segment) { window.start = window.start > segment.from ? window.start : segment.from; window.end = window.end < segment.to ? window.end : segment.to; }
    const inside = (date: string) => date >= window.start && date <= window.end;
    const starts = [request.start, ...(p.survivorStarts?.get(request.id) ?? [])];
    const changedDates = p.changedDates?.get(request.id) ?? approvedDates.get(request.id) ?? datesBetween(request.start, request.end);
    const affected = new Set<string>();
    if (unpaid) for (const date of starts) if (inside(date)) affected.add(date);
    // Weekly/biweekly disbursement weights read unpaid starts in the company's SALARY cycles,
    // independently of the employee's leave-deduction window. Mirror that existing consumer,
    // including its distinct paid-type treatment, without changing its arithmetic.
    const schedule = payrollScheduleFor(row.run_policy_config, { cutOffDay: row.salary_cutoff_day }, row.pay_period);
    if (schedule.frequency !== 'monthly' && schedule.periods.length > 1 && (!request.paid || request.allowance === false || p.prospectivePaid === false)) {
      for (const date of starts) if (schedule.periods.some(period => date >= period.start && date <= period.end)) affected.add(date);
    }
    if (p.action !== 'paid_setting' && request.duration === 'full_day' && row.policy_config?.leave?.deductAbsentDays === true) {
      for (const date of changedDates) if (inside(date)) affected.add(date);
    }
    if (affected.size) hits.push({ requestId: request.id, employmentId: row.employment_id, batchId: row.batch_id, status: row.status, dates: [...affected].sort() });
  }
  if ((p.action === 'cancellation' || p.action === 'paid_setting') && hits.some(hit => hit.status === 'closed')) throw new LeavePayrollClosedError();
  return hits;
}

/** Called before the Leave transaction commits, so an effect failure rolls the decision back. */
export async function applyLeavePayrollEffectsTx(tx: Tx, hits: readonly LeavePayrollHit[], action: SourceAction) {
  for (const hit of hits) {
    try {
      await tx.execute(sql`select app.record_leave_payroll_effect(${hit.requestId}::uuid,${hit.batchId}::uuid,${action},${JSON.stringify(hit.dates)}::jsonb)`);
    } catch (error) {
      if (postgresCode(error) === '55P03') throw new LeavePayrollBusyError();
      throw error;
    }
  }
}

export async function markPayrollAfterLeaveApprovalTx(tx: Tx, requestId: string, action: 'approval' | 'charged_import' = 'approval') {
  await applyLeavePayrollEffectsTx(tx, await lockPayrollForLeaveChangeTx(tx, { requestIds: [requestId], action }), action);
}

export async function lockPayrollForLeavePaidSettingTx(tx: Tx, typeId: string, nextPaid: boolean) {
  const [row] = await tx.execute(sql`select app.leave_type_payroll_requests(${typeId}::uuid) as ids`) as unknown as { ids: string[] }[];
  return lockPayrollForLeaveChangeTx(tx, { requestIds: row?.ids ?? [], action: 'paid_setting', prospectivePaid: nextPaid });
}

export type PayrollLeaveException = {
  id: string; leave_request_id: string; employment_id: string; employee: string; employee_no: string | null;
  source_action: 'approval' | 'charged_import'; affected_dates: string[]; created_at: Date;
  status: 'open' | 'resolved'; resolution: 'adjustment' | 'no_adjustment' | null;
  adjustment_batch_id: string | null; explanation: string | null; resolved_at: Date | null;
  opened_by: string | null; resolved_by: string | null;
};
export function listPayrollLeaveExceptions(ctx: SessionContext, batchId: string) {
  return payrollLeaveExceptionPage(ctx, batchId).then(page => page.rows);
}
export function payrollLeaveExceptionPage(ctx: SessionContext, batchId: string, p: { limit?: number; offset?: number } = {}) {
  const limit = Math.min(2000, Math.max(1, Math.trunc(p.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(p.offset ?? 0));
  return withTenant(ctx, async tx => {
    const [result] = await tx.execute(sql`with scoped as materialized (
      select x.id,x.leave_request_id,x.employment_id,p.full_name as employee,e.employee_code as employee_no,
        x.source_action,x.affected_dates,x.created_at,x.status,x.resolution,x.adjustment_batch_id,x.explanation,x.resolved_at,
        opener.full_name as opened_by,resolver.full_name as resolved_by
      from payroll_leave_exception x join employment e on e.id=x.employment_id and e.tenant_id=x.tenant_id
      join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
      left join app_user ou on ou.id=x.created_by and ou.tenant_id=x.tenant_id
      left join person opener on opener.id=ou.person_id and opener.tenant_id=x.tenant_id
      left join app_user ru on ru.id=x.resolved_by and ru.tenant_id=x.tenant_id
      left join person resolver on resolver.id=ru.person_id and resolver.tenant_id=x.tenant_id
      where x.batch_id=${batchId}::uuid and x.tenant_id=app.current_tenant_id()
    ), page as (select * from scoped order by created_at,id limit ${limit} offset ${offset})
    select coalesce(jsonb_agg(to_jsonb(page) order by created_at,id),'[]'::jsonb) as rows,
      (select count(*)::integer from scoped) as total from page`) as unknown as { rows: PayrollLeaveException[]; total: number }[];
    return result ?? { rows: [], total: 0 };
  });
}
export function listPayrollLeaveExceptionAdjustments(ctx: SessionContext, batchId: string, exceptionIds: readonly string[]) {
  if (!exceptionIds.length) return Promise.resolve([]);
  return withTenant(ctx, async tx => await tx.execute(sql`select distinct x.id as "exceptionId",b.id,b.pay_period as "payPeriod",b.batch_date::text as "batchDate",b.run_seq as "runSeq"
    from payroll_leave_exception x join payslip ps on ps.employment_id=x.employment_id and ps.tenant_id=x.tenant_id
    join payroll_batch b on b.id=ps.batch_id and b.tenant_id=x.tenant_id
    where x.batch_id=${batchId}::uuid and x.tenant_id=app.current_tenant_id() and x.status='open'
      and x.id in (select jsonb_array_elements_text(${JSON.stringify(exceptionIds)}::jsonb)::uuid)
      and b.id<>x.batch_id and b.status='closed' and b.run_type='adjustment'
      and app.is_admin_for(b.company_id) and app.can_admin_payroll_for(b.company_id)
    order by "payPeriod","batchDate","runSeq",b.id,x.id`) as unknown as { exceptionId: string; id: string; payPeriod: string; batchDate: string; runSeq: number }[]);
}
export function resolvePayrollLeaveException(ctx: SessionContext, p: { id: string; batchId: string; resolution: 'adjustment' | 'no_adjustment'; adjustmentBatchId?: string | null; explanation: string }) {
  if (!['adjustment', 'no_adjustment'].includes(p.resolution) || p.explanation.trim().length < 10 || p.explanation.length > 2000) throw new Error('Provide a clear resolution explanation.');
  return withTenant(ctx, async tx => {
    const [bound] = await tx.execute(sql`select id from payroll_leave_exception where id=${p.id}::uuid and batch_id=${p.batchId}::uuid and tenant_id=app.current_tenant_id()`) as unknown as { id: string }[];
    if (!bound) throw new Error('Payroll leave exception unavailable.');
    await tx.execute(sql`select app.resolve_leave_payroll_exception(${p.id}::uuid,${p.resolution},${p.adjustmentBatchId ?? null}::uuid,${p.explanation})`);
  });
}
